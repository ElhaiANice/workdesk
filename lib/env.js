'use strict';
// Tiny .env loader (KEY=VALUE per line). Existing environment variables win.
const fs = require('fs');
const path = require('path');

try {
  const text = fs.readFileSync(process.env.WORKDESK_ENV || path.join(__dirname, '..', '.env'), 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch { /* no .env file */ }
