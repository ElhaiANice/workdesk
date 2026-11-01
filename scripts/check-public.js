'use strict';
// Before publishing the source: scan every file that would be published for secrets and internal details.
//   node scripts/check-public.js        exit code 1 if anything is found
// "Would be published" = everything except what .gitignore lists. Words that must never appear (internal hostnames,
// company or product names) go one per line in .public-check-deny, which is itself git-ignored so the list stays private.
const fs = require('fs');
const path = require('path');

const repo = path.resolve(__dirname, '..');
// Placeholders and test fakes that are fine to publish.
const ALLOW = /you@yourcompany\.com|yourcompany\.atlassian\.net|\bx\.atlassian\.net|noreply@anthropic\.com|users\.noreply\.github\.com/i;
const RULES = {
  'GitHub token': /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/,
  'Atlassian API token': /\bATATT[A-Za-z0-9_\-=]{30,}/,
  'AWS key': /\b(AKIA|ASIA)[0-9A-Z]{16}\b/,
  'Slack token': /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  'private key': /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  'API key': /\bsk-(ant-)?[A-Za-z0-9_-]{20,}/,
  'JWT': /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  'private package registry': /codeartifact|jfrog|artifactory|pkgs\.dev\.azure|nexus\.[a-z]/i,
  'personal folder': /[A-Za-z]:[\\/]+Users[\\/]+(?!<|you\b|%)[A-Za-z0-9._-]+/,
  'email address': /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/i,
  'Jira site': /[a-z0-9-]+\.atlassian\.net/i,
};

const deny = (() => { try { return fs.readFileSync(path.join(repo, '.public-check-deny'), 'utf8').split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#')); } catch { return []; } })();
// Case-sensitive, so "CARD-" does not hit the CSS class "card-t": list each spelling that matters.
for (const w of deny) RULES[`denied word "${w}"`] = new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

// .gitignore patterns of the simple kinds used here: "name", "dir/", "prefix.*/", "a/b/".
const ignore = fs.readFileSync(path.join(repo, '.gitignore'), 'utf8').split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
const ignored = (rel) => ignore.some((p) => {
  const dir = p.endsWith('/'), pat = p.replace(/\/$/, '');
  const re = new RegExp('^' + pat.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*') + (dir ? '(/|$)' : '$'));
  return pat.includes('/') ? re.test(rel) : rel.split('/').some((_, i, a) => re.test(a.slice(i).join('/')) && (dir || i === a.length - 1));
});

const found = [];
let files = 0;
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name), rel = path.relative(repo, abs).split(path.sep).join('/');
    if (e.name === '.git' || ignored(rel + (e.isDirectory() ? '/' : ''))) continue;
    if (e.isDirectory()) { walk(abs); continue; }
    files++;
    if (rel === 'scripts/check-public.js') continue; // it holds the patterns themselves
    const buf = fs.readFileSync(abs);
    const lines = (buf.includes(0) ? buf.toString('latin1') : buf.toString('utf8')).split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const [name, re] of Object.entries(RULES)) {
        const m = re.exec(line);
        if (m && !ALLOW.test(m[0])) found.push(`${rel}:${i + 1}  ${name}: ${m[0].slice(0, 80)}`);
      }
    });
  }
})(repo);

console.log(`Checked ${files} files that would be published${deny.length ? `, ${deny.length} denied words` : ''}.`);
if (found.length) { console.log(`\n${found.length} finding(s):\n` + found.map((f) => '  ' + f).join('\n')); process.exitCode = 1; }
else console.log('Nothing internal or secret found.');
