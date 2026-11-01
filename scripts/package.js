'use strict';
// Build the shareable folder (and a .zip): WorkDesk.exe in the root, minimal tree around it.
//   node scripts/package.js            -> dist/WorkDesk-<version>/ and .zip (bundles node.exe, ~85 MB)
//   node scripts/package.js --no-node  -> smaller; the receiver needs Node 20+ on PATH
//   node scripts/package.js --web-only -> only dist/WorkDesk-web-<version>.zip (no exe: Start WorkDesk.cmd + the user's Node)
// Build the exe first:  cd desktop && npx tauri build
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const repo = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
const out = path.join(repo, 'dist', 'WorkDesk-' + pkg.version);
const exe = path.join(repo, 'desktop', 'src-tauri', 'target', 'release', 'workdesk.exe');
const zipUp = (dir) => { fs.rmSync(dir + '.zip', { force: true }); execFileSync('powershell.exe', ['-NoProfile', '-Command', `Compress-Archive -Path '${dir}' -DestinationPath '${dir}.zip' -Force`], { stdio: 'inherit' }); return dir + '.zip'; };
// The program files and an empty tasks folder: the same in both editions.
function base(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'app'), { recursive: true });
  for (const f of ['server.js', 'package.json', 'IMPORTING.md']) fs.copyFileSync(path.join(repo, f), path.join(dir, 'app', f));
  for (const d of ['lib', 'public', 'mcp', 'scripts']) fs.cpSync(path.join(repo, d), path.join(dir, 'app', d), { recursive: true });
  fs.mkdirSync(path.join(dir, 'tasks'));
  fs.writeFileSync(path.join(dir, 'tasks', '.gitkeep'), '');
  fs.copyFileSync(path.join(repo, '.env.example'), path.join(dir, '.env.example'));
}

// No-exe edition: runs on the user's own Node via "Start WorkDesk.cmd" and opens in the browser (for PCs that block unsigned exes).
const web = path.join(repo, 'dist', 'WorkDesk-web-' + pkg.version);
base(web);
const crlf = (f) => fs.readFileSync(f, 'utf8').replace(/\r?\n/g, '\r\n');
fs.writeFileSync(path.join(web, 'Start WorkDesk.cmd'), crlf(path.join(repo, 'scripts', 'start-workdesk.cmd')));
fs.writeFileSync(path.join(web, 'README.txt'), crlf(path.join(repo, 'scripts', 'SHARE-README-WEB.txt')));
const webZip = zipUp(web);
console.log(`No-exe: ${webZip} (${(fs.statSync(webZip).size / 1048576).toFixed(1)} MB)`);
if (process.argv.includes('--web-only')) process.exit(0);

if (!fs.existsSync(exe)) { console.error('Build the exe first: cd desktop && npx tauri build'); process.exit(1); }
base(out);
fs.copyFileSync(exe, path.join(out, 'WorkDesk.exe'));
fs.copyFileSync(path.join(repo, 'scripts', 'SHARE-README.txt'), path.join(out, 'README.txt'));
fs.writeFileSync(path.join(out, 'Update WorkDesk.cmd'), '@echo off\r\nsetlocal\r\nif "%~1"=="" (echo Drag the new WorkDesk .zip or folder onto this file, or run:  "Update WorkDesk.cmd" path\\to\\release & pause & exit /b 1)\r\nif exist "%~dp0node\\node.exe" ("%~dp0node\\node.exe" "%~dp0app\\scripts\\update.js" "%~1") else (node "%~dp0app\\scripts\\update.js" "%~1")\r\npause\r\n');
if (!process.argv.includes('--no-node')) { fs.mkdirSync(path.join(out, 'node')); fs.copyFileSync(process.execPath, path.join(out, 'node', 'node.exe')); }

const zip = zipUp(out);
// The Windows installer (Start menu + uninstall) goes next to the zip, so the dist folder is the whole thing to share.
const setup = path.join(repo, 'desktop', 'src-tauri', 'target', 'release', 'bundle', 'nsis', `WorkDesk_${pkg.version}_x64-setup.exe`);
if (fs.existsSync(setup)) fs.copyFileSync(setup, path.join(repo, 'dist', `WorkDesk-Setup-${pkg.version}.exe`));
// Publish this next to the zip (share drive, web server) so installed copies can find the release from Settings > Updates.
fs.writeFileSync(path.join(repo, 'dist', 'latest.json'), JSON.stringify({ version: pkg.version, url: `WorkDesk-${pkg.version}.zip`, web: `WorkDesk-web-${pkg.version}.zip` }, null, 2) + '\n');
console.log(`Folder: ${out}\nZip:    ${zip} (${(fs.statSync(zip).size / 1048576).toFixed(1)} MB)`);
