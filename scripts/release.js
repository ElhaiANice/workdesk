'use strict';
// One command to ship: bump version everywhere, test, build the exe, package, publish to GitHub Releases.
//   node scripts/release.js patch|minor|major|x.y.z "release notes"
// Windows only (it builds the Tauri exe). Needs the gh CLI signed in.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repo = path.resolve(__dirname, '..');
const [bump = 'patch', ...notes] = process.argv.slice(2);
const sh = (cmd, args, cwd = repo) => { const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' }); if (r.status !== 0) { console.error(`\nFailed: ${cmd} ${args.join(' ')}`); process.exit(r.status || 1); } };

const pkgPath = path.join(repo, 'package.json');
const cur = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;
const [a, b, c] = cur.split('.').map(Number);
const next = /^\d+\.\d+\.\d+$/.test(bump) ? bump : bump === 'major' ? `${a + 1}.0.0` : bump === 'minor' ? `${a}.${b + 1}.0` : `${a}.${b}.${c + 1}`;
console.log(`Releasing ${cur} -> ${next}`);

// 1. version, in the four places that carry it
const sub = (file, re) => { const p = path.join(repo, file); fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(re, (m, pre) => `${pre}${next}"`)); };
sub('package.json', /^(\s*"version":\s*")[^"]+"/m);
sub('desktop/package.json', /^(\s*"version":\s*")[^"]+"/m);
sub('desktop/src-tauri/tauri.conf.json', /^(\s*"version":\s*")[^"]+"/m);
sub('desktop/src-tauri/Cargo.toml', /^(version\s*=\s*")[^"]+"/m);

// 2. tests (before the slow build)
sh('node', ['test/smoke.js']);

// 3. stop a dev build of the exe if one is open: it locks the build output. The WorkDesk you use day to day is an installed
// copy (it updates itself from the release), so its server on 4321 is left alone.
spawnSync('taskkill', ['/F', '/IM', 'workdesk.exe'], { encoding: 'utf8', windowsHide: true });

// 4. build the exe + installer, package the zip, publish
sh('npx', ['tauri', 'build'], path.join(repo, 'desktop'));
sh('node', ['scripts/package.js']);
// Notes go to publish.js as a file: sh() runs through cmd.exe, which cuts a text argument at its first line break.
// The notes argument may itself be a path to a Markdown file.
const notesText = notes.length === 1 && fs.existsSync(notes[0]) ? fs.readFileSync(notes[0], 'utf8') : notes.join(' ') || `WorkDesk ${next}`;
const notesFile = path.join(require('os').tmpdir(), `workdesk-notes-${next}.md`);
fs.writeFileSync(notesFile, notesText);
sh('node', ['scripts/publish.js', notesFile]);

console.log(`\nDone: v${next} is live. Installed copies (yours too) offer it as "Update now" within 30 minutes or at their next start.`);
