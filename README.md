# WorkDesk

Local task manager for epics you own, stories on other people's epics, tech tasks, PR reviews, follow-ups and meetings.
Tasks are Markdown files in `tasks/`. No dependencies, no build step (Node 20+).

## Run

```
npm start          # http://localhost:4321
npm test           # end-to-end smoke test in a temp folder
```

Keys: `N` new task, `/` search, `Esc` close. Quick-add understands type words, `ABC-123` keys and "for Dana". Overview is a board by status. Drag cards to change status, or up and down to put them in your own order: new tasks go to the bottom of their column, and each card shows its age (0d, 3d, 100d); it adapts from phone to wide screens. No due dates by design.

## Task file

```
---
type: story            # epic | story | tech | review | follow-up | meeting
title: CWE-78 remediation
status: in-progress    # inbox (shown as Pending) | todo | in-progress | waiting | review | done
jira: ABC-2481
epic: ABC-2400
epic_owner: Noa
repos: [BE/media-utils]
who: Dana              # waiting on / reviewer / attendee
---
Free-form notes.
- [ ] checklist item
```

## Phase 2: Jira page

Put your Jira settings in `.env` (copy `.env.example`): `JIRA_BASE_URL` plus `JIRA_EMAIL` + `JIRA_TOKEN` (Cloud) or `JIRA_PAT` (Server/Data Center). Restart after editing.
Open **Jira** in the sidebar:

- **Connection:** shows which site you're signed in to; "Test connection" confirms the credentials.
- **Sync my tickets:** pulls your unresolved tickets (override the query with `JIRA_JQL`) and creates a task for each. Re-syncing refreshes title, epic link and done; your notes and local statuses (waiting, review) are kept.
- **Automatic sync:** three times a day on work days (09:00, 13:00, 17:00, Sun-Thu). A sync missed while the app was closed runs once on the next start. Change with `WORKDESK_SYNC_TIMES`, `WORKDESK_SYNC_DAYS`, or turn off with `WORKDESK_SYNC=off`. The page shows the last sync.
- **Import tickets:** enter keys or paste Jira links (`ABC-2481, ABC-2400`). An epic key also brings in its stories.
- **Two-way status:** moving a task that has a Jira key also moves the ticket, using the workflow's own transitions (To Do / In Progress / Validation / Done). `Resolution` is filled automatically when a transition requires it. If a transition needs other fields (listed on the transition, or demanded by a workflow validator), the move is undone locally and a dialog asks for those fields (pick lists, versions, text, numbers, dates, users); **Move in Jira** retries with them, and only when Jira accepts does the task move. If the workflow has no such step at all, a message says so. `JIRA_PUSH=off` makes WorkDesk read-only again. Only the status and the fields you fill in that dialog are ever written.

## Pull requests

A task with a GitHub `pr` URL shows a PR badge (open / draft / merged / closed, plus approved or changes requested). It is read with the GitHub CLI (`gh`, logged in). On a change an open PR moves the task to Review, a merged PR moves it to Done; it only acts when the PR state changes, so a task you move back by hand stays. Runs after each Jira sync and from **Jira > Refresh PR status**.

## Everyday features

- **Important** flag (red mark), **Waiting** is the last column, epics show a progress panel.
- **Types are chosen automatically** from the title (epic, story, tech, bug, review, security, incident, research, docs, planning, follow-up, meeting). Click the type chip on a card to change it from a floating menu; quick-add also shows a "Change" link.
- **Title auto-fix:** first letter capitalised and common typos fixed. Words it does not know are left alone; the **Undo** on the toast restores your text and remembers those words.
- **Keyboard:** arrows move between cards, Shift+Left/Right moves a card to the next status, X selects, F flags, N new, / search. Ctrl/Shift-click selects several; the bar moves them together. **Undo** after every status change. Saved filter presets sit above the board.
- **Tray + hotkey (desktop app):** closing the window keeps WorkDesk in the tray; **Ctrl+Alt+N** opens quick add from anywhere; the tray menu can start it with Windows.

## Phase 3: Claude connection

`.mcp.json` registers the `workdesk` MCP server when Claude Code runs in this folder. To use it from any folder:

```
claude mcp add --scope user workdesk -- node <path-to-workdesk>/mcp/server.js
```

and copy `.claude/commands/task.md` to `~/.claude/commands/task.md`.

Tools: `list_tasks`, `get_task`, `create_task`, `update_task`, `add_note`, `check_item`, `delete_task`.
`/task ABC-2481` loads the task, follows the workspace's own CLAUDE.md or AGENTS.md if there is one, sets it in-progress, ticks the checklist and writes notes as it goes. The web UI updates live. The drawer's "Work on this with Claude" button copies that command.

To pull Jira stories through Claude instead of the REST import, ask it to read the epic with the Atlassian connector and call `create_task` for each story.

## Desktop app (Tauri)

`desktop/` wraps the same server in a native window (Rust + Edge WebView2, small exe) with a tray icon, the Ctrl+Alt+N quick-add window and start-with-Windows. It starts `node server.js` (or the bundled `node
ode.exe` in the shared folder), and stops it when you choose Quit. If `npm start` is already running it reuses that server.

```
cd desktop
npm install
npm run dev        # run in a window
npm run build      # desktop/src-tauri/target/release/workdesk.exe + bundle/nsis/*-setup.exe
```

Requires Rust (rustup) and Visual Studio C++ build tools. Tasks and MCP are unchanged: same Markdown files.

## Share it

```
cd desktop && npm run build && cd ..
node scripts/package.js              # dist/WorkDesk-<version>/ and .zip, with node.exe bundled
node scripts/package.js --no-node    # smaller; receiver needs Node 20+
```

The folder has `WorkDesk.exe` in its root, `.env.example`, `tasks/`, `app/` (program files), `node/` and a short `README.txt`. Your data (`tasks/`, `.env`) is kept apart from the program files so updating is a swap.

**Settings page:** every `.env` option (Jira connection, JQL, write-back, automatic sync times and days, update source, repos folder) can be edited under Settings and applies at once, no restart. Secrets are write-only: the page never shows a saved token. The **Refresh** button (or `R`) reloads tasks and, when Jira is set up, syncs it.

**Updating from inside the app:** releases are published to GitHub (`workdesk.updateRepo` in `package.json`). A public repo needs no sign-in: copies read each release's `latest.json` through plain download links, which the GitHub API rate limit does not apply to; a private repo works too, through the API with a token. To ship a version: bump the version, build, `node scripts/package.js`, then `node scripts/publish.js` (needs the `gh` CLI signed in; creates the repo the first time). Every installed copy checks at start, shows an "Update now" banner, and installs in one click (Settings > Updates has the same button). Private repo: the machine needs `gh auth login` or a GitHub token in Settings. WorkDesk closes, installs, and reopens itself; tasks and settings are kept. "Update source (advanced)" can point at another repo, a shared folder, or a `latest.json` link instead.

**No-exe edition (for PCs that block unsigned exes):** every release also ships `WorkDesk-web-x.y.z.zip` (about 0.1 MB): the same app with `Start WorkDesk.cmd` instead of the exe. It runs on the Node.js already installed (20+), opens in the browser at http://127.0.0.1:4321/, and Edge's "Install this site as an app" gives it its own window. It updates itself like the exe: "Update now" installs `WorkDesk-web-<latest>.zip` in place, the server exits with code 75, and `Start WorkDesk.cmd` starts the new version in the same window; the page reloads. Build only this one with `node scripts/package.js --web-only`.

**Updating a shared copy by hand:** quit WorkDesk, drag the new `WorkDesk-x.y.z.zip` onto `Update WorkDesk.cmd`. It replaces `app/`, `node/` and the exe, keeps `tasks/` and `.env`, and saves the old version under `backup/`. Task data upgrades itself on first start (`lib/migrate.js`; a copy of the tasks is kept in `tasks.backup-v*`). Adding a migration for a future release means adding one step to that file.

## License

MIT, see [LICENSE](LICENSE).
