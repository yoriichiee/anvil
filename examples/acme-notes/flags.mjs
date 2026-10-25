// Acme Notes - feature flag tool. Changes take effect on the next request (no restart needed).
//   node flags.mjs                 print the state
//   node flags.mjs --on=ff_tags    turn a flag on   (then prints the state)
//   node flags.mjs --off=ff_tags   turn a flag off  (then prints the state)
// Uses the same data folder as the server: ACME_DATA_DIR, default <os temp>/acme-notes-data.
// Output (stable, Anvil parses the first line):
//   flags on: ff_tags            (or "flags on: (none)")
//   ff_tags  on   Tags on notes
import { FLAGS, readFlags, writeFlags, dataDirDefault } from './lib/store.mjs';

const dir = dataDirDefault();
const flags = readFlags(dir);
let changed = false;
for (const a of process.argv.slice(2)) {
  const m = /^--(on|off)=(.+)$/.exec(a);
  if (!m) { console.error(`unknown argument ${a} (use --on=<flag> or --off=<flag>)`); process.exit(2); }
  for (const name of m[2].split(',')) {
    if (!(name in FLAGS)) { console.error(`unknown flag ${name} (known: ${Object.keys(FLAGS).join(', ')})`); process.exit(1); }
    flags[name] = m[1] === 'on'; changed = true;
  }
}
if (changed) writeFlags(dir, flags);
const on = Object.keys(FLAGS).filter(k => flags[k]);
console.log('flags on: ' + (on.length ? on.join(' ') : '(none)'));
for (const [k, d] of Object.entries(FLAGS)) console.log(`${k.padEnd(8)} ${(flags[k] ? 'on' : 'off').padEnd(4)} ${d}`);
