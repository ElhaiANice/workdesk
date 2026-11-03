'use strict';
require('./lib/env');
const http = require('http');
const fs = require('fs');
const path = require('path');
const tasks = require('./lib/tasks');
const jira = require('./lib/jira');
const launch = require('./lib/launch');
const sched = require('./lib/sched');
const pr = require('./lib/pr');
const migrate = require('./lib/migrate');
const settings = require('./lib/settings');
const updater = require('./lib/updater');
const VERSION = require('./package.json').version;
const hooks = [() => pr.refresh()]; // run after every Jira sync

const PORT = Number(process.env.PORT) || 4321;
const PUBLIC = path.join(__dirname, 'public');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/quick.html': ['quick.html', 'text/html; charset=utf-8'],
  '/logo.svg': ['logo.svg', 'image/svg+xml'],
  '/favicon.svg': ['logo.svg', 'image/svg+xml'],
  // "Install this site as an app" (Edge/Chrome) takes the app's name and icon from the manifest; without it Edge draws a letter tile.
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
  '/icon-192.png': ['icon-192.png', 'image/png'],
  '/icon-512.png': ['icon-512.png', 'image/png'],
};

const clients = new Set();
let timer;
fs.mkdirSync(tasks.DIR, { recursive: true });
let migrated = null;
try { migrated = migrate.migrate(); } catch (e) { console.error('Data migration failed:', e.message); }
fs.watch(tasks.DIR, () => {
  clearTimeout(timer);
  timer = setTimeout(() => clients.forEach((res) => res.write('event: change\ndata: {}\n\n')), 120);
});

const send = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 1e6) { reject(Object.assign(new Error('Body too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); } });
  });
}

async function api(req, res, url) {
  const m = /^\/api\/tasks(?:\/([^/]+))?$/.exec(url.pathname);
  if (url.pathname === '/api/config') return send(res, 200, { version: VERSION, types: tasks.TYPES, statuses: tasks.STATUSES, typeFields: tasks.TYPE_FIELDS, rules: tasks.RULES, today: tasks.today(), dir: tasks.DIR });
  const tm = /^\/api\/tasks\/([^/]+)\/jira-transitions$/.exec(url.pathname);
  if (tm) return send(res, 200, await jira.transitionsFor(tasks.read(tm[1])));
  const gm = /^\/api\/tasks\/([^/]+)\/jira-step$/.exec(url.pathname);
  if (gm && req.method === 'POST') {
    const { transition } = await readBody(req);
    const push = await jira.pushStatus(tasks.read(gm[1]), null, {}, transition);
    if (!push) throw Object.assign(new Error('This task has no Jira ticket to move.'), { status: 400 });
    if (!push.ok) return send(res, 200, { ...tasks.read(gm[1]), _jira: push });
    return send(res, 200, { ...tasks.update(gm[1], { status: push.local }), _jira: push });
  }
  // Retry a move that Jira refused, with the field values the user filled in. Only a successful Jira move changes the local status.
  const jm = /^\/api\/tasks\/([^/]+)\/jira-move$/.exec(url.pathname);
  if (jm && req.method === 'POST') {
    const { status, fields = {} } = await readBody(req);
    if (!tasks.STATUSES.includes(status)) throw Object.assign(new Error('Unknown status'), { status: 400 });
    // Answers from earlier rounds of this move are remembered for ten minutes, so Jira can ask for fields one at a time.
    const mem = (globalThis.__moveAnswers ||= {}), m = mem[jm[1]];
    const given = { ...(m && Date.now() - m.at < 600000 ? m.fields : {}), ...fields };
    const push = await jira.pushStatus(tasks.read(jm[1]), status, given);
    mem[jm[1]] = push && push.ok ? undefined : { at: Date.now(), fields: given };
    if (!push) throw Object.assign(new Error('This task has no Jira ticket to move.'), { status: 400 });
    if (!push.ok) return send(res, 200, { ...tasks.read(jm[1]), _jira: { ...push, to: status } });
    return send(res, 200, { ...tasks.update(jm[1], { status }), _jira: push });
  }
  const lm = /^\/api\/tasks\/([^/]+)\/claude$/.exec(url.pathname);
  if (lm && req.method === 'POST') return send(res, 200, launch.launch(lm[1]));
  if (url.pathname === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (url.pathname === '/api/jira/import' && req.method === 'POST') {
    const b = await readBody(req);
    return send(res, 200, await jira.importKeys(b.keys ?? b.key ?? b.epic));
  }
  if (url.pathname === '/api/settings') {
    if (req.method === 'GET') return send(res, 200, { ...settings.get(), version: VERSION, dir: tasks.DIR, source: updater.source() });
    if (req.method === 'PUT') {
      const r = settings.save((await readBody(req)).values);
      return send(res, r.ok ? 200 : 400, r.ok ? { ...r, ...settings.get(), version: VERSION, dir: tasks.DIR, source: updater.source() } : { error: Object.values(r.errors)[0], errors: r.errors });
    }
  }
  if (url.pathname === '/api/open' && req.method === 'POST') {
    const u = String((await readBody(req)).url || '');
    if (/^claude:/i.test(u)) throw Object.assign(new Error('Not allowed.'), { status: 400 }); // only the Claude button may use claude://
    launch.openUrl(u);
    return send(res, 200, { ok: true });
  }
  if (url.pathname === '/api/update/check' && req.method === 'POST') return send(res, 200, await updater.check());
  if (url.pathname === '/api/update/apply' && req.method === 'POST') return send(res, 200, await updater.apply());
  if (url.pathname === '/api/pr/refresh' && req.method === 'POST') return send(res, 200, await pr.refresh());
  if (url.pathname === '/api/jira/status') return send(res, 200, { ...jira.status(), sync: sched.info() });
  if (url.pathname === '/api/jira/test' && req.method === 'POST') return send(res, 200, await jira.test());
  if (url.pathname === '/api/jira/sync' && req.method === 'POST') {
    const st = await sched.run('manual', hooks);
    if (!st.ok) throw Object.assign(new Error(st.error), { status: 502 });
    return send(res, 200, st.summary);
  }
  if (!m) return send(res, 404, { error: 'Not found' });
  const id = m[1];
  if (!id) {
    if (req.method === 'GET') return send(res, 200, tasks.list());
    if (req.method === 'POST') return send(res, 201, tasks.create(await readBody(req)));
  } else {
    if (req.method === 'GET') return send(res, 200, tasks.read(id));
    if (req.method === 'PATCH') {
      const patch = await readBody(req), before = tasks.read(id), t = tasks.update(id, patch);
      // Moving a Jira-linked task moves the ticket too; the outcome rides along so the UI can say what happened.
      const push = patch.status && patch.status !== before.status ? await jira.pushStatus(t, t.status) : null;
      // Jira did not take the move (missing fields, no such step, error, timeout): undo the local move so both sides agree, and report why.
      if (push && !push.ok) return send(res, 200, { ...tasks.update(id, { status: before.status, order: before.order ?? '', done: before.done ?? '' }), _jira: { ...push, from: before.status, to: patch.status } });
      return send(res, 200, push ? { ...(push.to ? tasks.read(id) : t), _jira: push } : t);
    }
    if (req.method === 'DELETE') { tasks.remove(id); return send(res, 200, { ok: true }); }
  }
  send(res, 405, { error: 'Method not allowed' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  // Local-only guard: block DNS-rebinding and cross-site writes.
  const host = (req.headers.host || '').split(':')[0];
  if (host !== 'localhost' && host !== '127.0.0.1') return send(res, 403, { error: 'Forbidden host' });
  if (req.method !== 'GET' && !String(req.headers['content-type'] || '').startsWith('application/json') && req.method !== 'DELETE') return send(res, 415, { error: 'JSON only' });
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    const s = STATIC[url.pathname];
    if (!s) return send(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': s[1], 'Cache-Control': 'no-store' });
    res.end(fs.readFileSync(path.join(PUBLIC, s[0])));
  } catch (e) {
    send(res, e.status || 500, { error: e.message });
  }
});
// Node closes an idle keep-alive connection after 5 s by default; a client that reuses it at that moment gets ECONNRESET
// (seen on a busy PC). Keep idle connections longer than any client-side pool.
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
server.listen(PORT, '127.0.0.1', () => {
  console.log(`WorkDesk running at http://localhost:${PORT}\nTasks folder: ${tasks.DIR}`);
  if (migrated && migrated.ran) console.log(`Migrated task data v${migrated.from} -> v${migrated.to} (backup: ${migrated.backup})`);
  sched.start(hooks);
  // "Start WorkDesk.cmd" (the no-exe edition) asks for the browser to open once the server is really up.
  if (process.env.WORKDESK_OPEN === '1' && process.platform === 'win32') require('child_process').spawn('cmd.exe', ['/c', 'start', '', `http://127.0.0.1:${PORT}/`], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
});
