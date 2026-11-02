#!/usr/bin/env node
// Build the pinned download: dist/anvil-<version>.tgz + dist/SHA256SUMS.
//   node scripts/pack.mjs            (or: npm run pack:dl)
// Local only: runs `npm pack`, never publishes. Fails if the installers pin a different version.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const version = pkg.version;
const outName = `anvil-${version}.tgz`;

function die(msg) { console.error(`pack: ${msg}`); process.exit(1); }

// 1. Installers must pin the same version.
const pins = [
  ['install/install.ps1', /\$AnvilVersion\s*=\s*'([^']+)'/],
  ['install/install.sh', /^ANVIL_VERSION="([^"]+)"/m],
];
for (const [rel, re] of pins) {
  const f = path.join(ROOT, rel);
  if (!fs.existsSync(f)) die(`${rel} is missing`);
  const m = fs.readFileSync(f, 'utf8').match(re);
  if (!m) die(`${rel}: version pin not found`);
  if (m[1] !== version) die(`${rel} pins ${m[1]} but package.json is ${version}. Update the pin first.`);
}

// 2. npm pack (no shell on Windows unless we have to; never publish).
fs.mkdirSync(DIST, { recursive: true });
const bundledNpm = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const npmCli = process.env.npm_execpath && /\.c?js$/.test(process.env.npm_execpath) ? process.env.npm_execpath
  : fs.existsSync(bundledNpm) ? bundledNpm : null;
const args = ['pack', '--json', '--pack-destination', DIST];
const r = npmCli
  ? spawnSync(process.execPath, [npmCli, ...args], { cwd: ROOT, encoding: 'utf8' })
  : process.platform === 'win32'
    ? spawnSync(`npm pack --json --pack-destination "${DIST}"`, { cwd: ROOT, encoding: 'utf8', shell: true })
    : spawnSync('npm', args, { cwd: ROOT, encoding: 'utf8' });
if (r.status !== 0) die(`npm pack failed (exit ${r.status}):\n${r.stderr || r.error || ''}`);

let info;
try { info = JSON.parse(r.stdout.slice(r.stdout.indexOf('['))); } catch { die(`could not parse npm pack output:\n${r.stdout}`); }
const produced = path.join(DIST, info[0].filename);
if (!fs.existsSync(produced)) die(`npm pack did not write ${produced}`);

// 3. Guard: nothing that looks like local state or secrets in the tarball.
// Fatal: top-level run state, any .anvil/runs (real scan output), node_modules, dist, env and key files.
const paths = info[0].files.map((f) => f.path.replace(/\\/g, '/'));
const bad = paths.filter((p) => /^(\.anvil|\.qa|dist|node_modules)\/|(^|\/)\.anvil\/runs\/|(^|\/)node_modules\/|(^|\/)\.env(\.|$)|\.pem$|\.key$/i.test(p));
// Warn only: the bundled demo's recorded sample run under examples/ (intentional, but adds size).
const demoState = paths.filter((p) => /^examples\/.*\/(\.qa|\.anvil)\//.test(p));
if (demoState.length) console.warn(`pack: note: shipping ${demoState.length} demo run files under examples/*/.qa|.anvil (drop them from "files" to slim the tarball).`);
if (bad.length) {
  fs.rmSync(produced, { force: true });
  die(`refusing to ship local state or key files:\n  ${bad.slice(0, 20).join('\n  ')}\nTighten "files" in package.json or add an .npmignore.`);
}

const out = path.join(DIST, outName);
if (produced !== out) fs.renameSync(produced, out);

// 4. SHA256SUMS (keeps lines for other files already in dist/).
const hash = crypto.createHash('sha256').update(fs.readFileSync(out)).digest('hex');
const sumsFile = path.join(DIST, 'SHA256SUMS');
const keep = fs.existsSync(sumsFile)
  ? fs.readFileSync(sumsFile, 'utf8').split(/\r?\n/).filter((l) => l.trim() && !l.trim().endsWith(` ${outName}`))
  : [];
keep.push(`${hash}  ${outName}`);
fs.writeFileSync(sumsFile, keep.sort((a, b) => a.split(/\s+/)[1].localeCompare(b.split(/\s+/)[1])).join('\n') + '\n');

const size = fs.statSync(out).size;
console.log(`dist/${outName}  ${(size / 1024).toFixed(0)} KB  ${info[0].entryCount} files`);
console.log(`sha256 ${hash}`);
console.log('dist/SHA256SUMS updated. Upload both to https://anvil.horvans.com/dl/ (W4 publish-dl.ps1).');
