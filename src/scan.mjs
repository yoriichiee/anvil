// Anvil - one scan of a target (url | folder | zip) -> .anvil/runs/<runId>/{report.json, report.html, fix-brief.md,
// prompts/, shots/, status.json, log.txt}. Also the run API the CLI and the MCP server (W2) use:
//   scan(opts), getRun(runId), listRuns(), recordHuman(runId, itemId, verdict, note?, shot?), fixBrief(runId, format),
//   listChecks(), verifyOwner(url)
// Read-only toward the target: GET/HEAD only, never submits forms, never runs install scripts without allowScripts.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { readJSON, writeJSON } from './lib.mjs';
import { parseTarget, isLocalHost, checkOwnership, ownerToken, extractZip, unwrapSingleDir, startPlan, startApp, waitForUrl, ANVIL_HOME } from './target.mjs';
import { listFiles, analyze, detectFramework, locate as locateIn } from './source.mjs';
import { runChecks, listChecks as registryList, skip, registerChecks, unregisterCheck } from './checks/index.mjs';
import { crawl as runCrawl, launchBrowser } from './checks/crawl.mjs';
import { resolveProvider } from './ai/provider.mjs';
import { humanChecklist } from './ai/checklist.mjs';
import { polishBrief } from './ai/brief.mjs';
import { buildReport, writeOutputs, summarize, fixBriefMd, promptMd } from './output.mjs';
import { loginPath, normalizeConfig } from './config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const VERSION = (() => { try { return JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8')).version; } catch { return '0.0.0'; } })();
export const newRunId = (d = new Date()) => d.toISOString().replace(/[:.]/g, '-');
const RUN_ID = /^[A-Za-z0-9._-]{1,80}$/;

// ---------------------------------------------------------------- run index (~/.anvil/runs.json: runId -> folder) so anvil_status{runId} works from anywhere
const indexFile = () => path.join(ANVIL_HOME(), 'runs.json');
function indexRun(runId, dir) {
  let all = {}; try { all = JSON.parse(fs.readFileSync(indexFile(), 'utf8')); } catch {}
  all[runId] = dir;
  const keys = Object.keys(all); if (keys.length > 500) for (const k of keys.slice(0, keys.length - 500)) delete all[k];
  fs.mkdirSync(path.dirname(indexFile()), { recursive: true });
  fs.writeFileSync(indexFile(), JSON.stringify(all, null, 1));
}
export function runDirOf(runId, { base } = {}) {
  if (!RUN_ID.test(String(runId))) throw new Error('bad run id');
  if (base) { const d = path.join(base, '.anvil', 'runs', runId); if (fs.existsSync(d)) return d; }
  let all = {}; try { all = JSON.parse(fs.readFileSync(indexFile(), 'utf8')); } catch {}
  if (all[runId] && fs.existsSync(all[runId])) return all[runId];
  const d = path.join(process.cwd(), '.anvil', 'runs', runId);
  if (fs.existsSync(d)) return d;
  throw new Error('unknown run ' + runId);
}
export function listRuns({ limit = 20 } = {}) {
  let all = {}; try { all = JSON.parse(fs.readFileSync(indexFile(), 'utf8')); } catch {}
  return Object.entries(all).reverse().slice(0, limit).map(([runId, dir]) => { const s = readJSONSync(path.join(dir, 'status.json')) || {}; return { runId, dir, state: s.state || 'unknown', target: s.target || null }; });
}
const readJSONSync = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')); } catch { return null; } };

// ---------------------------------------------------------------- scan config
// Sources (later wins): <dir>/anvil.config.json legacy fields (roles.list + app.login_path + app.origin + start_command),
// its "scan" section, then <dir>/.anvil/scan.json. Shape of scan config:
//   { start?: "/", roles?: [{ name, login: "/dev/login/admin", start? }], access?: [{ id?, name?, as, path, method?: "GET", expect: [403] }],
//     exclude?: ["regex on path"], maxPages?: 8 }
export function loadScanConfig({ dir, configFile } = {}) {
  const out = { roles: [], access: [], exclude: [], legacy: null, sources: [] };
  const legacyFile = configFile || (dir && path.join(dir, 'anvil.config.json'));
  const raw = legacyFile ? readJSONSync(legacyFile) : null;
  if (raw) {
    out.sources.push(legacyFile);
    try {
      const cfg = normalizeConfig(raw, legacyFile); out.legacy = cfg;
      if (raw.roles && raw.app && raw.app.login_path) out.roles = cfg.roles.list.map(r => ({ name: r, login: loginPath(cfg, r, '') }));
      const plan = dir && (readJSONSync(path.join(dir, '.anvil', 'plan.json')));
      if (plan && Array.isArray(plan.access)) out.access = plan.access.map(a => ({ ...a, path: cfg.app.api_base.replace(/\/?$/, '/') + String(a.path).replace(/^\/+/, '') }));
    } catch {}
    if (raw.scan && typeof raw.scan === 'object') Object.assign(out, pickScan(raw.scan));
  }
  const sj = dir && readJSONSync(path.join(dir, '.anvil', 'scan.json'));
  if (sj) { out.sources.push(path.join(dir, '.anvil', 'scan.json')); Object.assign(out, pickScan(sj)); }
  return out;
}
const SAFE_PATH = p => typeof p === 'string' && p.startsWith('/') && !p.startsWith('//') && !p.includes('..') && p.length < 500;
function pickScan(s) {
  const o = {};
  if (Array.isArray(s.roles)) o.roles = s.roles.filter(r => r && /^[a-z][a-z0-9_-]{0,30}$/.test(r.name) && r.name !== 'anon' && (!r.login || SAFE_PATH(r.login))).map(r => ({ name: r.name, login: r.login || null, start: SAFE_PATH(r.start) ? r.start : undefined }));
  if (Array.isArray(s.access)) o.access = s.access.filter(a => a && typeof a.as === 'string' && SAFE_PATH(a.path)).map(a => ({ id: a.id, name: a.name, as: a.as, path: a.path, method: a.method || 'GET', expect: [].concat(a.expect || [401, 403]) }));
  if (Array.isArray(s.exclude)) o.exclude = s.exclude.filter(x => typeof x === 'string').slice(0, 50);
  if (Number.isInteger(s.maxPages)) o.maxPages = Math.max(1, Math.min(40, s.maxPages));
  if (SAFE_PATH(s.start)) o.start = s.start;
  return o;
}

// ---------------------------------------------------------------- scan
// opts: { target, url?, dir?, out?, ai?, aiMode?, allowScripts?, only?: [ids], skip?: [ids], noBrowser?, noProbe?, maxPages?,
//         ownerToken?, configFile?, runId?, log?, onProgress?, fetchImpl? }
export async function scan(opts) {
  const log0 = opts.log || (() => {});
  const t = parseTarget(opts.target);
  let dir = t.kind === 'dir' ? t.abs : opts.dir ? path.resolve(opts.dir) : null;
  const baseDir = t.kind === 'zip' ? path.dirname(t.abs) : dir || process.cwd();
  const runId = opts.runId || newRunId();
  const runDir = path.resolve(opts.out ? path.join(opts.out, runId) : path.join(baseDir, '.anvil', 'runs', runId));
  const shotsDir = path.join(runDir, 'shots');
  fs.mkdirSync(shotsDir, { recursive: true });
  try { const gi = path.join(baseDir, '.anvil', '.gitignore'); if (!opts.out && !fs.existsSync(gi)) fs.writeFileSync(gi, 'runs/\ntmp/\n'); } catch {}
  indexRun(runId, runDir);
  const logLines = [];
  const log = s => { const line = new Date().toISOString().slice(11, 19) + ' ' + s; logLines.push(line); log0(s); };
  const status = { runId, state: 'running', target: { kind: t.kind, value: t.value }, startedAt: new Date().toISOString(), step: 'starting', checks: {} };
  const saveStatus = () => writeJSON(path.join(runDir, 'status.json'), status).catch(() => {});
  await saveStatus();
  let app = null, tmpZip = null;
  try {
    // zip -> folder (never run unless allowScripts)
    if (t.kind === 'zip') {
      status.step = 'unzipping'; await saveStatus();
      tmpZip = path.join(baseDir, '.anvil', 'tmp', 'zip-' + runId);
      await extractZip(t.abs, tmpZip);
      dir = unwrapSingleDir(tmpZip);
      log('unzipped to ' + dir);
    }
    const cfg = loadScanConfig({ dir, configFile: opts.configFile });
    if (opts.maxPages) cfg.maxPages = opts.maxPages;
    // a URL to test
    let url = t.kind === 'url' ? t.url : opts.url || null;
    const startNotes = [];
    if (!url && dir && !opts.noBrowser) {
      const plan = startPlan(dir, { legacy: cfg.legacy, allowScripts: !!opts.allowScripts, untrusted: t.kind === 'zip' });
      if (plan.origin && await waitForUrl(plan.origin + '/', 1500)) { url = plan.origin + '/'; log('app already running at ' + url); }
      else if (plan.how === 'none') startNotes.push({ what: 'Browser checks (page load, sideways scroll, accessibility, role access)', why: 'The app was not started: ' + plan.reason + '.' });
      else {
        status.step = 'starting app'; await saveStatus();
        try { app = await startApp(dir, plan, { allowScripts: !!opts.allowScripts, log }); url = app.url; }
        catch (e) { startNotes.push({ what: 'Browser checks (page load, sideways scroll, accessibility, role access)', why: 'Could not start the app: ' + String(e.message).slice(0, 600) }); }
      }
    }
    let origin = null;
    if (url) {
      const u = new URL(url); origin = u.origin;
      if (!isLocalHost(u.hostname)) {
        status.step = 'ownership'; await saveStatus();
        const own = await checkOwnership(url, { token: opts.ownerToken, fetchImpl: opts.fetchImpl });
        if (!own.ok) throw Object.assign(new Error('Remote URL not verified: ' + own.reason + '. Anvil only scans sites you own: run "anvil verify-owner ' + origin + '", put the token in ' + own.wellKnown + ', then scan again. (localhost is always allowed.)'), { code: 'OWNERSHIP' });
        log('ownership verified via ' + own.wellKnown);
      }
    }
    // source
    let source = null;
    if (dir) {
      status.step = 'reading source'; await saveStatus();
      const { files, ignoredDirs, truncated } = listFiles(dir);
      source = { root: dir, files, ignoredDirs, truncated, framework: detectFramework(dir), analysis: analyze(dir, { files }) };
      log(`source: ${files.length} files` + (ignoredDirs.length ? `, skipped git-ignored ${ignoredDirs.slice(0, 5).join(', ')}` : ''));
    }
    // context for checks
    let crawlP = null;
    const ctx = {
      target: { kind: t.kind, value: t.value, url, dir }, origin, runDir, shotsDir, config: cfg, source, opts, log,
      fetch: opts.fetchImpl || globalThis.fetch,
      onProgress: p => { status.checks[p.check] = p.state; status.step = 'check ' + p.check; saveStatus(); opts.onProgress && opts.onProgress(p); },
      crawl() {
        if (!origin) return Promise.reject(skip(startNotes[0] ? startNotes[0].why : 'No URL to open: give a URL, or a folder Anvil can start (or --url).'));
        if (opts.noBrowser) return Promise.reject(skip('Browser checks were turned off (--no-browser).'));
        if (!crawlP) crawlP = runCrawl({ origin, startUrl: cfg.start ? origin + cfg.start : url, roles: cfg.roles, maxPages: cfg.maxPages || 8, shotsDir, exclude: cfg.exclude, log })
          .catch(e => { throw skip('The browser could not run: ' + String(e.message).split('\n')[0].slice(0, 300)); });
        return crawlP;
      },
      locate: (needle, re) => (source ? locateIn(source.files, needle, re) : null),
      readFile: rel => { if (!source) return null; const f = source.files.find(x => x.rel === rel); if (!f || f.size > 1e6) return null; try { return fs.readFileSync(f.abs, 'utf8'); } catch { return null; } },
      async get(p, { method = 'GET' } = {}) {
        if (!origin) throw skip('no URL');
        method = String(method).toUpperCase(); if (method !== 'GET' && method !== 'HEAD') throw new Error('only GET and HEAD are sent');
        const u = new URL(p, origin); if (u.origin !== origin) throw new Error('not same-site: ' + p);
        const r = await (opts.fetchImpl || fetch)(u.href, { method, redirect: 'manual', signal: AbortSignal.timeout(10000) });
        const text = method === 'HEAD' ? '' : (await r.text()).slice(0, 2e6);
        return { status: r.status, headers: Object.fromEntries(r.headers), text };
      },
    };
    // installed add-on packs (W5, declarative JSON) -> registered as checks for this scan
    const addons = await loadAddons(ctx, opts);
    status.step = 'checks'; await saveStatus();
    let checks;
    try {
      const only = opts.only ? [...opts.only, ...addons.ids] : null;
      checks = await runChecks(ctx, { only, skipIds: opts.skip || [] });
    } finally {
      for (const id of addons.ids) unregisterCheck(id);
      await addons.close();
    }
    checks.humanChecks.push(...addons.humanChecks);
    checks.notChecked.push(...addons.problems);
    // human checklist (templates or AI) + report
    status.step = 'report'; await saveStatus();
    let provider = { name: 'none', mode: 'none' };
    try { provider = await resolveProvider(opts.ai); if (provider.warning) log(provider.warning); } catch (e) { log(e.message); }
    let crawled = null; if (crawlP) crawled = await crawlP.catch(() => null);
    const pages = crawled ? crawled.pages.map(p => ({ role: p.role, path: p.finalPath || p.path })) : [];
    const features = source ? source.analysis.features : {};
    const hc = await humanChecklist({ provider, features, findings: checks.findings, pages, extra: checks.humanChecks }, opts.fetchImpl);
    if (hc.warning) log(hc.warning);
    const extraNc = [...startNotes];
    if (!source) extraNc.push({ what: 'Source code (secret scan of files, Supabase / Firebase config)', why: 'Only a URL was given. Pass --dir <project folder> to scan the code too.' });
    const aiMode = opts.aiMode || (provider.mode === 'byok' ? 'byok' : provider.mode === 'credits' ? 'credits' : 'none');
    const report = buildReport({ runId, version: VERSION, target: { kind: t.kind, value: t.kind === 'zip' ? path.basename(t.abs) : t.value }, aiMode, checks, humanChecks: hc.items, notChecked: [...checks.notChecked, ...extraNc] });
    const polish = await polishBrief({ provider, report }, opts.fetchImpl);
    const files = await writeOutputs(runDir, report, polish);
    fs.writeFileSync(path.join(runDir, 'log.txt'), logLines.join('\n') + '\n');
    Object.assign(status, { state: 'done', step: 'done', finishedAt: new Date().toISOString(), summary: report.summary, files });
    await saveStatus();
    return { runId, runDir, report, files: files.map(f => path.join(runDir, f)) };
  } catch (e) {
    Object.assign(status, { state: 'error', step: 'error', error: String(e.message).slice(0, 1000), finishedAt: new Date().toISOString() });
    await saveStatus();
    try { fs.writeFileSync(path.join(runDir, 'log.txt'), logLines.join('\n') + '\nERROR ' + e.message + '\n'); } catch {}
    throw e;
  } finally {
    if (app) await app.stop().catch(() => {});
    if (tmpZip) try { fs.rmSync(tmpZip, { recursive: true, force: true }); } catch {}
  }
}

// ---------------------------------------------------------------- add-ons (W5) -> registry, with a ctx adapter
// W5's runtime expects { baseUrl, page, files, rulesTargets, fetch, shot, timeoutMs }; build that from the engine ctx.
// A browser page is opened lazily, only when an add-on check of kind page/dom/axe actually runs.
async function loadAddons(ctx, opts) {
  const none = { ids: [], humanChecks: [], problems: [], close: async () => {} };
  if (opts.noAddons) return none;
  let mod;
  try { mod = await import('./addons/index.mjs'); } catch { return none; }
  let res;
  try { res = await mod.registerInstalledAddons({ only: opts.addons || undefined, registerChecks: () => {} }); }
  catch (e) { return { ...none, problems: [{ what: 'Add-on packs', why: 'Could not load installed add-ons: ' + String(e.message).slice(0, 300) }] }; }
  if (!res.checks.length) return { ...none, humanChecks: res.humanChecks, problems: res.problems };
  let browser = null, pageP = null;
  const getPage = () => {
    if (!ctx.origin || opts.noBrowser) return Promise.resolve(null);
    if (!pageP) pageP = launchBrowser(ctx.log).then(async b => { browser = b; const c = await b.newContext({ viewport: { width: 1366, height: 900 } }); return c.newPage(); }).catch(() => null);
    return pageP;
  };
  const files = () => (ctx.source ? ctx.source.files.filter(f => f.size <= 2e6).map(f => { let text = ''; try { text = fs.readFileSync(f.abs, 'utf8'); } catch {} return { path: f.rel, text }; }) : null);
  const rulesTargets = () => {
    if (!ctx.source || opts.noProbe) return [];
    const sb = ctx.source.analysis.supabase, key = sb.anonKeys[0];
    return key ? sb.urls.slice(0, 3).map(base => ({ base, name: 'supabase', headers: { apikey: key, Authorization: 'Bearer ' + key } })) : [];
  };
  const wrapped = res.checks.map(c => ({ ...c, needs: c.kind === 'secret-pattern' ? 'source' : 'browser', async run() {
    const page = ['page', 'dom', 'axe'].includes(c.kind) ? await getPage() : null;
    const shot = page ? async name => { const rel = 'shots/addon-' + name + '.png'; await page.screenshot({ path: path.join(ctx.runDir, rel) }); return rel; } : undefined;
    return c.run({ baseUrl: ctx.origin || undefined, page: page || undefined, files: c.kind === 'secret-pattern' ? files() : undefined,
      rulesTargets: c.kind === 'rules-probe' ? rulesTargets() : [], fetch: ctx.fetch, shot, timeoutMs: 15000 });
  } }));
  const ids = registerChecks(wrapped);
  ctx.log('add-ons: ' + res.packs.map(p => p.id + '@' + p.version).join(', ') + ' (' + ids.length + ' checks)');
  return { ids, humanChecks: res.humanChecks, problems: res.problems, close: async () => { if (browser) await browser.close().catch(() => {}); } };
}

// ---------------------------------------------------------------- run folder helpers for the MCP CLI contract
// <anvilDir>/runs/<runId>; re-scores (human verdicts count) and rewrites report.html, fix-brief.md and prompts/.
export function runDirIn(anvilDir, runId) {
  if (!RUN_ID.test(String(runId))) throw new Error('bad run id');
  const d = path.join(path.resolve(anvilDir), 'runs', runId);
  if (!fs.existsSync(path.join(d, 'report.json'))) throw new Error('no report.json in ' + d);
  return d;
}
export async function renderRun(dir) {
  const r = await readJSON(path.join(dir, 'report.json'));
  if (!r) throw new Error('no report yet');
  r.summary = summarize(r.findings, r.humanChecks);
  const polish = await readJSON(path.join(dir, 'polish.json'));
  return writeOutputs(dir, r, polish);
}

// ---------------------------------------------------------------- run API (CLI + MCP)
export async function getRun(runId, { base } = {}) {
  const dir = runDirOf(runId, { base });
  return { runId, dir, status: await readJSON(path.join(dir, 'status.json')), report: await readJSON(path.join(dir, 'report.json')) };
}

export async function recordHuman(runId, itemId, verdict, { note, shot, base } = {}) {
  if (!['works', 'broken', 'unsure'].includes(verdict)) throw new Error('verdict must be works, broken or unsure');
  const dir = runDirOf(runId, { base });
  const file = path.join(dir, 'report.json');
  const r = await readJSON(file);
  if (!r) throw new Error('run ' + runId + ' has no report yet');
  const h = r.humanChecks.find(x => x.id === itemId);
  if (!h) throw new Error('no human check "' + itemId + '" in run ' + runId);
  h.verdict = verdict;
  if (note != null) h.note = String(note).slice(0, 4000);
  if (shot) {
    const src = path.resolve(shot);
    if (!/\.(png|jpe?g)$/i.test(src) || !fs.existsSync(src) || fs.statSync(src).size > 8e6) throw new Error('screenshot must be an existing .png/.jpg under 8 MB');
    const name = 'human-' + itemId.replace(/[^a-z0-9-]/g, '-') + path.extname(src).toLowerCase();
    fs.copyFileSync(src, path.join(dir, 'shots', name)); h.shot = 'shots/' + name;
  }
  r.summary = summarize(r.findings, r.humanChecks);
  const polish = await readJSON(path.join(dir, 'polish.json'));
  await writeOutputs(dir, r, polish);
  return { runId, item: h, summary: r.summary };
}

export async function fixBrief(runId, format = 'md', { base } = {}) {
  const dir = runDirOf(runId, { base });
  const r = await readJSON(path.join(dir, 'report.json'));
  if (!r) throw new Error('run ' + runId + ' has no report yet');
  const polish = await readJSON(path.join(dir, 'polish.json'));
  if (format === 'md') return fixBriefMd(r, polish);
  if (['lovable', 'cursor', 'claude'].includes(format)) return promptMd(r, format, polish);
  throw new Error('format must be md, lovable, cursor or claude');
}

export const listChecks = () => registryList();

// -> { origin, token, wellKnown, ok, reason, instructions }
export async function verifyOwner(url, { fetchImpl } = {}) {
  const u = new URL(/^https?:\/\//i.test(url) ? url : 'https://' + url);
  if (isLocalHost(u.hostname)) return { origin: u.origin, ok: true, exempt: true, reason: 'local addresses never need proof', instructions: '' };
  const token = ownerToken(u.origin);
  const res = await checkOwnership(u.origin, { token, fetchImpl });
  return { origin: u.origin, token, wellKnown: res.wellKnown, ok: res.ok, reason: res.reason,
    instructions: res.ok ? '' : `Create a file served at ${res.wellKnown} whose content is this line:\n\n  ${token}\n\nThen run "anvil verify-owner ${u.origin}" again (or just "anvil scan ${u.origin}"). The token is stored in ${path.join(ANVIL_HOME(), 'owner-tokens.json')} on this computer.` };
}

export const diagnostics = () => ({ node: process.version, platform: process.platform + ' ' + os.release(), arch: process.arch, anvil: VERSION });
