'use strict';
// Task storage: one Markdown file per task, YAML-style front-matter + free-form body.
// Zero dependencies. Shared by the web server and the MCP server.
const fs = require('fs');
const path = require('path');
const { classify, RULES } = require('./classify');

const DIR = path.resolve(process.env.WORKDESK_TASKS || path.join(__dirname, '..', 'tasks'));
const TYPES = ['epic', 'story', 'tech', 'bug', 'review', 'security', 'incident', 'research', 'docs', 'planning', 'follow-up', 'meeting'];
const STATUSES = ['inbox', 'todo', 'in-progress', 'waiting', 'review', 'done'];
const FIELDS = ['type', 'title', 'status', 'jira', 'url', 'jira_status', 'epic', 'epic_title', 'epic_owner', 'reporter', 'repos', 'who', 'pr', 'env', 'pr_state', 'pr_review', 'important', 'archived', 'tags', 'order', 'created', 'done'];
// Editable fields shown per task type (everything else stays in the file but is hidden in the UI).
const TYPE_FIELDS = {
  epic: ['jira', 'url', 'jira_status', 'repos'],
  story: ['jira', 'url', 'jira_status', 'epic', 'epic_owner', 'reporter', 'repos', 'pr'],
  tech: ['jira', 'url', 'repos', 'env'],
  bug: ['jira', 'url', 'jira_status', 'epic', 'repos', 'pr', 'env'],
  review: ['pr', 'who', 'repos', 'jira', 'url'],
  security: ['jira', 'url', 'repos', 'pr'],
  incident: ['jira', 'url', 'who', 'env', 'repos'],
  research: ['jira', 'url', 'who', 'repos'],
  docs: ['jira', 'url', 'repos', 'pr'],
  planning: ['jira', 'url', 'who', 'epic'],
  'follow-up': ['who'],
  meeting: ['who'],
};
const ARRAYS = ['repos', 'tags'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });
const pad = (n) => String(n).padStart(2, '0');
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

function unquote(v) {
  v = v.trim();
  if (/^".*"$/.test(v)) { try { return JSON.parse(v); } catch { /* fall through */ } }
  if (/^'.*'$/.test(v)) return v.slice(1, -1);
  return v;
}

function parseFile(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { data: {}, body: text };
  const data = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i < 1 || line.startsWith('#')) continue;
    const key = line.slice(0, i).trim();
    const raw = line.slice(i + 1).trim();
    if (raw.startsWith('[') && raw.endsWith(']')) {
      data[key] = (raw.slice(1, -1).match(/"(?:[^"\\]|\\.)*"|[^,]+/g) || []).map(unquote).filter(Boolean);
    } else {
      data[key] = unquote(raw);
    }
  }
  return { data, body: m[2] };
}

function fmtScalar(s) {
  s = String(s);
  return /^[\w./@#()+ -]+$/.test(s) && s === s.trim() ? s : JSON.stringify(s);
}

function dumpFile(data, body) {
  const keys = [...FIELDS, ...Object.keys(data).filter((k) => !FIELDS.includes(k))];
  const lines = [];
  for (const k of keys) {
    const v = data[k];
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) continue;
    lines.push(`${k}: ${Array.isArray(v) ? '[' + v.map(fmtScalar).join(', ') + ']' : fmtScalar(v)}`);
  }
  return `---\n${lines.join('\n')}\n---\n${body ? body.replace(/^\r?\n/, '') : ''}`;
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

function fileFor(id) {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id || '')) throw fail('Invalid task id');
  return path.join(DIR, id + '.md');
}

function validate(d) {
  if (d.type !== undefined && !TYPES.includes(d.type)) throw fail(`type must be one of: ${TYPES.join(', ')}`);
  if (d.status !== undefined && !STATUSES.includes(d.status)) throw fail(`status must be one of: ${STATUSES.join(', ')}`);
  for (const k of ['created', 'done']) {
    if (d[k] && !DATE_RE.test(d[k])) throw fail(`${k} must be YYYY-MM-DD`);
  }
  if (d.title !== undefined && !String(d.title).trim()) throw fail('title is required');
}

function clean(patch) {
  const out = {};
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'id' || k === 'due' || k === 'followup') continue; // dates were dropped from the model
    if (k === 'body') { out.body = String(v); continue; }
    if (k === 'order') { const n = Number(v); out.order = v === null || v === '' || !Number.isFinite(n) ? '' : String(Math.round(n * 1e6) / 1e6); continue; }
    if (k === 'archived') { out.archived = v === true || /^(true|yes|1)$/i.test(String(v)) ? 'true' : ''; continue; }
    if (k === 'important') { out.important = v === true || /^(true|yes|1)$/i.test(String(v)) ? 'true' : ''; continue; }
    if (ARRAYS.includes(k)) out[k] = Array.isArray(v) ? v.map(String).filter(Boolean) : String(v).split(',').map((s) => s.trim()).filter(Boolean);
    else out[k] = v === null ? '' : String(v).trim();
  }
  return out;
}

function read(id) {
  let text;
  try { text = fs.readFileSync(fileFor(id), 'utf8'); } catch (e) { if (e.code === 'ENOENT') throw fail('Task not found: ' + id, 404); throw e; }
  const { data, body } = parseFile(text);
  return { id, ...data, body };
}

function list() {
  fs.mkdirSync(DIR, { recursive: true });
  const out = [];
  for (const f of fs.readdirSync(DIR)) {
    if (!f.endsWith('.md')) continue;
    try { out.push(read(f.slice(0, -3))); } catch { /* skip unreadable file */ }
  }
  return out;
}

function find(idOrJira) {
  try { return read(idOrJira); } catch (e) { if (e.status !== 404 && e.status !== 400) throw e; }
  const key = String(idOrJira).toUpperCase();
  return list().find((t) => (t.jira || '').toUpperCase() === key) || (() => { throw fail('Task not found: ' + idOrJira, 404); })();
}

function create(input) {
  const p = clean(input);
  const data = { type: p.type || classify(p.title), status: 'inbox', ...p, created: today() }; // no type given: choose one from the title
  delete data.body;
  validate(data);
  if (!data.title) throw fail('title is required');
  fs.mkdirSync(DIR, { recursive: true });
  let base = slug([data.jira, data.title].filter(Boolean).join('-')) || 'task';
  let id = base, n = 2;
  while (fs.existsSync(fileFor(id))) id = `${base}-${n++}`;
  if (data.status === 'done') data.done = today();
  // New tasks go to the bottom; the user drags them up. 'order' is only a sort key (lower = higher on the board).
  if (data.order === undefined || data.order === '') data.order = String(list().reduce((m, x) => Math.max(m, Number(x.order) || 0), 0) + 1);
  fs.writeFileSync(fileFor(id), dumpFile(data, p.body || ''), { flag: 'wx' });
  return read(id);
}

function update(id, patch) {
  const cur = read(id);
  const p = clean(patch);
  const { id: _id, body: curBody, ...data } = cur;
  const next = { ...data };
  for (const [k, v] of Object.entries(p)) { if (k === 'body') continue; if (v === '' || (Array.isArray(v) && !v.length)) delete next[k]; else next[k] = v; }
  validate(next);
  // Becoming done puts the task at the top of the Done column (unless the caller sets an order).
  if (next.status === 'done' && cur.status !== 'done' && p.order === undefined) next.order = String(list().reduce((m, y) => Math.min(m, Number(y.order) || 0), 0) - 1);
  if (next.status === 'done' && !next.done) next.done = today();
  if (next.status && next.status !== 'done') delete next.done;
  fs.writeFileSync(fileFor(id), dumpFile(next, p.body !== undefined ? p.body : curBody));
  return read(id);
}

function remove(id) {
  read(id);
  fs.unlinkSync(fileFor(id));
}

// Toggle the n-th "- [ ]" checklist line (0-based) in a task body.
function setCheck(id, index, checked) {
  const t = read(id);
  let n = -1;
  const body = t.body.replace(/^(\s*- \[)([ xX])(\] .*)$/gm, (all, a, _c, b) => (++n === index ? a + (checked ? 'x' : ' ') + b : all));
  if (index > n || index < 0) throw fail('No checklist item at index ' + index);
  return update(id, { body });
}

// A task body can start with a machine-managed block holding the Jira details (description, links).
// Jira sync rewrites only that block; everything after it is the user's own notes.
const BLOCK_RE = /<!-- jira -->[\s\S]*?<!-- \/jira -->\r?\n?/;
function splitBody(body = '') {
  const m = BLOCK_RE.exec(body);
  if (!m) return { jira: '', notes: body };
  return { jira: m[0].replace(/<!-- \/?jira -->\r?\n?/g, '').trim(), notes: (body.slice(0, m.index) + body.slice(m.index + m[0].length)).replace(/^\s+/, '') };
}
function withJiraBlock(body, text) {
  const { notes } = splitBody(body);
  return (text && text.trim() ? `<!-- jira -->\n${text.trim()}\n<!-- /jira -->\n\n` : '') + notes;
}

module.exports = { RULES, classify, DIR, TYPES, STATUSES, TYPE_FIELDS, today, list, read, find, create, update, remove, setCheck, parseFile, dumpFile, splitBody, withJiraBlock };
