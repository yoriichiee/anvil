// Anvil - scoring + report text (docs/ARCHITECTURE.md). Imported by server.mjs.
//   score(plan, results, state)                       -> summary (contract formula; needs no config)
//   draft(plan, results, state, summary, opts)        -> { comments:[{lane,body}], chat_md, summary, source, warning? }
//   finalChat(md, urls)                               -> chat note with the posted comment link filled in
//   contactSheet(qaDir, plan, results, state)         -> abs path of screens.png (Playwright via lib.mjs, lazy import)
// Never invents results: every line comes from plan/results/state; Claude only rewrites and is validated against them.
// Project wording (review commands, signature, lanes, roles, page paths) comes from the config (opts.cfg).
//   node src/report.mjs <qaDir> [--config <file>] [--no-claude]   prints summary + draft for a <data_dir>/pr-<n>/ folder
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { normalizeConfig, configFromArgs, fill, passLine, fixLine, signature as sigOf, laneForArea, pagePrefix, envOf, ConfigError } from './config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const AREAS = ['works', 'roles', 'phone', 'laptop', 'stability'];
export const REPORT_URL = '{report_url}';            // placeholder in draft.chat_md, replaced after posting
const GROUP_AREA = { Tests: 'stability', Build: 'stability', CI: 'stability', Pages: 'works', Roles: 'roles', Flags: 'roles', Layout: 'phone', Accessibility: 'laptop' };
const AUTO_PTS = { pass: 1, flake: 0.75, warn: 0.5, fail: 0 };   // preexisting / skip / pending / running: left out
const MAN_PTS = { works: 1, unsure: 0.5, broken: 0 };            // null / missing: left out
const r1 = x => Math.round(x * 10) / 10;
const areaOf = c => AREAS.includes(c.area) ? c.area : (GROUP_AREA[c.group] || 'stability');
const ans = (state, id) => (state?.manual?.[id]?.answer) || null;
export const stars = n => { const k = Math.max(0, Math.min(5, Math.round(n || 0))); return '★'.repeat(k) + '☆'.repeat(5 - k); };
const oneLine = (s, n = 160) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const reEsc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
let DEFAULT_CFG = null;
const cfgOf = opts => opts?.cfg || (DEFAULT_CFG ||= normalizeConfig({}));

// ---- hand-check overrides ("Check it myself") ------------------------------------------------------------------
// state.overrides[id] = {status: pass|fail, note, at}. Returns results with status = override, auto_status = runner's,
// override = {...}. Idempotent (re-applying uses auto_status). A "fail" override is a blocker only for blocker-type
// checks (tests A1, build A5, pages P-, access R-, flags F-), matching the runner's blocker rule.
const BLOCKER_TYPE = /^(A1$|A5$|P-|R-|F-)/;
// Every page the PR adds or changes gets a tester look on laptop AND phone, for each role that may open it. Generated
// (ids `look-<page>-<role>-<device>`), so the plan cannot forget them; a plan may switch it off with
// "page_looks": false, or replace one by writing a manual item with the same id.
export function expandPlan(plan, cfg) {
  if (!plan || plan.page_looks === false) return plan;
  const fm = cfg?.roles?.folder_map || {}, def = cfg?.roles?.default || cfg?.roles?.list?.[0];
  const manual = [...(plan.manual || [])], have = new Set(manual.map(m => m.id));
  const ui = (plan.lanes || []).includes(cfg?.review?.ui_lane || 'ui') ? (cfg?.review?.ui_lane || 'ui') : (plan.lanes || [])[0];
  for (const p of plan.pages || []) {
    const roles = p.roles?.length ? p.roles : [fm[String(p.page).split('/')[0]] || def].filter(Boolean);
    for (const role of roles) for (const [device, label, size] of [['laptop', 'laptop', '1440 px'], ['phone', 'phone', '390 px']]) {
      const id = `look-${String(p.page).replace(/\.html?$/, '').replace(/[^a-z0-9]+/gi, '-')}-${role}-${device}`;
      if (have.has(id)) continue;
      manual.push({ id, generated: true, area: device, lane: ui, needs: device, role, page: p.page,
        title: `Look at ${p.page} on a ${label} (${role})`,
        why: p.why ? `Changed in this PR: ${p.why}` : 'This page is new or changed in this PR.',
        steps: [`Open the page as ${role} on ${label} size (${size}).`, 'Read everything on it and try each button, link and form on the page.',
          'Scroll to the end. Compare with the other size if something looks odd.'],
        good: `Everything fits the ${label} screen, nothing overlaps or is cut off, text is readable, and every control works.` });
    }
  }
  return { ...plan, manual };
}

export function applyOverrides(results, state) {
  const ov = state?.overrides || {};
  if (!results) return results;
  return { ...results, checks: (results.checks || []).map(c0 => {
    const c = 'auto_status' in c0 ? { ...c0, status: c0.auto_status, blocker: c0.auto_blocker } : c0;
    const { auto_status, auto_blocker, override, ...base } = c;
    const o = ov[c.id];
    if (!o || !['pass', 'fail'].includes(o.status)) return base;
    return { ...base, status: o.status, blocker: o.status === 'fail' && BLOCKER_TYPE.test(c.id), auto_status: base.status, auto_blocker: !!base.blocker, override: o };
  }) };
}
const handNote = c => c.override ? ` (checked by hand${c.override.note ? ': ' + oneLine(c.override.note, 200) : ''}; automatic result: ${c.auto_status}${c.detail ? ' - ' + oneLine(c.detail, 120) : ''})` : '';

// ---- score ------------------------------------------------------------------------------------------------------
export function score(plan, results, state) {
  plan = plan || {}; state = state || {};
  const checks = applyOverrides(results, state)?.checks || [];
  const areas = Object.fromEntries(AREAS.map(a => [a, { pts: 0, counted: 0, passed: 0, notes: [] }]));
  const auto = { pass: 0, fail: 0, warn: 0, flake: 0, preexisting: 0, skip: 0, stopped: 0 };   // stopped: left out like skip
  for (const c of checks) {
    if (c.status in auto) auto[c.status]++;
    if (!(c.status in AUTO_PTS)) continue;
    const a = areas[areaOf(c)];
    a.pts += AUTO_PTS[c.status]; a.counted++;
    if (c.status === 'pass' && !c.override) a.passed++;
    else if (c.status === 'pass') { a.passed++; a.notes.push(`pass: ${oneLine(c.name, 80)}${handNote(c)}`); }
    else a.notes.push(`${c.status}: ${oneLine(c.name, 80)}${c.override ? handNote(c) : c.detail ? ' - ' + oneLine(c.detail, 120) : ''}`);
  }
  const manual = { works: 0, broken: 0, unsure: 0, open: 0 };
  let manualBlocks = false;
  for (const m of plan.manual || []) {
    const v = ans(state, m.id);
    if (!(v in MAN_PTS)) { manual.open++; continue; }
    manual[v]++;
    const a = areas[AREAS.includes(m.area) ? m.area : 'works'];
    a.pts += MAN_PTS[v]; a.counted++;
    if (v === 'works') a.passed++;
    else a.notes.push(`${v}: ${oneLine(m.title, 80)}${state.manual[m.id].note ? ' - ' + oneLine(state.manual[m.id].note, 120) : ''}`);
    if (v === 'broken' && (m.area === 'works' || m.area === 'roles')) manualBlocks = true;
  }
  const out = {};
  for (const [k, a] of Object.entries(areas)) out[k] = { score: a.counted ? r1(5 * a.pts / a.counted) : 5, passed: a.passed, total: a.counted, notes: a.notes };
  const blockers = checks.filter(c => c.blocker && c.status === 'fail').map(c => ({ id: c.id, text: oneLine(c.name + (c.override ? ': checked by hand' + (c.override.note ? ': ' + c.override.note : '') : c.detail ? ': ' + c.detail : ''), 200) }));
  const mean = AREAS.reduce((s, k) => s + (areas[k].counted ? 5 * areas[k].pts / areas[k].counted : 5), 0) / AREAS.length;
  const rating = Number.isFinite(+state.rating) && state.rating !== null && +state.rating >= 1 && +state.rating <= 5 ? +state.rating : null;
  const overall = r1(rating === null ? mean : 0.7 * mean + 0.3 * rating);
  return { areas: out, auto, manual, blockers, overall, decision: blockers.length || manualBlocks ? 'fix' : 'final' };
}

// ---- facts: the only material any report text is built from -------------------------------------------------------
// Lanes: manual items go to their own lane; auto checks in areas phone/laptop go to review.ui_lane, everything else
// to review.default_lane; if that lane is not in plan.lanes the item goes to every lane.
function laneFor(lanes, lane) { return lanes.includes(lane) ? [lane] : lanes; }
const isIssueStatus = s => s === 'fail' || s === 'warn';
const isAutoIssue = i => i.evidence[0].startsWith('auto') || i.evidence[0].startsWith('checked by hand');

export function facts(plan, results, state, summary, changedFiles = [], cfg = cfgOf()) {
  const lanes = plan.lanes?.length ? plan.lanes : [cfg.review.default_lane];
  const per = Object.fromEntries(lanes.map(l => [l, { expected: [], other: [], issues: [], blockers: 0 }]));
  const ses = sessionFacts(state?.session, cfg);
  const pageKey = p => String(p).replace(/\//g, '-');
  const pageOfKey = k => (plan.pages || []).find(p => pageKey(p.page) === k)?.page || k;
  const roleAlt = cfg.roles.list.map(reEsc).join('|');
  const PL = new RegExp(`^(?:P|L)-(.+)-(${roleAlt})$`);
  for (const m of plan.manual || []) {
    const v = ans(state, m.id), note = oneLine(state?.manual?.[m.id]?.note, 300);
    const item = { id: m.id, title: oneLine(m.title, 120), answer: v, note, area: m.area };
    for (const l of laneFor(lanes, m.lane)) {
      (m.area === 'works' || m.area === 'roles' ? per[l].expected : per[l].other).push(item);
      if (v === 'broken' || v === 'unsure') {
        const sev = v === 'unsure' ? 'minor' : (m.area === 'works' || m.area === 'roles') ? 'blocker' : 'major';
        if (sev === 'blocker') per[l].blockers++;
        per[l].issues.push({ id: m.id, severity: sev, area: m.area, title: item.title, role: m.role || null, page: m.page || null,
          steps: (m.steps || []).map(s => oneLine(s, 200)), expected: oneLine(m.good, 300),
          actual: note || (v === 'broken' ? 'Tester marked it as broken (no note)' : 'Tester was not sure it works (no note)'),
          evidence: [`manual check ${m.id}: tester answered "${v}"`, ...(state?.manual?.[m.id]?.shots || []).map(s => `screenshot ${s} (in screens.png)`), ...sessionEvidence(ses, m.page, null)],
          files_hint: filesHint(changedFiles, m.page, null) });
      }
    }
  }
  const checks = applyOverrides(results, state)?.checks || [];
  // hand-checked "pass" over an automatic fail/warn: not an issue, but the report says the automatic result differed
  const handPassed = checks.filter(c => c.override && c.status === 'pass' && c.auto_status !== 'pass');
  for (const c of handPassed) for (const l of laneFor(lanes, laneForArea(cfg, areaOf(c)))) per[l].other.push({ id: c.id, title: oneLine(c.name, 120), answer: 'works', note: '', hand: handNote(c) });
  for (const c of checks.filter(c => isIssueStatus(c.status))) {
    const lane = laneForArea(cfg, areaOf(c));
    const sev = c.blocker && c.status === 'fail' ? 'blocker' : c.status === 'fail' ? 'major' : 'minor';
    const pl = PL.exec(c.id), x = /^X-(.+)$/.exec(c.id);
    const page = pl ? pageOfKey(pl[1]) : x ? pageOfKey(x[1]) : null;
    const role = pl ? pl[2] : null;
    const acc = /^R-(.+)$/.exec(c.id) ? (plan.access || []).find(a => 'R-' + a.id === c.id) : null;
    const flg = /^F-(.+)$/.exec(c.id) ? (plan.flags || []).find(f => 'F-' + f.id === c.id) : null;
    for (const l of laneFor(lanes, lane)) {
      if (sev === 'blocker') per[l].blockers++;
      per[l].issues.push({ id: c.id, severity: sev, area: areaOf(c), title: oneLine(c.name, 120),
        role: role || acc?.as || flg?.as || null, page, steps: [],
        expected: acc ? `${acc.method || 'GET'} ${acc.path} as ${acc.as} returns ${[].concat(acc.expect).join(' or ')}` : 'automatic check passes',
        actual: c.override ? (oneLine(c.override.note, 300) || 'Tester checked it by hand: it fails') : (oneLine(c.detail, 300) || c.status),
        evidence: [c.override ? `checked by hand: ${c.status}${c.override.note ? ' - ' + oneLine(c.override.note, 200) : ''} (automatic check ${c.id} said ${c.auto_status}${c.detail ? ': ' + oneLine(c.detail, 160) : ''})`
          : `auto check ${c.id} (${c.status}): ${oneLine(c.detail, 200)}`, ...sessionEvidence(ses, page, acc?.path || flg?.path)],
        hand: handNote(c),
        files_hint: filesHint(changedFiles, page, acc?.path || flg?.path) });
    }
  }
  const sum = summary || score(plan, results, state);
  for (const l of lanes) per[l].decision = per[l].blockers || per[l].issues.some(i => i.severity === 'blocker') ? 'fix' : 'pass';
  if (sum.decision === 'fix' && !lanes.some(l => per[l].decision === 'fix')) lanes.forEach(l => (per[l].decision = 'fix'));
  if (sum.decision === 'final') lanes.forEach(l => (per[l].decision = 'pass'));
  const roles = [...new Set([...(plan.pages || []).flatMap(p => p.roles || []), ...(plan.manual || []).map(m => m.role), ...(plan.access || []).map(a => a.as), ...ses.roles].filter(Boolean))];
  const devices = [...new Set([...(results?.shots || []).map(s => s.device), ...ses.devices].filter(d => d && d !== 'fit'))];
  const autoLine = Object.entries(sum.auto).filter(([, n]) => n).map(([k, n]) => `${n} ${k === 'pass' ? 'passed' : k === 'fail' ? 'failed' : k === 'preexisting' ? 'pre-existing (also on main)' : k === 'flake' ? 'flaky' : k === 'warn' ? 'warning' + (n > 1 ? 's' : '') : k === 'stopped' ? 'stopped (not checked)' : 'skipped'}`).join(', ');
  return { pr: plan.pr, title: plan.title, commit: plan.commit || results?.commit || '', tester: plan.tester || 'tester',
    author: plan.author, owner: plan.owner || cfg.review.owner, lanes, per, roles, session: ses, sessionLine: sessionLine(ses),
    sessionLanes: laneFor(lanes, cfg.review.default_lane), devices, autoLine: autoLine || 'none ran',
    extras: (plan.copilot?.extras || []).map(e => oneLine(e, 160)), rating: state?.rating ?? null,
    note_to_dev: oneLine(state?.note_to_dev, 1000), overall: sum.overall, decision: sum.decision,
    preexisting: checks.filter(c => c.status === 'preexisting').map(c => oneLine(c.name, 100)),
    notChecked: checks.filter(c => ['stopped', 'pending', 'running'].includes(c.status)).map(c => oneLine(c.name, 80)),
    rv: { pass: l => passLine(cfg, l), fix: l => fixLine(cfg, l), sig: sigOf(cfg, plan.tester || 'tester'), recheck: cfg.review.recheck_command } };
}

// state.session (test view): API answers >= 400 and console/page errors seen while the tester worked, plus pages visited.
// Facts only (method, path, status, error text) - grouped, numeric ids folded to :id so repeats count once.
export function sessionFacts(session, cfg = cfgOf()) {
  const reqs = session?.requests || [], evs = session?.events || [];
  const api = new Map();
  const addApi = (method, p, status) => {
    if (!p || !(status >= 400)) return;
    const key = `${status} ${method || 'GET'} ${String(p).split('?')[0].replace(/\/\d+(?=\/|$)/g, '/:id')}`;
    api.set(key, (api.get(key) || 0) + 1);
  };
  reqs.forEach(r => addApi(r.method, r.path, r.status));
  // UI-side api-error events duplicate the proxy log for the same call; only use them when the proxy saw nothing
  if (!reqs.length) evs.filter(e => e.type === 'api-error').forEach(e => addApi(e.method, e.path || e.url, e.status));
  const pageOf = pageOfFn(cfg);
  const cons = new Map();
  evs.filter(e => e.type === 'console-error' || e.type === 'page-error').forEach(e => {
    const k = oneLine(e.text, 200); if (!k) return;
    const c = cons.get(k) || { text: k, count: 0, pages: new Set() }; c.count++; const pg = pageOf(e.url); if (pg) c.pages.add(pg); cons.set(k, c);
  });
  const visited = new Map();
  let role = null, device = null;
  for (const e of evs) {
    if (e.role) role = e.role; if (e.device) device = e.device;
    const pg = e.type === 'navigate' && pageOf(e.url);
    if (pg) { const k = `${pg} (${[e.role || role, e.device || device].filter(Boolean).join(', ') || '?'})`; visited.set(k, (visited.get(k) || 0) + 1); }
  }
  return {
    apiErrors: [...api].map(([k, n]) => ({ key: k, count: n, status: +k.split(' ')[0], path: k.split(' ')[2] })).sort((a, b) => b.status - a.status || b.count - a.count),
    consoleErrors: [...cons.values()].map(c => ({ text: c.text, count: c.count, pages: [...c.pages] })).sort((a, b) => b.count - a.count),
    visited: [...visited.keys()],
    roles: [...new Set(evs.map(e => e.role).filter(r => r && r !== 'anon'))],
    devices: [...new Set(evs.map(e => e.device).filter(d => d && d !== 'fit'))],
  };
}
// page (relative to app.page_path) from a URL or path seen in the test view
function pageOfFn(cfg) {
  const pre = pagePrefix(cfg);
  return url => {
    let s = String(url || '');
    try { s = new URL(s, 'http://x').pathname; } catch { return null; }
    const i = pre && pre !== '/' ? s.indexOf(pre) : 0;
    if (i < 0) return null;
    const rest = s.slice(i + (pre && pre !== '/' ? pre.length : 1));
    return /^[A-Za-z0-9_][A-Za-z0-9_.\/-]*$/.test(rest) ? rest : null;
  };
}
const SEEN = 'seen during manual testing';
function sessionLine(s) {
  if (!s.apiErrors.length && !s.consoleErrors.length && !s.visited.length) return null;
  const parts = [];
  if (s.apiErrors.length) parts.push(`API answers >= 400: ${s.apiErrors.slice(0, 4).map(a => a.key + (a.count > 1 ? ` (${a.count}x)` : '')).join('; ')}${s.apiErrors.length > 4 ? `; +${s.apiErrors.length - 4} more` : ''}`);
  else parts.push('no API errors');
  if (s.consoleErrors.length) parts.push(`console errors: ${s.consoleErrors.slice(0, 2).map(c => `"${oneLine(c.text, 100)}"` + (c.count > 1 ? ` (${c.count}x)` : '')).join('; ')}${s.consoleErrors.length > 2 ? `; +${s.consoleErrors.length - 2} more` : ''}`);
  else parts.push('no console errors');
  if (s.visited.length) parts.push(`pages: ${s.visited.slice(0, 6).join(', ')}${s.visited.length > 6 ? ', ...' : ''}`);
  return `- ${SEEN[0].toUpperCase() + SEEN.slice(1)}: ${parts.join(' · ')}`;
}
const stem = page => path.posix.basename(String(page)).replace(/\.[a-z0-9]+$/i, '');
// session evidence for one issue: API errors on its route/page stem, console errors on its page
function sessionEvidence(s, page, route) {
  const toks = [page && stem(page), route && String(route).split(/[/?]/)[0]].filter(t => t && t.length >= 3).map(t => t.toLowerCase());
  const out = [];
  for (const a of s.apiErrors) if (toks.some(t => a.path.toLowerCase().includes(t))) out.push(`${SEEN}: ${a.key}${a.count > 1 ? ` (${a.count}x)` : ''}`);
  for (const c of s.consoleErrors) if (page && c.pages.includes(page)) out.push(`${SEEN}: console error on ${page}: ${oneLine(c.text, 160)}`);
  return out.slice(0, 6);
}

// files_hint: only PR-changed files whose path contains the page stem or the API route's first segment
function filesHint(changed, page, route) {
  const toks = [];
  if (page) toks.push(stem(page));
  if (route) toks.push(String(route).split(/[/?]/)[0]);
  const t = toks.map(s => s.toLowerCase()).filter(s => s.length >= 3);
  if (!t.length) return [];
  return (changed || []).filter(f => t.some(k => f.toLowerCase().includes(k))).slice(0, 8);
}

// ---- deterministic template ----------------------------------------------------------------------------------------
const DEV_DESC = { phone: 'Chrome phone 390x844', tablet: 'Chrome tablet 820x1180', laptop: 'Chrome laptop 1440x900' };

export function fixBrief(f, lane) {
  const autoIds = f.per[lane].issues.filter(isAutoIssue).map(i => i.id);
  const recheck = fill(f.rv.recheck, { pr: f.pr }) + (autoIds.length ? ` --only=${[...new Set(autoIds)].join(',')}` : '');
  // compact, one issue per line; ` and < escaped so a tester note cannot close the code block/details
  const J = v => JSON.stringify(v).replace(/`/g, '\\u0060').replace(/</g, '\\u003c');
  const json = `{"pr":${J(f.pr)},"commit":${J(f.commit)},"tested_by":${J(f.tester)},"issues":[\n` +
    f.per[lane].issues.map(({ hand, ...i }) => '  ' + J(i)).join(',\n') + `],\n` +
    (f.session.apiErrors.length || f.session.consoleErrors.length ? ` "seen_during_manual_testing":${J({
      api_errors: f.session.apiErrors.slice(0, 10).map(a => a.key + (a.count > 1 ? ` (${a.count}x)` : '')),
      console_errors: f.session.consoleErrors.slice(0, 5).map(c => ({ text: c.text, count: c.count, pages: c.pages })) })},\n` : '') +
    ` "recheck":${J(recheck)}}`;
  return '<details><summary>Fix brief for Claude</summary>\n\n```json\n' + json + '\n```\n</details>';
}

function firstLine(f, lane) {
  const p = f.per[lane];
  if (p.decision === 'pass') return f.rv.pass(lane);
  const n = p.issues.length, top = p.issues.filter(i => i.severity !== 'minor').slice(0, 2).map(i => i.title).join('; ');
  return oneLine(`${f.rv.fix(lane)} ${n} issue${n === 1 ? '' : 's'} to fix` + (top ? ': ' + top : ''), 200);
}

function templateBody(f, lane) {
  const p = f.per[lane], L = [firstLine(f, lane)];
  const mark = i => i.answer === 'works' ? 'x' : ' ';
  const why = i => i.answer === 'works' ? '' : ` - ${i.answer === 'broken' ? 'broken' : 'not sure'}${i.note ? ': ' + i.note : ''}`;
  L.push('Expected:');
  if (p.expected.length) p.expected.forEach(i => L.push(`- [${mark(i)}] ${i.title}${why(i)}`));
  else L.push('- (no manual checks of expected results in the plan)');
  L.push('Extras:');
  if (f.extras.length) f.extras.forEach(e => L.push(`- ${e} (listed by the developer, not rated separately)`));
  else L.push('- none listed');
  L.push('Other:');
  p.other.forEach(i => L.push(`- [${mark(i)}] ${i.title}${i.hand || why(i)}`));
  p.issues.filter(isAutoIssue).forEach(i => L.push(i.hand ? `- [ ] ${i.title}${i.hand}${i.severity === 'blocker' ? ' (blocker)' : ''}` : `- [ ] ${i.title} - ${i.actual}${i.severity === 'blocker' ? ' (blocker)' : ''}`));
  L.push(`- Automatic checks: ${f.autoLine}`);
  if (f.sessionLine && f.sessionLanes.includes(lane)) L.push(f.sessionLine);
  if (f.preexisting.length) L.push(`- Also failing on main (not this PR): ${f.preexisting.join(', ')}`);
  if (f.notChecked.length) L.push(`- Not checked (the run was stopped): ${f.notChecked.slice(0, 8).join(', ')}${f.notChecked.length > 8 ? ` and ${f.notChecked.length - 8} more` : ''}`);
  const dev = (f.devices.length ? f.devices : ['phone', 'laptop']).map(d => DEV_DESC[d] || d).join(' + ');
  L.push(`Tested on: ${f.commit || '?'}, ${dev}, roles ${f.roles.join(' + ') || '-'}`);
  L.push(`Rating: ${stars(f.overall)} ${f.overall}/5` + (f.rating ? ` (tester: ${f.rating}/5)` : ''));
  if (f.note_to_dev) L.push(`Note from the tester: ${f.note_to_dev}`);
  L.push('Screenshots: drag `screens.png` here');
  L.push(f.rv.sig);
  if (p.decision === 'fix') L.push('', fixBrief(f, lane));
  return L.join('\n');
}

function templateChat(f) {
  const issues = f.lanes.reduce((s, l) => s + f.per[l].issues.length, 0);
  const sent = f.decision === 'fix' ? 'sent back to the developer' : 'sent for final review';
  const hl = f.decision === 'fix' ? `${issues} issue${issues === 1 ? '' : 's'} to fix (details in the report)`
    : issues ? `Passed, with ${issues} small note${issues === 1 ? '' : 's'} in the report` : `All checks passed (${f.autoLine})`;
  const who = [f.author && '@' + f.author, f.owner && '@' + f.owner].filter(Boolean).join(' ');
  return [`**PR #${f.pr} tested** - ${oneLine(f.title, 80)}`, `${stars(f.overall)} ${f.overall}/5 - ${sent}`, hl,
    `${who ? who + ' - ' : ''}report: ${REPORT_URL}`, f.rv.sig].join('\n');
}

export function templateDraft(f) {
  return { comments: f.lanes.map(lane => ({ lane, body: templateBody(f, lane) })), chat_md: templateChat(f) };
}

// ---- Claude rewrite (validated) ---------------------------------------------------------------------------------
const prompt = (cfg) => {
  const sig = fill(cfg.review.signature, { tester: '<tester>' });
  return `You write QA test reports for GitHub pull requests. stdin is JSON with "facts" (the ONLY truth: plan,
check results, the tester's manual answers and notes, scores) and "baseline" (a correct but plain draft).
Rewrite the baseline into clear, friendly plain English for a junior developer. Rules:
- Return ONLY strict JSON, no markdown fences: {"comments":[{"lane":"<lane>","body":"<markdown>"}],"chat_md":"<text>"}
- One comment per lane in facts.lanes. Keep each body's FIRST LINE exactly as in the baseline.
- Keep the sections Expected: / Extras: / Other: / Tested on: / Rating: and the lines "Screenshots: drag \`screens.png\` here"
  and "${sig}" exactly. Keep every "- [x]" / "- [ ]" line's meaning; never tick something that is not
  ticked in the baseline, never add results, checks, numbers or issues that are not in facts. Keep the line starting
  "Seen during manual testing" (if present) with its facts and that label, every "(checked by hand: ...; automatic
  result: ...)" marker, and the "Not checked" line. Do not include any
  "Fix brief" block (it is added automatically).
- chat_md: at most 5 short lines, no details, no security details; must contain the literal text {report_url}
  where the link goes, the stars + score, the decision, the @developer and @owner mentions from the baseline, and
  end with the baseline's last line ("${sig}") unchanged.`;
};

function runClaude(input, timeoutMs, cfg) {
  return new Promise((resolve, reject) => {
    const bin = envOf('CLAUDE_BIN') || 'claude';
    let out = '', err = '', done = false;
    let ch;
    try { ch = spawn(bin, ['-p', prompt(cfg), '--output-format', 'text', '--tools', ''], { cwd: os.tmpdir(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (e) { return reject(e); }
    const t = setTimeout(() => { if (!done) { done = true; try { ch.kill(); } catch {} reject(new Error(`claude timed out after ${timeoutMs / 1000}s`)); } }, timeoutMs);
    ch.on('error', e => { if (!done) { done = true; clearTimeout(t); reject(e); } });
    ch.stdout.on('data', d => (out += d)); ch.stderr.on('data', d => (err += d));
    ch.on('close', code => { if (done) return; done = true; clearTimeout(t); code === 0 ? resolve(out) : reject(new Error(`claude exited ${code}: ${oneLine(err, 200)}`)); });
    ch.stdin.on('error', () => {});
    ch.stdin.end(JSON.stringify(input));
  });
}

function parseLoose(text) {
  const s = String(text).replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('no JSON object in claude output');
  return JSON.parse(s.slice(a, b + 1));
}

// returns null when OK, else the reason the Claude draft was rejected
export function validateDraft(d, f, base) {
  if (!d || !Array.isArray(d.comments) || typeof d.chat_md !== 'string') return 'wrong shape';
  if (d.comments.length !== f.lanes.length) return 'wrong number of comments';
  for (const lane of f.lanes) {
    const c = d.comments.find(x => x && x.lane === lane);
    if (!c || typeof c.body !== 'string') return `missing lane ${lane}`;
    const b = c.body, bb = base.comments.find(x => x.lane === lane).body;
    if (b.split('\n')[0].trim() !== bb.split('\n')[0]) return `first line changed for ${lane}`;
    for (const need of ['Expected:', 'Tested on:', 'Screenshots: drag `screens.png` here', f.rv.sig]) if (!b.includes(need)) return `"${need}" missing (${lane})`;
    if (b.length > 50000) return 'body too long';
    const cnt = (s, re) => (s.match(re) || []).length;
    if (cnt(b, /^\s*- \[x\]/gim) > cnt(bb, /^\s*- \[x\]/gim)) return `more ticked lines than results (${lane})`;
    if (cnt(b, /^\s*- \[ \]/gm) < cnt(bb, /^\s*- \[ \]/gm)) return `open issues dropped (${lane})`;
    if (/Fix brief for Claude/i.test(b)) return 'claude wrote its own fix brief';
    if (/seen during manual testing/i.test(bb) && !/seen during manual testing/i.test(b)) return `session evidence dropped (${lane})`;
    if (cnt(b, /checked by hand/gi) < cnt(bb, /checked by hand/gi)) return `hand-check marker dropped (${lane})`;
    if (/Not checked \(/.test(bb) && !/not checked/i.test(b)) return `not-checked line dropped (${lane})`;
  }
  const lines = d.chat_md.split('\n').filter(l => l.trim());
  if (lines.length > 6 || d.chat_md.length > 700) return 'chat note too long';
  if (!d.chat_md.includes(REPORT_URL)) return 'chat note has no {report_url}';
  if (!d.chat_md.includes(f.rv.sig)) return 'chat note lost the signature';
  if (!d.chat_md.includes(stars(f.overall))) return 'chat note lost the rating';
  return null;
}

export async function draft(plan, results, state, summary, opts = {}) {
  const cfg = cfgOf(opts);
  summary = summary || score(plan, results, state);
  const f = facts(plan, results, state, summary, opts.changedFiles || [], cfg);
  const base = templateDraft(f);
  const out = (d, source, warning) => ({ ...d, summary, source, ...(warning ? { warning } : {}) });
  if (opts.claude === false || envOf('NO_CLAUDE') === '1') return out(base, 'template', 'Claude not used');
  try {
    const safePlan = { ...plan, copilot: { ...(plan.copilot || {}), security: undefined } };   // security notes never go into public text
    const { rv, ...plainFacts } = f;
    const input = { facts: { ...plainFacts, plan: safePlan, checks: (results?.checks || []).map(({ shots, ...c }) => c), summary }, baseline: base };
    const d = parseLoose(await runClaude(input, opts.timeoutMs || 90000, cfg));
    if (d && typeof d.discord_md === 'string' && typeof d.chat_md !== 'string') d.chat_md = d.discord_md;
    const bad = validateDraft(d, f, base);
    if (bad) return out(base, 'template', 'Claude draft rejected: ' + bad);
    return out({
      comments: f.lanes.map(lane => {
        const body = d.comments.find(c => c.lane === lane).body.trim();
        return { lane, body: f.per[lane].decision === 'fix' ? body + '\n\n' + fixBrief(f, lane) : body };
      }), chat_md: d.chat_md.trim()
    }, 'claude');
  } catch (e) { return out(base, 'template', 'Claude unavailable: ' + oneLine(e.message, 200)); }
}

// chat note after posting: fill in ONE report link (the caller puts the most relevant comment first; appended if
// the tester removed the placeholder)
export function finalChat(md, urls) {
  const link = (urls || []).filter(Boolean)[0] || '';
  const s = String(md || '').trim();
  return (s.includes(REPORT_URL) ? s.split(REPORT_URL).join(link) : s + `\nReport: ${link}`) + '\n';
}

// ---- contact sheet ---------------------------------------------------------------------------------------------
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function sheetFiles(plan, results, state) {
  const all = results?.shots || [];
  const chosen = (state?.include_shots || []).length ? state.include_shots : all.filter(s => s.source === 'auto').map(s => s.file);
  return chosen.slice(0, 30).map(file => {
    const meta = all.find(s => s.file === file);
    const mm = /manual-([A-Za-z0-9_-]+?)-\d+\.(png|jpe?g)$/.exec(file);
    const mi = mm && (plan?.manual || []).find(m => m.id === mm[1]);
    const cap = meta ? [meta.page, meta.role, meta.device].filter(Boolean).join(' · ') : mi ? `manual ${mi.id} · ${mi.title}` : path.basename(file);
    return { file, cap };
  });
}

export async function contactSheet(qaDir, plan, results, state) {
  const items = sheetFiles(plan, results, state).filter(i => fs.existsSync(path.join(qaDir, i.file)));
  if (!items.length) throw new Error('no screenshots to put on the sheet');
  const lib = await import(pathToFileURL(path.join(HERE, 'lib.mjs')).href);
  const html = `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;padding:24px;background:#f4f4f5;font:14px system-ui,sans-serif;color:#18181b}
    h1{font-size:18px;margin:0 0 16px} .g{display:grid;grid-template-columns:repeat(4,1fr);gap:16px}
    figure{margin:0;background:#fff;border:1px solid #e4e4e7;border-radius:8px;overflow:hidden}
    img{display:block;width:100%;height:520px;object-fit:cover;object-position:top} figcaption{padding:8px 10px;font-size:13px}
  </style><h1>PR #${esc(plan?.pr)} · ${esc(plan?.title)} · ${esc(plan?.commit)}</h1><div class="g">` +
    items.map(i => `<figure><img src="${esc(pathToFileURL(path.join(qaDir, i.file)).href)}"><figcaption>${esc(i.cap)}</figcaption></figure>`).join('') + '</div>';
  const tmp = path.join(qaDir, `.screens-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.html`), out = path.join(qaDir, 'screens.png');
  fs.writeFileSync(tmp, html);
  const browser = await lib.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    await page.goto(pathToFileURL(tmp).href, { waitUntil: 'load' });
    await page.screenshot({ path: out, fullPage: true });
  } finally { await browser.close().catch(() => {}); fs.rmSync(tmp, { force: true }); }
  return out;
}

// ---- CLI (manual testing) ---------------------------------------------------------------------------------------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = path.resolve(process.argv.slice(2).find(a => !a.startsWith('--') && a !== process.argv[process.argv.indexOf('--config') + 1]) || '.');
  let cfg; try { cfg = configFromArgs(); } catch (e) { if (!(e instanceof ConfigError)) throw e; console.error('note: ' + e.message + ' - using defaults'); cfg = normalizeConfig({}); }
  const rd = (f, fb) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8').replace(/^\uFEFF/, '')); } catch { return fb; } };
  const plan = expandPlan(rd('plan.json', {}), cfg), results = rd('results.json', {}), state = rd('state.json', {});
  const summary = score(plan, results, state);
  console.log(JSON.stringify(summary, null, 1));
  const d = await draft(plan, results, state, summary, { cfg, claude: !process.argv.includes('--no-claude') });
  console.log('--- source:', d.source, d.warning || '');
  d.comments.forEach(c => console.log(`--- lane ${c.lane}\n${c.body}`));
  console.log('--- chat note\n' + d.chat_md);
}
