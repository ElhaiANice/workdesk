'use strict';
// Jira import/sync (read) plus status write-back: moving a task in WorkDesk moves the ticket (set JIRA_PUSH=off to disable).
//
// Config (env or workdesk/.env):
//   JIRA_BASE_URL  e.g. https://yourcompany.atlassian.net   (or an on-prem base URL)
//   JIRA_EMAIL + JIRA_TOKEN   Jira Cloud: account email + API token
//   JIRA_PAT                  Jira Server/Data Center: personal access token (Bearer)
//   JIRA_JQL                  optional: overrides which tickets "sync my tickets" pulls
//   JIRA_PUSH                 "off" stops WorkDesk from changing ticket statuses in Jira
const tasks = require('./tasks');

const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });
const DEFAULT_JQL = 'assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC';
const FIELDS = 'summary,status,issuetype,assignee,reporter,parent,description,labels,updated';

function config() {
  const base = (process.env.JIRA_BASE_URL || '').replace(/\/+$/, '');
  if (!base) throw fail('Jira is not configured. Set JIRA_BASE_URL and either JIRA_PAT or JIRA_EMAIL + JIRA_TOKEN in workdesk/.env (see .env.example).');
  let auth;
  if (process.env.JIRA_PAT) auth = 'Bearer ' + process.env.JIRA_PAT;
  else if (process.env.JIRA_EMAIL && process.env.JIRA_TOKEN) auth = 'Basic ' + Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_TOKEN}`).toString('base64');
  else throw fail('Jira credentials missing. Set JIRA_PAT, or JIRA_EMAIL and JIRA_TOKEN, in workdesk/.env.');
  return { base, auth };
}

async function api(cfg, pathname, body, method = 'POST') {
  let res;
  const init = { headers: { Authorization: cfg.auth, Accept: 'application/json' } };
  if (body) { init.method = method; init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
  try { res = await fetch(cfg.base + pathname, init); }
  catch (e) { throw fail(`Cannot reach Jira at ${cfg.base}: ${e.cause?.code || e.message}`, 502); }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const hint = res.status === 401 || res.status === 403 ? ' Check your Jira credentials.' : '';
    let body; try { body = JSON.parse(text); } catch { /* not JSON */ }
    throw Object.assign(new Error(`Jira ${res.status} on ${pathname.split('?')[0]}.${hint} ${text.slice(0, 160)}`.trim()), { status: res.status === 401 || res.status === 403 ? 502 : res.status, body });
  }
  return res.status === 204 ? {} : res.json();
}

// Paged search. Tries the classic /rest/api/2/search, falls back to Cloud's /rest/api/3/search/jql.
async function search(cfg, jql) {
  const out = [], enc = encodeURIComponent(jql);
  let modern = false, startAt = 0, token = '';
  for (let page = 0; page < 10; page++) {
    if (!modern) {
      try {
        const data = await api(cfg, `/rest/api/2/search?jql=${enc}&fields=${FIELDS}&maxResults=100&startAt=${startAt}`);
        const issues = data.issues || [];
        out.push(...issues); startAt += issues.length;
        if (!issues.length || startAt >= (data.total || 0)) break;
        continue;
      } catch (e) {
        if ((e.status !== 404 && e.status !== 410) || page > 0) throw e;
        modern = true;
      }
    }
    const data = await api(cfg, `/rest/api/3/search/jql?jql=${enc}&fields=${FIELDS}&maxResults=100${token ? '&nextPageToken=' + encodeURIComponent(token) : ''}`);
    out.push(...(data.issues || []));
    if (data.isLast || !data.nextPageToken) break;
    token = data.nextPageToken;
  }
  return out;
}

const typeOf = (issue) => {
  const t = (issue.fields.issuetype?.name || '').toLowerCase();
  if (t === 'epic') return 'epic';
  if (/bug|defect/.test(t)) return 'bug';
  return /task|sub-task|subtask|technical/.test(t) ? 'tech' : 'story';
};
const statusOf = (issue) => {
  const name = (issue.fields.status?.name || '').toLowerCase();
  if (/validation|verif|review|testing|qa|uat/.test(name)) return 'review';
  if (/block|wait|on hold|pending/.test(name)) return 'waiting';
  return { new: 'todo', indeterminate: 'in-progress', done: 'done' }[issue.fields.status?.statusCategory?.key] || 'todo';
};
const epicOf = (issue) => (issue.fields.parent?.fields?.issuetype?.name || '').toLowerCase() === 'epic' ? issue.fields.parent.key : '';

// Jira descriptions are plain/wiki text on v2 and Atlassian Document Format (a JSON tree) on v3.
function adfText(n) {
  if (!n) return '';
  if (typeof n === 'string') return n;
  if (n.type === 'text') return n.text || '';
  if (n.type === 'hardBreak') return '\n';
  const inner = (n.content || []).map(adfText).join('');
  if (n.type === 'listItem') return '- ' + inner.trim() + '\n';
  if (['paragraph', 'heading', 'codeBlock', 'blockquote'].includes(n.type)) return inner + '\n\n';
  return inner;
}

const issueUrl = (cfg, issue) => cfg.base + '/browse/' + issue.key;

// The machine-managed "from Jira" block at the top of a task body.
function jiraBlock(cfg, issue) {
  const f = issue.fields;
  const desc = adfText(f.description).replace(/\n{3,}/g, '\n\n').trim();
  const meta = [f.issuetype?.name, f.status?.name && 'Jira status: ' + f.status.name, f.reporter?.displayName && 'Reporter: ' + f.reporter.displayName, f.assignee?.displayName && 'Assignee: ' + f.assignee.displayName, f.updated && 'Updated: ' + String(f.updated).slice(0, 10)].filter(Boolean).join(' · ');
  return '[' + issue.key + '](' + issueUrl(cfg, issue) + ') · ' + meta + '\n\n### Description\n' + (desc || '_No description in Jira._');
}

function jiraFields(cfg, issue, ctx = {}) {
  const f = issue.fields, epic = ctx.epic || epicOf(issue) || (typeOf(issue) === 'epic' ? issue.key : '');
  return {
    url: issueUrl(cfg, issue), jira_status: f.status?.name || '', reporter: f.reporter?.displayName || '',
    epic, epic_title: epic === issue.key ? '' : (f.parent?.fields?.summary && epicOf(issue) === epic ? f.parent.fields.summary : ctx.epicTitle || ''),
  };
}

// Create tasks for new issues; refresh the Jira details of ones already imported.
// Local-only states (waiting, review) and your own notes are kept.
function upsert(cfg, issues, result, ctx = {}) {
  result.items ||= [];
  const byKey = new Map(tasks.list().filter((t) => t.jira).map((t) => [t.jira.toUpperCase(), t]));
  for (const issue of issues) {
    const key = issue.key.toUpperCase(), jStatus = statusOf(issue), cur = byKey.get(key);
    const jf = jiraFields(cfg, issue, ctx), block = jiraBlock(cfg, issue);
    if (!cur) {
      const t = tasks.create({
        type: typeOf(issue), title: issue.fields.summary, status: jStatus, jira: issue.key, ...jf,
        epic_owner: typeOf(issue) === 'epic' ? '' : ctx.owner || '', tags: issue.fields.labels || [], body: tasks.withJiraBlock('', block),
      });
      byKey.set(key, t); result.created++;
      result.items.push({ key: issue.key, title: issue.fields.summary, type: t.type, action: 'created' });
      continue;
    }
    const patch = {};
    if (issue.fields.summary && cur.title !== issue.fields.summary) patch.title = issue.fields.summary;
    for (const [k, v] of Object.entries(jf)) if (v && cur[k] !== v) patch[k] = v;
    const body = tasks.withJiraBlock(cur.body, block);
    if (body !== cur.body) patch.body = body;
    // Follow Jira when its status changed since the last sync; otherwise keep local states (waiting, review).
    const moved = (issue.fields.status?.name || '') !== (cur.jira_status || '');
    if (jStatus === 'done' && cur.status !== 'done') patch.status = 'done';
    else if (jStatus !== 'done' && cur.status === 'done') patch.status = jStatus;
    else if (moved && jStatus !== cur.status && cur.status !== 'done') patch.status = jStatus;
    if (patch.status === 'waiting' && !cur.who) patch.status = 'todo';
    if (Object.keys(patch).length) {
      tasks.update(cur.id, patch); result.updated++;
      result.items.push({ key: issue.key, title: patch.title || cur.title, type: cur.type, action: 'updated' });
    } else result.unchanged++;
  }
}

// Import by key(s) or pasted browse URL(s), comma/space separated. An epic key also pulls its stories.
async function importKeys(input) {
  const keys = [...new Set(String(input || '').toUpperCase().match(/\b[A-Z][A-Z0-9]+-\d+\b/g) || [])];
  if (!keys.length) throw fail('Enter a ticket key like ABC-2481 (or paste its Jira link).');
  if (keys.length > 20) throw fail('Import up to 20 tickets at a time.');
  const cfg = config();
  const result = { keys, created: 0, updated: 0, unchanged: 0, items: [] };
  for (const key of keys) {
    const issue = await api(cfg, `/rest/api/2/issue/${key}?fields=${FIELDS}`).catch((e) => { throw e.status === 404 ? fail(`${key} was not found in Jira, or you don't have access to it.`, 404) : e; });
    if (typeOf(issue) !== 'epic') { upsert(cfg, [issue], result); continue; }
    let children = await search(cfg, `parent = ${key} ORDER BY key`).catch(() => []);
    if (!children.length) children = await search(cfg, `"Epic Link" = ${key} ORDER BY key`).catch(() => []);
    upsert(cfg, [issue], result, { epic: key });
    upsert(cfg, children, result, { epic: key, epicTitle: issue.fields.summary, owner: issue.fields.assignee?.displayName || '' });
  }
  return result;
}

// ---------- write-back: local status -> Jira transition ----------
const PUSH_OFF = () => /^(0|off|false|no)$/i.test(process.env.JIRA_PUSH || '');
// Which of Jira's available transitions best matches a local status (by target status name, then by category).
const WANT = {
  inbox: { cat: 'new', name: /to ?do|open|backlog|selected|new/i },
  todo: { cat: 'new', name: /to ?do|open|backlog|selected|new/i },
  'in-progress': { cat: 'indeterminate', name: /progress|develop|doing|implement/i, not: /review|validation|verif|test|qa|uat|block|wait|hold|pending/i },
  review: { name: /review|validation|verif|testing|qa|uat/i },
  waiting: { name: /block|wait|hold|pending/i },
  done: { cat: 'done', name: /done|closed|resolved|complete/i },
};
function pickTransition(list, status) {
  const w = WANT[status]; if (!w) return null;
  const to = (t) => t.to?.name || t.name || '';
  const byName = list.find((t) => w.name.test(to(t)) && !(w.not && w.not.test(to(t))));
  if (byName) return byName;
  return w.cat ? list.find((t) => t.to?.statusCategory?.key === w.cat && !(w.not && w.not.test(to(t)))) : null;
}
// Required transition screen fields we can fill ourselves (resolution); anything else needs a human in Jira.
// What a field looks like to the UI form: a pick list (one or many), a number, a date, or free text.
function describe(id, f = {}, why = '') {
  const t = f.schema?.type || 'string', multi = t === 'array';
  const options = (f.allowedValues || []).map((v) => ({ id: String(v.id ?? v.name ?? v.value), label: v.name || v.value || v.key || String(v.id) }));
  const kind = options.length ? (multi ? 'multi' : 'pick') : t === 'number' ? 'number' : t === 'date' ? 'date' : t === 'datetime' ? 'datetime' : t === 'user' ? 'user' : multi ? 'list' : 'text';
  return { id, name: f.name || id, kind, options, why };
}
// Turn the values typed in the UI into what Jira's transition API expects for that field.
function encode(d, v) {
  if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) return undefined;
  const ids = [].concat(v).map(String);
  if (d.kind === 'pick') return { id: ids[0] };
  if (d.kind === 'multi') return ids.map((id) => ({ id }));
  if (d.kind === 'number') return Number(v);
  if (d.kind === 'datetime') return String(v).length === 16 ? `${v}:00.000+0000` : String(v);
  if (d.kind === 'user') return process.env.JIRA_PAT ? { name: String(v).trim() } : { accountId: String(v).trim() };
  if (d.kind === 'list') return String(v).split(',').map((x) => x.trim()).filter(Boolean);
  return String(v);
}
// Required transition fields: resolution is chosen automatically, values the user gave are encoded, the rest is returned as missing.
function fillRequired(tr, given = {}) {
  const fields = {}, missing = [];
  for (const [id, f] of Object.entries(tr.fields || {})) {
    const d = describe(id, f), v = encode(d, given[id]);
    if (v !== undefined) { fields[id] = v; continue; } // anything the user filled goes with the move, required on the step or not
    if (!f.required || f.hasDefaultValue) continue;
    if (id === 'resolution' && f.allowedValues?.length) { const r = f.allowedValues.find((x) => /^done|fixed|complete/i.test(x.name)) || f.allowedValues[0]; fields.resolution = { name: r.name }; }
    else missing.push(d);
  }
  return { fields, missing };
}

// A workflow validator names the fields it wants only in prose ("Field Cost category is required."), sometimes keyed by field id.
// Look those fields up on the ticket's edit screen so the UI can offer their real choices. They are set on the ticket, not the transition.
async function validatorNeeds(cfg, key, tr, body = {}) {
  const named = [];
  for (const [id, msg] of Object.entries(body.errors || {})) named.push({ id, msg });
  for (const msg of body.errorMessages || []) { const m = /^(?:field\s+)?["']?(.+?)["']? (?:is|are) required/i.exec(msg.trim()); if (m) named.push({ name: m[1], msg }); }
  if (!named.length) return [];
  const meta = (await api(cfg, `/rest/api/2/issue/${key}/editmeta`).catch(() => ({}))).fields || {};
  return named.map(({ id, name, msg }) => {
    const hit = id ? [id, meta[id] || tr.fields?.[id]] : Object.entries(meta).find(([, f]) => (f.name || '').toLowerCase() === name.toLowerCase()) || [];
    return { ...describe(hit[0] || id || name, hit[1] || { name: name || id }, msg), onTicket: !tr.fields?.[hit[0] || id] };
  });
}
// Values the user filled are also saved on the ticket first (a plain edit), then the transition runs: a validator may check the
// ticket's stored value even when the field is on the step's screen too. Fields the ticket cannot edit go with the transition only.
async function setOnTicket(cfg, key, tr, given) {
  const filled = Object.keys(given).filter((id) => encode({ kind: 'text' }, given[id]) !== undefined);
  if (!filled.length) return;
  const meta = (await api(cfg, `/rest/api/2/issue/${key}/editmeta`).catch(() => ({}))).fields || {};
  const ids = filled.filter((id) => meta[id] || !tr.fields?.[id]);
  if (!ids.length) return;
  const fields = {};
  for (const id of ids) fields[id] = encode(describe(id, meta[id]), given[id]);
  await api(cfg, `/rest/api/2/issue/${key}`, { fields }, 'PUT');
}

// Move the Jira ticket to match a local status. `given` holds field values the user filled in after a refusal.
// A refusal for missing fields comes back as { ok: false, needs: { key, transition, fields: [...] } } so the UI can ask for them.
async function pushStatus(task, status, given = {}) {
  const key = (task.jira || '').toUpperCase();
  if (PUSH_OFF() || !/^[A-Z][A-Z0-9]+-\d+$/.test(key) || !WANT[status]) return null;
  let cfg; try { cfg = config(); } catch { return null; }
  const link = cfg.base + '/browse/' + key;
  try {
    const issue = await api(cfg, `/rest/api/2/issue/${key}?fields=status`);
    if (statusOf(issue) === status) return { ok: true, unchanged: true, link };
    const { transitions = [] } = await api(cfg, `/rest/api/2/issue/${key}/transitions?expand=transitions.fields`);
    const tr = pickTransition(transitions, status);
    if (!tr) return { ok: false, link, error: `${key} stays "${issue.fields.status?.name}" in Jira: its workflow has no step to "${status}" from here.` };
    const { fields, missing } = fillRequired(tr, given);
    const needs = (list, why) => ({ ok: false, link, error: `Jira needs ${list.map((f) => f.name).join(', ')} to move ${key} to "${tr.to?.name || tr.name}".`, needs: { key, transition: tr.name || tr.to?.name, fields: list, why } });
    if (missing.length) return needs(missing);
    try {
      await setOnTicket(cfg, key, tr, given);
      await api(cfg, `/rest/api/2/issue/${key}/transitions`, { transition: { id: tr.id }, ...(Object.keys(fields).length ? { fields } : {}) });
    } catch (e) {
      // A workflow validator can still refuse; when Jira names the fields, ask for those too.
      const asked = e.status === 400 ? await validatorNeeds(cfg, key, tr, e.body) : [];
      if (asked.length) return needs(asked);
      throw e;
    }
    const to = tr.to?.name || tr.name;
    tasks.update(task.id, { jira_status: to });
    return { ok: true, to, link };
  } catch (e) { return { ok: false, link, error: `Jira did not accept the move: ${e.message}` }; }
}

function status() {
  const base = (process.env.JIRA_BASE_URL || '').replace(/\/+$/, '');
  const auth = process.env.JIRA_PAT ? 'personal access token' : (process.env.JIRA_EMAIL && process.env.JIRA_TOKEN ? 'email + API token' : '');
  return { configured: !!(base && auth), base, auth, jql: process.env.JIRA_JQL || DEFAULT_JQL, push: !PUSH_OFF() };
}

async function test() {
  const cfg = config();
  const me = await api(cfg, '/rest/api/2/myself');
  return { ok: true, user: me.displayName || me.name || me.emailAddress || 'unknown' };
}

async function syncMine() {
  const cfg = config();
  const jql = process.env.JIRA_JQL || DEFAULT_JQL;
  const issues = await search(cfg, jql);
  const result = { jql, found: issues.length, created: 0, updated: 0, unchanged: 0 };
  upsert(cfg, issues, result);
  // A ticket that leaves the query (resolved, removed, reassigned) is never returned by it again, so its task would keep its old
  // status forever. Look up the tasks that are still open here but were not in the results, and bring those up to date too.
  const seen = new Set(issues.map((i) => i.key.toUpperCase()));
  const stale = [...new Set(tasks.list().filter((t) => t.status !== 'done' && /^[A-Z][A-Z0-9]+-\d+$/i.test(t.jira || '') && !seen.has(t.jira.toUpperCase())).map((t) => t.jira.toUpperCase()))];
  const extra = { created: 0, updated: 0, unchanged: 0 };
  for (let k = 0; k < stale.length; k += 50) {
    const batch = stale.slice(k, k + 50);
    const found = await search(cfg, `key in (${batch.join(',')})`).catch(() => []); // a deleted or hidden key fails the batch; skip it
    upsert(cfg, found.filter((i) => batch.includes(i.key.toUpperCase())), extra);
  }
  result.refreshed = extra.updated;
  result.items.push(...(extra.items || [])); // so the sync summary lists them too
  return result;
}

module.exports = { pushStatus, pickTransition, importKeys, syncMine, status, test, config, adfText, jiraBlock };
