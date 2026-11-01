'use strict';
// Publish the packaged release to GitHub Releases so every installed copy can update itself from Settings.
//   node scripts/package.js      (build first: cd desktop && npx tauri build)
//   node scripts/publish.js      (uploads dist/WorkDesk-<version>.zip and the installer as release v<version>)
// The repo comes from package.json workdesk.updateRepo. It is created (private) the first time if it does not exist.
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const repo = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
const target = (pkg.workdesk || {}).updateRepo;
const v = pkg.version, tag = 'v' + v;
const zip = path.join(repo, 'dist', `WorkDesk-${v}.zip`), setup = path.join(repo, 'dist', `WorkDesk-Setup-${v}.exe`);
const die = (m) => { console.error(m); process.exit(1); };
const gh = (...a) => spawnSync('gh', a, { encoding: 'utf8' });

if (!target) die('Set "workdesk": { "updateRepo": "owner/name" } in package.json first.');
if (!fs.existsSync(zip)) die(`Missing ${zip}. Run: node scripts/package.js`);
if (gh('auth', 'status').status !== 0) die('Sign in first: gh auth login');

if (gh('repo', 'view', target).status !== 0) {
  console.log(`Creating private repo ${target} ...`);
  const c = gh('repo', 'create', target, '--private', '--description', 'WorkDesk releases');
  if (c.status !== 0) die(c.stderr);
  const body = Buffer.from('# WorkDesk releases\n\nInstallers and updates for WorkDesk. Installed copies check the latest release here.\n').toString('base64');
  const f = gh('api', '-X', 'PUT', `repos/${target}/contents/README.md`, '-f', 'message=Initial commit', '-f', `content=${body}`);
  if (f.status !== 0) die(f.stderr);
}

const webZip = path.join(repo, 'dist', `WorkDesk-web-${v}.zip`); // the no-exe edition updates from this one
// Notes: text, or the path of a Markdown file (multi-line notes do not survive being passed through cmd.exe as text).
const notesArgs = () => { const n = process.argv[2]; return n && fs.existsSync(n) ? ['--notes-file', n] : ['--notes', n || `WorkDesk ${v}`]; };
// latest.json lets installed copies find this release through a plain download link (no GitHub API, no rate limit).
const latest = path.join(repo, 'dist', 'latest.json');
const files = [zip, ...[setup, webZip, latest].filter((f) => fs.existsSync(f))];
const exists = gh('release', 'view', tag, '--repo', target).status === 0;
const r = exists
  ? gh('release', 'upload', tag, ...files, '--repo', target, '--clobber')
  : gh('release', 'create', tag, ...files, '--repo', target, '--title', `WorkDesk ${v}`, ...notesArgs());
if (r.status !== 0) die(r.stderr);
console.log(`Published ${tag} to https://github.com/${target}/releases/tag/${tag}\nInstalled copies will offer the update on their next start.`);
