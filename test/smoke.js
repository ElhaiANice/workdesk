'use strict';
// End-to-end smoke test in a throw-away tasks folder. Run: npm test
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const { spawn } = require('child_process');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'workdesk-'));
process.env.WORKDESK_TASKS = tmp;
const root = path.join(__dirname, '..');
const T = require('../lib/tasks');

// --- storage
const a = T.create({ title: 'Fix: colon "quote" title', type: 'story', jira: 'LOCAL-1', repos: ['BE/a', 'BE/b'], body: '- [ ] one\n- [ ] two\n' });
assert.equal(T.read(a.id).title, 'Fix: colon "quote" title');
assert.deepEqual(T.read(a.id).repos, ['BE/a', 'BE/b']);
T.setCheck(a.id, 1, true);
assert.match(T.read(a.id).body, /- \[ \] one\n- \[x\] two/);
assert.equal(T.update(a.id, { status: 'done' }).done, T.today());
assert.equal(T.update(a.id, { status: 'todo' }).done, undefined);
assert.throws(() => T.update(a.id, { status: 'bogus' }));
assert.throws(() => T.read('../etc/passwd'));
assert.equal(T.find('local-1').id, a.id);
console.log('storage ok');

// --- MCP over stdio
const mcp = spawn('node', [path.join(root, 'mcp', 'server.js')], { env: process.env });
const pending = new Map(); let buf = '';
mcp.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); pending.get(m.id)?.(m); } });
let n = 0;
const rpc = (method, params) => new Promise((res) => { const id = ++n; pending.set(id, res); mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
const tool = async (name, args) => { const r = await rpc('tools/call', { name, arguments: args }); return { err: r.result.isError, data: r.result.isError ? r.result.content[0].text : JSON.parse(r.result.content[0].text) }; };

(async () => {
  const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } });
  assert.equal(init.result.serverInfo.name, 'workdesk');
  assert.equal((await rpc('tools/list')).result.tools.length, 7);
  const c = await tool('create_task', { title: 'Validate ECS deploy', type: 'tech', status: 'waiting', who: 'Ops' });
  await tool('add_note', { id: c.data.id, text: 'Staging is green.' });
  assert.match((await tool('get_task', { id: c.data.id })).data.body, /Staging is green/);
  assert.equal((await tool('list_tasks', { status: 'waiting' })).data.length, 1);
  assert.ok((await tool('update_task', { id: 'nope', status: 'done' })).err);
  const o1 = (await tool('create_task', { title: 'Order one' })).data, o2 = (await tool('create_task', { title: 'Order two' })).data;
  assert.ok(Number(o2.order) > Number(o1.order) && Number(o1.order) > Number(c.data.order), 'new tasks go to the bottom');
  assert.equal((await tool('update_task', { id: o2.id, order: 0.5 })).data.order, '0.5');
  assert.equal((await tool('list_tasks', { status: 'inbox' })).data[0].id, o2.id, 'list follows manual order');
  console.log('mcp ok');

  // --- mock Jira (classic v2 paging, or Cloud-style v2 404 + v3 token paging)
  const http = require('http');
  const mine = [
    { key: 'ABC-10', fields: { summary: 'Mine one', issuetype: { name: 'Story' }, status: { statusCategory: { key: 'new' } }, parent: { key: 'ABC-1', fields: { issuetype: { name: 'Epic' } } } } },
    { key: 'ABC-11', fields: { summary: 'Mine two', issuetype: { name: 'Task' }, status: { statusCategory: { key: 'indeterminate' } } } },
    { key: 'ABC-12', fields: { summary: 'Mine three', issuetype: { name: 'Bug' }, status: { statusCategory: { key: 'new' } } } },
  ];
  const EPIC = { key: 'ABC-1', fields: { summary: 'The epic', issuetype: { name: 'Epic' }, status: { statusCategory: { key: 'indeterminate' } }, assignee: { displayName: 'Noa' } } };
  const EXTRA = { key: 'ABC-20', fields: { summary: 'Extra story', issuetype: { name: 'Story' }, status: { statusCategory: { key: 'new' } } } };
  let mode = 'classic', seenAuth = [], seenJql = [], posted = [], edits = [], capRule = false; const gone = new Set();
  const mock = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'); seenAuth.push(req.headers.authorization);
    const out = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.headers.authorization !== 'Bearer tok') return out(401, { errorMessages: ['no'] });
    if (u.pathname === '/rest/api/2/myself') return out(200, { displayName: 'Test User' });
    const one = /^\/rest\/api\/2\/issue\/([A-Z0-9-]+)$/.exec(u.pathname);
    if (one && req.method === 'PUT') { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { edits.push(JSON.parse(b)); out(204, {}); }); return; }
    if (one) {
      const hit = [...mine, EPIC, EXTRA].find((i) => i.key === one[1]);
      return hit ? out(200, hit) : out(404, { errorMessages: ['Issue does not exist'] });
    }
    if (u.pathname === '/rest/api/2/search') {
      if (mode === 'cloud') return out(404, {});
      seenJql.push(u.searchParams.get('jql'));
      if ((u.searchParams.get('jql') || '').startsWith('parent = ABC-1 ')) return out(200, { total: 2, issues: [mine[0], EXTRA] });
      const keys = /^key in \((.*)\)$/.exec(u.searchParams.get('jql') || ''); // the follow-up lookup of tickets that left the query
      if (keys) { const want = keys[1].split(','); const hit = [...mine, EXTRA].filter((i) => want.includes(i.key)); return out(200, { total: hit.length, issues: hit }); }
      const live = mine.filter((i) => !gone.has(i.key)); // "gone": resolved/removed, so the JQL no longer returns it
      const s = +u.searchParams.get('startAt'); // page size 2 to force paging
      return out(200, { total: live.length, issues: live.slice(s, s + 2) });
    }
    if (u.pathname === '/rest/api/3/search/jql') {
      const tok = u.searchParams.get('nextPageToken');
      return tok ? out(200, { issues: mine.slice(2), isLast: true }) : out(200, { issues: mine.slice(0, 2), nextPageToken: 'p2' });
    }
    const tm = /^\/rest\/api\/2\/issue\/([A-Z0-9-]+)\/transitions$/.exec(u.pathname);
    if (tm && req.method === 'GET') return out(200, { transitions: [
      { id: '11', name: 'Start', to: { name: 'In Progress', statusCategory: { key: 'indeterminate' } } },
      { id: '31', name: 'Finish', to: { name: 'Done', statusCategory: { key: 'done' } }, fields: { resolution: { name: 'Resolution', required: true, allowedValues: [{ name: 'Wontfix' }, { name: 'Done' }] }, customfield_10100: { name: 'Cost category', required: false, schema: { type: 'option' }, allowedValues: [{ id: '501', value: 'Category A' }, { id: '502', value: 'Category B' }] } } },
      { id: '41', name: 'Validate', to: { name: 'Validation', statusCategory: { key: 'indeterminate' } }, fields: { fixVersions: { name: 'Fix versions', required: true } } },
    ] });
    // a validator on Done that wants the "Cost category" dropdown, which lives on the ticket's edit screen, not the transition
    if (/^\/rest\/api\/2\/issue\/[A-Z0-9-]+\/editmeta$/.test(u.pathname)) return out(200, { fields: { customfield_10100: { name: 'Cost category', schema: { type: 'option' }, allowedValues: [{ id: '501', value: 'Category A' }, { id: '502', value: 'Category B' }] } } });
    if (tm && req.method === 'POST') {
      let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
        const body = JSON.parse(b); posted.push(body);
        if (capRule && body.transition.id === '31' && !edits.some((e) => e.fields.customfield_10100)) return out(400, { errorMessages: ['Field Cost category is required.'], errors: {} });
        const cat = { 11: 'indeterminate', 31: 'done' }[body.transition.id];
        mine.find((i) => i.key === tm[1]).fields.status = { name: cat === 'done' ? 'Done' : 'In Progress', statusCategory: { key: cat } };
        out(200, {});
      }); return;
    }
    out(404, {});
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));

  // --- HTTP server
  const port = 7000 + Math.floor(Math.random() * 90); // and port + 100: clear of ports fetch refuses (e.g. 5060/5061) and of 4321
  const envFile = path.join(tmp, '..', 'wd-env-' + process.pid + '.env'); // keeps the settings test away from the real .env
  const srv = spawn('node', [path.join(root, 'server.js')], { env: { ...process.env, WORKDESK_SYNC: 'off', WORKDESK_ENV: envFile, WORKDESK_GH: path.join(__dirname, 'fake-gh.js'), WORKDESK_STATE: path.join(tmp, '..', 'wd-state-' + process.pid + '.json'), PORT: port, JIRA_BASE_URL: `http://127.0.0.1:${mock.address().port}`, JIRA_PAT: 'tok' } });
  await new Promise((r) => srv.stdout.once('data', r));
  // If the server dies mid-test, say why instead of only "fetch failed".
  let srvErr = ''; srv.stderr.on('data', (d) => { srvErr += d; }); srv.stdout.resume();
  srv.on('exit', (code, sig) => { if (code || (sig && sig !== 'SIGTERM')) console.error(`test server exited (${code ?? sig})\n${srvErr}`); });
  process.on('exit', (c) => { if (c && srvErr) console.error('test server stderr:\n' + srvErr); });
  const base = `http://127.0.0.1:${port}`; // not "localhost": it can resolve to ::1, where the server is not listening
  const j = async (m, p, b) => { const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json' }, body: b && JSON.stringify(b) }); return { s: r.status, d: await r.json() }; };
  assert.equal((await j('GET', '/api/tasks')).d.length, 4);
  const made = await j('POST', '/api/tasks', { title: 'Review PR 412', type: 'review', who: 'Dana' });
  assert.equal(made.s, 201);
  assert.equal((await j('PATCH', '/api/tasks/' + made.d.id, { status: 'in-progress' })).d.status, 'in-progress');
  assert.equal((await j('PATCH', '/api/tasks/' + made.d.id, { status: 'x' })).s, 400);
  assert.equal((await j('DELETE', '/api/tasks/' + made.d.id)).s, 200);
  // important flag round-trips through the API and clears again
  const flagged = await j('POST', '/api/tasks', { title: 'Urgent thing', important: true });
  assert.equal(flagged.d.important, 'true');
  assert.equal((await j('PATCH', '/api/tasks/' + flagged.d.id, { important: false })).d.important, undefined);
  assert.equal((await j('PATCH', '/api/tasks/' + flagged.d.id, { important: 'yes' })).d.important, 'true');
  await j('DELETE', '/api/tasks/' + flagged.d.id);
  assert.equal((await j('POST', '/api/jira/import', { epic: 'bad key' })).s, 400);

  // sync: classic paging (2 pages), default JQL, bearer auth
  let r = await j('POST', '/api/jira/sync');
  assert.equal(r.s, 200); assert.deepEqual([r.d.found, r.d.created, r.d.updated], [3, 3, 0]);
  assert.match(seenJql[0], /assignee = currentUser\(\) AND resolution = Unresolved/);
  assert.ok(seenAuth.every((a) => a === 'Bearer tok'));
  const after = (await j('GET', '/api/tasks')).d;
  const t10 = after.find((t) => t.jira === 'ABC-10');
  assert.deepEqual([t10.type, t10.status, t10.epic], ['story', 'todo', 'ABC-1']);
  assert.equal(after.find((t) => t.jira === 'ABC-11').type, 'tech');
  assert.equal(after.find((t) => t.jira === 'ABC-11').status, 'in-progress');

  // re-sync is idempotent; local-only state survives; Jira changes flow in
  r = await j('POST', '/api/jira/sync'); assert.deepEqual([r.d.created, r.d.updated, r.d.unchanged], [0, 0, 3]);
  await j('PATCH', '/api/tasks/' + t10.id, { status: 'waiting', who: 'Ops', body: 'my notes\n' });
  mine[0].fields.summary = 'Mine one (renamed)'; mine[2].fields.status.statusCategory.key = 'done';
  r = await j('POST', '/api/jira/sync'); assert.deepEqual([r.d.created, r.d.updated, r.d.unchanged], [0, 2, 1]);
  const t10b = (await j('GET', '/api/tasks/' + t10.id)).d;
  assert.deepEqual([t10b.title, t10b.status, t10b.who, t10b.body.trim().endsWith('my notes')], ['Mine one (renamed)', 'waiting', 'Ops', true]);
  assert.equal((await j('GET', '/api/tasks')).d.find((t) => t.jira === 'ABC-12').status, 'done');
  // a ticket moved to a closing status that sets a resolution (e.g. "Removed"), so the "Unresolved" query stops returning it; the task must still follow
  gone.add('ABC-11'); mine[1].fields.status = { name: 'Removed', statusCategory: { key: 'done' } };
  r = await j('POST', '/api/jira/sync');
  assert.deepEqual([r.d.found, r.d.refreshed, (await j('GET', '/api/tasks')).d.find((t) => t.jira === 'ABC-11').status], [2, 1, 'done']);
  r = await j('POST', '/api/jira/sync'); assert.equal(r.d.refreshed, 0); // done locally now: not looked up again
  gone.clear();

  // Cloud-style fallback (v2 search 404 -> v3 token paging)
  fs.readdirSync(tmp).filter((f) => /^abc-1[012]/.test(f)).forEach((f) => fs.unlinkSync(path.join(tmp, f)));
  mode = 'cloud';
  r = await j('POST', '/api/jira/sync'); assert.deepEqual([r.s, r.d.found, r.d.created], [200, 3, 3]);

  mode = 'classic';

  const made2 = (await j('POST', '/api/tasks', { title: 'No ticket' })).d.id;
  // write-back: local moves become Jira transitions; required fields are filled when possible, else reported
  const t10id = (await j('GET', '/api/tasks')).d.find((t) => t.jira === 'ABC-10').id;
  const pj = async (st) => (await j('PATCH', '/api/tasks/' + t10id, { status: st })).d;
  let w = await pj('in-progress');
  assert.deepEqual([w._jira.ok, w._jira.to, w.jira_status, posted.length], [true, 'In Progress', 'In Progress', 1]);
  assert.equal(posted[0].transition.id, '11');
  w = await pj('done');
  assert.deepEqual([w._jira.ok, w._jira.to, posted[1].fields.resolution.name], [true, 'Done', 'Done']);
  w = await pj('review');
  assert.equal(w._jira.ok, false); assert.match(w._jira.error, /Fix versions/); assert.equal(posted.length, 2);
  // refused for a missing field: the local move is undone and the field comes back for the UI to ask
  assert.deepEqual([w.status, w._jira.from, w._jira.to, w._jira.needs.fields.map((f) => f.id)], ['done', 'done', 'review', ['fixVersions']]);
  r = await j('POST', `/api/tasks/${t10id}/jira-move`, { status: 'review', fields: {} });
  assert.deepEqual([r.d.status, r.d._jira.needs.fields.length, posted.length], ['done', 1, 2]); // still missing: nothing moves
  r = await j('POST', `/api/tasks/${t10id}/jira-move`, { status: 'review', fields: { fixVersions: '2.4' } });
  assert.deepEqual([r.d.status, r.d._jira.ok, posted[2].transition.id, posted[2].fields.fixVersions], ['review', true, '41', '2.4']);
  // a validator that only says "Field Cost category is required.": the field is found on the edit screen, set on the ticket, then the move retried
  capRule = true;
  w = await pj('done');
  assert.deepEqual([w.status, w._jira.needs.fields[0].id, w._jira.needs.fields[0].kind, w._jira.needs.fields[0].options.length], ['review', 'customfield_10100', 'pick', 2]); // optional on the Done step, demanded by a validator
  r = await j('POST', `/api/tasks/${t10id}/jira-move`, { status: 'done', fields: { customfield_10100: '501' } });
  assert.deepEqual([r.d.status, r.d._jira.ok, edits[0].fields.customfield_10100.id, posted[posted.length - 1].fields.customfield_10100.id], ['done', true, '501', '501']); // saved on the ticket and sent with the move
  capRule = false;
  await pj('review'); // back where the next checks expect it
  w = await pj('waiting');
  assert.equal(w._jira.ok, false); assert.match(w._jira.error, /no step/); assert.equal(w.status, 'waiting');
  assert.equal(JSON.parse(JSON.stringify((await j('PATCH', '/api/tasks/' + made2, { status: 'done' })).d))._jira, undefined); // task without a ticket
  // status + connection test
  const st = (await j('GET', '/api/jira/status')).d;
  assert.deepEqual([st.configured, st.auth], [true, 'personal access token']);
  assert.equal((await j('POST', '/api/jira/test')).d.user, 'Test User');
  // sync state is recorded and shown with the schedule
  assert.deepEqual([st.sync.schedule.times, st.sync.schedule.days.length], [['09:00', '13:00', '17:00'], 5]);
  const st2 = (await j('GET', '/api/jira/status')).d.sync;
  assert.deepEqual([st2.ok, st2.trigger], [true, 'manual']);

  // import: single key via pasted link, already-present key is unchanged, unknown key is a clear 404
  r = await j('POST', '/api/jira/import', { keys: 'see https://x.atlassian.net/browse/abc-20?foo=1' });
  assert.deepEqual([r.s, r.d.created, r.d.items[0].type], [200, 1, 'story']);
  r = await j('POST', '/api/jira/import', { keys: 'ABC-20, ABC-11' }); assert.deepEqual([r.d.created, r.d.unchanged], [0, 2]);
  r = await j('POST', '/api/jira/import', { keys: 'ABC-99' }); assert.equal(r.s, 404); assert.match(r.d.error, /ABC-99 was not found/);
  assert.equal((await j('POST', '/api/jira/import', { keys: 'no keys here' })).s, 400);
  // import: epic key brings the epic (owner from assignee) and its stories linked to it
  r = await j('POST', '/api/jira/import', { keys: 'ABC-1' });
  assert.equal(r.s, 200); assert.equal(r.d.created, 1); // epic new; its two children already exist
  const all = (await j('GET', '/api/tasks')).d;
  assert.equal(all.find((t) => t.jira === 'ABC-1').type, 'epic');
  assert.equal(all.find((t) => t.jira === 'ABC-20').epic, 'ABC-1');

  // errors are readable: bad credentials
  const bad = spawn('node', [path.join(root, 'server.js')], { env: { ...process.env, WORKDESK_SYNC: 'off', WORKDESK_STATE: path.join(tmp, '..', 'wd-state-bad-' + process.pid + '.json'), PORT: port + 100, JIRA_BASE_URL: `http://127.0.0.1:${mock.address().port}`, JIRA_PAT: 'wrong' } });
  await new Promise((rr) => bad.stdout.once('data', rr));
  const br = await (await fetch(`http://127.0.0.1:${port + 100}/api/jira/sync`, { method: 'POST', headers: { 'Content-Type': 'application/json' } })).json();
  assert.match(br.error, /Check your Jira credentials/);
  bad.kill();
  // PR state: open -> review, merged -> done, draft stays, unknown PR is reported; second refresh changes nothing
  const mk = async (title, pr, status) => (await j('POST', '/api/tasks', { title, pr, status })).d.id;
  const p1 = await mk('pr one', 'https://github.com/o/r/pull/1', 'in-progress'), p2 = await mk('pr two', 'https://github.com/o/r/pull/2', 'review'), p3 = await mk('pr three', 'https://github.com/o/r/pull/3', 'todo'), p9 = await mk('pr nine', 'https://github.com/o/r/pull/9', 'todo');
  let pr = (await j('POST', '/api/pr/refresh')).d;
  assert.deepEqual([pr.checked, pr.moved, pr.errors.length], [4, 2, 1], JSON.stringify(pr));
  const g = async (id) => (await j('GET', '/api/tasks/' + id)).d;
  assert.deepEqual([(await g(p1)).status, (await g(p1)).pr_state, (await g(p1)).pr_review], ['review', 'open', 'approved']);
  assert.deepEqual([(await g(p2)).status, (await g(p2)).pr_state], ['done', 'merged']);
  assert.deepEqual([(await g(p3)).status, (await g(p3)).pr_state], ['todo', 'draft']);
  await j('PATCH', '/api/tasks/' + p1, { status: 'in-progress' }); // user moves it back: unchanged PR must not override
  pr = (await j('POST', '/api/pr/refresh')).d; assert.equal(pr.moved, 0);
  assert.equal((await g(p1)).status, 'in-progress');
  for (const id of [p1, p2, p3, p9]) await j('DELETE', '/api/tasks/' + id);
  console.log('jira ok');
  // scheduler: 3 slots on work days, catch-up when a slot was missed
  const S = require('../lib/sched'), cfg = S.config({});
  const at = (d, h, m) => new Date(2026, 9, d, h, m); // 2026-10-25 is a Sunday, 2026-10-30 a Friday
  assert.equal(S.lastSlot(at(25, 8, 59), cfg), null);
  assert.equal(S.lastSlot(at(25, 13, 5), cfg).getHours(), 13);
  assert.equal(S.lastSlot(at(30, 13, 5), cfg), null); // Friday is off
  assert.ok(S.isDue(at(25, 13, 5), at(25, 9, 1).toISOString(), cfg));
  assert.ok(!S.isDue(at(25, 13, 5), at(25, 13, 1).toISOString(), cfg));
  assert.ok(S.isDue(at(25, 9, 0), at(24, 17, 1).toISOString(), cfg)); // missed overnight -> catch up
  assert.ok(!S.isDue(at(25, 13, 5), null, S.config({ WORKDESK_SYNC: 'off' })));
  assert.deepEqual(S.config({ WORKDESK_SYNC_TIMES: '8:30, bad, 25:00', WORKDESK_SYNC_DAYS: 'mon,fri' }).times, [510]);
  console.log('sched ok');
  const CL = T.classify;
  const want = { 'Review PR 412': 'review', 'Weekly sync with Dana': 'meeting', 'Fix login crash': 'bug', 'Fix CVE-2024-1 in lib': 'security', 'Outage on prod': 'incident', 'Investigate slow query': 'research', 'Update the runbook': 'docs', 'Plan Q3 roadmap': 'planning', 'Deploy helm chart': 'tech', 'ABC-12 add export': 'story', 'Call mom': 'meeting', 'lunch': 'follow-up', 'Epic for billing': 'epic' };
  for (const [title, type] of Object.entries(want)) assert.equal(CL(title), type, title);
  assert.equal(T.create({ title: 'Fix the crash' }).type, 'bug');
  assert.equal(T.create({ title: 'Fix the crash', type: 'story' }).type, 'story');
  assert.equal((await fetch(base + '/api/config').then((r) => r.json())).rules.length, require('../lib/classify').RULES.length);
  console.log('types ok');
  // migration: legacy due/followup keys are stripped once, with a backup copy of the tasks
  const mig = fs.mkdtempSync(path.join(os.tmpdir(), 'workdesk-mig-')), md = path.join(mig, 'tasks');
  fs.mkdirSync(md); fs.writeFileSync(path.join(md, 'old.md'), ['---', 'type: story', 'title: Old', 'due: 2026-01-01', 'followup: 2026-01-02', 'status: todo', '---', 'body', ''].join('\n'));
  const run = require('child_process').spawnSync('node', ['-e', "console.log(JSON.stringify(require('./lib/migrate').migrate()))"], { cwd: root, env: { ...process.env, WORKDESK_TASKS: md }, encoding: 'utf8' });
  const mr = JSON.parse(run.stdout);
  assert.deepEqual([mr.from, mr.to, mr.ran], [1, 2, 1]);
  assert.equal(fs.readFileSync(path.join(md, 'old.md'), 'utf8'), ['---', 'type: story', 'title: Old', 'status: todo', '---', 'body', ''].join('\n'));
  assert.ok(fs.existsSync(path.join(mig, 'tasks.backup-v1', 'old.md')));
  assert.equal(JSON.parse(require('child_process').spawnSync('node', ['-e', "console.log(JSON.stringify(require('./lib/migrate').migrate()))"], { cwd: root, env: { ...process.env, WORKDESK_TASKS: md }, encoding: 'utf8' }).stdout).ran, 0);
  fs.rmSync(mig, { recursive: true, force: true });
  console.log('migrate ok');
  // settings: read, validate, save to the .env file, apply live, never leak secrets
  const J = (method, url, body) => fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json() }));
  let sg = await J('GET', '/api/settings');
  assert.equal(sg.body.values.JIRA_PAT, '');
  assert.equal(sg.body.secretSet.JIRA_PAT, true);
  assert.ok(!JSON.stringify(sg.body).includes('"tok"'));
  assert.equal((await J('PUT', '/api/settings', { values: { WORKDESK_SYNC_TIMES: '25:99' } })).status, 400);
  assert.equal((await J('PUT', '/api/settings', { values: { JIRA_BASE_URL: 'nope' } })).status, 400);
  fs.writeFileSync(envFile, '# my notes\nJIRA_PUSH=off\nKEEP=1\n');
  sg = await J('PUT', '/api/settings', { values: { WORKDESK_SYNC_TIMES: '08:30, 16:00', WORKDESK_SYNC_DAYS: 'mon,tue', JIRA_PUSH: true, JIRA_JQL: 'project = X', JIRA_TOKEN: 's3cret value' } });
  assert.equal(sg.status, 200);
  const envText = fs.readFileSync(envFile, 'utf8');
  assert.ok(envText.includes('# my notes') && envText.includes('KEEP=1'), 'keeps comments and unknown lines');
  assert.ok(!/JIRA_PUSH/.test(envText), 'enabled switch removes the off line');
  assert.ok(envText.includes('WORKDESK_SYNC_TIMES=08:30, 16:00') || envText.includes('WORKDESK_SYNC_TIMES="08:30, 16:00"'));
  assert.ok(envText.includes('JIRA_TOKEN="s3cret value"'));
  assert.ok(!JSON.stringify(sg.body).includes('s3cret'));
  const js = (await J('GET', '/api/jira/status')).body;
  assert.deepEqual(js.sync.schedule.times, ['08:30', '16:00']); // applied without a restart
  assert.equal(js.jql, 'project = X');
  assert.equal((await J('PUT', '/api/settings', { values: { JIRA_TOKEN: '' } })).status, 200);
  assert.equal((await J('GET', '/api/settings')).body.secretSet.JIRA_TOKEN, true, 'blank secret keeps the saved one');
  await J('PUT', '/api/settings', { values: { JIRA_TOKEN: null, JIRA_JQL: '' } });
  assert.ok(!/JIRA_TOKEN|JIRA_JQL/.test(fs.readFileSync(envFile, 'utf8')));
  // updater: finds the newest release in a folder; refuses to install from a source checkout
  const rel = path.join(tmp, 'releases'); fs.mkdirSync(rel);
  for (const v of ['0.9.0', '1.10.0', '1.2.0']) fs.writeFileSync(path.join(rel, `WorkDesk-${v}.zip`), 'x');
  assert.equal((await J('PUT', '/api/settings', { values: { WORKDESK_UPDATE_SOURCE: 'someone/some-repo' } })).status, 200, 'owner/repo is a valid source');
  assert.equal((await J('PUT', '/api/settings', { values: { WORKDESK_UPDATE_SOURCE: 'not a source' } })).status, 400);
  await J('PUT', '/api/settings', { values: { WORKDESK_UPDATE_SOURCE: rel } });
  const uc = (await J('POST', '/api/update/check')).body;
  assert.deepEqual([uc.latest, uc.available, uc.packaged], ['1.10.0', true, false]);
  assert.equal((await J('POST', '/api/update/apply')).status, 400, 'source checkout is not self-updatable');
  assert.ok(require('../lib/updater').newer('1.10.0', '1.9.9') && !require('../lib/updater').newer('1.0', '1.0.0'));
  assert.equal((await J('POST', '/api/open', { url: 'claude://code/new?q=x' })).status, 400, 'only the Claude button may use claude://');
  assert.equal((await J('POST', '/api/open', { url: 'file:///C:/Windows/notepad.exe' })).status, 400);
  assert.equal((await J('POST', '/api/open', { url: 'javascript:alert(1)' })).status, 400);
  console.log('settings ok');
  assert.equal((await fetch(base + '/')).status, 200);
  const evil = await new Promise((r) => require('http').get({ port, path: '/api/tasks', headers: { Host: 'evil.com' } }, (res) => { res.resume(); r(res.statusCode); }));
  assert.equal(evil, 403);
  console.log('http ok');
  srv.kill(); mcp.kill(); mock.close(); fs.rmSync(tmp, { recursive: true, force: true }); fs.rmSync(envFile, { force: true });
  console.log('ALL OK');
})().catch((e) => { console.error(e); process.exit(1); });
