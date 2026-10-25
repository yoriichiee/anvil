// Test helper for server.mjs: a stand-in for run.mjs (ANVIL_RUNNER=<this file>). Emits progress/log/shot lines slowly,
// starts a long-lived child process (like a test command) and honours the stop file unless FAKE_IGNORE_STOP=1 or
// <data_dir>/pr-<n>/fake-ignore-stop exists (then only a tree kill stops it). Writes results.json like the runner;
// never touches the app.
//   ANVIL_RUNNER=fixtures/fake-run.mjs ANVIL_DRY_RUN=1 node src/server.mjs --pr 995 --config <anvil.config.json>
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { configFromArgs, resolveRoot, argValue, dataDir } from '../src/config.mjs';

const a = process.argv.slice(2), pr = String(argValue(a, 'pr'));
const only = (a.find(x => x.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
const cfg = configFromArgs(a);
const root = typeof argValue(a, 'root') === 'string' ? path.resolve(argValue(a, 'root')) : resolveRoot({ configFile: cfg._file });
const dir = dataDir(cfg, root, pr);
fs.mkdirSync(dir, { recursive: true });
const resFile = path.join(dir, 'results.json');
const emit = o => process.stdout.write(JSON.stringify({ at: new Date().toISOString(), ...o }) + '\n');
const prev = fs.existsSync(resFile) ? JSON.parse(fs.readFileSync(resFile, 'utf8').replace(/^﻿/, '')) : { checks: [], shots: [] };
const ids = ['A1', 'P-member-notes.html-member', 'L-member-notes.html-member', 'R-r1', 'X-member-notes.html', 'A5'];
const run = ids.filter(id => !only.length || only.some(p => id.startsWith(p)));
const res = { ...prev, pr: +pr, started: new Date().toISOString(), finished: null, running: true, stopped: null, current: null };
for (const id of run) {
  const c = res.checks.find(x => x.id === id) || (res.checks.push({ id, group: 'Tests', name: 'Fake ' + id, area: id[0] === 'L' ? 'phone' : 'stability', blocker: false, shots: [] }), res.checks.at(-1));
  c.status = 'pending'; c.detail = '';
}
const save = () => { const t = resFile + '.fake.tmp'; fs.writeFileSync(t, JSON.stringify(res, null, 1)); fs.renameSync(t, resFile); };
save();
const kid = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });   // the "test command" grandchild
fs.writeFileSync(path.join(dir, 'fake-grandchild.pid'), String(kid.pid));
emit({ type: 'log', id: 'A1', text: 'grandchild pid ' + kid.pid });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ignoreStop = process.env.FAKE_IGNORE_STOP === '1' || fs.existsSync(path.join(dir, 'fake-ignore-stop'));
const stopNow = () => !ignoreStop && fs.existsSync(path.join(dir, 'stop'));
let done = 0;
for (const id of run) {
  const c = res.checks.find(x => x.id === id);
  if (stopNow()) break;
  c.status = 'running'; res.current = { id, label: c.name, started: new Date().toISOString() }; save();
  emit({ type: 'progress', id, label: c.name, done, total: run.length });
  for (let k = 1; k <= 3; k++) { emit({ type: 'log', id, text: `${id}: step ${k} of 3` }); await sleep(Number(process.env.FAKE_STEP_MS || (fs.existsSync(path.join(dir, 'fake-step-ms')) ? fs.readFileSync(path.join(dir, 'fake-step-ms'), 'utf8') : 700))); }
  if (id.startsWith('P-')) { emit({ type: 'shot', id, file: 'shots/member-notes-member-phone.png' }); }
  c.status = id === 'R-r1' ? 'fail' : 'pass'; c.detail = id === 'R-r1' ? 'got 200, expected 401 or 403' : 'ok'; c.blocker = id === 'R-r1';
  done++; save();
}
if (stopNow()) {
  for (const c of res.checks) if (c.status === 'running') c.status = 'stopped';
  res.stopped = new Date().toISOString();
}
res.running = false; res.current = null; res.finished = new Date().toISOString(); save();
kid.kill();
emit({ type: 'done' });
