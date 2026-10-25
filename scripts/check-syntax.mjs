// node --check on every .mjs/.js file of the repo (skips node_modules and dot folders). Exit 1 on the first failure list.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(mjs|js)$/.test(e.name)) files.push(p);
  }
})(root);
let bad = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) { bad++; console.error('FAIL ' + path.relative(root, f) + '\n' + r.stderr); }
  else console.log('ok   ' + path.relative(root, f));
}
console.log(`${files.length - bad}/${files.length} files pass node --check`);
process.exit(bad ? 1 : 0);
