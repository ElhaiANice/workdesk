'use strict';
// In-app update: look for a newer release and install it.
// Default source: the GitHub repo named in package.json (workdesk.updateRepo), so users configure nothing.
// WORKDESK_UPDATE_SOURCE overrides it with one of: "owner/repo" (GitHub releases), a folder (or UNC share) holding WorkDesk-x.y.z.zip files or release folders,
// a single .zip, or an https URL to a latest.json like {"version":"1.2.0","url":"WorkDesk-1.2.0.zip"}.
// Installing hands over to a small script that quits WorkDesk, runs scripts/update.js (data is never touched) and starts it again.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync, execFileSync } = require('child_process');

const APP = path.resolve(__dirname, '..');
const ROOT = path.resolve(APP, '..');
const current = () => require('../package.json').version;
// Two packaged editions share one layout (app/ next to tasks/): the desktop exe, and the no-exe one that
// "Start WorkDesk.cmd" runs on the user's own Node. Each updates from its own release file.
const edition = () => (path.basename(APP) !== 'app' ? '' : fs.existsSync(path.join(ROOT, 'WorkDesk.exe')) ? 'exe' : fs.existsSync(path.join(ROOT, 'Start WorkDesk.cmd')) ? 'web' : '');
const packaged = () => !!edition();
const ASSET = () => (edition() === 'web' ? /^WorkDesk-web-(\d+(?:\.\d+)*)(\.zip)?$/i : /^WorkDesk-(\d+(?:\.\d+)*)(\.zip)?$/i);
const assetName = () => (edition() === 'web' ? 'WorkDesk-web-x.y.z.zip' : 'WorkDesk-x.y.z.zip');
const parts = (v) => String(v).split('.').map((n) => parseInt(n, 10) || 0);
const newer = (a, b) => { const x = parts(a), y = parts(b); for (let i = 0; i < Math.max(x.length, y.length); i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; };

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const repoDefault = () => (require('../package.json').workdesk || {}).updateRepo || '';
let ghToken; // a private repo needs one: setting / env, else the GitHub CLI's login
function token() {
  const e = process.env.WORKDESK_GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (e) return e;
  // gh can take 10+ s on a busy PC; keep only a token actually found, so a slow or failed try is retried on the next check.
  if (!ghToken) { try { ghToken = execFileSync('gh', ['auth', 'token'], { timeout: 30000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim(); } catch { ghToken = ''; } }
  return ghToken;
}
const ghHeaders = (accept = 'application/vnd.github+json') => ({ Accept: accept, 'User-Agent': 'WorkDesk', ...(token() ? { Authorization: 'Bearer ' + token() } : {}) });

// HTTP GET that survives company networks which inspect HTTPS with their own certificate (Cato, Zscaler, ...): Windows
// trusts that certificate, Node's built-in list does not. On such a certificate error, Windows' own curl.exe (which uses
// the Windows certificate store) does the request instead. --ssl-no-revoke only skips the revocation lookup those networks
// block; the certificate chain is still verified. Returns a fetch-like response.
const CERT_ERR = /CERT|ISSUER|SELF_SIGNED|UNABLE_TO_VERIFY/i;
async function get(url, { headers = {}, timeout = 15000 } = {}) {
  try { return await fetch(url, { headers, signal: AbortSignal.timeout(timeout) }); }
  catch (e) {
    if (process.platform !== 'win32' || !CERT_ERR.test(String(e.cause?.code || e.cause?.message || ''))) throw e;
    const out = path.join(os.tmpdir(), `workdesk-get-${process.pid}-${Date.now()}`);
    const args = ['-sSL', '--ssl-no-revoke', '--max-time', String(Math.ceil(timeout / 1000)), '-o', out, '-w', '%{http_code}'];
    for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
    const status = Number(execFileSync('curl.exe', [...args, url], { encoding: 'utf8', windowsHide: true, timeout: timeout + 5000 }).trim()) || 0;
    const body = fs.existsSync(out) ? fs.readFileSync(out) : Buffer.alloc(0);
    fs.rmSync(out, { force: true });
    return { ok: status >= 200 && status < 300, status, json: async () => JSON.parse(body.toString('utf8')), text: async () => body.toString('utf8'), arrayBuffer: async () => body };
  }
}

// A public repo is read through plain release downloads: no sign-in, and no API rate limit (the API allows only 60
// unauthenticated calls an hour per network address, which an office full of copies would use up). Each release carries a
// small latest.json naming its version and files. A private repo (or a release without latest.json) falls back to the API.
async function findGithubPublic(repo) {
  const r = await get(`https://github.com/${repo}/releases/latest/download/latest.json`, { headers: { 'User-Agent': 'WorkDesk' } }).catch(() => null);
  if (!r || !r.ok) return null;
  const j = await r.json().catch(() => ({}));
  const name = edition() === 'web' ? j.web : j.url;
  if (!j.version || !name) return null;
  return { version: j.version, where: `https://github.com/${repo}/releases/download/v${j.version}/${name}`, remote: true, headers: { 'User-Agent': 'WorkDesk' } };
}

async function findGithub(repo) {
  const pub = await findGithubPublic(repo);
  if (pub) return pub;
  const r = await get(`https://api.github.com/repos/${repo}/releases/latest`, { headers: ghHeaders() });
  if (r.status === 404) throw new Error(`No release found in ${repo}. If the repo is private, sign in with the GitHub CLI (gh auth login) or add a GitHub token in Settings.`);
  if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
  const j = await r.json();
  const asset = (j.assets || []).find((x) => ASSET().test(x.name) && /\.zip$/i.test(x.name));
  if (!asset) throw new Error(`Release ${j.tag_name} has no ${assetName()} file.`);
  return { version: String(j.tag_name).replace(/^v/i, ''), where: asset.url, remote: true, headers: ghHeaders('application/octet-stream') };
}

async function find() {
  const src = (process.env.WORKDESK_UPDATE_SOURCE || '').trim() || repoDefault();
  if (!src) throw Object.assign(new Error('No update source. Set one in Settings.'), { status: 400 });
  if (REPO_RE.test(src) && !fs.existsSync(src)) return findGithub(src);
  if (/^https?:\/\//i.test(src)) {
    const r = await get(src);
    if (!r.ok) throw new Error(`Update source answered ${r.status}`);
    const j = await r.json();
    if (!j.version || !j.url) throw new Error('latest.json needs "version" and "url".');
    return { version: j.version, where: new URL(edition() === 'web' ? j.web || j.url : j.url, src).href, remote: true };
  }
  const stat = fs.existsSync(src) && fs.statSync(src);
  if (!stat) throw new Error(`Update source not found: ${src}`);
  if (stat.isFile()) { const m = /(\d+(?:\.\d+)+)/.exec(path.basename(src)); return { version: m ? m[1] : '0', where: src }; }
  let best = null;
  for (const n of fs.readdirSync(src)) {
    const m = ASSET().exec(n);
    if (m && (!best || newer(m[1], best.version))) best = { version: m[1], where: path.join(src, n) };
  }
  if (!best) throw new Error(`No ${assetName()} found in ${src}`);
  return best;
}

async function check() {
  const found = await find();
  return { current: current(), latest: found.version, available: newer(found.version, current()), packaged: packaged(), edition: edition(), source: (process.env.WORKDESK_UPDATE_SOURCE || '').trim() || repoDefault() };
}

async function apply() {
  if (!packaged()) throw Object.assign(new Error('This copy runs from source, not the packaged app. Update it with git pull instead.'), { status: 400 });
  if (process.platform !== 'win32') throw Object.assign(new Error('In-app update is Windows only.'), { status: 400 });
  const found = await find();
  if (!newer(found.version, current())) throw Object.assign(new Error(`Already on the latest version (${current()}).`), { status: 400 });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'workdesk-upd-'));
  let release = found.where;
  if (found.remote) {
    const r = await get(found.where, { headers: found.headers, timeout: 300000 });
    if (!r.ok) throw new Error(`Download failed (${r.status})`);
    release = path.join(tmp, 'release.zip');
    fs.writeFileSync(release, Buffer.from(await r.arrayBuffer()));
  }
  if (edition() === 'web') {
    // No exe to restart: install in place, then exit with code 75, which tells "Start WorkDesk.cmd" to start the new version.
    fs.copyFileSync(path.join(APP, 'scripts', 'update.js'), path.join(tmp, 'update.js'));
    const r = spawnSync(process.execPath, [path.join(tmp, 'update.js'), release], { env: { ...process.env, WORKDESK_ROOT: ROOT }, encoding: 'utf8' });
    fs.writeFileSync(path.join(ROOT, 'update.log'), (r.stdout || '') + (r.stderr || ''));
    if (r.status !== 0) throw new Error((r.stderr || r.stdout || '').trim().split('\n').pop() || 'Update failed; see update.log');
    setTimeout(() => process.exit(75), 400);
    return { ok: true, from: current(), to: found.version };
  }
  // The running node.exe and update script live inside the folder being replaced, so run them from a copy.
  fs.copyFileSync(process.execPath, path.join(tmp, 'node.exe'));
  fs.copyFileSync(path.join(APP, 'scripts', 'update.js'), path.join(tmp, 'update.js'));
  const q = (p) => `"${p}"`;
  const bat = [
    '@echo off',
    'timeout /t 2 /nobreak >nul',
    // stop only the processes that run from this install folder (the exe, its server, a standalone server), not another copy
    `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '${ROOT.replace(/'/g, "''")}\\*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`,
    `taskkill /F /PID ${process.pid} >nul 2>&1`,
    'timeout /t 2 /nobreak >nul',
    `set WORKDESK_ROOT=${ROOT}`,
    `${q(path.join(tmp, 'node.exe'))} ${q(path.join(tmp, 'update.js'))} ${q(release)} > ${q(path.join(ROOT, 'update.log'))} 2>&1`,
    `start "" ${q(path.join(ROOT, 'WorkDesk.exe'))}`,
    '',
  ].join('\r\n');
  const file = path.join(tmp, 'apply.cmd');
  fs.writeFileSync(file, bat);
  spawn('cmd.exe', ['/c', file], { detached: true, stdio: 'ignore', windowsHide: true, cwd: tmp }).unref();
  return { ok: true, from: current(), to: found.version };
}

const source = () => (process.env.WORKDESK_UPDATE_SOURCE || '').trim() || repoDefault();

module.exports = { check, apply, newer, source };
