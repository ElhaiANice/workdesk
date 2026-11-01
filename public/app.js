'use strict';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const state = { tasks: [], cfg: null, view: 'board', open: null, sel: new Set() };

async function call(method, url, body) {
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { errors: data.errors });
  return data;
}
function toast(msg, act) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  if (act) {
    const b = document.createElement('button'); b.className = 'toast-btn'; b.textContent = act.label;
    b.onclick = async () => { t.hidden = true; try { await act.fn(); } catch (e) { toast(e.message); } };
    t.append(' ', b);
  }
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, act ? 7000 : 4000);
}
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message); } };

// ---------- rendering ----------
const chip = (t) => `<span class="chip t-${t}">${t}</span>`;
const stat = (s) => `<span class="status ${s}">${s.replace('-', ' ')}</span>`;
const epicKey = (e) => e.jira || e.id;
const hue = (k) => { let h = 7; for (const c of String(k)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const epicTitle = (k) => { const e = state.tasks.find((t) => t.type === 'epic' && epicKey(t) === k); return e ? e.title : ''; };
const epicTag = (k) => k ? `<span class="etag" style="--h:${hue(k)}" title="${esc(epicTitle(k))}">${esc(k)}</span>` : '';
const imp = (t) => t.important === 'true';
const isArch = (t) => t.archived === 'true';
const PR_LABEL = { open: 'PR open', draft: 'PR draft', merged: 'PR merged', closed: 'PR closed' };
const prBadge = (t) => t.pr_state ? `<span class="prb pr-${t.pr_state}" title="Pull request: ${t.pr_state}${t.pr_review ? ', ' + t.pr_review : ''}">${PR_LABEL[t.pr_state] || 'PR'}${t.pr_review === 'changes-requested' ? ' !' : t.pr_review === 'approved' ? ' ok' : ''}</span>` : '';
const flag = (t) => imp(t) ? '<span class="flag" title="Important">!</span>' : '';
// Manual order (drag to change); tasks without one keep creation order, then title.
const byTitle = (a, b) => (Number(a.order) || 0) - (Number(b.order) || 0) || (a.created || '').localeCompare(b.created || '') || a.title.localeCompare(b.title);
// How old a task is, as a small mark: 0d, 3d, 100d.
const dayNum = (s) => { const [y, m, d] = String(s || '').split('-').map(Number); return y && m && d ? Date.UTC(y, m - 1, d) / 864e5 : null; };
const ageDays = (t) => { const c = dayNum(t.created), n = dayNum(state.cfg.today); return c === null || n === null ? null : Math.max(0, Math.round(n - c)); };
const age = (t) => { const d = t.status === 'done' ? null : ageDays(t); return d === null ? '' : `<span class="age${d >= 30 ? ' old' : ''}" title="Created ${esc(t.created)}">${d}d</span>`; };
const STATUS_ORDER = ['inbox', 'todo', 'in-progress', 'review', 'waiting', 'done'];
const STATUS_LABEL = { inbox: 'Pending', todo: 'To do', 'in-progress': 'In progress', waiting: 'Waiting', review: 'In review', done: 'Done' };

function row(t) {
  return `<div class="row ${t.status === 'done' ? 'done' : ''}${imp(t) ? ' imp' : ''}" tabindex="0" data-id="${esc(t.id)}">${chip(t.type)}<span class="title">${flag(t)}${esc(t.title)}${t.who ? ` <span class="meta">· ${esc(t.who)}</span>` : ''}</span>${stat(t.status)}<span class="meta">${esc(t.jira || '')}</span>${age(t)}</div>`;
}
const group = (name, items) => `<div class="group"><h3>${name} <span class="count">${items.length}</span></h3>${items.length ? items.map(row).join('') : '<div class="empty">Nothing here.</div>'}</div>`;

// A story whose epic is in the same column is drawn directly under that epic (indented); everything else keeps its stored (dragged) order.
function nested(list) {
  const keys = new Set(list.filter((t) => t.type === 'epic').map(epicKey));
  const under = (t) => t.type !== 'epic' && !!t.epic && keys.has(t.epic);
  const out = [];
  for (const t of list) {
    if (under(t)) continue;
    out.push([t, false]);
    if (t.type === 'epic') for (const c of list) if (under(c) && c.epic === epicKey(t)) out.push([c, true]);
  }
  return out;
}

// Progress of an epic across its stories: counts per status and % done.
function epicStats(e) {
  const kids = state.tasks.filter((t) => t.type !== 'epic' && t.epic && t.epic === epicKey(e));
  const by = {}; kids.forEach((k) => { by[k.status] = (by[k.status] || 0) + 1; });
  const done = by.done || 0;
  return { kids, by, total: kids.length, done, pct: kids.length ? Math.round((done / kids.length) * 100) : 0 };
}
const segBar = (st) => `<div class="seg" role="img" aria-label="${st.done} of ${st.total} done">${STATUS_ORDER.map((s) => st.by[s] ? `<i class="s-${s}" style="flex:${st.by[s]}" title="${STATUS_LABEL[s]}: ${st.by[s]}"></i>` : '').join('')}</div>`;
function epicMini(t) {
  const st = epicStats(t);
  if (!st.total) return '<div class="epic-mini meta">No stories yet</div>';
  return `<div class="epic-mini">${segBar(st)}<span class="meta">${st.done}/${st.total} done · ${st.pct}%</span></div>`;
}
function epicPanel(t) {
  const st = epicStats(t);
  if (!st.total) return '<section class="epicpanel"><h3>Progress</h3><div class="empty">No stories linked to this epic yet.</div></section>';
  return `<section class="epicpanel"><h3>Progress <span class="meta">${st.done}/${st.total} stories done · ${st.pct}%</span></h3>${segBar(st)}
    <div class="legend">${STATUS_ORDER.filter((s) => st.by[s]).map((s) => `<span class="s-${s}"><i></i>${STATUS_LABEL[s]} ${st.by[s]}</span>`).join('')}</div>
    <div class="estories">${st.kids.sort(byTitle).map((k) => `<button class="estory" data-open="${esc(k.id)}">${stat(k.status)}<span>${flag(k)}${esc(k.title)}</span><span class="meta">${esc(k.jira || '')}</span></button>`).join('')}</div></section>`;
}

function card(t, child) {
  const ek = t.type === 'epic' ? '' : t.epic;
  return `<div class="card-t t-${t.type}${ek ? ' has-epic' : ''}${child ? ' child' : ''}${imp(t) ? ' imp' : ''}${state.sel.has(t.id) ? ' sel' : ''}" ${ek ? `style="--h:${hue(ek)}"` : ''} tabindex="0" draggable="true" data-id="${esc(t.id)}">
    <div class="ct-top"><button class="chip typebtn t-${t.type}" data-typemenu="${esc(t.id)}" title="Change type" aria-haspopup="menu">${t.type}</button><span class="meta">${esc(t.jira || '')}</span><button class="flagbtn" title="${imp(t) ? 'Remove important flag' : 'Mark important'}" aria-label="Toggle important" aria-pressed="${imp(t)}">${imp(t) ? '⚑' : '⚐'}</button></div>
    <div class="ct-title">${esc(t.title)}</div>
    ${t.type === 'epic' ? epicMini(t) : ''}
    <div class="ct-foot">${epicTag(ek)}${prBadge(t)}${t.who ? `<span class="meta">${esc(t.who)}</span>` : ''}${age(t)}</div></div>`;
}

function board(items) {
  const order = [...state.cfg.statuses.filter((s) => s !== 'waiting'), 'waiting']; // Waiting sits in the far-right column
  const cols = order.map((s) => {
    let list = items.filter((t) => t.status === s).sort(byTitle);
    const n = list.length;
    if (s === 'done') list = list.slice(0, 8); // manual order like the other columns; a task that becomes done goes to the top (see tasks.update)
    return `<section class="col s-${s}" data-status="${s}" aria-label="${STATUS_LABEL[s]}"><h3><span>${STATUS_LABEL[s]}</span><span class="count">${n}</span></h3><div class="cards">${nested(list).map(([t, c]) => card(t, c)).join('') || '<div class="empty">Empty</div>'}</div>${s === 'done' && n > list.length ? `<div class="meta more">+${n - list.length} more in Done</div>` : ''}</section>`;
  });
  return `<div class="board">${cols.join('')}</div>`;
}

function epicBlock(key, e, kids) {
  const all = state.tasks.filter((t) => t.epic === key && t.type !== 'epic');
  const done = all.filter((t) => t.status === 'done').length;
  const pct = all.length ? Math.round((done / all.length) * 100) : (e && e.status === 'done' ? 100 : 0);
  const owner = (kids.find((k) => k.epic_owner) || {}).epic_owner;
  const head = e ? row(e).replace('class="row ', 'class="row epic-head ')
    : `<div class="epic-head plain">${chip('epic')}<span class="title">${esc(key)}${owner ? ' · owner ' + esc(owner) : ''} <span class="meta">epic not tracked here</span></span></div>`;
  return `<div class="epicbox">${head}<div class="epic-prog"><div class="bar"><div style="width:${pct}%"></div></div><span class="meta">${done}/${all.length} stories done</span></div><div class="kids">${kids.length ? kids.map(row).join('') : '<div class="empty">No stories yet.</div>'}</div></div>`;
}
function epicBlocks(items) {
  const epicsByKey = new Map(state.tasks.filter((t) => t.type === 'epic').map((e) => [epicKey(e), e]));
  const kidsBy = {};
  items.filter((t) => t.type !== 'epic' && t.epic).forEach((t) => (kidsBy[t.epic] ||= []).push(t));
  const keys = new Set([...Object.keys(kidsBy), ...items.filter((t) => t.type === 'epic').map(epicKey)]);
  return `<div class="epics">${[...keys].map((k) => epicBlock(k, epicsByKey.get(k), (kidsBy[k] || []).sort(byTitle))).join('')}</div>`;
}

// While a search is typed, tasks in the Archive that match are listed under the results (they never show on the board itself).
function archivedHits(archived) {
  if (!$('f-q').value.trim()) return '';
  const hits = filtered(archived);
  return hits.length ? group(`In the archive (${hits.length})`, hits.sort((a, b) => (b.created || '').localeCompare(a.created || ''))) : '';
}
function filtered(base) {
  const q = $('f-q').value.trim().toLowerCase(), ft = $('f-type').value, fe = $('f-epic').value, fi = $('f-imp').checked;
  return base.filter((t) => (!fi || imp(t)) && (!ft || t.type === ft) && (!fe || t.epic === fe || epicKey(t) === fe) && (!q || [t.title, t.jira, t.who, t.body, (t.tags || []).join(' ')].join(' ').toLowerCase().includes(q)));
}

// A refresh (file change, Jira sync) while a card is in the air would rebuild the cards under the pointer and spoil the drop; hold it until the drag ends.
var dragId = null, staleDuringDrag = false;
function render() {
  if (dragId) { staleDuringDrag = true; return; }
  const live = state.tasks.filter((t) => !isArch(t)), archived = state.tasks.filter(isArch);
  const open = live.filter((t) => t.status !== 'done');
  const done = live.filter((t) => t.status === 'done');
  const epics = live.filter((t) => t.type === 'epic');
  $('n-archive').textContent = archived.length || '';
  $('n-board').textContent = open.length || '';
  $('n-epics').textContent = epics.length || '';
  $('n-list').textContent = open.length || '';
  $('n-done').textContent = done.length || '';
  document.querySelectorAll('.navbtn[data-view]').forEach((b) => b.setAttribute('aria-current', b.dataset.view === state.view));
  $('filters').hidden = !['board', 'list', 'archive', 'done'].includes(state.view);
  $('n-imp').textContent = live.filter((t) => imp(t) && t.status !== 'done').length || '';
  state.sel = new Set([...state.sel].filter((id) => state.tasks.some((t) => t.id === id)));
  renderBulk(); renderPresets();

  let html = '';
  if (state.view === 'jira') {
    html = jiraPanel();
  } else if (state.view === 'settings') {
    html = settingsPanel();
  } else if (state.view === 'archive') {
    html = group('Archive', filtered(archived).sort((a, b) => (b.created || '').localeCompare(a.created || ''))) + '<p class="meta">Drag a card toward the right edge: an Archive tray peeks out there. To bring a task back, open it and press Restore.</p>';
  } else if (!state.tasks.length) {
    html = `<div class="welcome"><b>No tasks yet.</b><br>Type one in the box above and press Enter, for example <i>review PR 412 for Dana</i>. Or use the Jira page to sync your tickets or import an epic with its stories.<br><br>Tasks are saved as Markdown files in:<br><code>${esc(state.cfg.dir)}</code></div>`;
  } else if (state.view === 'board') {
    html = board(filtered(live)) + archivedHits(archived);
  } else if (state.view === 'list') {
    const items = filtered(open);
    html = state.cfg.statuses.filter((s) => s !== 'done').map((s) => group(STATUS_LABEL[s], items.filter((t) => t.status === s).sort(byTitle))).join('') + archivedHits(archived);
  } else if (state.view === 'epics') {
    html = epicBlocks(live.filter((t) => t.type === 'epic' || t.epic)) || '<div class="empty">No epics yet. Add one with "epic" in the title, or import from Jira.</div>';
  } else {
    html = group('Done', filtered(done).sort((a, b) => (b.done || '').localeCompare(a.done || '')));
  }
  const fid = document.activeElement?.closest?.('.card-t')?.dataset.id;
  $('list').innerHTML = html;
  if (fid) $('list').querySelector(`.card-t[data-id="${CSS.escape(fid)}"]`)?.focus({ preventScroll: true });
  const ft = $('f-type');
  if (ft.options.length !== state.cfg.types.length + 1) { const cur = ft.value; ft.innerHTML = '<option value="">All types</option>' + state.cfg.types.map((k) => `<option>${k}</option>`).join(''); ft.value = cur; }
  const keep = $('f-epic').value;
  const keys = [...new Set(state.tasks.map((t) => t.epic).filter(Boolean))].sort();
  $('f-epic').innerHTML = '<option value="">Any epic</option>' + keys.map((k) => `<option ${k === keep ? 'selected' : ''}>${esc(k)}</option>`).join('');
  if (!$('drawer').contains(document.activeElement)) renderDrawer();
}

const JIRA_RE = /<!-- jira -->([\s\S]*?)<!-- \/jira -->\r?\n?/;
const splitBody = (b = '') => { const m = JIRA_RE.exec(b); return m ? { block: m[0], jira: m[1].trim(), notes: (b.slice(0, m.index) + b.slice(m.index + m[0].length)).replace(/^\s+/, '') } : { block: '', jira: '', notes: b }; };
const WHO = { review: 'author', meeting: 'attendees', 'follow-up': 'who' };
const LABEL = { url: 'jira link', jira_status: 'jira status', epic_owner: 'epic owner', pr: 'pr url' };

function renderDrawer() {
  const D = $('drawer'), t = state.tasks.find((x) => x.id === state.open);
  if (!t) { D.hidden = true; D.innerHTML = ''; return; }
  const checks = [];
  (t.body || '').split(/\r?\n/).forEach((l) => { const m = /^\s*- \[([ xX])\] (.*)$/.exec(l); if (m) checks.push([m[2], m[1] !== ' ']); });
  const f = (k) => `<label for="d-${k}">${k === 'who' ? WHO[t.type] || 'who' : LABEL[k] || k}</label><input id="d-${k}" data-f="${k}" ${k === 'epic' ? 'list="d-epics"' : ''} value="${esc(Array.isArray(t[k]) ? t[k].join(', ') : t[k])}">`;
  const sb = splitBody(t.body), fields = ((state.cfg.typeFields || {})[t.type] || ['jira', 'url', 'epic', 'repos', 'pr', 'tags']).filter((k) => k !== 'url' || !t.url);
  const epicKeys = [...new Set(state.tasks.map((x) => x.epic || (x.type === 'epic' && x.jira)).filter(Boolean))];
  const needWho = t.status === 'waiting' && !t.who;
  D.hidden = false;
  D.innerHTML = `<div class="top">${chip(t.type)}<span><button class="link" id="d-arch">${isArch(t) ? 'restore' : 'archive'}</button> &nbsp; <button class="link danger" id="d-del">delete</button> &nbsp; <button class="link" id="d-close">close ✕</button></span></div>
  <h2><input id="d-title" data-f="title" value="${esc(t.title)}" style="width:100%;font-weight:600" aria-label="Title"></h2>
  <div class="steps" role="group" aria-label="Status">${state.cfg.statuses.map((s) => `<button data-s="${s}" aria-pressed="${t.status === s}">${s.replace('-', ' ')}</button>`).join('')}</div>
  <div class="fields">
    <label for="d-imp">important</label><label class="chk"><input type="checkbox" id="d-imp" data-imp ${imp(t) ? 'checked' : ''}> flag with a red mark</label>
    <label for="d-type">type</label><select id="d-type" data-f="type">${state.cfg.types.map((x) => `<option ${x === t.type ? 'selected' : ''}>${x}</option>`).join('')}</select>
    ${['story', 'epic', 'tech'].includes(t.type) && t.status !== 'waiting' ? '' : f('who')}
    ${needWho ? '<div class="need">Waiting needs a person: who are you waiting on?</div>' : ''}
    ${fields.filter((k) => k !== 'who').map(f).join('')}
    <datalist id="d-epics">${epicKeys.map((k) => `<option value="${esc(k)}">`).join('')}</datalist>
  </div>
  ${t.type === 'epic' ? epicPanel(t) : ''}
  ${/^https?:/.test(t.pr || '') ? `<a class="jlink" href="${esc(t.pr)}">Open pull request ↗</a>` : ''}
  ${t.url ? `<a class="jlink" href="${esc(t.url)}" target="_blank" rel="noopener noreferrer">Open ${esc(t.jira || 'ticket')} in Jira ↗</a>` : ''}
  ${sb.jira ? `<details class="jira" open><summary>From Jira${t.epic_title ? ' · epic: ' + esc(t.epic_title) : ''}</summary><pre>${esc(sb.jira)}</pre></details>` : ''}
  ${checks.length ? `<div class="check">${checks.map((c, i) => `<label><input type="checkbox" data-c="${i}" ${c[1] ? 'checked' : ''}> ${esc(c[0])}</label>`).join('')}</div>` : ''}
  <label for="d-body" class="file">notes (Markdown; use "- [ ] item" for a checklist)</label>
  <textarea id="d-body" aria-label="Notes">${esc(sb.notes)}</textarea>
  <button class="claudebtn" id="d-claude">Work on this with Claude ›</button>
  <button class="link" id="d-copy">copy command</button>
  <div class="file">${esc(state.cfg.dir)}\\${esc(t.id)}.md</div>`;
}

// ---------- data ----------
async function load() {
  state.cfg = await call('GET', '/api/config');
  state.tasks = await call('GET', '/api/tasks');
  state.jira.status = await call('GET', '/api/jira/status').catch((e) => ({ error: e.message }));
  render();
}
async function patch(id, body, quiet) {
  const i = state.tasks.findIndex((t) => t.id === id);
  const t = await call('PATCH', '/api/tasks/' + encodeURIComponent(id), body);
  const j = t._jira; delete t._jira;
  if (i >= 0) state.tasks[i] = t;
  if (j?.needs) jiraAsk(t, j); // Jira refused for missing fields; the server already undid the move
  else if (j && !j.ok) toast(j.error);
  else if (j?.to) toast(`Jira ticket moved to "${j.to}"`);
  if (!quiet) { render(); renderDrawer(); }
}

// Jira refused a move because the transition needs fields. Ask for them right here, then retry: only a move Jira accepts changes the task.
function jiraAsk(t, j) {
  let dlg = $('jira-ask');
  if (!dlg) { dlg = document.createElement('dialog'); dlg.id = 'jira-ask'; dlg.className = 'ask'; document.body.append(dlg); }
  const keep = Object.fromEntries([...(dlg.querySelector('form') ? new FormData(dlg.querySelector('form')) : [])]);
  const input = (f) => {
    const a = `name="${esc(f.id)}" id="ja-${esc(f.id)}" required`;
    if (f.kind === 'pick') return `<select ${a}><option value="">Choose…</option>${f.options.map((o) => `<option value="${esc(o.id)}" ${keep[f.id] === o.id ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
    if (f.kind === 'multi') return `<div class="checks" role="group" id="ja-${esc(f.id)}" aria-label="${esc(f.name)}">${f.options.map((o) => `<label><input type="checkbox" name="${esc(f.id)}" value="${esc(o.id)}"> ${esc(o.label)}</label>`).join('')}</div>`;
    const type = { number: 'number', date: 'date', datetime: 'datetime-local' }[f.kind] || 'text';
    const ph = { user: state.jira.status?.auth === 'personal access token' ? 'Jira username' : 'Atlassian account id', list: 'Comma separated' }[f.kind] || '';
    return `<input ${a} type="${type}" placeholder="${esc(ph)}" value="${esc(keep[f.id] || '')}">`;
  };
  const from = STATUS_LABEL[j.from || t.status] || t.status, to = STATUS_LABEL[j.to] || j.to;
  dlg.innerHTML = `<form method="dialog">
    <h2>Jira needs more to move ${esc(j.needs.key)}</h2>
    <p>Moving to <b>${esc(to)}</b> runs the Jira step "${esc(j.needs.transition)}", which requires the field${j.needs.fields.length > 1 ? 's' : ''} below. The task stays in <b>${esc(from)}</b> until Jira accepts it.</p>
    ${j.needs.why ? `<p class="why">${esc(j.needs.why)}</p>` : ''}
    ${j.needs.fields.map((f) => `<label for="ja-${esc(f.id)}">${esc(f.name)}</label>${input(f)}${f.why || f.onTicket ? `<small class="why">${esc([f.why, f.onTicket ? 'Saved on the ticket, then the move is retried.' : ''].filter(Boolean).join(' '))}</small>` : ''}`).join('')}
    <p class="err" role="alert"></p>
    <div class="acts"><button class="btn" value="go">Move in Jira</button><button class="btn ghost" value="cancel" formnovalidate>Keep in ${esc(from)}</button>${j.link ? `<a class="link" href="${esc(j.link)}" target="_blank" rel="noopener">Open in Jira</a>` : ''}</div>
  </form>`;
  const form = dlg.querySelector('form');
  form.addEventListener('submit', async (e) => {
    if (e.submitter?.value !== 'go') return; // Cancel and Esc just close
    e.preventDefault();
    const btn = e.submitter, err = form.querySelector('.err');
    const fields = {};
    for (const f of j.needs.fields) fields[f.id] = f.kind === 'multi' ? [...form.querySelectorAll(`input[name="${CSS.escape(f.id)}"]:checked`)].map((x) => x.value) : form.elements[f.id].value;
    const empty = j.needs.fields.find((f) => f.kind === 'multi' && !fields[f.id].length);
    if (empty) { err.textContent = `Pick at least one ${empty.name}.`; form.querySelector(`input[name="${CSS.escape(empty.id)}"]`)?.focus(); return; }
    btn.disabled = true; btn.textContent = 'Moving…'; err.textContent = '';
    try {
      const r = await call('POST', `/api/tasks/${encodeURIComponent(t.id)}/jira-move`, { status: j.to, fields });
      const res = r._jira; delete r._jira;
      const i = state.tasks.findIndex((x) => x.id === t.id); if (i >= 0) state.tasks[i] = r;
      if (res.ok) { dlg.close(); render(); renderDrawer(); toast(`${j.needs.key} moved to "${res.to || to}" in Jira`); return; }
      if (res.needs) { jiraAsk(r, { ...res, from: j.from }); dlg.querySelector('.err').textContent = 'Jira still needs: ' + res.needs.fields.map((f) => f.name).join(', '); return; }
      err.textContent = res.error;
    } catch (x) { err.textContent = x.message; }
    btn.disabled = false; btn.textContent = 'Move in Jira';
  });
  if (!dlg.open) dlg.showModal();
  form.querySelector('input,select')?.focus();
}
// Move one or more tasks to a status, with an Undo toast.
async function setStatus(ids, status) {
  const prev = ids.map((id) => state.tasks.find((t) => t.id === id)).filter((t) => t && t.status !== status).map((t) => [t.id, t.status, t.title]);
  if (!prev.length) { render(); return; }
  for (const [id] of prev) await patch(id, { status }, true);
  render(); renderDrawer();
  const moved = prev.filter(([id]) => state.tasks.find((t) => t.id === id)?.status === status); // Jira can refuse (and undo) a move
  if (!moved.length) return;
  toast(`Moved ${moved.length > 1 ? moved.length + ' tasks' : '"' + moved[0][2] + '"'} to ${STATUS_LABEL[status]}`, {
    label: 'Undo', fn: async () => { for (const [id, st] of moved) await patch(id, { status: st }, true); render(); renderDrawer(); },
  });
}

// ---------- quick add parsing ----------
function pickType(s) {
  const r = (state.cfg.rules || []).find(([, src]) => new RegExp(src, 'i').test(s));
  return r ? r[0] : 'follow-up';
}
function parse(s) {
  const type = pickType(s);
  const jira = (s.match(/\b[A-Z][A-Z0-9]+-\d+\b/) || [])[0] || '';
  const who = (s.match(/\b(?:for|with|to)\s+([A-Z][\w]+(?:\s[A-Z][\w]+)?)/) || [])[1] || '';
  const important = /(^|\s)!(\s|$)|!$/.test(s.trim());
  return { type, jira, who, important, title: s.replace(/(^|\s)!+(?=\s|$)|!+$/g, ' ').replace(/\s+/g, ' ').trim() };
}

// ---------- floating type menu: the type is auto-chosen; this changes it in one click ----------
let typeMenuFor = null;
function closeTypeMenu() { const m = $('typemenu'); m.hidden = true; typeMenuFor = null; }
function openTypeMenu(id, rect) {
  const t = state.tasks.find((x) => x.id === id); if (!t) return;
  const m = $('typemenu'); typeMenuFor = id;
  m.innerHTML = state.cfg.types.map((k) => `<button role="menuitemradio" aria-checked="${k === t.type}" class="t-${k}${k === t.type ? ' on' : ''}" data-settype="${k}"><i></i>${k}</button>`).join('');
  m.hidden = false;
  const w = m.offsetWidth, h = m.offsetHeight;
  m.style.left = Math.max(8, Math.min(rect.left, innerWidth - w - 8)) + 'px';
  m.style.top = Math.max(8, rect.bottom + h + 12 > innerHeight ? rect.top - h - 4 : rect.bottom + 4) + 'px';
  m.querySelector('.on')?.focus();
}
async function setType(id, type) {
  const t = state.tasks.find((x) => x.id === id); if (!t || t.type === type) return;
  const was = t.type;
  await patch(id, { type });
  toast(`"${t.title}" is now ${type}`, { label: 'Undo', fn: () => patch(id, { type: was }) });
}
document.addEventListener('click', (e) => {
  const tb = e.target.closest('[data-typemenu]'), pick = e.target.closest('[data-settype]');
  if (pick) { e.stopPropagation(); const id = typeMenuFor; closeTypeMenu(); setType(id, pick.dataset.settype).catch((err) => toast(err.message)); }
  else if (tb) { e.stopPropagation(); const again = typeMenuFor === tb.dataset.typemenu && !$('typemenu').hidden; closeTypeMenu(); if (!again) openTypeMenu(tb.dataset.typemenu, tb.getBoundingClientRect()); }
  else if (!e.target.closest('#typemenu')) closeTypeMenu();
}, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('typemenu').hidden) { closeTypeMenu(); e.stopImmediatePropagation(); } }, true);

// ---------- title auto-fix: capitalise + common typos; reversible, and Undo teaches the words ----------
const TYPOS = Object.fromEntries('teh the|recieve receive|recieved received|adress address|seperate separate|definately definitely|occured occurred|occurence occurrence|untill until|wich which|becuase because|beleive believe|thier their|wierd weird|acheive achieve|accomodate accommodate|enviroment environment|enviornment environment|dependancy dependency|dependancies dependencies|retreive retrieve|sucessful successful|successfull successful|sucess success|autentication authentication|athentication authentication|authetication authentication|authentification authentication|configration configuration|configuraton configuration|confguration configuration|deploymnet deployment|deploment deployment|delpoy deploy|pipline pipeline|piplines pipelines|databse database|requets requests|reqeust request|responce response|valdation validation|validaton validation|vulnerabilty vulnerability|vulnerabilites vulnerabilities|secuirty security|securty security|performace performance|perfomance performance|documention documentation|documentaton documentation|implemention implementation|implmentation implementation|implementaion implementation|intergration integration|integraton integration|repositry repository|reposiotry repository|brach branch|upgarde upgrade|migraton migration|migartion migration|notifcation notification|notifiaction notification|scheduel schedule|shedule schedule|aproval approval|approvel approval|bussiness business|buisness business|calender calendar|comming coming|writting writing|runing running|geting getting|seting setting|begining beginning|existance existence|foward forward|independant independent|lenght length|neccessary necessary|necesary necessary|noticable noticeable|prefered preferred|recomend recommend|refered referred|relevent relevant|specifc specific|sepcific specific|succesful successful|tommorow tomorrow|tomorow tomorrow|wether whether|taht that|hte the|adn and'.split('|').map((p) => p.split(' ')));
const KEEP_LOWER = new Set(['npm', 'pnpm', 'yarn', 'git', 'gh', 'kubectl', 'curl', 'ssh', 'eslint', 'pip', 'ios', 'macos', 'jq', 'vim', 'nvm', 'iphone', 'ipad']);
const DICT_KEY = 'workdesk.dict';
const getDict = () => { try { return new Set(JSON.parse(localStorage.getItem(DICT_KEY)) || []); } catch { return new Set(); } };
const learn = (words) => { try { const d = getDict(); words.forEach((w) => d.add(w.toLowerCase())); localStorage.setItem(DICT_KEY, JSON.stringify([...d])); } catch { /* no storage */ } };
const identLike = (w) => /[\d_./\\@#:()=<>]/.test(w) || /[a-z][A-Z]/.test(w) || (w.length > 1 && w === w.toUpperCase() && /[A-Z]/.test(w));
function autofix(title) {
  const dict = getDict(), changes = [];
  let text = title.split(/(\s+)/).map((tok) => {
    const m = /^([^\w]*)([\w'-]+)(.*)$/.exec(tok); if (!m || identLike(m[2])) return tok;
    const low = m[2].toLowerCase(), fix = TYPOS[low];
    if (!fix || dict.has(low)) return tok;
    const to = m[2][0] === m[2][0].toUpperCase() ? fix[0].toUpperCase() + fix.slice(1) : fix;
    changes.push({ from: m[2], to }); return m[1] + to + m[3];
  }).join('');
  const first = /^([^\w]*)([a-z][\w'-]*)/.exec(text);
  if (first && !identLike(first[2]) && !KEEP_LOWER.has(first[2].toLowerCase()) && !dict.has('#cap')) {
    text = first[1] + first[2][0].toUpperCase() + text.slice(first[1].length + 1);
    changes.push({ from: first[2], to: first[2][0].toUpperCase() + first[2].slice(1), cap: true });
  }
  return { text, changes };
}
// Offer Undo for an auto-fix: restores the original title and remembers the words so they are left alone next time.
function fixedTitle(id, original, fixed) {
  if (!fixed.changes.length) return;
  const desc = fixed.changes.map((c) => c.cap ? 'capitalised' : '"' + c.from + '" to "' + c.to + '"').join(', ');
  toast('Auto-fixed: ' + desc, { label: 'Undo', fn: async () => { learn(fixed.changes.filter((c) => !c.cap).map((c) => c.from)); await patch(id, { title: original }); } });
}

// ---------- events ----------
document.querySelectorAll('.navbtn[data-view]').forEach((b) => b.addEventListener('click', () => { state.view = b.dataset.view; state.open = null; render(); }));
['f-q', 'f-type', 'f-epic', 'f-imp'].forEach((id) => $(id).addEventListener('input', render));

const openRow = (e) => {
  const fb = e.target.closest('.flagbtn');
  if (fb) { const t = state.tasks.find((x) => x.id === fb.closest('.card-t').dataset.id); if (t) guard(() => patch(t.id, { important: !imp(t) }))(); return; }
  const r = e.target.closest('.row, .card-t');
  if (r && r.classList.contains('card-t') && (e.ctrlKey || e.metaKey || e.shiftKey || state.sel.size)) { toggleSel(r.dataset.id); return; }
  if (r) { state.open = r.dataset.id; renderDrawer(); } };
$('list').addEventListener('click', openRow);
$('list').addEventListener('keydown', (e) => { if (e.key === 'Enter') openRow(e); });

function toggleSel(id) { state.sel.has(id) ? state.sel.delete(id) : state.sel.add(id); render(); }
function renderBulk() {
  const b = $('bulk'), n = state.sel.size;
  b.hidden = !n;
  if (!n) { b.innerHTML = ''; return; }
  b.innerHTML = `<b>${n} selected</b><span class="bulk-steps">${state.cfg.statuses.map((s) => `<button data-bs="${s}">${STATUS_LABEL[s]}</button>`).join('')}</span><button data-bflag="1">Flag</button><button data-bclear="1">Clear</button>`;
}
$('bulk').addEventListener('click', guard(async (e) => {
  const el = e.target.closest('button'); if (!el) return;
  const ids = [...state.sel];
  if (el.dataset.bs) { await setStatus(ids, el.dataset.bs); state.sel.clear(); render(); }
  else if (el.dataset.bflag) { const on = !ids.every((id) => imp(state.tasks.find((t) => t.id === id))); for (const id of ids) await patch(id, { important: on }, true); render(); }
  else if (el.dataset.bclear) { state.sel.clear(); render(); }
}));

// ---------- saved filter presets (per browser, localStorage) ----------
const PRE_KEY = 'workdesk.presets';
const getPresets = () => { try { return JSON.parse(localStorage.getItem(PRE_KEY)) || []; } catch { return []; } };
const putPresets = (l) => { try { localStorage.setItem(PRE_KEY, JSON.stringify(l)); } catch { toast('Could not save presets in this browser.'); } };
const curFilter = () => ({ q: $('f-q').value.trim(), type: $('f-type').value, epic: $('f-epic').value, imp: $('f-imp').checked });
const sameFilter = (a, b) => a.q === b.q && a.type === b.type && a.epic === b.epic && a.imp === b.imp;
let namingPreset = false;
function renderPresets() {
  const box = $('presets'); box.hidden = $('filters').hidden;
  if (box.hidden) return;
  const cur = curFilter();
  box.innerHTML = getPresets().map((p, i) => `<span class="pchip${sameFilter(p.f, cur) ? ' on' : ''}"><button data-p="${i}">${esc(p.name)}</button><button data-pdel="${i}" aria-label="Delete preset ${esc(p.name)}">x</button></span>`).join('')
    + (namingPreset ? `<form id="pform" class="pform"><input id="pname" placeholder="Preset name" maxlength="30" aria-label="Preset name"><button class="btn" type="submit">Save</button></form>`
      : '<button class="link" id="psave">+ save current filters</button>');
  if (namingPreset) $('pname').focus();
}
$('presets').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  const list = getPresets();
  if (b.dataset.p !== undefined) { const f = list[+b.dataset.p].f; $('f-q').value = f.q; $('f-type').value = f.type; $('f-epic').value = f.epic; $('f-imp').checked = f.imp; render(); }
  else if (b.dataset.pdel !== undefined) { list.splice(+b.dataset.pdel, 1); putPresets(list); renderPresets(); }
  else if (b.id === 'psave') { namingPreset = true; renderPresets(); }
});
$('presets').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('pname').value.trim(); namingPreset = false;
  if (name) { const l = getPresets().filter((p) => p.name !== name); l.push({ name, f: curFilter() }); putPresets(l); }
  renderPresets();
});

$('list').addEventListener('dragstart', (e) => { const c = e.target.closest('.card-t'); if (!c) return; dragId = c.dataset.id; c.classList.add('drag'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', dragId); });
$('list').addEventListener('dragend', () => { dragId = null; if (staleDuringDrag) { staleDuringDrag = false; render(); } document.querySelectorAll('.drag,.over').forEach((x) => x.classList.remove('drag', 'over')); });
// Nearest visible column to the pointer; distance is measured on both axes because the board wraps onto several rows on narrow windows.
const colAt = (e) => { let best = null, bd = Infinity; for (const c of document.querySelectorAll('.board .col')) { if (!c.offsetWidth) continue; const r = c.getBoundingClientRect(), dx = Math.max(r.left - e.clientX, 0, e.clientX - r.right), dy = Math.max(r.top - e.clientY, 0, e.clientY - r.bottom), d = dx * dx + dy * dy; if (d < bd) { bd = d; best = c; } } return best; };
// Where in this column would the dragged card land? Returns the card it goes before (null = at the end).
function dropBefore(col, e) {
  return [...col.querySelectorAll('.card-t:not(.drag)')].find((x) => { const r = x.getBoundingClientRect(); return e.clientY < r.top + r.height / 2; }) || null;
}
// Give the dropped cards an order that matches where they were dropped. Normally that is a value between the two neighbours (one write).
// But the column shows cards grouped (stories under their epic), so its display order can differ from the stored order; then, or when
// there is no gap left, the whole column is numbered in display order instead (only the cards whose number changes are written).
async function placeAmong(seq, ids) {
  const ord = (id) => Number((state.tasks.find((y) => y.id === id) || {}).order) || 0;
  const rest = seq.filter((x) => !ids.includes(x)).map(ord);
  const i = seq.indexOf(ids[0]), n = ids.length;
  const prev = i > 0 ? ord(seq[i - 1]) : null, next = i + n < seq.length ? ord(seq[i + n]) : null;
  const lo = prev ?? (next === null ? 0 : next - n - 1), hi = next ?? (prev === null ? n + 1 : prev + n + 1);
  const sorted = rest.every((v, k) => k === 0 || v > rest[k - 1]);
  if (sorted && hi - lo > 1e-3 * (n + 1)) await Promise.all(ids.map((x, k) => patch(x, { order: lo + ((hi - lo) * (k + 1)) / (n + 1) }, true)));
  else await Promise.all(seq.map((x, k) => (ord(x) !== k + 1 ? patch(x, { order: k + 1 }, true) : null)));
}
$('list').addEventListener('dragover', (e) => {
  const c = colAt(e); if (!c || !dragId) return; e.preventDefault();
  document.querySelectorAll('.over').forEach((x) => x !== c && x.classList.remove('over')); c.classList.add('over');
  document.querySelectorAll('.drop-before,.drop-end').forEach((x) => x.classList.remove('drop-before', 'drop-end'));
  const b = dropBefore(c, e);
  if (b) b.classList.add('drop-before'); else c.querySelector('.cards')?.classList.add('drop-end');
});
$('list').addEventListener('drop', guard(async (e) => {
  const c = colAt(e); if (!c || !dragId) return; e.preventDefault();
  const t = state.tasks.find((x) => x.id === dragId); const id = dragId; dragId = null;
  const ids = state.sel.has(id) ? [...state.sel] : [id];
  const status = c.dataset.status;
  const was = ids.filter((x) => isArch(state.tasks.find((y) => y.id === x) || {}));
  if (was.length) await archive(was, false);
  const before = dropBefore(c, e);
  const seq = [...c.querySelectorAll('.card-t')].map((x) => x.dataset.id).filter((x) => !ids.includes(x));
  const at = before ? seq.indexOf(before.dataset.id) : seq.length;
  seq.splice(at < 0 ? seq.length : at, 0, ...ids);
  document.querySelectorAll('.drop-before,.drop-end').forEach((x) => x.classList.remove('drop-before', 'drop-end'));
  if (t && (t.status !== status || ids.length > 1)) await setStatus(ids, status);
  // A card Jira refused to move went back to its column; ordering it here would misplace it there.
  if (ids.every((x) => state.tasks.find((y) => y.id === x)?.status === status)) await placeAmong(seq, ids);
  render();
}));

// Archive: drop a card (or the selection) on the Archive tray at the right edge.
async function archive(ids, on) {
  const prev = ids.map((id) => state.tasks.find((t) => t.id === id)).filter((t) => t && isArch(t) !== on);
  for (const t of prev) await patch(t.id, { archived: on }, true);
  if (state.open && on && ids.includes(state.open)) state.open = null;
  render(); renderDrawer();
  if (prev.length) toast(`${on ? 'Archived' : 'Restored'} ${prev.length > 1 ? prev.length + ' tasks' : '"' + prev[0].title + '"'}`, { label: 'Undo', fn: async () => { for (const t of prev) await patch(t.id, { archived: !on }, true); render(); renderDrawer(); } });
}
// The Archive tray peeks out of the right edge while a card is dragged, half hidden; hover it to open it. It overlays the page, so nothing
// reflows during a drag. It must always go away: dragend never arrives if the card was re-rendered mid-drag, so also hide on drop,
// on mouse release, and when dragover events stop coming (they repeat while a drag is alive).
const tray = $('tray');
let dragT;
const dragHide = () => { clearTimeout(dragT); tray.classList.remove('show', 'over'); if (!dragId) return; dragId = null; if (staleDuringDrag) { staleDuringDrag = false; render(); } };
const dragKeep = () => { clearTimeout(dragT); dragT = setTimeout(dragHide, 1500); };
document.addEventListener('dragstart', (e) => { if (e.target.closest?.('.card-t')) setTimeout(() => { tray.classList.add('show'); dragKeep(); }, 0); });
document.addEventListener('dragover', () => { if (tray.classList.contains('show')) dragKeep(); });
document.addEventListener('dragend', dragHide);
document.addEventListener('drop', dragHide);
document.addEventListener('mouseup', dragHide);
tray.addEventListener('dragover', (e) => { if (!dragId) return; e.preventDefault(); tray.classList.add('over'); });
tray.addEventListener('dragleave', () => tray.classList.remove('over'));
tray.addEventListener('drop', guard(async (e) => {
  e.preventDefault(); if (!dragId) return;
  const id = dragId; dragId = null; dragHide();
  await archive(state.sel.has(id) ? [...state.sel] : [id], true);
}));

// External links (Jira, PRs): the desktop window cannot open new windows, so the server opens them in the default browser.
document.addEventListener('click', (e) => {
  const a = e.target.closest?.('a[href^="http"]'); if (!a) return;
  e.preventDefault();
  call('POST', '/api/open', { url: a.href }).catch((err) => { toast(err.message); });
});

$('drawer').addEventListener('click', guard(async (e) => {
  const t = state.tasks.find((x) => x.id === state.open); if (!t) return;
  const el = e.target;
  const op = el.closest('[data-open]');
  if (op) { state.open = op.dataset.open; renderDrawer(); return; }
  if (el.id === 'd-close') { state.open = null; renderDrawer(); }
  else if (el.dataset.s) await setStatus([t.id], el.dataset.s);
  else if (el.id === 'd-arch') { await archive([t.id], !isArch(t)); }
  else if (el.id === 'd-del') {
    if (!el.classList.contains('armed')) { el.classList.add('armed'); el.textContent = 'click again to delete'; return; }
    await call('DELETE', '/api/tasks/' + encodeURIComponent(t.id)); state.open = null; document.activeElement?.blur?.(); await load(); renderDrawer();
  } else if (el.id === 'd-claude') {
    const cmd = `/task ${t.jira || t.id}`;
    try { const r = await call('POST', '/api/tasks/' + encodeURIComponent(t.id) + '/claude', {}); toast(`Opened in Claude desktop`); }
    catch (err) { try { await navigator.clipboard.writeText(cmd); } catch { /* ignore */ } toast(`${err.message} Copied "${cmd}" instead.`); }
  } else if (el.id === 'd-copy') {
    const cmd = `/task ${t.jira || t.id}`;
    try { await navigator.clipboard.writeText(cmd); toast(`Copied "${cmd}"`); } catch { toast(`Run in Claude Code: ${cmd}`); }
  }
}));
$('drawer').addEventListener('change', guard(async (e) => {
  const t = state.tasks.find((x) => x.id === state.open); if (!t) return;
  if (e.target.dataset.imp !== undefined) await patch(t.id, { important: e.target.checked });
  else if (e.target.dataset.c !== undefined) {
    let n = -1;
    const body = t.body.replace(/^(\s*- \[)([ xX])(\] .*)$/gm, (all, a, _c, b) => (++n === +e.target.dataset.c ? a + (e.target.checked ? 'x' : ' ') + b : all));
    await patch(t.id, { body });
  } else if (e.target.id === 'd-body') await patch(t.id, { body: splitBody(t.body).block + e.target.value });
  else if (e.target.dataset.f === 'title') {
    const orig = e.target.value.trim(), fx = autofix(orig); await patch(t.id, { title: fx.text }); fixedTitle(t.id, orig, fx);
  } else if (e.target.dataset.f) await patch(t.id, { [e.target.dataset.f]: e.target.value });
}));

$('quick-input').addEventListener('input', (e) => {
  const v = e.target.value.trim();
  if (!v) { $('parse').innerHTML = ''; return; }
  const p = parse(v);
  $('parse').innerHTML = `→ ${chip(p.type)}${p.who ? `<span>· who ${esc(p.who)}</span>` : ''}${p.jira ? `<span>· ${esc(p.jira)}</span>` : ''}${p.important ? '<span class="pflag">! important</span>' : ''}`;
});
$('quick').addEventListener('submit', guard(async (e) => {
  e.preventDefault();
  const v = $('quick-input').value.trim(); if (!v) return;
  const p = parse(v);
  const fx = autofix(p.title);
  const t = await call('POST', '/api/tasks', { type: p.type, title: fx.text, jira: p.jira, who: p.who, important: p.important, status: 'inbox' });
  $('quick-input').value = ''; $('parse').textContent = `Added: ${t.title}`;
  await load();
  fixedTitle(t.id, p.title, fx);
  if (!fx.changes.length) toast(`Added as ${t.type}`, { label: 'Change', fn: () => openTypeMenu(t.id, $('quick-input').getBoundingClientRect()) });
}));

// ---------- Jira page ----------
const J = state.jira = { status: null, test: '', key: '', busy: '', last: null };
function jiraPanel() {
  const s = J.status;
  if (!s) return '<div class="empty">Loading…</div>';
  if (s.error) return `<div class="card"><h2>Jira is unavailable</h2><p>${esc(s.error)}</p><p>WorkDesk's server may be an older version than this page. Stop it and run <code>npm start</code> again in the workdesk folder.</p></div>`;
  const off = !s.configured || J.busy ? 'disabled' : '';
  const res = J.last;
  const changed = res ? (res.items || []) : [];
  return `<div class="jira">
  <section class="card"><h2>Connection</h2>
    ${s.configured
      ? `<p><b>${esc(s.base)}</b><br><span class="meta">signed in with ${esc(s.auth)}</span></p>
         <div class="actions"><button class="btn ghost" id="jira-test" ${J.busy ? 'disabled' : ''}>Test connection</button><span class="meta" id="jira-test-out">${esc(J.test)}</span></div>`
      : `<p>Jira is not set up yet. Add <code>JIRA_BASE_URL</code> and either <code>JIRA_EMAIL</code> + <code>JIRA_TOKEN</code> (Jira Cloud) or <code>JIRA_PAT</code> (Server/Data Center) to <code>workdesk/.env</code>, then restart WorkDesk.</p>`}
  </section>
  <section class="card"><h2>Sync my tickets</h2>
    <p>Pulls the tickets matching this query and creates a task for each. Tasks you already have are refreshed (title, epic link, done). Your notes and local statuses stay.</p>
    <p><code>${esc(s.jql)}</code></p>
    <div class="actions"><button class="btn" id="jira-sync" ${off}>${J.busy === 'sync' ? 'Syncing…' : 'Sync my tickets'}</button><button class="btn ghost" id="pr-refresh" ${J.busy ? 'disabled' : ''}>${J.busy === 'pr' ? 'Checking…' : 'Refresh PR status'}</button></div>
    ${s.sync ? `<p class="meta" id="jira-auto">${s.sync.schedule.off ? 'Automatic sync is off.' : `Automatic sync at ${s.sync.schedule.times.join(', ')} (${s.sync.schedule.days.join(', ')}). `}${s.sync.at ? `Last sync ${s.sync.ok ? 'OK' : 'failed: ' + esc(s.sync.error)}, ${new Date(s.sync.at).toLocaleString()} (${s.sync.trigger}).` : 'Not synced yet.'}</p>` : ''}
  </section>
  <section class="card"><h2>Import tickets</h2>
    <p>Enter one or more ticket keys, or paste Jira links. An epic key also brings in its stories.</p>
    <form class="actions" id="jira-import-form"><input id="jira-key" placeholder="ABC-2481, ABC-2400 or a Jira link" value="${esc(J.key)}" aria-label="Ticket keys" ${off}><button class="btn" type="submit" ${off}>${J.busy === 'import' ? 'Importing…' : 'Import'}</button></form>
  </section>
  ${res ? `<section class="card"><h2>Last result</h2>
    <p>${res.found !== undefined ? `${res.found} tickets found. ` : ''}${res.created} new, ${res.updated} updated, ${res.unchanged} unchanged.</p>
    ${changed.length ? `<div class="items">${changed.map((i) => `<div class="item"><span class="meta">${esc(i.key)}</span><span class="title">${esc(i.title)}</span>${chip(i.type)}<span class="status ${i.action === 'created' ? 'done' : ''}">${i.action}</span></div>`).join('')}</div>` : ''}
  </section>` : ''}
  </div>`;
}
async function jiraRun(kind, fn) {
  J.busy = kind; render();
  try { J.last = await fn(); await load(); } catch (e) { toast(e.message); } finally { J.busy = ''; render(); }
}
$('list').addEventListener('click', guard(async (e) => {
  const id = e.target.id;
  if (id === 'pr-refresh') { J.busy = 'pr'; render(); try { const r = await call('POST', '/api/pr/refresh'); toast(`${r.checked} PR${r.checked === 1 ? '' : 's'} checked, ${r.moved} task${r.moved === 1 ? '' : 's'} moved${r.errors.length ? ', ' + r.errors.length + ' failed (' + r.errors[0] + ')' : ''}`); } finally { J.busy = ''; render(); } return; }
  if (id === 'jira-sync') await jiraRun('sync', () => call('POST', '/api/jira/sync'));
  else if (id === 'jira-test') {
    J.test = 'Testing…'; $('jira-test-out').textContent = J.test;
    try { const r = await call('POST', '/api/jira/test'); J.test = `Connected as ${r.user}`; } catch (err) { J.test = err.message; }
    render();
  }
}));
$('list').addEventListener('input', (e) => { if (e.target.id === 'jira-key') J.key = e.target.value; });
$('list').addEventListener('submit', (e) => {
  if (e.target.id !== 'jira-import-form') return;
  e.preventDefault();
  if (!J.key.trim()) return toast('Enter a ticket key first.');
  jiraRun('import', async () => { const r = await call('POST', '/api/jira/import', { keys: J.key }); J.key = ''; return r; });
});

// ---------- refresh: reload from disk, then pull Jira (which also checks PRs) when it is set up ----------
let refreshing = false;
async function refreshAll() {
  if (refreshing) return;
  refreshing = true; $('refresh').disabled = true; $('refresh').classList.add('busy');
  try {
    await load();
    if (state.jira.status?.configured) {
      const r = await call('POST', '/api/jira/sync');
      await load();
      toast(`Refreshed. Jira: ${r.created} new, ${r.updated} updated.`);
    } else toast('Refreshed.');
  } catch (e) { toast('Refreshed from disk, but Jira sync failed: ' + e.message); }
  finally { refreshing = false; $('refresh').disabled = false; $('refresh').classList.remove('busy'); }
}
$('refresh').addEventListener('click', refreshAll);

// ---------- Settings page: click-first controls that save and apply at once ----------
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const JQL_PRESETS = [
  ['Assigned to me, open', ''],
  ['Mine or reported by me', '(assignee = currentUser() OR reporter = currentUser()) AND resolution = Unresolved ORDER BY updated DESC'],
  ['Current sprint', 'assignee = currentUser() AND sprint in openSprints() ORDER BY updated DESC'],
  ['Updated in 14 days', 'assignee = currentUser() AND updated >= -14d ORDER BY updated DESC'],
];
const S = state.settings = { data: null, errors: {}, test: '', custom: false, conn: false, adding: false, upd: { busy: '', info: null, msg: '' } };
const sv = (k) => S.data.values[k];
const times = () => (sv('WORKDESK_SYNC_TIMES') || '09:00,13:00,17:00').split(',').map((x) => x.trim()).filter(Boolean);
const days = () => (sv('WORKDESK_SYNC_DAYS') || 'sun,mon,tue,wed,thu').split(',').map((d) => d.trim().slice(0, 3));
const lsCount = (key) => { try { const v = JSON.parse(localStorage.getItem(key)); return Array.isArray(v) ? v.length : Object.keys(v || {}).length; } catch { return 0; } };

async function loadSettings() { S.data = await call('GET', '/api/settings'); render(); }
async function saveKeys(changes) {
  try {
    S.data = await call('PUT', '/api/settings', { values: changes });
    S.errors = {}; S.test = '';
    state.jira.status = await call('GET', '/api/jira/status').catch(() => state.jira.status);
    toast('Saved');
  } catch (err) { S.errors = err.errors || {}; toast(err.message); }
  render();
}

const swt = (k, label, help) => `<label class="tgl"><input type="checkbox" data-sw="${k}" ${sv(k) ? 'checked' : ''}><span class="knob"></span><span class="tl"><b>${esc(label)}</b>${help ? `<small>${esc(help)}</small>` : ''}</span></label>`;
const txt = (k, label, help, ph = '') => `<div class="sfield"><label for="s-${k}">${esc(label)}</label><input id="s-${k}" data-txt="${k}" value="${esc(sv(k))}" placeholder="${esc(ph)}" spellcheck="false">${help ? `<small>${esc(help)}</small>` : ''}${S.errors[k] ? `<div class="need">${esc(S.errors[k])}</div>` : ''}</div>`;
const secret = (k, label, help) => {
  const set = S.data.secretSet[k];
  return `<div class="sfield"><label for="s-${k}">${esc(label)}</label><div class="inl"><input id="s-${k}" type="password" autocomplete="new-password" data-txt="${k}" placeholder="${set ? '•••••••• saved, type to replace' : 'not set'}">${set ? `<button class="btn ghost sm" data-sclear="${k}">Remove</button>` : ''}</div><small>${esc(help)}</small>${S.errors[k] ? `<div class="need">${esc(S.errors[k])}</div>` : ''}</div>`;
};

function settingsPanel() {
  if (!S.data) { loadSettings().catch((e) => toast(e.message)); return '<div class="empty">Loading…</div>'; }
  const st = state.jira.status || {}, jql = sv('JIRA_JQL');
  const preset = JQL_PRESETS.findIndex(([, q]) => q === jql);
  const custom = S.custom || preset < 0;
  const on = days(), ts = times();
  const u = S.upd;
  return `<div class="settings">
  <section class="card"><h2>Jira connection <span class="pill ${st.configured ? 'ok' : ''}">${st.configured ? 'configured' : 'not set up'}</span></h2>
    ${st.configured ? `<p class="meta">${esc(st.base)}, signed in with ${esc(st.auth)}</p>` : '<p class="meta">Add your Jira address and a token to sync tickets and move them from the board.</p>'}
    <div class="actions"><button class="btn" id="set-test" ${st.configured ? '' : 'disabled'}>Test connection</button><button class="btn ghost" id="set-conn">${S.conn || !st.configured ? 'Hide details' : 'Edit connection'}</button><span class="meta" id="set-test-out">${esc(S.test)}</span></div>
    ${S.conn || !st.configured ? `<div class="sgrid">${txt('JIRA_BASE_URL', 'Jira address', '', 'https://yourcompany.atlassian.net')}${txt('JIRA_EMAIL', 'Email (Jira Cloud)')}${secret('JIRA_TOKEN', 'API token (Jira Cloud)', 'Create at id.atlassian.com, Security, API tokens.')}</div>` : ''}
  </section>
  <section class="card"><h2>Which tickets to sync</h2>
    <div class="segs">${JQL_PRESETS.map(([l], i) => `<button class="seg2 ${!custom && preset === i ? 'on' : ''}" data-jqlp="${i}">${esc(l)}</button>`).join('')}<button class="seg2 ${custom ? 'on' : ''}" data-jqlp="custom">Custom query</button></div>
    ${custom ? txt('JIRA_JQL', 'JQL', 'Any Jira query. Leave empty for the default.') : `<p class="meta"><code>${esc(jql || 'assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC')}</code></p>`}
    ${swt('JIRA_PUSH', 'Move the Jira ticket when I move a task', 'Only the status is written back.')}
  </section>
  <section class="card"><h2>Automatic sync</h2>
    ${swt('WORKDESK_SYNC', 'Sync Jira by itself', 'A slot missed while the app was closed runs once on the next start.')}
    ${sv('WORKDESK_SYNC') ? `<div class="sfield"><label>Times</label><div class="chips">${ts.map((t) => `<span class="tchip">${esc(t)}${ts.length > 1 ? `<button data-tdel="${esc(t)}" aria-label="Remove ${esc(t)}">×</button>` : ''}</span>`).join('')}${S.adding ? '<input type="time" id="s-tadd" autofocus>' : '<button class="tadd" id="s-tshow">+ add time</button>'}</div>${S.errors.WORKDESK_SYNC_TIMES ? `<div class="need">${esc(S.errors.WORKDESK_SYNC_TIMES)}</div>` : ''}</div>
    <div class="sfield"><label>Days</label><div class="chips">${DAY_NAMES.map((d) => `<button class="dpill ${on.includes(d) ? 'on' : ''}" data-day="${d}" aria-pressed="${on.includes(d)}">${d}</button>`).join('')}</div></div>` : ''}
  </section>
  <section class="card"><h2>Updates</h2>
    <p class="meta">Installed version ${esc(S.data.version)}. Tasks and settings are never touched; old program files are kept in backup/.</p>
    <div class="actions"><button class="btn ghost" id="upd-check" ${u.busy ? 'disabled' : ''}>${u.busy === 'check' ? 'Checking…' : 'Check for updates'}</button>${u.info?.available && u.info.packaged ? `<button class="btn" id="upd-apply" ${u.busy ? 'disabled' : ''}>${u.busy === 'apply' ? 'Updating, WorkDesk will restart…' : `Update to ${esc(u.info.latest)}`}</button>` : ''}<span class="meta">${esc(u.msg)}</span></div>
    <p class="meta">Updates come from ${S.data.source ? `<code>${esc(S.data.source)}</code> on GitHub` : 'GitHub'}.</p>
  </section>
  <section class="card"><h2>Workspace</h2>
    ${txt('WORKDESK_REPOS', 'Workspace folder', 'The folder that holds your repositories. "Work on this with Claude" opens the task\'s repo inside it.', 'C:\\path\\to\\repositories')}
  </section>
  <section class="card"><h2>This browser</h2>
    <div class="actions"><button class="btn ghost" id="set-clear-dict" ${lsCount(DICT_KEY) ? '' : 'disabled'}>Forget learned words (${lsCount(DICT_KEY)})</button><button class="btn ghost" id="set-clear-presets" ${lsCount(PRE_KEY) ? '' : 'disabled'}>Delete saved filters (${lsCount(PRE_KEY)})</button></div>
  </section>
  <section class="card"><h2>About</h2>
    <p class="meta">WorkDesk ${esc(S.data.version)}<br>Tasks: <code>${esc(S.data.dir)}</code><br>Settings file: <code>${esc(S.data.file)}</code><br>Start with Windows and quick add (Ctrl+Alt+N) are in the tray menu.</p>
  </section>
  </div>`;
}

$('list').addEventListener('change', guard(async (e) => {
  const t = e.target;
  if (!S.data) return;
  if (t.dataset.sw) await saveKeys({ [t.dataset.sw]: t.checked });
  else if (t.dataset.txt) { const v = t.value.trim(); if (t.type === 'password' && !v) return; await saveKeys({ [t.dataset.txt]: v }); }
  else if (t.id === 's-tadd') {
    S.adding = false;
    if (t.value && !times().includes(t.value)) await saveKeys({ WORKDESK_SYNC_TIMES: [...times(), t.value].sort().join(',') }); else render();
  }
}));
$('list').addEventListener('click', guard(async (e) => {
  const el = e.target.closest('button'); if (!el || !S.data || state.view !== 'settings') return;
  const id = el.id, d = el.dataset;
  if (d.jqlp !== undefined) {
    if (d.jqlp === 'custom') { S.custom = true; render(); } else { S.custom = false; await saveKeys({ JIRA_JQL: JQL_PRESETS[+d.jqlp][1] }); }
  }
  else if (d.day) { const cur = new Set(days()); cur.has(d.day) ? cur.delete(d.day) : cur.add(d.day); if (!cur.size) return toast('Pick at least one day.'); await saveKeys({ WORKDESK_SYNC_DAYS: DAY_NAMES.filter((x) => cur.has(x)).join(',') }); }
  else if (d.tdel) await saveKeys({ WORKDESK_SYNC_TIMES: times().filter((x) => x !== d.tdel).join(',') });
  else if (id === 's-tshow') { S.adding = true; render(); $('s-tadd')?.focus(); }
  else if (d.sclear) await saveKeys({ [d.sclear]: null });
  else if (id === 'set-conn') { S.conn = !S.conn; render(); }
  else if (id === 'set-test') {
    S.test = 'Testing…'; $('set-test-out').textContent = S.test;
    try { const r = await call('POST', '/api/jira/test'); S.test = `Connected as ${r.user}`; } catch (err) { S.test = err.message; }
    render();
  }
  else if (id === 'upd-check') {
    S.upd = { busy: 'check', info: null, msg: '' }; render();
    try {
      const i = await call('POST', '/api/update/check');
      // A copy running from source cannot install a release; it is updated with git pull, so no Update button there.
      S.upd = { busy: '', info: i, msg: !i.available ? `You are up to date (${i.current}).` : i.packaged ? `Version ${i.latest} is available.` : `Version ${i.latest} is out. This copy runs from source: update it with git pull.` };
      document.querySelector('.navbtn[data-view=settings]')?.classList.toggle('has-upd', !!(i.available && i.packaged));
    } catch (err) { S.upd = { busy: '', info: null, msg: err.message }; }
    render();
  }
  else if (id === 'upd-apply') {
    const info = S.upd.info;
    S.upd.busy = 'apply'; render();
    const err = await runUpdate(info);
    if (err) { S.upd = { busy: '', info, msg: err }; render(); }
  }
  else if (id === 'set-clear-dict') { try { localStorage.removeItem(DICT_KEY); } catch { /* ignore */ } toast('Learned words cleared.'); render(); }
  else if (id === 'set-clear-presets') { try { localStorage.removeItem(PRE_KEY); } catch { /* ignore */ } toast('Saved filters deleted.'); render(); }
}));

// Arrow keys move between cards; Shift+Left/Right moves the focused card to the next status; X selects; F flags.
function cardKeys(e, c, typing) {
  const cols = [...document.querySelectorAll('.board .col')];
  if (typing || e.ctrlKey || e.metaKey || e.altKey || state.view !== 'board' || !cols.length) return false;
  if (!c) {
    if (!e.key.startsWith('Arrow')) return false;
    cols.flatMap((col) => [...col.querySelectorAll('.card-t')])[0]?.focus(); return true;
  }
  const col = c.closest('.col'), ci = cols.indexOf(col), mine = [...col.querySelectorAll('.card-t')], i = mine.indexOf(c);
  if (e.key === 'ArrowDown') { (mine[i + 1] || c).focus(); }
  else if (e.key === 'ArrowUp') { (mine[i - 1] || c).focus(); }
  else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    const d = e.key === 'ArrowRight' ? 1 : -1;
    if (e.shiftKey) { const to = cols[ci + d]; if (to) setStatus([c.dataset.id], to.dataset.status).catch((err) => toast(err.message)); }
    else for (let k = ci + d; cols[k]; k += d) { const cs = cols[k].querySelectorAll('.card-t'); if (cs.length) { cs[Math.min(i, cs.length - 1)].focus(); break; } }
  }
  else if (e.key === 'x') toggleSel(c.dataset.id);
  else if (e.key === 'f') { const t = state.tasks.find((x) => x.id === c.dataset.id); if (t) patch(t.id, { important: !imp(t) }).catch((err) => toast(err.message)); }
  else return false;
  return true;
}
document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
  if (cardKeys(e, document.activeElement.closest?.('.card-t'), typing)) { e.preventDefault(); return; }
  if (e.key === 'Escape' && state.sel.size) { state.sel.clear(); render(); }
  else if (e.key === 'Escape') { state.open = null; renderDrawer(); document.activeElement.blur?.(); }
  else if (!typing && e.key === 'n') { e.preventDefault(); $('quick-input').focus(); }
  else if (!typing && e.key === 'r' && !e.ctrlKey && !e.metaKey) { e.preventDefault(); refreshAll(); }
  else if (!typing && e.key === '/') { e.preventDefault(); state.view = 'list'; render(); $('f-q').focus(); }
});

// Shared by the Settings button and the start-up banner. Resolves with an error message, or reloads once the new version is up.
async function runUpdate(info) {
  if (!confirm(`Update WorkDesk to ${info.latest}? ${info.edition === 'web' ? 'WorkDesk restarts in its window and this page reloads' : 'The app closes and reopens by itself'}. Your tasks and settings are kept.`)) return 'Cancelled.';
  try { await call('POST', '/api/update/apply'); } catch (err) { return err.message; }
  const was = S.data.version;
  for (let n = 0; n < 90; n++) {
    await new Promise((r) => setTimeout(r, 2000));
    try { const c = await fetch('/api/config').then((r) => r.json()); if (c.version && c.version !== was) { location.reload(); return ''; } } catch { /* restarting */ }
  }
  return 'Still not back. Open WorkDesk.exe manually; see update.log next to it.';
}

// At start and every 30 minutes: if a newer release exists, offer it in a one-click banner and mark Settings. Silent when offline or from source.
let dismissed = '';
async function updateBanner() {
  try {
    const i = await call('POST', '/api/update/check');
    if (!i.packaged) return;
    document.querySelector('.navbtn[data-view=settings]')?.classList.toggle('has-upd', !!i.available);
    if (!i.available) return;
    S.upd = { busy: '', info: i, msg: `Version ${i.latest} is available.` }; // Settings shows the Update button straight away
    if (state.view === 'settings') render();
    if (dismissed === i.latest || document.querySelector('.updbar')) return;
    const bar = document.createElement('div');
    bar.className = 'updbar';
    bar.innerHTML = `<span>Version ${esc(i.latest)} is available</span><button class="btn" id="ub-go">Update now</button><button class="btn ghost" id="ub-no">Later</button>`;
    document.body.appendChild(bar);
    bar.querySelector('#ub-no').onclick = () => { dismissed = i.latest; bar.remove(); };
    bar.querySelector('#ub-go').onclick = async (e) => {
      e.target.disabled = true; e.target.textContent = 'Updating, WorkDesk will restart…';
      const err = await runUpdate(i);
      if (err) { toast(err); e.target.disabled = false; e.target.textContent = 'Update now'; }
    };
  } catch { /* offline or no source: stay quiet */ }
}
setInterval(updateBanner, 30 * 60 * 1000);

const events = new EventSource('/api/events');
let reloadT;
events.addEventListener('change', () => { clearTimeout(reloadT); reloadT = setTimeout(() => load().catch(() => {}), 200); });
load().then(updateBanner).catch((e) => toast(e.message));
