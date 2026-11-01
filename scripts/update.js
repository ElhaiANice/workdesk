'use strict';
// Update an installed WorkDesk folder from a newer release (a folder or a .zip) without touching your data.
//   node app/scripts/update.js <new-release-folder-or-zip>
// Replaces: app/, node/ (if the release has it) and WorkDesk.exe.  Keeps: tasks/, .env, and every dotfile.
// The previous app/ is kept as backup/app-<old version> so you can roll back by copying it back.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const root = process.env.WORKDESK_ROOT || path.resolve(__dirname, '..', '..'); // WORKDESK_ROOT: the in-app updater runs a copy of this script from a temp folder
const src0 = process.argv[2];
const die = (m) => { console.error('Update failed: ' + m); process.exit(1); };
if (!src0) die('give the path of the new release folder or .zip.  Example: node app\\scripts\\update.js C:\\Downloads\\WorkDesk-1.2.0.zip');
if (!fs.existsSync(path.join(root, 'app', 'server.js'))) die('run this from an installed WorkDesk folder (the one that contains app\\ and WorkDesk.exe).');

let src = path.resolve(src0), tmp = '';
if (/\.zip$/i.test(src)) {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'workdesk-update-'));
  execFileSync('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${src.replace(/'/g, "''")}' -DestinationPath '${tmp.replace(/'/g, "''")}' -Force`], { stdio: 'inherit' });
  const inner = fs.readdirSync(tmp);
  src = inner.length === 1 && fs.statSync(path.join(tmp, inner[0])).isDirectory() ? path.join(tmp, inner[0]) : tmp;
}
if (!fs.existsSync(path.join(src, 'app', 'server.js'))) die(`${src} does not look like a WorkDesk release (no app\\server.js).`);

const ver = (d) => { try { return JSON.parse(fs.readFileSync(path.join(d, 'app', 'package.json'), 'utf8')).version; } catch { return '?'; } };
const from = ver(root), to = ver(src);
console.log(`Updating WorkDesk ${from} -> ${to}`);

const hasExe = fs.existsSync(path.join(root, 'WorkDesk.exe')); // the no-exe edition runs from "Start WorkDesk.cmd" instead
if (hasExe) {
  try { fs.accessSync(path.join(root, 'WorkDesk.exe'), fs.constants.W_OK); fs.renameSync(path.join(root, 'WorkDesk.exe'), path.join(root, 'WorkDesk.exe')); }
  catch { die('WorkDesk is still running. Quit it from the tray icon, then run the update again.'); }
}

const backup = path.join(root, 'backup', 'app-' + from);
fs.mkdirSync(path.dirname(backup), { recursive: true });
fs.rmSync(backup, { recursive: true, force: true });
fs.cpSync(path.join(root, 'app'), backup, { recursive: true });

fs.rmSync(path.join(root, 'app'), { recursive: true, force: true });
fs.cpSync(path.join(src, 'app'), path.join(root, 'app'), { recursive: true });
for (const extra of ['node', 'WorkDesk.exe', 'README.txt', 'Update WorkDesk.cmd', 'Start WorkDesk.cmd']) {
  if (!fs.existsSync(path.join(src, extra))) continue;
  // cmd.exe reads a running batch file as it goes; only rewrite the start script when it actually changed.
  if (extra.endsWith('.cmd') && fs.existsSync(path.join(root, extra)) && fs.readFileSync(path.join(src, extra), 'utf8') === fs.readFileSync(path.join(root, extra), 'utf8')) continue;
  fs.rmSync(path.join(root, extra), { recursive: true, force: true });
  fs.cpSync(path.join(src, extra), path.join(root, extra), { recursive: true });
}
if (fs.existsSync(path.join(src, '.env.example'))) fs.copyFileSync(path.join(src, '.env.example'), path.join(root, '.env.example'));
if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
console.log(`Done. Your tasks and .env were not touched. Old version saved in ${path.relative(root, backup)}.\nStart ${hasExe ? 'WorkDesk.exe' : '"Start WorkDesk.cmd"'}. Task data is migrated automatically on first start (a copy is kept in tasks.backup-v*).`);
