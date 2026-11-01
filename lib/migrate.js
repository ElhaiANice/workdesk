'use strict';
// Data migrations. Tasks are plain Markdown, so most releases need none; when one does, add a step here.
// The schema number lives next to the tasks folder (.workdesk-schema). Before a step runs, the tasks are copied to
// tasks.backup-v<N>, so a bad migration is always recoverable by copying that folder back.
const fs = require('fs');
const path = require('path');
const tasks = require('./tasks');

const STEPS = [
  // v1 -> v2: due dates and follow-up dates were dropped from the model; remove the leftover keys from the files.
  { to: 2, run() {
    for (const f of fs.readdirSync(tasks.DIR).filter((x) => x.endsWith('.md'))) {
      const file = path.join(tasks.DIR, f), text = fs.readFileSync(file, 'utf8');
      const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text); if (!m) continue;
      const kept = m[1].split(/\r?\n/).filter((l) => !/^(due|followup)\s*:/.test(l));
      if (kept.length !== m[1].split(/\r?\n/).length) fs.writeFileSync(file, text.replace(m[1], kept.join('\n')));
    }
  } },
];
const CURRENT = STEPS.length ? STEPS[STEPS.length - 1].to : 1;

function migrate() {
  const marker = process.env.WORKDESK_SCHEMA || path.join(path.dirname(tasks.DIR), '.workdesk-schema');
  let have = 1;
  try { have = parseInt(fs.readFileSync(marker, 'utf8'), 10) || 1; } catch { /* first run */ }
  if (!fs.existsSync(tasks.DIR)) { try { fs.writeFileSync(marker, String(CURRENT)); } catch { /* read-only */ } return { from: have, to: CURRENT, ran: 0 }; }
  const todo = STEPS.filter((s) => s.to > have);
  if (!todo.length) return { from: have, to: have, ran: 0 };
  const backup = path.join(path.dirname(tasks.DIR), `${path.basename(tasks.DIR)}.backup-v${have}`);
  if (!fs.existsSync(backup)) fs.cpSync(tasks.DIR, backup, { recursive: true });
  for (const s of todo) s.run();
  try { fs.writeFileSync(marker, String(CURRENT)); } catch { /* read-only */ }
  return { from: have, to: CURRENT, ran: todo.length, backup };
}

module.exports = { migrate, CURRENT };
