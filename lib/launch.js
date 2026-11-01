'use strict';
// Open the Claude desktop app on a task: a new Code session in the task's folder with `/task <key>` prefilled.
// Working directory is the task's first repo (when it exists under the repositories root), else the root.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const tasks = require('./tasks');

const ROOT = path.resolve(process.env.WORKDESK_REPOS || path.join(__dirname, '..', '..'));
const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });

function workDir(task) {
  for (const r of task.repos || []) {
    const p = path.resolve(ROOT, r);
    if ((p === ROOT || p.startsWith(ROOT + path.sep)) && /^[\w .:\\/()-]+$/.test(p) && fs.existsSync(p)) return p;
  }
  return ROOT;
}

function launch(id) {
  const t = tasks.read(id);
  const ref = /^[A-Za-z][A-Za-z0-9]+-\d+$/.test(t.jira || '') ? t.jira : t.id;
  if (!/^[A-Za-z0-9._-]+$/.test(ref)) throw fail('Task has no safe reference to pass to Claude.');
  const cwd = workDir(t);
  // Open a new Code session in the Claude desktop app (claude:// deep link): folder + prefilled prompt.
  const link = 'claude://code/new?q=' + encodeURIComponent('/task ' + ref) + '&folder=' + encodeURIComponent(cwd);
  if (process.platform !== 'win32') throw fail(`Opening the Claude desktop app from here is only set up for Windows. Run: claude "/task ${ref}"`, 501);
  openUrl(link);
  return { ok: true, ref, cwd, link };
}

// Hand a URL to Windows: it picks the default browser for http(s) and the registered app for claude://.
// (The desktop window cannot open target=_blank links itself, so the UI asks the server to.)
function openUrl(url) {
  if (!/^(https?|claude):\/\//i.test(url) || /[\s"<>^|]/.test(url.replace(/%20/g, ''))) throw fail('Only http(s) links can be opened.');
  if (process.platform !== 'win32') throw fail('Opening links from here is only set up for Windows.', 501);
  const child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => {});
  child.unref();
}

module.exports = { launch, openUrl, ROOT };
