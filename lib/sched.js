'use strict';
// Background Jira sync: a few fixed times per work day (default 09:00, 13:00, 17:00, Sun-Thu).
// A slot that passed while the app was closed runs once on the next check (catch-up).
const fs = require('fs');
const path = require('path');
const tasks = require('./tasks');
const jira = require('./jira');

const STATE = process.env.WORKDESK_STATE || path.join(path.dirname(tasks.DIR), '.workdesk-sync.json');
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function config(env = process.env) {
  const times = (env.WORKDESK_SYNC_TIMES || '09:00,13:00,17:00').split(',').map((s) => /^(\d{1,2}):(\d{2})$/.exec(s.trim())).filter(Boolean).map((m) => +m[1] * 60 + +m[2]).filter((n) => n < 1440).sort((a, b) => a - b);
  const days = (env.WORKDESK_SYNC_DAYS || 'sun,mon,tue,wed,thu').toLowerCase().split(',').map((s) => DAYS.indexOf(s.trim().slice(0, 3))).filter((n) => n >= 0);
  return { times, days, off: /^(0|off|false|no)$/i.test(env.WORKDESK_SYNC || '') };
}

// The latest scheduled slot at or before `now` on a work day, as a Date (or null).
function lastSlot(now, cfg) {
  if (cfg.off || !cfg.days.includes(now.getDay())) return null;
  const mins = now.getHours() * 60 + now.getMinutes();
  const t = [...cfg.times].reverse().find((x) => x <= mins);
  if (t === undefined) return null;
  const d = new Date(now); d.setHours(Math.floor(t / 60), t % 60, 0, 0); return d;
}
const isDue = (now, last, cfg) => { const s = lastSlot(now, cfg); return !!s && (!last || new Date(last) < s); };

function readState() { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; } }
function writeState(s) { try { fs.writeFileSync(STATE, JSON.stringify(s)); } catch { /* read-only location: keep in memory only */ } }

let state = readState(), running = false;
const info = () => ({ ...state, schedule: { times: config().times.map((m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`), days: config().days.map((d) => DAYS[d]), off: config().off } });

async function run(trigger, hooks = []) {
  if (running) return state;
  running = true;
  const at = new Date().toISOString();
  try {
    const r = await jira.syncMine();
    for (const h of hooks) { try { await h(); } catch { /* a hook must not break the sync */ } }
    state = { at, trigger, ok: true, summary: r.summary || r };
  } catch (e) { state = { at, trigger, ok: false, error: e.message }; }
  writeState(state); running = false;
  return state;
}

function start(hooks = [], every = 60000) {
  const tick = () => { if (jira.status().configured && isDue(new Date(), state.at, config())) run('schedule', hooks); };
  setTimeout(tick, 5000).unref?.();
  return setInterval(tick, every).unref?.();
}

module.exports = { config, lastSlot, isDue, run, start, info };
