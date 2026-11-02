// src/addons/index.mjs - Anvil add-on packs: load, validate, install, list, remove, and turn into checks.
//
// Packs are declarative JSON (schemas/anvil-addon.schema.json). No pack code ever runs.
// Installed packs live at  <ANVIL_HOME or ~/.anvil>/addons/<id>@<version>/{anvil-addon.json, install.json}
// Registry:                ANVIL_REGISTRY_URL or https://anvil.horvans.com/registry/index.json
//                          (built by addons-spec/repo-template/scripts/build-index.mjs; every pack file
//                          is verified against the sha256 the index lists before it is installed).
//
// Wiring for the engine (W1):
//   import { registerInstalledAddons } from './addons/index.mjs';
//   const { checks, humanChecks, problems } = await registerInstalledAddons();   // all installed packs
//   // or just some: await registerInstalledAddons({ only: ['supabase-rls'] })
//   - If src/checks/index.mjs exists and exports registerChecks(checks), it is called for you
//     (lazy import, so this module works before/without it). Otherwise use the returned `checks`.
//   - Each check: { id, name, kind, severity, needs, source, def, run(ctx) } - see runtime.mjs for ctx.
//     run(ctx) -> { status, findings, notChecked } in report.json shapes; push status into checksRun
//     as { id, name, status, durationMs }, findings into findings, notChecked into notChecked.
//   - humanChecks are report.json humanChecks entries (id, prompt, steps) to append to the checklist.
//   - `problems` (packs that failed validation/compat/hash) belong in notChecked.
//
// CLI (W1's cli.mjs):  if (argv[0] === 'addon') process.exitCode = await addonCommand(argv.slice(1));
//   anvil addon list [--available] [--json]
//   anvil addon add <id>[@<version>] | --file <anvil-addon.json>
//   anvil addon remove <id>[@<version>]
//   anvil addon validate <anvil-addon.json>...

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { checkPack, compareSemver, satisfiesRange, parseSemver } from './pack-validate.mjs';
import { packToChecks, packToHumanChecks } from './runtime.mjs';

export { checkPack, validatePack, lintPack, lintRegex, safeMatchAll } from './pack-validate.mjs';
export { packToChecks, packToHumanChecks } from './runtime.mjs';

export const DEFAULT_REGISTRY_URL = 'https://anvil.horvans.com/registry/index.json';
const MAX_INDEX_BYTES = 2 * 1024 * 1024;
const MAX_PACK_BYTES = 256 * 1024;
const ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const SHA_RE = /^[a-f0-9]{64}$/;
const HERE = path.dirname(fileURLToPath(import.meta.url));

export function anvilVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(HERE, '..', '..', 'package.json'), 'utf8')).version; } catch { return '0.0.0'; }
}
export const anvilHome = (env = process.env) => path.resolve(env.ANVIL_HOME || path.join(os.homedir(), '.anvil'));
export const addonsDir = (env = process.env) => path.join(anvilHome(env), 'addons');
export const registryUrl = (env = process.env) => env.ANVIL_REGISTRY_URL || DEFAULT_REGISTRY_URL;
export const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

// Strips terminal control characters from untrusted pack/registry text before printing it.
export const clean = (s, max = 200) => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, ' ').slice(0, max);

export function parseSpec(spec) {
  const m = /^([a-z0-9][a-z0-9-]{1,63})(?:@(.+))?$/.exec(String(spec || ''));
  if (!m) throw new Error(`not an add-on id: ${clean(spec, 80)} (expected <id> or <id>@<version>)`);
  if (m[2] && !parseSemver(m[2])) throw new Error(`not a version: ${clean(m[2], 40)}`);
  return { id: m[1], version: m[2] || null };
}

// ---- loading local packs ------------------------------------------------------------------------

export function parsePackText(text, where = 'pack') {
  let pack;
  try { pack = JSON.parse(text); } catch (e) { return { ok: false, errors: [`${where}: not valid JSON (${e.message})`] }; }
  const r = checkPack(pack);
  return r.ok ? { ok: true, pack, errors: [] } : { ok: false, pack, errors: r.errors };
}

export function loadPackFile(file) {
  let buf;
  try { buf = fs.readFileSync(file); } catch (e) { return { ok: false, errors: [`cannot read ${file}: ${e.code || e.message}`] }; }
  if (buf.length > MAX_PACK_BYTES) return { ok: false, errors: [`${file}: larger than ${MAX_PACK_BYTES} bytes`] };
  return { ...parsePackText(buf.toString('utf8'), path.basename(file)), sha256: sha256(buf) };
}

export function isCompatible(pack, version = anvilVersion()) { return satisfiesRange(version, pack.anvil); }

// Every installed pack (all versions), re-validated and hash-checked against install.json.
export function listInstalled({ env = process.env } = {}) {
  const dir = addonsDir(env);
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of ents) {
    if (!e.isDirectory()) continue;
    const m = /^([a-z0-9][a-z0-9-]{1,63})@(.+)$/.exec(e.name);
    if (!m || !parseSemver(m[2])) continue;
    const folder = path.join(dir, e.name);
    const item = { id: m[1], version: m[2], folder, ok: false, errors: [] };
    const r = loadPackFile(path.join(folder, 'anvil-addon.json'));
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(path.join(folder, 'install.json'), 'utf8')); } catch { item.errors.push('install.json missing or unreadable'); }
    item.source = typeof meta.source === 'string' ? meta.source : 'unknown';
    item.sha256 = r.sha256;
    if (!r.ok) item.errors.push(...r.errors);
    else if (r.pack.id !== m[1] || r.pack.version !== m[2]) item.errors.push(`folder says ${m[1]}@${m[2]} but the pack says ${r.pack.id}@${r.pack.version}`);
    if (meta.sha256 && r.sha256 && meta.sha256 !== r.sha256) item.errors.push('pack file changed since it was installed (sha256 mismatch)');
    if (r.pack) { item.name = r.pack.name; item.pack = r.pack; item.compatible = isCompatible(r.pack); }
    item.ok = item.errors.length === 0;
    out.push(item);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id) || compareSemver(b.version, a.version));
}

// Valid, compatible packs; the highest installed version of each id. Problems go into notChecked.
export function loadInstalledPacks({ env = process.env, only, version = anvilVersion() } = {}) {
  const packs = [], problems = [], taken = new Set();
  for (const it of listInstalled({ env })) {
    if (only && !only.includes(it.id)) continue;
    if (taken.has(it.id)) continue;
    if (!it.ok) { problems.push({ what: `Add-on ${it.id}@${it.version}`, why: `Not loaded: ${clean(it.errors[0], 300)}` }); continue; }
    if (!isCompatible(it.pack, version)) { problems.push({ what: `Add-on ${it.id}@${it.version}`, why: `Needs Anvil ${clean(it.pack.anvil, 20)}; this is ${version}.` }); continue; }
    taken.add(it.id);
    packs.push(it.pack);
  }
  if (only) for (const id of only) if (!taken.has(id) && !problems.some(p => p.what.startsWith(`Add-on ${id}@`)))
    problems.push({ what: `Add-on ${clean(id, 64)}`, why: 'Not installed (run: anvil addon add ' + clean(id, 64) + ').' });
  return { packs, problems };
}

// Loads installed packs, converts them, and registers them with W1's check registry if it exists.
export async function registerInstalledAddons(opts = {}) {
  const { packs, problems } = loadInstalledPacks(opts);
  const checks = packs.flatMap(packToChecks);
  const humanChecks = packs.flatMap(packToHumanChecks);
  let registered = false;
  const register = opts.registerChecks || await import('../checks/index.mjs').then(m => m.registerChecks).catch(() => null);
  if (typeof register === 'function' && checks.length) { await register(checks); registered = true; }
  return { packs, checks, humanChecks, problems, registered };
}

// ---- registry -----------------------------------------------------------------------------------

function assertFetchable(u) {
  const url = new URL(u);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new Error(`registry must use https: ${clean(u, 200)}`);
  if (url.username || url.password) throw new Error('registry URL must not contain credentials');
  return url;
}

async function fetchBytes(u, cap, fetchImpl = globalThis.fetch) {
  assertFetchable(u);
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 20000);
  try {
    const res = await fetchImpl(u, { signal: ac.signal, redirect: 'error', headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`GET ${clean(u, 200)} -> ${res.status}`);
    const len = Number(res.headers?.get?.('content-length'));
    if (len > cap) throw new Error(`GET ${clean(u, 200)}: response larger than ${cap} bytes`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > cap) throw new Error(`GET ${clean(u, 200)}: response larger than ${cap} bytes`);
    return buf;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`GET ${clean(u, 200)} timed out`);
    throw e;
  } finally { clearTimeout(t); }
}

export function validateIndex(idx) {
  const errors = [];
  if (!idx || typeof idx !== 'object' || !Array.isArray(idx.packs)) return ['index: missing "packs" array'];
  if (idx.schemaVersion !== '1') errors.push(`index: unsupported schemaVersion ${clean(idx.schemaVersion, 20)}`);
  idx.packs.forEach((p, i) => {
    if (!p || !ID_RE.test(p.id)) { errors.push(`packs[${i}]: bad id`); return; }
    if (!Array.isArray(p.versions) || !p.versions.length) { errors.push(`packs[${i}] ${p.id}: no versions`); return; }
    for (const v of p.versions) {
      if (!v || !parseSemver(v.version)) errors.push(`${p.id}: bad version`);
      else if (!SHA_RE.test(v.sha256 || '')) errors.push(`${p.id}@${v.version}: bad sha256`);
      else if (typeof v.path !== 'string' || v.path.startsWith('/') || v.path.includes('..') || v.path.includes('\\') || /^[a-z]+:/i.test(v.path)) errors.push(`${p.id}@${v.version}: bad path`);
    }
  });
  return errors;
}

export async function fetchIndex({ env = process.env, fetch: f } = {}) {
  const url = registryUrl(env);
  const buf = await fetchBytes(url, MAX_INDEX_BYTES, f);
  let idx;
  try { idx = JSON.parse(buf.toString('utf8')); } catch { throw new Error('registry index is not valid JSON'); }
  const errors = validateIndex(idx);
  if (errors.length) throw new Error(`registry index rejected: ${errors.slice(0, 3).join('; ')}`);
  return { url, index: idx };
}

// Picks the version to install: the requested one, else the highest stable version compatible with this Anvil.
export function pickVersion(entry, wanted, version = anvilVersion()) {
  const vs = [...entry.versions].sort((a, b) => compareSemver(b.version, a.version));
  if (wanted) return vs.find(v => v.version === wanted) || null;
  return vs.find(v => !parseSemver(v.version).pre && (!v.anvil || satisfiesRange(version, v.anvil))) || null;
}

function writeInstall(env, pack, buf, source) {
  const dir = addonsDir(env);
  fs.mkdirSync(dir, { recursive: true });
  const final = path.join(dir, `${pack.id}@${pack.version}`);
  const tmp = path.join(dir, `.tmp-${pack.id}-${process.pid}-${Date.now()}`);
  fs.mkdirSync(tmp);
  try {
    fs.writeFileSync(path.join(tmp, 'anvil-addon.json'), buf);
    fs.writeFileSync(path.join(tmp, 'install.json'), JSON.stringify({ id: pack.id, version: pack.version, sha256: sha256(buf), source, installedAt: new Date().toISOString() }, null, 2) + '\n');
    fs.renameSync(tmp, final);
  } catch (e) { fs.rmSync(tmp, { recursive: true, force: true }); throw e; }
  return final;
}

function existingInstall(env, id, version) {
  const folder = path.join(addonsDir(env), `${id}@${version}`);
  if (!fs.existsSync(folder)) return null;
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(path.join(folder, 'install.json'), 'utf8')); } catch { /* treat as unknown */ }
  return { folder, sha256: meta.sha256 || null };
}

// Installs from the registry. Returns { id, version, folder, status: 'installed'|'already-installed' }.
export async function addAddon(spec, { env = process.env, fetch: f, version = anvilVersion() } = {}) {
  const { id, version: wanted } = parseSpec(spec);
  const { url: indexUrl, index } = await fetchIndex({ env, fetch: f });
  const entry = index.packs.find(p => p.id === id);
  if (!entry) throw new Error(`no add-on "${id}" in the registry`);
  const v = pickVersion(entry, wanted, version);
  if (!v) throw new Error(wanted ? `${id}@${wanted} is not in the registry` : `no version of ${id} is compatible with Anvil ${version}`);
  const prev = existingInstall(env, id, v.version);
  if (prev && prev.sha256 === v.sha256) return { id, version: v.version, folder: prev.folder, status: 'already-installed' };
  if (prev) throw new Error(`${id}@${v.version} is already installed with different contents. Versions are immutable, so this is suspicious; run "anvil addon remove ${id}@${v.version}" first if you trust the registry.`);

  const packUrl = new URL(v.path, indexUrl);
  if (packUrl.origin !== new URL(indexUrl).origin) throw new Error('pack URL leaves the registry origin');
  const buf = await fetchBytes(packUrl.href, MAX_PACK_BYTES, f);
  const got = sha256(buf);
  if (got !== v.sha256) throw new Error(`sha256 mismatch for ${id}@${v.version}: index says ${v.sha256.slice(0, 12)}..., download is ${got.slice(0, 12)}... Not installed.`);
  const r = parsePackText(buf.toString('utf8'), `${id}@${v.version}`);
  if (!r.ok) throw new Error(`${id}@${v.version} failed validation: ${r.errors.slice(0, 3).join('; ')}`);
  if (r.pack.id !== id || r.pack.version !== v.version) throw new Error(`registry file is ${r.pack.id}@${r.pack.version}, expected ${id}@${v.version}`);
  if (!isCompatible(r.pack, version)) throw new Error(`${id}@${v.version} needs Anvil ${r.pack.anvil}; this is ${version}`);
  const folder = writeInstall(env, r.pack, buf, packUrl.href);
  return { id, version: v.version, folder, status: 'installed', pack: r.pack };
}

// Installs a local pack file (for pack authors). Same validation, no registry.
export function addLocalAddon(file, { env = process.env, version = anvilVersion() } = {}) {
  const buf = fs.readFileSync(file);
  if (buf.length > MAX_PACK_BYTES) throw new Error(`larger than ${MAX_PACK_BYTES} bytes`);
  const r = parsePackText(buf.toString('utf8'), path.basename(file));
  if (!r.ok) throw new Error(`failed validation: ${r.errors.slice(0, 5).join('; ')}`);
  if (!isCompatible(r.pack, version)) throw new Error(`needs Anvil ${r.pack.anvil}; this is ${version}`);
  const prev = existingInstall(env, r.pack.id, r.pack.version);
  if (prev) {
    if (prev.sha256 === sha256(buf)) return { id: r.pack.id, version: r.pack.version, folder: prev.folder, status: 'already-installed' };
    fs.rmSync(prev.folder, { recursive: true, force: true });   // local dev packs may be reinstalled
  }
  const folder = writeInstall(env, r.pack, buf, 'file:' + path.resolve(file));
  return { id: r.pack.id, version: r.pack.version, folder, status: 'installed', pack: r.pack };
}

export function removeAddon(spec, { env = process.env } = {}) {
  const { id, version } = parseSpec(spec);
  const removed = [];
  for (const it of listInstalled({ env })) {
    if (it.id !== id || (version && it.version !== version)) continue;
    const dir = addonsDir(env);
    if (path.dirname(it.folder) !== dir) continue;   // never leave the addons folder
    fs.rmSync(it.folder, { recursive: true, force: true });
    removed.push(`${it.id}@${it.version}`);
  }
  return removed;
}

// ---- CLI ----------------------------------------------------------------------------------------

const HELP = `anvil addon - declarative check packs (no add-on code ever runs)

  anvil addon list [--available] [--json]      installed packs, or what the registry offers
  anvil addon add <id>[@<version>]             install from the registry (sha256-verified)
  anvil addon add --file <anvil-addon.json>    install a local pack (for pack authors)
  anvil addon remove <id>[@<version>]          uninstall
  anvil addon validate <anvil-addon.json>...   schema + ReDoS lint, as the registry CI does

Packs install to ${'<ANVIL_HOME or ~/.anvil>'}/addons/<id>@<version>/.
Registry: ANVIL_REGISTRY_URL or ${DEFAULT_REGISTRY_URL}`;

export async function addonCommand(argv = [], { stdout = process.stdout, stderr = process.stderr, env = process.env, fetch: f } = {}) {
  const out = s => stdout.write(s + '\n');
  const err = s => stderr.write(s + '\n');
  const [sub, ...rest] = argv;
  const flags = new Set(rest.filter(a => a.startsWith('--')));
  const args = rest.filter(a => !a.startsWith('--'));
  try {
    switch (sub) {
      case 'list': case 'ls': {
        if (flags.has('--available')) {
          const { url, index } = await fetchIndex({ env, fetch: f });
          if (flags.has('--json')) { out(JSON.stringify(index.packs.map(p => ({ id: p.id, name: p.name, latest: p.latest, versions: p.versions.map(v => v.version), tags: p.tags })), null, 2)); return 0; }
          out(`Registry: ${clean(url)}`);
          if (!index.packs.length) out('  (empty)');
          for (const p of index.packs) out(`  ${clean(p.id, 64).padEnd(22)} ${clean(p.latest || p.versions[0].version, 20).padEnd(9)} ${clean(p.name, 60)}${p.description ? ' - ' + clean(p.description, 90) : ''}`);
          out('\nInstall one with: anvil addon add <id>');
          return 0;
        }
        const items = listInstalled({ env });
        if (flags.has('--json')) { out(JSON.stringify(items.map(({ pack, folder, ...it }) => ({ ...it, checks: pack ? pack.checks.length : 0, humanChecks: pack ? (pack.humanChecks || []).length : 0 })), null, 2)); return 0; }
        if (!items.length) { out(`No add-ons installed (${addonsDir(env)}).\nSee what is available: anvil addon list --available`); return 0; }
        for (const it of items) {
          const n = it.pack ? `${it.pack.checks.length} checks, ${(it.pack.humanChecks || []).length} human checks` : '';
          const state = !it.ok ? `BROKEN: ${clean(it.errors[0], 120)}` : it.compatible ? n : `needs Anvil ${clean(it.pack.anvil, 20)}`;
          out(`  ${it.id}@${it.version}`.padEnd(32) + ` ${clean(it.name || '', 50)}  (${state})`);
        }
        return 0;
      }
      case 'add': case 'install': {
        const fileIdx = rest.indexOf('--file');
        const r = fileIdx >= 0
          ? (rest[fileIdx + 1] ? addLocalAddon(rest[fileIdx + 1], { env }) : (() => { throw new Error('--file needs a path'); })())
          : args[0] ? await addAddon(args[0], { env, fetch: f }) : (() => { throw new Error('usage: anvil addon add <id>[@<version>]'); })();
        out(r.status === 'already-installed' ? `${r.id}@${r.version} is already installed.` : `Installed ${r.id}@${r.version} -> ${r.folder}`);
        if (r.pack) out(`  ${r.pack.checks.length} checks, ${(r.pack.humanChecks || []).length} human checks. They run on the next "anvil scan".`);
        return 0;
      }
      case 'remove': case 'rm': case 'uninstall': {
        if (!args[0]) throw new Error('usage: anvil addon remove <id>[@<version>]');
        const removed = removeAddon(args[0], { env });
        if (!removed.length) { err(`Not installed: ${clean(args[0], 80)}`); return 1; }
        out(`Removed ${removed.join(', ')}`);
        return 0;
      }
      case 'validate': case 'lint': {
        if (!args.length) throw new Error('usage: anvil addon validate <anvil-addon.json>...');
        let bad = 0;
        for (const file of args) {
          const r = loadPackFile(file);
          if (r.ok) out(`ok   ${file}  (${r.pack.id}@${r.pack.version}, sha256 ${r.sha256})`);
          else { bad++; out(`FAIL ${file}`); for (const e of r.errors) out(`     - ${clean(e, 300)}`); }
        }
        return bad ? 1 : 0;
      }
      case undefined: case 'help': case '--help': case '-h':
        out(HELP); return 0;
      default:
        err(`Unknown addon command: ${clean(sub, 40)}\n\n${HELP}`); return 2;
    }
  } catch (e) {
    err(`anvil addon: ${clean(e.message, 500)}`);
    return 1;
  }
}
