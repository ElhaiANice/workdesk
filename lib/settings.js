'use strict';
// Settings editor: reads and writes the same .env file the app loads at start, and applies changes live
// (every module reads process.env when it needs a value, so no restart is needed).
// Secrets are never sent to the browser: the form only learns whether one is set.
const fs = require('fs');
const path = require('path');

const FILE = () => process.env.WORKDESK_ENV || path.join(__dirname, '..', '.env');
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// kind: text | secret | switch (stored as "off" when disabled, removed when enabled) ; check validates a non-empty value
const SCHEMA = [
  { key: 'JIRA_BASE_URL', group: 'Jira connection', kind: 'text', label: 'Jira URL', help: 'For example https://yourcompany.atlassian.net', check: (v) => /^https?:\/\/\S+$/i.test(v) || 'Must start with http:// or https://' },
  { key: 'JIRA_EMAIL', group: 'Jira connection', kind: 'text', label: 'Account email', help: 'Jira Cloud: the email you sign in with.' },
  { key: 'JIRA_TOKEN', group: 'Jira connection', kind: 'secret', label: 'API token', help: 'Jira Cloud: create one at id.atlassian.com, Security, API tokens.' },
  { key: 'JIRA_PAT', group: 'Jira connection', kind: 'secret', label: 'Personal access token', help: 'Jira Server / Data Center: use this instead of email + API token.' },
  { key: 'JIRA_JQL', group: 'Jira sync', kind: 'text', label: 'Tickets to sync (JQL)', help: 'Empty = assigned to you and unresolved.' },
  { key: 'JIRA_PUSH', group: 'Jira sync', kind: 'switch', label: 'Move the Jira ticket when I move a task', help: 'Only the status is written back to Jira.' },
  { key: 'WORKDESK_SYNC', group: 'Automatic sync', kind: 'switch', label: 'Sync Jira automatically', help: 'Runs at the times below on the chosen days. A missed slot runs once when the app next opens.' },
  { key: 'WORKDESK_SYNC_TIMES', group: 'Automatic sync', kind: 'text', label: 'Times', help: 'Comma-separated 24h times. Default 09:00,13:00,17:00', check: (v) => v.split(',').every((s) => { const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(s); return m && +m[1] < 24 && +m[2] < 60; }) || 'Use HH:MM times separated by commas, e.g. 09:00,13:00' },
  { key: 'WORKDESK_SYNC_DAYS', group: 'Automatic sync', kind: 'days', label: 'Work days', help: 'Default Sunday to Thursday.', check: (v) => v.split(',').every((s) => DAYS.includes(s.trim().toLowerCase().slice(0, 3))) || 'Use day names like sun,mon,tue' },
  { key: 'WORKDESK_UPDATE_SOURCE', group: 'Updates', kind: 'text', label: 'Update source (advanced)', help: 'Leave empty to use the built-in GitHub releases. Or: owner/repo, a shared folder, or a link to latest.json.', check: (v) => /^https?:\/\/\S+$/i.test(v) || /^[\w.-]+\/[\w.-]+$/.test(v) || fs.existsSync(v) || 'Not a repo (owner/name), link, or existing folder' },
  { key: 'WORKDESK_GITHUB_TOKEN', group: 'Updates', kind: 'secret', label: 'GitHub token (private repos only)', help: 'Not needed if the GitHub CLI is signed in on this machine.' },
  { key: 'WORKDESK_REPOS', group: 'Workspace', kind: 'text', label: 'Workspace folder', help: 'Folder that holds your repositories. "Work on this with Claude" opens the task\'s repo inside it.', check: (v) => fs.existsSync(v) || 'That folder does not exist' },
];
const BY_KEY = Object.fromEntries(SCHEMA.map((s) => [s.key, s]));
const OFF = /^(0|off|false|no)$/i;

function readLines() { try { return fs.readFileSync(FILE(), 'utf8').split(/\r?\n/); } catch { return []; } }
const active = (line, key) => { const m = /^\s*([A-Z0-9_]+)\s*=/i.exec(line); return !line.trim().startsWith('#') && m && m[1] === key; };
const unquote = (v) => v.trim().replace(/^(['"])(.*)\1$/, '$2');

function get() {
  const fromFile = {};
  for (const l of readLines()) { const m = /^\s*([A-Z0-9_]+)\s*=(.*)$/i.exec(l); if (m && !l.trim().startsWith('#')) fromFile[m[1]] = unquote(m[2]); }
  const values = {}, secretSet = {};
  for (const s of SCHEMA) {
    const v = process.env[s.key] ?? fromFile[s.key] ?? '';
    if (s.kind === 'secret') { secretSet[s.key] = !!v; values[s.key] = ''; }
    else if (s.kind === 'switch') values[s.key] = !OFF.test(v);
    else values[s.key] = v;
  }
  return { schema: SCHEMA.map(({ check, ...rest }) => rest), values, secretSet, file: FILE() };
}

// changes: { KEY: value }.  text: '' removes the key.  secret: '' keeps, null removes.  switch: boolean.
function save(changes) {
  const errors = {};
  const next = {};
  for (const [key, raw] of Object.entries(changes || {})) {
    const s = BY_KEY[key]; if (!s) continue;
    if (s.kind === 'switch') { next[key] = raw ? null : 'off'; continue; }
    if (s.kind === 'secret') { if (raw === null) next[key] = null; else if (String(raw).trim()) next[key] = String(raw).trim(); continue; }
    const v = String(raw ?? '').trim().replace(/\s*\r?\n\s*/g, ' ');
    if (!v) { next[key] = null; continue; }
    const ok = s.check ? s.check(v) : true;
    if (ok !== true) { errors[key] = ok; continue; }
    next[key] = s.kind === 'days' ? v.toLowerCase().replace(/\s+/g, '') : v;
  }
  if (Object.keys(errors).length) return { ok: false, errors };

  let lines = readLines();
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  for (const [key, v] of Object.entries(next)) {
    const i = lines.findIndex((l) => active(l, key));
    if (v === null) { if (i >= 0) lines.splice(i, 1); delete process.env[key]; continue; }
    const line = `${key}=${/[#\s]/.test(v) ? JSON.stringify(v) : v}`;
    if (i >= 0) lines[i] = line;
    else {
      // put it right after its commented example if there is one, else at the end
      const c = lines.findIndex((l) => new RegExp(`^\\s*#\\s*${key}\\s*=`).test(l));
      if (c >= 0) lines.splice(c + 1, 0, line); else lines.push(line);
    }
    process.env[key] = v;
  }
  try {
    fs.mkdirSync(path.dirname(FILE()), { recursive: true });
    fs.writeFileSync(FILE(), lines.join('\n') + '\n');
  } catch (e) { return { ok: false, errors: { _: `Could not write ${FILE()}: ${e.message}` } }; }
  return { ok: true, changed: Object.keys(next) };
}

module.exports = { get, save, SCHEMA };
