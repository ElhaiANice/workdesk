WorkDesk
========
A local task board: epics, stories, tech tasks, reviews, follow-ups. One Markdown file per task.

Start
  1. Double-click WorkDesk.exe.  It lives in the tray (bottom-right). Closing the window keeps it running;
     right-click the tray icon to Quit or to turn on "Start with Windows".
  2. Quick add from anywhere: Ctrl+Alt+N.
  3. Optional: copy .env.example to .env and add your Jira details (see comments inside), then restart.

Folder
  WorkDesk.exe          the app
  .env.example          settings template -> copy to .env
  tasks/                your tasks (plain .md files; back this up)
  app/                  the program files (replaced on update)
  node/                 bundled Node.js runtime (if present)

Update to a new version
  Quit WorkDesk (tray -> Quit), then drag the new WorkDesk-x.y.z.zip onto "Update WorkDesk.cmd".
  It replaces app/, node/ and the exe, keeps tasks/ and .env, and saves the old version in backup/.
  Task data is upgraded automatically on first start; a copy is kept in tasks.backup-v*.

Use from Claude (optional)
  The MCP server is: node\node.exe app\mcp\server.js   (set WORKDESK_TASKS to the tasks folder path)
