// Acme Notes - "build": copies public/ into an output folder and writes manifest.json listing every page.
//   node build.mjs                 -> ./dist
//   node build.mjs --out=<dir>     -> <dir> (Anvil passes its own folder so the working tree is never touched)
// Serve a build with: ACME_APP_DIR=<dir> node server.mjs
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, 'public');

export function build(outDir) {
  const t = Date.now();
  const out = path.resolve(outDir);
  if (out === SRC || out.startsWith(SRC + path.sep)) throw new Error('--out must not be inside public/');
  fs.rmSync(out, { recursive: true, force: true });
  fs.cpSync(SRC, out, { recursive: true });
  const pages = {};
  const appDir = path.join(out, 'app');
  for (const folder of fs.readdirSync(appDir).sort()) {
    const dir = path.join(appDir, folder);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.html')).sort()) {
      const html = fs.readFileSync(path.join(dir, f), 'utf8');
      const title = (/<title>([^<]*)<\/title>/i.exec(html) || [])[1] || f;
      pages[folder + '/' + f] = { role: folder, title: title.replace(/\s*·\s*Acme Notes$/, ''), bytes: Buffer.byteLength(html),
        sha256: crypto.createHash('sha256').update(html).digest('hex').slice(0, 12) };
    }
  }
  const files = [];
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else files.push(p); } })(out);
  const manifest = { app: 'acme-notes', built: new Date().toISOString(), roles: ['admin', 'member', 'guest'], pages };
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return { out, pages: Object.keys(pages).length, files: files.length + 1, ms: Date.now() - t };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = process.argv.slice(2).find(a => a.startsWith('--out='));
  try {
    const r = build(arg ? arg.slice(6) : path.join(HERE, 'dist'));
    console.log(`wrote ${r.out}`);
    console.log(`build ok: ${r.pages} pages, ${r.files} files, manifest.json written in ${r.ms} ms`);
  } catch (e) { console.error('build failed: ' + e.message); process.exit(1); }
}
