// Anvil - check registry. A check is a plain object:
//   { id, name, needs?: 'browser'|'source'|'any', run(ctx) -> Finding[] | { status?, findings?, notChecked?, humanChecks? } }
// Finding (report.schema.json, `check` and `id` are filled in when missing):
//   { id?, severity: critical|high|medium|low|info, title, evidence: { shot?, selector?, file?, line?, request?, response? },
//     why, fix, confidence: proven|likely|unconfirmed }
// To skip, throw skip('reason') (the reason goes to notChecked). A check that crashes becomes status "warn" plus a
// notChecked entry; it never fails the scan.
//
// ctx (built by src/scan.mjs) gives checks read-only helpers:
//   ctx.target { kind, value, url, dir }   ctx.source { files, framework, analysis } | null   ctx.config (scan config)
//   await ctx.crawl()            -> browser results (pages, apiByRole, bundles, roles); throws skip when no URL/browser
//   await ctx.get(path, { method: 'GET'|'HEAD', role? }) -> { status, headers, text } same-site only, never other methods
//   ctx.locate(needle, extRe?)   -> { file, line } | null   (first match in the scanned source)
//   ctx.readFile(rel)            -> string | null           (source file, size capped)
//   ctx.log(text)
// W5's declarative add-ons (src/addons/) turn each anvil-addon.json check into an object of this shape and pass them
// to registerChecks(); nothing in an add-on is executed as code.
import { pageLoad, overflow, axe } from './browser-checks.mjs';
import { roleAccess } from './access.mjs';
import { secretScan } from './secrets.mjs';
import { backendProbe } from './backend.mjs';

import { SkipCheck, skip } from './skip.mjs';
export { SkipCheck, skip };

const ID_RE = /^[a-z0-9][a-z0-9._:-]{0,99}$/;
const SEV = ['critical', 'high', 'medium', 'low', 'info'];
const CONF = ['proven', 'likely', 'unconfirmed'];
export const BUILTIN = [pageLoad, overflow, axe, roleAccess, secretScan, backendProbe];
const registry = new Map(BUILTIN.map(c => [c.id, c]));

// add (or replace, by id) checks; returns the ids that were registered
export function registerChecks(checks, { source = 'addon' } = {}) {
  const ok = [];
  for (const c of [].concat(checks || [])) {
    if (!c || typeof c.run !== 'function' || !ID_RE.test(String(c.id || '')) || typeof c.name !== 'string') throw new Error('registerChecks: a check needs id (lower-case), name and run(ctx)');
    if (registry.has(c.id) && BUILTIN.includes(registry.get(c.id))) throw new Error('registerChecks: "' + c.id + '" is a built-in check id');
    registry.set(c.id, { ...c, source });
    ok.push(c.id);
  }
  return ok;
}
export const unregisterCheck = id => { const c = registry.get(id); if (c && !BUILTIN.includes(c)) registry.delete(id); };
export const listChecks = () => [...registry.values()].map(c => ({ id: c.id, name: c.name, needs: c.needs || 'any', source: c.source || 'builtin', description: c.description || '' }));
export const getCheck = id => registry.get(id) || null;

const clip = (s, n) => String(s ?? '').slice(0, n);
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9._:-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'x';

// makes a check's output schema-shaped (clips lengths, fills ids, drops empty evidence)
export function normalizeFinding(f, check, used) {
  const ev = {};
  for (const k of ['shot', 'selector', 'file', 'request', 'response']) if (f.evidence && f.evidence[k]) ev[k] = clip(f.evidence[k], k === 'request' || k === 'response' ? 4000 : k === 'selector' ? 1000 : 1024);
  if (f.evidence && Number.isInteger(f.evidence.line) && f.evidence.line >= 1 && ev.file) ev.line = f.evidence.line;
  if (!Object.keys(ev).length) ev.response = 'see check ' + check;
  let id = ID_RE.test(String(f.id || '')) ? f.id : 'f-' + slug(check + '-' + (f.title || 'finding')).slice(0, 80);
  let n = 2; const base = id; while (used.has(id)) id = base.slice(0, 95) + '-' + n++;
  used.add(id);
  return {
    id, check, severity: SEV.includes(f.severity) ? f.severity : 'info', title: clip(f.title || 'Finding', 300) || 'Finding', evidence: ev,
    why: clip(f.why || 'See the evidence.', 4000) || 'See the evidence.', fix: clip(f.fix || 'Review the evidence and decide.', 4000) || 'Review the evidence and decide.',
    confidence: CONF.includes(f.confidence) ? f.confidence : 'unconfirmed',
  };
}

const statusOf = fs => (fs.some(f => f.severity === 'critical' || f.severity === 'high') ? 'fail' : fs.some(f => f.severity === 'medium' || f.severity === 'low') ? 'warn' : 'pass');

// runs the selected checks in order -> { checksRun, findings, notChecked, humanChecks }
export async function runChecks(ctx, { only = null, skipIds = [] } = {}) {
  const checksRun = [], findings = [], notChecked = [], humanChecks = [], used = new Set();
  const list = [...registry.values()].filter(c => (!only || only.includes(c.id)) && !skipIds.includes(c.id));
  for (const c of list) {
    const t0 = Date.now();
    ctx.log && ctx.log('check ' + c.id + ': running');
    ctx.onProgress && ctx.onProgress({ check: c.id, state: 'running' });
    let status, out;
    try {
      out = await c.run(ctx);
      const r = Array.isArray(out) ? { findings: out } : (out || {});
      const fs = (r.findings || []).map(f => normalizeFinding(f, c.id, used));
      findings.push(...fs);
      for (const n of r.notChecked || []) notChecked.push({ what: clip(n.what, 500), why: clip(n.why, 1000) });
      for (const h of r.humanChecks || []) humanChecks.push(h);
      status = r.status === 'skip' ? 'skip' : (r.status && ['pass', 'fail', 'warn'].includes(r.status) ? r.status : statusOf(fs));
    } catch (e) {
      if (e instanceof SkipCheck) { status = 'skip'; notChecked.push({ what: clip(c.name, 500), why: clip(e.message, 1000) }); }
      else { status = 'warn'; notChecked.push({ what: clip(c.name, 500), why: clip('The check could not run: ' + String(e && e.message || e).replace(/\s+/g, ' '), 1000) }); }
    }
    checksRun.push({ id: c.id, name: clip(c.name, 200), status, durationMs: Math.max(0, Date.now() - t0) });
    ctx.log && ctx.log('check ' + c.id + ': ' + status);
    ctx.onProgress && ctx.onProgress({ check: c.id, state: status });
  }
  return { checksRun, findings, notChecked, humanChecks };
}
