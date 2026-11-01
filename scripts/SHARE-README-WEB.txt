WorkDesk (no-exe edition)
=========================
A local task board: epics, stories, tech tasks, reviews, follow-ups. One Markdown file per task.
This edition has no .exe: it runs on the Node.js already on your PC and opens in your browser.

Needs
  Node.js 20 or newer (check: open a terminal and type  node -v). Get it from https://nodejs.org (LTS).

Start
  1. Unzip this folder somewhere permanent, for example Documents\WorkDesk.
  2. Double-click "Start WorkDesk.cmd". WorkDesk opens in your browser at http://127.0.0.1:4321/
     A small window stays open: minimise it. Closing it stops WorkDesk.
  3. Make it feel like an app (optional): in Edge open the menu (...) > Apps > "Install this site as an app".
     You get its own window, a Start menu entry and a taskbar icon. In Chrome: menu > Cast, save and share > Install page as app.
  4. Optional: Settings > Jira to connect your Jira.

Updates
  WorkDesk checks for new versions by itself and shows a banner. Press "Update now":
  it installs the new version, restarts in the same window and reloads the page. Your tasks and settings are kept.
  Releases come from https://github.com/ElhaiANice/workdesk-releases (public: no GitHub account or sign-in needed).

Folder
  Start WorkDesk.cmd    starts WorkDesk
  tasks/                your tasks (plain .md files; back this up)
  .env                  your settings (created by the Settings page)
  app/                  the program files (replaced on update; the previous one is kept in backup/)

Use from Claude (optional)
  MCP server: node app\mcp\server.js   (set WORKDESK_TASKS to the full path of the tasks folder)
