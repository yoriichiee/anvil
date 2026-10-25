// Acme Notes - test runner with a one-line summary that tools (Anvil) can parse.
// `node --test tests/` works too; this wrapper runs each test file on its own and prints:
//   <file>                       a section per file
//     ok   <test name>
//     FAIL <test name>
//   RESULT: 14 tests, 1 failed, 1.3 s (flaky.test.mjs)      <- failing files in brackets, comma separated
//   node run-tests.mjs                   all files in tests/
//   node run-tests.mjs flaky.test.mjs    only files whose name contains the argument
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(HERE, 'tests');
const filter = process.argv[2] || '';
const files = fs.readdirSync(DIR).filter(f => f.endsWith('.test.mjs') && (!filter || f.includes(path.basename(filter)))).sort();
if (!files.length) { console.log(`RESULT: 0 tests, 0 failed, 0 s (no test file matches "${filter}")`); process.exit(1); }

const runFile = f => new Promise(resolve => {
  const p = spawn(process.execPath, ['--test', '--test-reporter=tap', path.join(DIR, f)], { cwd: HERE, windowsHide: true });
  let out = '';
  p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { out += d; });
  p.on('close', code => resolve({ code, out }));
});

const t0 = Date.now();
let total = 0, failed = 0;
const failedFiles = [];
for (const f of files) {
  const { code, out } = await runFile(f);
  console.log(f);
  const lines = out.split(/\r?\n/);
  let n = 0, bad = 0;
  for (const l of lines) {
    const m = /^(not )?ok \d+ - (.+?)(?: # .*)?$/.exec(l);   // top-level tests only (subtests are indented)
    if (!m) continue;
    n++; if (m[1]) bad++;
    console.log(`  ${m[1] ? 'FAIL' : 'ok  '} ${m[2]}`);
    if (m[1]) {   // show the assertion message under a failing test
      const msg = lines.find(x => /^\s+error: /.test(x));
      if (msg) console.log('       ' + msg.trim().replace(/^error:\s*/, '').replace(/^['|"]|['|"]$/g, ''));
    }
  }
  if (code !== 0 && !bad) { bad = 1; n = n || 1; console.log('  FAIL (file crashed, exit ' + code + ')'); }
  total += n; failed += bad;
  if (bad) failedFiles.push(f);
}
const secs = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`RESULT: ${total} tests, ${failed} failed, ${secs} s` + (failedFiles.length ? ` (${failedFiles.join(', ')})` : ''));
process.exit(failed ? 1 : 0);
