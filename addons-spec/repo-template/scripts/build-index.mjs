#!/usr/bin/env node
// build-index.mjs - validates every pack in packs/<id>/<version>/anvil-addon.json and writes index.json.
//
//   node scripts/build-index.mjs                       validate + write index.json
//   node scripts/build-index.mjs --check               validate + fail if the committed index.json is stale
//   node scripts/build-index.mjs --previous base.json  also enforce immutable versions against an older index
//   node scripts/build-index.mjs --out dist/index.json --root .
//
// Per pack it runs: folder layout rules, the schema (via pack-validate.mjs, a zero-dependency mirror of
// schema/anvil-addon.schema.json), policy lint (unique ids, same-site GET/HEAD probes only) and the ReDoS
// lint on every regex. It then records sha256 + size of the exact file bytes, which `anvil addon add`
// verifies before installing. Zero dependencies: runs on a bare Node 20+.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { checkPack, compareSemver, parseSemver } from './pack-validate.mjs';

const ALLOWED_FILES = new Set(['anvil-addon.json', 'README.md']);
const MAX_PACK_BYTES = 256 * 1024;
export const REGISTRY = 'https://github.com/yoriichiee/anvil-addons';

export function buildIndex(root) {
  const errors = [];
  const packsDir = path.join(root, 'packs');
  const byId = new Map();
  let ids = [];
  try { ids = fs.readdirSync(packsDir, { withFileTypes: true }); } catch { errors.push('packs/: folder not found'); }
  for (const idEnt of ids) {
    const at = `packs/${idEnt.name}`;
    if (!idEnt.isDirectory()) { errors.push(`${at}: only pack folders belong in packs/`); continue; }
    for (const vEnt of fs.readdirSync(path.join(packsDir, idEnt.name), { withFileTypes: true })) {
      const vat = `${at}/${vEnt.name}`;
      if (!vEnt.isDirectory() || !parseSemver(vEnt.name)) { errors.push(`${vat}: expected a <version> folder (semver)`); continue; }
      const dir = path.join(packsDir, idEnt.name, vEnt.name);
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!f.isFile() || !ALLOWED_FILES.has(f.name)) errors.push(`${vat}/${f.name}: not allowed (a version folder holds anvil-addon.json and an optional README.md; add-ons are declarative, no code)`);
      }
      const file = path.join(dir, 'anvil-addon.json');
      if (!fs.existsSync(file)) { errors.push(`${vat}: missing anvil-addon.json`); continue; }
      const buf = fs.readFileSync(file);
      const rel = `${vat}/anvil-addon.json`;
      if (buf.length > MAX_PACK_BYTES) { errors.push(`${rel}: larger than ${MAX_PACK_BYTES} bytes`); continue; }
      if (buf.includes(13)) errors.push(`${rel}: use LF line endings (CRLF changes the sha256)`);
      let pack;
      try { pack = JSON.parse(buf.toString('utf8')); } catch (e) { errors.push(`${rel}: not valid JSON (${e.message})`); continue; }
      const r = checkPack(pack);
      for (const e of r.errors) errors.push(`${rel}: ${e}`);
      if (!r.ok) continue;
      if (pack.id !== idEnt.name) errors.push(`${rel}: id "${pack.id}" does not match folder "${idEnt.name}"`);
      if (pack.version !== vEnt.name) errors.push(`${rel}: version "${pack.version}" does not match folder "${vEnt.name}"`);
      if (!byId.has(pack.id)) byId.set(pack.id, []);
      byId.get(pack.id).push({ pack, path: rel, sha256: crypto.createHash('sha256').update(buf).digest('hex'), size: buf.length });
    }
  }
  const packs = [...byId.keys()].sort().map(id => {
    const vs = byId.get(id).sort((a, b) => compareSemver(b.pack.version, a.pack.version));
    const stable = vs.find(v => !parseSemver(v.pack.version).pre) || vs[0];
    const head = stable.pack;
    return {
      id,
      name: head.name,
      description: head.description,
      author: head.author,
      license: head.license,
      tags: head.tags,
      latest: head.version,
      versions: vs.map(v => ({
        version: v.pack.version,
        anvil: v.pack.anvil,
        path: v.path,
        sha256: v.sha256,
        size: v.size,
        kinds: [...new Set(v.pack.checks.map(c => c.kind))].sort(),
        checks: v.pack.checks.length,
        humanChecks: (v.pack.humanChecks || []).length,
      })),
    };
  });
  return { index: { schemaVersion: '1', registry: REGISTRY, packs }, errors };
}

// Published versions never change and never disappear.
export function compareWithPrevious(prev, next) {
  const errors = [];
  const now = new Map();
  for (const p of next.packs) for (const v of p.versions) now.set(`${p.id}@${v.version}`, v.sha256);
  for (const p of (prev && prev.packs) || []) for (const v of p.versions || []) {
    const key = `${p.id}@${v.version}`;
    if (!now.has(key)) errors.push(`${key}: published versions cannot be removed`);
    else if (now.get(key) !== v.sha256) errors.push(`${key}: published versions are immutable (sha256 changed); publish a new version instead`);
  }
  return errors;
}

export const serialize = index => JSON.stringify(index, null, 2) + '\n';

function main(argv) {
  const opt = { root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), out: null, check: false, previous: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') opt.check = true;
    else if (a === '--root') opt.root = path.resolve(argv[++i]);
    else if (a === '--out') opt.out = path.resolve(argv[++i]);
    else if (a === '--previous') opt.previous = path.resolve(argv[++i]);
    else { console.error(`unknown option ${a}`); return 2; }
  }
  opt.out = opt.out || path.join(opt.root, 'index.json');
  const { index, errors } = buildIndex(opt.root);
  if (opt.previous) {
    let prev = null;
    try { prev = JSON.parse(fs.readFileSync(opt.previous, 'utf8')); } catch (e) { errors.push(`--previous ${opt.previous}: ${e.message}`); }
    if (prev) errors.push(...compareWithPrevious(prev, index));
  }
  if (errors.length) {
    console.error(`FAIL: ${errors.length} problem(s)`);
    for (const e of errors) console.error(`  - ${e}`);
    return 1;
  }
  const text = serialize(index);
  const n = index.packs.reduce((s, p) => s + p.versions.length, 0);
  if (opt.check) {
    let cur = '';
    try { cur = fs.readFileSync(opt.out, 'utf8'); } catch { /* missing */ }
    if (cur !== text) { console.error(`FAIL: ${path.relative(process.cwd(), opt.out) || opt.out} is out of date. Run: node scripts/build-index.mjs`); return 1; }
    console.log(`ok: ${index.packs.length} pack(s), ${n} version(s); index.json is up to date`);
    return 0;
  }
  fs.mkdirSync(path.dirname(opt.out), { recursive: true });
  fs.writeFileSync(opt.out, text);
  console.log(`ok: ${index.packs.length} pack(s), ${n} version(s) -> ${opt.out}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
