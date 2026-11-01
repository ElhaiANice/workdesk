// WorkDesk desktop shell: starts the Node server (same code as `npm start`) and shows it in a native window.
// Lives in the tray (close hides the window), Ctrl+Alt+N opens a small quick-capture window, and it can start with Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

const PORT: u16 = 4321;
const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";

struct Server(Mutex<Option<Child>>);

fn up() -> bool {
    let addr: SocketAddr = ([127, 0, 0, 1], PORT).into();
    TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_ok()
}

fn quiet(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(cmd, 0x0800_0000); // CREATE_NO_WINDOW
    cmd.stdout(Stdio::null()).stderr(Stdio::null()).stdin(Stdio::null())
}

fn exe_dir() -> PathBuf {
    std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.to_path_buf())).unwrap_or_default()
}

// Shared folder layout: WorkDesk.exe next to app/ (server.js), node/ (node.exe), tasks/ and .env.
// WORKDESK_HOME forces a development folder; otherwise the repo this was built from.
struct Layout { app: PathBuf, node: PathBuf, portable: Option<PathBuf> }

fn layout() -> Layout {
    if let Some(h) = std::env::var_os("WORKDESK_HOME") {
        return Layout { app: PathBuf::from(h), node: "node".into(), portable: None };
    }
    let here = exe_dir();
    if here.join("app").join("server.js").exists() {
        let bundled = here.join("node").join("node.exe");
        return Layout { app: here.join("app"), node: if bundled.exists() { bundled } else { "node".into() }, portable: Some(here) };
    }
    Layout { app: PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join(".."), node: "node".into(), portable: None }
}

fn spawn_server() -> Result<Option<Child>, String> {
    if up() {
        return Ok(None); // `npm start` is already running; reuse it
    }
    let l = layout();
    let mut cmd = Command::new(&l.node);
    cmd.arg("server.js").current_dir(&l.app).env("PORT", PORT.to_string());
    if let Some(root) = &l.portable {
        cmd.env("WORKDESK_TASKS", root.join("tasks")).env("WORKDESK_ENV", root.join(".env")).env("WORKDESK_STATE", root.join(".workdesk-sync.json"));
    }
    quiet(&mut cmd);
    let child = cmd.spawn().map_err(|e| format!("Could not start Node ({e}). Install Node 20+ or use the folder that ships node/node.exe."))?;
    let t = Instant::now();
    while !up() {
        if t.elapsed() > Duration::from_secs(10) {
            return Err("The WorkDesk server did not start in 10 seconds.".into());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Ok(Some(child))
}

fn autostart_on() -> bool {
    quiet(Command::new("reg").args(["query", RUN_KEY, "/v", "WorkDesk"])).status().map(|s| s.success()).unwrap_or(false)
}

fn set_autostart(on: bool) {
    let exe = std::env::current_exe().unwrap_or_default();
    let value = format!("\"{}\" --hidden", exe.display());
    let mut c = Command::new("reg");
    if on {
        c.args(["add", RUN_KEY, "/v", "WorkDesk", "/t", "REG_SZ", "/d", &value, "/f"]);
    } else {
        c.args(["delete", RUN_KEY, "/v", "WorkDesk", "/f"]);
    }
    let _ = quiet(&mut c).status();
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

// The quick window closes on click-away, but only once it has actually had focus: Windows often refuses focus while Ctrl+Alt are still held,
// and the resulting "focus lost" event used to close the window the instant it opened.
static QUICK_ARMED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn focus_soon(w: tauri::WebviewWindow) {
    std::thread::spawn(move || {
        for ms in [120u64, 250, 500] {
            std::thread::sleep(Duration::from_millis(ms));
            let _ = w.set_focus();
        }
    });
}

fn show_quick(app: &AppHandle) {
    QUICK_ARMED.store(false, std::sync::atomic::Ordering::SeqCst);
    if let Some(w) = app.get_webview_window("quick") {
        let _ = w.eval("document.getElementById('q').value=''");
        let _ = w.show();
        let _ = w.set_focus();
        focus_soon(w);
        return;
    }
    let url = format!("http://localhost:{PORT}/quick.html");
    if let Ok(b) = WebviewWindowBuilder::new(app, "quick", WebviewUrl::External(url.parse().unwrap()))
        .title("WorkDesk: quick add")
        .inner_size(540.0, 130.0)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .always_on_top(true)
        .center()
        .build()
    {
        // Click-away closes it, like a launcher.
        let w = b.clone();
        b.on_window_event(move |e| {
            match e {
                WindowEvent::Focused(true) => QUICK_ARMED.store(true, std::sync::atomic::Ordering::SeqCst),
                WindowEvent::Focused(false) => {
                    if QUICK_ARMED.swap(false, std::sync::atomic::Ordering::SeqCst) {
                        let _ = w.hide();
                    }
                }
                _ => {}
            }
        });
        focus_soon(b);
    }
}

fn main() {
    let hotkey = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyN);
    let app = tauri::Builder::default()
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, sc, ev| {
                    if ev.state() == ShortcutState::Pressed && sc.matches(Modifiers::CONTROL | Modifiers::ALT, Code::KeyN) {
                        show_quick(app);
                    }
                })
                .build(),
        )
        .setup(move |app| {
            let child = spawn_server()?;
            app.manage(Server(Mutex::new(child)));
            let url = format!("http://localhost:{PORT}");
            let hidden = std::env::args().any(|a| a == "--hidden");
            let main = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url.parse().unwrap()))
                .title("WorkDesk")
                .inner_size(1280.0, 820.0)
                .min_inner_size(360.0, 500.0)
                .visible(!hidden)
                .disable_drag_drop_handler() // lets the page's own HTML5 drag-and-drop work on Windows
                .build()?;
            // Closing the window keeps WorkDesk in the tray; "Quit" in the tray menu ends it.
            let w = main.clone();
            main.on_window_event(move |e| {
                if let WindowEvent::CloseRequested { api, .. } = e {
                    api.prevent_close();
                    let _ = w.hide();
                }
            });

            let open = MenuItem::with_id(app, "open", "Open WorkDesk", true, None::<&str>)?;
            let quick = MenuItem::with_id(app, "quick", "Quick add  (Ctrl+Alt+N)", true, None::<&str>)?;
            let auto = CheckMenuItem::with_id(app, "autostart", "Start with Windows", true, autostart_on(), None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit WorkDesk", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quick, &PredefinedMenuItem::separator(app)?, &auto, &PredefinedMenuItem::separator(app)?, &quit])?;
            let auto2 = auto.clone();
            TrayIconBuilder::with_id("tray")
                .icon(app.default_window_icon().cloned().ok_or("no app icon")?)
                .tooltip("WorkDesk")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, ev| match ev.id().as_ref() {
                    "open" => show_main(app),
                    "quick" => show_quick(app),
                    "autostart" => set_autostart(auto2.is_checked().unwrap_or(false)),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, ev| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;

            let _ = app.global_shortcut().register(hotkey); // another app may own the shortcut; the tray still works
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building WorkDesk");
    app.run(|handle, event| match event {
        RunEvent::ExitRequested { api, code, .. } if code.is_none() => api.prevent_exit(), // last window hid: stay in the tray
        RunEvent::Exit => {
            if let Some(s) = handle.try_state::<Server>() {
                if let Some(mut c) = s.0.lock().unwrap().take() {
                    let _ = c.kill();
                }
            }
        }
        _ => {}
    });
}
