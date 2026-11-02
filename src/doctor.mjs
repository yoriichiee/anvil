// anvil doctor [--share] - checks Node, the browser, playwright-core, axe-core, the keychain and AI config.
// --share prints a block that is safe to paste in a bug report: paths scrubbed (home -> ~, user name -> <user>),
// every value passed through redact(), API keys reported only as "set" / "not set".
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { browserPath } from './lib.mjs';
import { redact, scrubPaths } from './redact.mjs';
import { VERSION } from './scan.mjs';
import { resolveProvider, keyringAvailable } from './ai/provider.mjs';
import { ANVIL_HOME } from './target.mjs';

const req = createRequire(import.meta.url);
// package versions read from node_modules directly (some packages do not export ./package.json)
const ver = name => {
  for (let d = path.dirname(req.resolve('./doctor.mjs')); ; d = path.dirname(d)) {
    try { return JSON.parse(fs.readFileSync(path.join(d, 'node_modules', name, 'package.json'), 'utf8')).version; } catch {}
    if (path.dirname(d) === d) return null;
  }
};

export async function doctor({ share = false } = {}) {
  const rows = [];
  const add = (ok, what, detail, fix) => rows.push({ ok, what, detail, fix });
  const major = Number(process.versions.node.split('.')[0]);
  add(major >= 20, 'Node.js', process.version, major >= 20 ? '' : 'install Node 20 or newer');
  const b = browserPath();
  add(!!b, 'Chrome / Edge', b || 'not found', b ? '' : 'install Chrome or Edge, set ANVIL_CHROME, or run: npx playwright install chromium');
  for (const m of ['playwright-core', 'axe-core', '@modelcontextprotocol/sdk', 'yauzl']) { const v = ver(m); add(!!v, m, v || 'missing', v ? '' : 'run npm install in the anvil folder'); }
  add(true, '@napi-rs/keyring', (await keyringAvailable()) ? 'available' : 'not installed (optional; env vars are used)', '');
  let ai; try { ai = await resolveProvider(); } catch (e) { ai = { name: 'error: ' + e.message }; }
  add(true, 'AI provider', ai.name + (ai.model ? ' (' + ai.model + ')' : '') + (ai.warning ? ' - ' + ai.warning : ''), '');
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'ANVIL_CREDITS_TOKEN']) add(true, k, process.env[k] ? 'set' : 'not set', '');
  const anvilEnv = Object.keys(process.env).filter(k => /^ANVIL_/.test(k)).map(k => k + '=' + (/TOKEN|KEY|SECRET|PASS/i.test(k) ? '[set]' : redact(process.env[k])));
  add(true, 'ANVIL_* variables', anvilEnv.join(' ') || 'none', '');
  add(true, 'Anvil home', ANVIL_HOME(), '');
  const head = [`anvil ${VERSION} doctor`, `os: ${os.type()} ${os.release()} ${process.arch}`, `shell: ${process.env.ComSpec ? path.basename(process.env.ComSpec) : process.env.SHELL || '?'}`, `cwd: ${process.cwd()}`];
  let text = [...head, '', ...rows.map(r => `${r.ok ? 'ok  ' : 'FAIL'}  ${r.what}: ${r.detail}${r.fix ? '  -> ' + r.fix : ''}`), ''].join('\n');
  if (share) text = '```\n' + redact(scrubPaths(text), { aggressive: false }) + '```\n(redacted: paths and user name scrubbed, keys shown only as set / not set)\n';
  return text;
}
