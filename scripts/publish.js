'use strict';
// Publish the packaged release to GitHub Releases so every installed copy can update itself from Settings.
//   node scripts/package.js      (build first: cd desktop && npx tauri build)
//   node scripts/publish.js      (uploads dist/WorkDesk-<version>.zip and the installer as release v<version>)
// The repo comes from package.json workdesk.updateRepo; workdesk.alsoPublishTo lists repos that get the same release too
// (older installed copies still look there). It is created (private) the first time if it does not exist.
// The main repo also gets copies with no version in the name (WorkDesk-web.zip ...), so
// https://github.com/<repo>/releases/latest/download/WorkDesk-web.zip always downloads the newest one.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repo = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
const cfg = pkg.workdesk || {};
const main = cfg.updateRepo;
const targets = [main, ...(cfg.alsoPublishTo || [])].filter(Boolean);
const v = pkg.version, tag = 'v' + v;
const dist = path.join(repo, 'dist');
const zip = path.join(dist, `WorkDesk-${v}.zip`), setup = path.join(dist, `WorkDesk-Setup-${v}.exe`);
const die = (m) => { console.error(m); process.exit(1); };
const gh = (...a) => spawnSync('gh', a, { encoding: 'utf8' });

if (!main) die('Set "workdesk": { "updateRepo": "owner/name" } in package.json first.');
if (!fs.existsSync(zip)) die(`Missing ${zip}. Run: node scripts/package.js`);
if (gh('auth', 'status').status !== 0) die('Sign in first: gh auth login');

const webZip = path.join(dist, `WorkDesk-web-${v}.zip`); // the no-exe edition updates from this one
// Notes: text, or the path of a Markdown file (multi-line notes do not survive being passed through cmd.exe as text).
const notesArgs = () => { const n = process.argv[2]; return n && fs.existsSync(n) ? ['--notes-file', n] : ['--notes', n || `WorkDesk ${v}`]; };
// latest.json lets installed copies find this release through a plain download link (no GitHub API, no rate limit).
const latest = path.join(dist, 'latest.json');
const versioned = [zip, ...[setup, webZip, latest].filter((f) => fs.existsSync(f))];
// Same files under names without the version, for links that never change.
const stable = path.join(dist, 'stable');
fs.rmSync(stable, { recursive: true, force: true });
fs.mkdirSync(stable);
const copies = [[zip, 'WorkDesk.zip'], [setup, 'WorkDesk-Setup.exe'], [webZip, 'WorkDesk-web.zip']].filter(([f]) => fs.existsSync(f));
for (const [f, name] of copies) fs.copyFileSync(f, path.join(stable, name));
const stableFiles = copies.map(([, name]) => path.join(stable, name));

let failed = 0;
for (const target of targets) {
  if (gh('repo', 'view', target).status !== 0) {
    console.log(`Creating private repo ${target} ...`);
    const c = gh('repo', 'create', target, '--private', '--description', 'WorkDesk releases');
    if (c.status !== 0) { console.error(c.stderr); failed++; continue; }
    const body = Buffer.from('# WorkDesk releases\n\nInstallers and updates for WorkDesk. Installed copies check the latest release here.\n').toString('base64');
    const f = gh('api', '-X', 'PUT', `repos/${target}/contents/README.md`, '-f', 'message=Initial commit', '-f', `content=${body}`);
    if (f.status !== 0) { console.error(f.stderr); failed++; continue; }
  }
  const files = target === main ? [...versioned, ...stableFiles] : versioned;
  const exists = gh('release', 'view', tag, '--repo', target).status === 0;
  const r = exists
    ? gh('release', 'upload', tag, ...files, '--repo', target, '--clobber')
    : gh('release', 'create', tag, ...files, '--repo', target, '--title', `WorkDesk ${v}`, ...notesArgs());
  if (r.status !== 0) { console.error(r.stderr); failed++; continue; }
  console.log(`Published ${tag} to https://github.com/${target}/releases/tag/${tag}`);
}
if (failed) die(`${failed} of ${targets.length} repos did not get the release.`);
console.log('Installed copies will offer the update on their next start.');
