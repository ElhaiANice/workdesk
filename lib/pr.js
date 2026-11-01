'use strict';
// Pull-request state for tasks that carry a `pr` URL, read through the GitHub CLI (`gh`, already logged in).
// The state is cached on the task (pr_state). When it changes, the task moves along:
//   open (not draft) -> review (only from inbox/todo/in-progress);  merged -> done.
// Moves happen only on a change, so a task you move back by hand is left alone.
const { execFile } = require('child_process');
const tasks = require('./tasks');

const GH = process.env.WORKDESK_GH || 'gh';
const PR_RE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/i;

const lookup = (url) => new Promise((resolve, reject) => {
  const js = /\.js$/i.test(GH); // a .js override (used by the tests) runs under node
  execFile(js ? process.execPath : GH, [...(js ? [GH] : []), 'pr', 'view', url.match(PR_RE)[0], '--json', 'state,isDraft,reviewDecision'], { timeout: 20000, windowsHide: true }, (err, out) => {
    if (err) return reject(new Error(err.code === 'ENOENT' ? 'GitHub CLI (gh) not found' : (String(err.message).split('\n')[1] || err.message)));
    try { resolve(JSON.parse(out)); } catch { reject(new Error('Unreadable gh output')); }
  });
});

const norm = (j) => j.state === 'MERGED' ? 'merged' : j.state === 'CLOSED' ? 'closed' : j.isDraft ? 'draft' : 'open';

async function refresh() {
  const res = { checked: 0, changed: 0, moved: 0, errors: [] };
  for (const t of tasks.list()) {
    if (!PR_RE.test(t.pr || '')) continue;
    res.checked++;
    try {
      const j = await lookup(t.pr), s = norm(j), review = (j.reviewDecision || '').toLowerCase().replace('_', '-');
      if (s === t.pr_state && review === (t.pr_review || '')) continue;
      const patch = { pr_state: s, pr_review: review };
      if (s !== t.pr_state) {
        res.changed++;
        if (s === 'merged' && t.status !== 'done') patch.status = 'done';
        else if (s === 'open' && ['inbox', 'todo', 'in-progress'].includes(t.status)) patch.status = 'review';
        if (patch.status) res.moved++;
      }
      tasks.update(t.id, patch);
    } catch (e) { res.errors.push(`${t.id}: ${e.message}`); }
  }
  return res;
}

module.exports = { refresh, norm };
