#!/usr/bin/env node
// Smoke test for anvil-mcp over raw JSON-RPC (stdio, newline-delimited).
//   node src/mcp/smoke.mjs          initialize + tools/list (asserts the exact 9 tools)
//   node src/mcp/smoke.mjs --full   also runs a scan flow against a fake CLI that copies fixtures/sample-report.json
// Uses a temp workspace; never touches the real project.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const FULL = process.argv.includes('--full');
const EXPECTED = ['anvil_scan', 'anvil_status', 'anvil_get_report', 'anvil_list_checks', 'anvil_human_checklist',
  'anvil_record_human', 'anvil_fix_brief', 'anvil_addons', 'anvil_verify_owner'];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'anvil-mcp-smoke-'));
const env = { ...process.env, ANVIL_WORKSPACE: tmp };
if (FULL) {
  const fake = path.join(tmp, 'fake-cli.mjs');
  const sample = path.join(ROOT, 'fixtures', 'sample-report.json').replace(/\\/g, '\\\\');
  fs.writeFileSync(fake, `
import fs from 'node:fs'; import path from 'node:path';
const a = process.argv.slice(2); const opt = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
if (a[0] !== 'scan') { console.error('unknown command ' + a[0]); process.exit(2); }
const runDir = path.join(opt('--anvil-dir'), 'runs', opt('--run-id'));
fs.writeFileSync(path.join(runDir, 'progress.json'), JSON.stringify({ phase: 'browser', done: 2, total: 6, current: 'axe' }));
await new Promise((r) => setTimeout(r, 1500));
const rep = JSON.parse(fs.readFileSync('${sample}', 'utf8')); rep.runId = opt('--run-id'); rep.mode.ai = opt('--ai');
fs.writeFileSync(path.join(runDir, 'report.json'), JSON.stringify(rep, null, 2));
console.log(JSON.stringify({ ok: true, runId: opt('--run-id'), runDir, reportPath: path.join(runDir, 'report.json') }));
`);
  env.ANVIL_CLI = fake;
}

const child = spawn(process.execPath, [path.join(HERE, 'server.mjs')], { cwd: tmp, env, stdio: ['pipe', 'pipe', 'pipe'] });
let buf = '';
const waiters = new Map();
child.stdout.on('data', (d) => {
  buf += d.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && waiters.has(msg.id)) { waiters.get(msg.id)(msg); waiters.delete(msg.id); }
  }
});
let stderr = '';
child.stderr.on('data', (d) => { stderr += d; });

let nextId = 1;
function rpc(method, params) {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout on ${method}\n${stderr}`)), 20000);
    waiters.set(id, (m) => { clearTimeout(t); m.error ? reject(new Error(`${method}: ${JSON.stringify(m.error)}`)) : resolve(m.result); });
  });
}
const call = async (name, args) => {
  const r = await rpc('tools/call', { name, arguments: args });
  const t = r.content?.[0]?.text || '';
  if (r.isError) throw new Error(`${name} error: ${t}`);
  return t;
};
function assert(c, m) { if (!c) throw new Error('ASSERT: ' + m); }

try {
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: 'smoke' } });
  assert(init.serverInfo?.name === 'anvil', 'serverInfo.name');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  console.log(`initialize ok: ${init.serverInfo.name} ${init.serverInfo.version}, protocol ${init.protocolVersion}`);

  const list = await rpc('tools/list', {});
  const names = list.tools.map((t) => t.name).sort();
  assert(JSON.stringify(names) === JSON.stringify([...EXPECTED].sort()), `tools mismatch: ${names}`);
  for (const t of list.tools) assert(t.description && t.inputSchema?.type === 'object', `${t.name} schema`);
  assert(/approv/i.test(list.tools.find((t) => t.name === 'anvil_fix_brief').description), 'approval convention in fix_brief');
  assert(/read-only/i.test(list.tools.find((t) => t.name === 'anvil_scan').description), 'read-only in scan');
  console.log(`tools/list ok: ${names.join(', ')}`);

  if (FULL) {
    const appDir = path.join(tmp, 'app'); fs.mkdirSync(appDir);
    const started = JSON.parse(await call('anvil_scan', { target: appDir }));
    assert(started.state === 'running' && started.runId, 'scan started');
    console.log(`anvil_scan ok: runId ${started.runId}`);
    let st;
    for (let i = 0; i < 40; i++) {
      st = JSON.parse(await call('anvil_status', { runId: started.runId }));
      if (st.state !== 'running') break;
      await new Promise((r) => setTimeout(r, 300));
    }
    assert(st.state === 'done', `status done, got ${JSON.stringify(st)}`);
    console.log(`anvil_status ok: done, score ${st.summary.score0to100}`);
    const rep = await call('anvil_get_report', { runId: started.runId, severity: 'high' });
    assert(rep.includes('<untrusted') && rep.includes('f-role-settings-member') && !rep.includes('f-overflow-notes-phone'), 'severity filter');
    assert(rep.includes('"ai": "claude-code"'), 'ai mode passed through');
    console.log('anvil_get_report ok (severity filter, untrusted fence, ai mode)');
    const hc = await call('anvil_human_checklist', { runId: 'latest' });
    assert(hc.includes('1 not answered'), 'pending count');
    await call('anvil_record_human', { runId: started.runId, itemId: 'h-phone-notes', verdict: 'broken', note: 'Rows are cut off on my Pixel' });
    const after = JSON.parse(fs.readFileSync(path.join(started.runDir, 'report.json'), 'utf8'));
    assert(after.summary.counts.humanPending === 0 && after.summary.counts.humanBroken === 1, 'counts recomputed');
    console.log('anvil_record_human ok (counts recomputed)');
    const brief = await call('anvil_fix_brief', { runId: started.runId, format: 'claude' });
    assert(brief.includes('Rows are cut off') && brief.includes('approv'), 'brief has human broken item');
    assert(fs.existsSync(path.join(started.runDir, 'prompts', 'claude.md')), 'brief saved');
    console.log('anvil_fix_brief ok (built-in template, saved prompts/claude.md)');
    const checks = await call('anvil_list_checks', {});
    assert(checks.includes('secret-scan'), 'checks fallback');
    console.log('anvil_list_checks ok (fallback)');
    const bad = await rpc('tools/call', { name: 'anvil_status', arguments: { runId: '..' } });
    assert(bad.isError, 'rejects .. runId');
    const bad2 = await rpc('tools/call', { name: 'anvil_scan', arguments: { target: '--help' } });
    assert(bad2.isError, 'rejects flag-like target');
    console.log('input guards ok');
    // validate the edited report against the frozen schema
    try {
      const { default: Ajv } = await import('ajv');
      const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
      const ok = ajv.validate(JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', 'report.schema.json'), 'utf8')), after);
      assert(ok, 'schema: ' + JSON.stringify(ajv.errors));
      console.log('edited report.json still matches schemas/report.schema.json');
    } catch (e) { if (String(e.message).startsWith('ASSERT')) throw e; console.log('(ajv not installed, schema check skipped)'); }
  }
  console.log('SMOKE PASS');
  child.kill();
  await new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)));
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 }); } catch { /* temp dir cleanup is best effort */ }
  process.exit(0);
} catch (e) {
  console.error('SMOKE FAIL:', e.message);
  console.error(stderr);
  child.kill();
  process.exit(1);
}
