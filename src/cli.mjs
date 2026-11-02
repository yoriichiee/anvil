#!/usr/bin/env node
// anvil - launch-readiness checker for AI-built apps.
//   anvil scan <url|folder|file.zip> [options]     run the checks -> .anvil/runs/<runId>/
//   anvil status <runId> | anvil runs               progress / recent runs
//   anvil report <runId> [--severity=high] [--json] print the findings
//   anvil answer <runId> <itemId> works|broken|unsure [--note "..."] [--shot file.png]
//   anvil brief <runId> [--format=md|lovable|cursor|claude]
//   anvil checks [--json]                           list checks (built-in + add-ons)
//   anvil addon list [--available] | add <id> | remove <id> | validate <file>   declarative add-on packs
//   anvil verify-owner <url>                        ownership token for a remote site (/.well-known/anvil.txt)
//   anvil key set <anthropic|openai|openrouter>     store a key in the OS keychain (reads it from stdin)
//   anvil doctor [--share]                          environment check (--share: redacted, safe to paste)
//   anvil --pr <n> ... / anvil server --pr <n> ...  the older per-PR flow (anvil-run / anvil-server)
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);

// legacy PR mode, only behind --pr
if (argv.some(a => a === '--pr' || a.startsWith('--pr='))) {
  const server = argv[0] === 'server';
  const rest = argv.filter((a, i) => !(i === 0 && (a === 'server' || a === 'run' || a === 'scan')));
  const p = spawn(process.execPath, [path.join(HERE, server ? 'server.mjs' : 'run.mjs'), ...rest], { stdio: 'inherit' });
  p.on('exit', c => process.exit(c ?? 1));
} else main().catch(e => { console.error('anvil: ' + (e && e.message || e)); process.exit(e && e.code === 'OWNERSHIP' ? 3 : 1); });

function parse(args) {
  const pos = [], o = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split(/=(.*)/s);
      if (v !== undefined) o[k] = v;
      else if (args[i + 1] !== undefined && !args[i + 1].startsWith('--') && ['url', 'dir', 'out', 'ai', 'mode', 'only', 'skip', 'config', 'note', 'shot', 'format', 'severity', 'max-pages', 'owner-token', 'run-id', 'anvil-dir', 'devices', 'addons'].includes(k)) o[k] = args[++i];
      else o[k] = true;
    } else pos.push(a);
  }
  return { pos, o };
}
const list = v => (typeof v === 'string' ? v.split(',').map(s => s.trim()).filter(Boolean) : null);
const SEV = ['critical', 'high', 'medium', 'low', 'info'];

async function main() {
  const [cmd, ...rest] = argv;
  const { pos, o } = parse(rest);
  const S = await import('./scan.mjs');
  switch (cmd) {
    case 'scan': {
      if (!pos[0]) throw new Error('usage: anvil scan <url | folder | file.zip> [--dir <src>] [--url <running app>] [--allow-scripts] [--ai none|anthropic|openai|openrouter|credits] [--only a,b] [--skip a,b] [--addons a,b] [--no-addons] [--no-browser] [--no-probe] [--out <dir>] [--json]');
      const quiet = !!o.json;
      // MCP contract (src/mcp/CLI-CONTRACT.md): --ai carries the agent name (claude-code|codex|byok|credits|none) and
      // --anvil-dir <abs .anvil> puts the run at <anvil-dir>/runs/<run-id>. --no-open / --devices are accepted (the CLI
      // never opens a browser window; devices are always phone 390px + laptop 1366px).
      let ai = o.ai, aiMode = o.mode;
      if (['claude-code', 'codex'].includes(ai)) { aiMode = ai; ai = 'none'; }
      else if (ai === 'byok') { aiMode = 'byok'; ai = undefined; }
      const out = typeof o['anvil-dir'] === 'string' ? path.join(path.resolve(o['anvil-dir']), 'runs') : o.out;
      try {
        const res = await S.scan({ target: pos[0], url: o.url, dir: o.dir, out, ai, aiMode, allowScripts: !!o['allow-scripts'], only: list(o.only), skip: list(o.skip),
          addons: list(o.addons), noAddons: !!o['no-addons'],
          noBrowser: !!o['no-browser'], noProbe: !!o['no-probe'], maxPages: o['max-pages'] ? Number(o['max-pages']) : undefined, ownerToken: o['owner-token'], configFile: o.config, runId: o['run-id'],
          log: s => process.stderr.write('  ' + s + '\n') });
        if (quiet) { process.stdout.write(JSON.stringify({ ok: true, runId: res.runId, runDir: res.runDir, reportPath: path.join(res.runDir, 'report.json'), summary: res.report.summary, files: res.files }) + '\n'); return; }
        printSummary(res.report, res.runDir);
      } catch (e) {
        if (!quiet) throw e;
        process.stdout.write(JSON.stringify({ ok: false, error: (e.code === 'OWNERSHIP' ? 'ownership not verified: ' : '') + String(e.message).slice(0, 1500) }) + '\n');
        process.exitCode = e.code === 'OWNERSHIP' ? 3 : 1;
      }
      return;
    }
    case 'render': case 'fix-brief': {
      // MCP contract: re-render a run after human answers / write the brief in one format
      try {
        const dir = typeof o['anvil-dir'] === 'string' ? S.runDirIn(o['anvil-dir'], need(o['run-id'] || pos[0], 'runId')) : (await S.getRun(need(o['run-id'] || pos[0], 'runId'))).dir;
        await S.renderRun(dir);
        const format = typeof o.format === 'string' ? o.format : 'md';
        if (!['md', 'lovable', 'cursor', 'claude'].includes(format)) throw new Error('--format must be md, lovable, cursor or claude');
        const rel = cmd === 'render' ? 'report.html' : format === 'md' ? 'fix-brief.md' : 'prompts/' + format + '.md';
        if (o.json) console.log(JSON.stringify({ ok: true, path: rel, runDir: dir }));
        else if (cmd === 'fix-brief') process.stdout.write(fs.readFileSync(path.join(dir, rel), 'utf8'));
        else console.log('re-rendered ' + path.join(dir, rel));
      } catch (e) { if (!o.json) throw e; console.log(JSON.stringify({ ok: false, error: String(e.message).slice(0, 1000) })); process.exitCode = 1; }
      return;
    }
    case 'addon': case 'addons': {
      const A = await import('./addons/index.mjs');
      const sub = pos[0];
      if (o.json && (sub === 'list' || sub === 'ls')) {
        // one JSON line: installed packs plus what the registry offers (registry errors are reported, not fatal)
        const inst = A.listInstalled().map(it => ({ id: it.id, name: it.name || it.id, version: it.version, installed: true, ok: it.ok, description: it.pack ? it.pack.description || '' : '' }));
        let available = [], registryError;
        try { const { index } = await A.fetchIndex(); available = index.packs.map(p => ({ id: p.id, name: p.name, version: p.latest || (p.versions[0] || {}).version, installed: inst.some(i => i.id === p.id), description: p.description || '' })); }
        catch (e) { registryError = String(e.message).slice(0, 300); }
        const addons = [...inst, ...available.filter(a => !inst.some(i => i.id === a.id))];
        console.log(JSON.stringify({ addons, ...(registryError ? { registryError } : {}) }));
        return;
      }
      if (o.json && (sub === 'add' || sub === 'install')) {
        try { const r = await A.addAddon(need(pos[1], 'add-on id')); console.log(JSON.stringify({ ok: true, id: r.id, version: r.version, path: r.folder, status: r.status })); }
        catch (e) { console.log(JSON.stringify({ ok: false, error: String(e.message).slice(0, 500) })); process.exitCode = 1; }
        return;
      }
      process.exitCode = await A.addonCommand(rest);
      return;
    }
    case 'status': { const r = await S.getRun(need(pos[0], 'runId')); console.log(JSON.stringify(r.status, null, 2)); return; }
    case 'runs': { for (const r of S.listRuns()) console.log(`${r.runId}  ${r.state.padEnd(7)} ${r.target ? r.target.value : ''}`); return; }
    case 'report': {
      const r = await S.getRun(need(pos[0], 'runId'));
      if (!r.report) throw new Error('no report yet (state: ' + (r.status && r.status.state) + ')');
      const min = o.severity ? SEV.indexOf(o.severity) : 4;
      if (min < 0) throw new Error('--severity must be one of ' + SEV.join(', '));
      const rep = { ...r.report, findings: r.report.findings.filter(f => SEV.indexOf(f.severity) <= min) };
      if (o.json) console.log(JSON.stringify(rep, null, 2)); else printSummary(rep, r.dir);
      return;
    }
    case 'answer': {
      const res = await S.recordHuman(need(pos[0], 'runId'), need(pos[1], 'itemId'), need(pos[2], 'works|broken|unsure'), { note: typeof o.note === 'string' ? o.note : undefined, shot: typeof o.shot === 'string' ? o.shot : undefined });
      console.log(`recorded ${res.item.id}: ${res.item.verdict} - ${res.summary.counts.humanPending} human check(s) left, score ${res.summary.score0to100}`);
      return;
    }
    case 'brief': { process.stdout.write(await S.fixBrief(need(pos[0], 'runId'), typeof o.format === 'string' ? o.format : 'md')); return; }
    case 'checks': {
      const builtin = S.listChecks().map(c => ({ id: c.id, name: c.name, kind: c.source === 'builtin' ? 'builtin' : 'addon', source: c.source }));
      let addon = [];
      try { const A = await import('./addons/index.mjs'); const { packs } = A.loadInstalledPacks(); addon = packs.flatMap(p => A.packToChecks(p).map(c => ({ id: c.id, name: c.name, kind: 'addon', source: p.id + '@' + p.version }))); } catch {}
      const all = [...builtin, ...addon];
      if (o.json) { console.log(JSON.stringify({ checks: all })); return; }
      for (const c of all) console.log(`${c.id.padEnd(20)} ${c.name}${c.kind !== 'builtin' ? '  [' + c.source + ']' : ''}`);
      return;
    }
    case 'verify-owner': {
      const r = await S.verifyOwner(need(pos[0], 'url'));
      if (o.json) {
        console.log(JSON.stringify({ url: r.origin, verified: !!r.ok, exempt: !!r.exempt, token: r.token || null, wellKnownUrl: r.wellKnown || null, instructions: r.instructions || r.reason || '' }));
        if (!r.ok) process.exitCode = 2;
        return;
      }
      if (r.exempt) { console.log(r.origin + ': ' + r.reason + '.'); return; }
      if (r.ok) { console.log(`verified: ${r.wellKnown} contains this computer's token. You can scan ${r.origin}.`); return; }
      console.log(`Not verified yet (${r.reason}).\n\n${r.instructions}`);
      process.exitCode = 2; return;
    }
    case 'key': {
      if (pos[0] !== 'set' || !['anthropic', 'openai', 'openrouter'].includes(pos[1])) throw new Error('usage: anvil key set <anthropic|openai|openrouter>   (paste the key on stdin)');
      const { keyringSet } = await import('./ai/provider.mjs');
      const chunks = []; for await (const c of process.stdin) chunks.push(c);
      const key = Buffer.concat(chunks).toString('utf8').trim();
      if (!key) throw new Error('no key on stdin');
      await keyringSet(pos[1], key);
      console.log('stored in the OS keychain (service "anvil", account "' + pos[1] + '")');
      return;
    }
    case 'doctor': { const { doctor } = await import('./doctor.mjs'); process.stdout.write(await doctor({ share: !!o.share })); return; }
    case undefined: case 'help': case '--help': case '-h': help(); return;
    case '--version': case '-v': case 'version': console.log(S.VERSION); return;
    default: throw new Error('unknown command "' + cmd + '" (try anvil help)');
  }
}
function need(v, what) { if (!v) throw new Error('missing ' + what); return v; }

function printSummary(r, dir) {
  const c = r.summary.counts;
  const out = [];
  out.push('', `Anvil · ${r.target.value}`, `score ${r.summary.score0to100}/100 (launch readiness of what was checked, not a security rating)`,
    `findings: ${SEV.map(s => c[s] + ' ' + s).join(', ')} · human checks to answer: ${c.humanPending || 0}`, '');
  for (const ch of r.checksRun) out.push(`  ${ch.status.padEnd(4)}  ${ch.name}`);
  if (r.findings.length) out.push('');
  for (const f of r.findings.slice(0, 25)) out.push(`  [${f.severity}] ${f.title}${f.evidence.file ? '  (' + f.evidence.file + (f.evidence.line ? ':' + f.evidence.line : '') + ')' : ''}`);
  if (r.findings.length > 25) out.push(`  ... and ${r.findings.length - 25} more`);
  out.push('', 'Not checked: ' + r.notChecked.map(n => n.what).join('; '), '');
  if (dir) out.push('report:    ' + path.join(dir, 'report.html'), 'fix brief: ' + path.join(dir, 'fix-brief.md'), 'run id:    ' + r.runId, '');
  console.log(out.join('\n'));
}

function help() {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter(l => l.startsWith('//')).slice(0, 13).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
}
