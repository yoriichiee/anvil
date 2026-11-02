// Anvil - report.json assembly (schemas/report.schema.json, schemaVersion "1"), its dependency-free validator, and the
// human-readable outputs: report.html (self-contained), fix-brief.md and prompts/{lovable,cursor,claude}.md.
// Honest claims only: never "secure"; notChecked is never empty.
import fs from 'node:fs';
import path from 'node:path';
import { writeJSON } from './lib.mjs';
import { redact } from './redact.mjs';

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'];
const WEIGHT = { critical: 30, high: 15, medium: 7, low: 2, info: 0 };
export const ALWAYS_NOT_CHECKED = [
  { what: 'Payments end to end', why: 'Anvil never makes real or test charges; payment findings come from static scans only.' },
  { what: 'Email delivery (sign-up, password reset)', why: 'Anvil does not read inboxes.' },
  { what: 'Load, performance under traffic and rate limits', why: 'Out of scope: Anvil runs one browser, not a load test.' },
  { what: 'Write actions (create, edit, delete) and anything behind a form', why: 'Anvil only sends GET requests and never submits forms; the human checks cover these.' },
  { what: 'Server-side code paths not reachable from the pages crawled', why: 'Only pages linked from the start page (per role) and configured access rules were exercised.' },
  { what: 'Overall security', why: 'Passing these checks does not make an app secure. Anvil reports what it checked and found, nothing more.' },
];

export function summarize(findings, humanChecks) {
  const counts = Object.fromEntries(SEVERITIES.map(s => [s, findings.filter(f => f.severity === s).length]));
  counts.humanPending = humanChecks.filter(h => !h.verdict).length;
  counts.humanBroken = humanChecks.filter(h => h.verdict === 'broken').length;
  let score = 100 - findings.reduce((a, f) => a + WEIGHT[f.severity], 0) - 8 * counts.humanBroken - 2 * humanChecks.filter(h => h.verdict === 'unsure').length;
  return { score0to100: Math.max(0, Math.min(100, Math.round(score))), counts };
}

const ID = /^[a-z0-9][a-z0-9._:-]{0,99}$/;
// mirrors report.schema.json + fixtures/validate-sample.mjs crossCheck (ajv is only a dev dependency) -> [errors]
export function validateReport(r) {
  const e = [], str = (v, max, k, min = 1) => { if (typeof v !== 'string' || v.length < min || v.length > max) e.push(k + ': string ' + min + '-' + max); };
  const only = (o, keys, k) => { if (!o || typeof o !== 'object' || Array.isArray(o)) return e.push(k + ': object'); for (const x of Object.keys(o)) if (!keys.includes(x)) e.push(k + ': unknown field ' + x); };
  only(r, ['schemaVersion', 'runId', 'anvilVersion', 'scannedAt', 'target', 'mode', 'checksRun', 'findings', 'humanChecks', 'notChecked', 'summary'], 'report');
  if (r.schemaVersion !== '1') e.push('schemaVersion must be "1"');
  if (r.runId != null && !/^[A-Za-z0-9._-]{1,80}$/.test(r.runId)) e.push('runId');
  if (r.anvilVersion != null) str(r.anvilVersion, 40, 'anvilVersion');
  if (!/^\d{4}-\d{2}-\d{2}T/.test(String(r.scannedAt)) || Number.isNaN(Date.parse(r.scannedAt))) e.push('scannedAt');
  only(r.target, ['kind', 'value'], 'target'); if (r.target) { if (!['url', 'dir', 'zip', 'github'].includes(r.target.kind)) e.push('target.kind'); str(r.target.value, 2048, 'target.value'); }
  only(r.mode, ['ai'], 'mode'); if (r.mode && !['none', 'claude-code', 'codex', 'byok', 'credits'].includes(r.mode.ai)) e.push('mode.ai');
  for (const [i, c] of (r.checksRun || []).entries()) { only(c, ['id', 'name', 'status', 'durationMs'], 'checksRun/' + i); if (!ID.test(c.id)) e.push('checksRun/' + i + '/id'); str(c.name, 200, 'checksRun/' + i + '/name'); if (!['pass', 'fail', 'warn', 'skip'].includes(c.status)) e.push('checksRun/' + i + '/status'); if (!Number.isInteger(c.durationMs) || c.durationMs < 0) e.push('checksRun/' + i + '/durationMs'); }
  for (const [i, f] of (r.findings || []).entries()) {
    const k = 'findings/' + i;
    only(f, ['id', 'check', 'severity', 'title', 'evidence', 'why', 'fix', 'confidence'], k);
    if (!ID.test(f.id)) e.push(k + '/id'); if (!ID.test(f.check)) e.push(k + '/check');
    if (!SEVERITIES.includes(f.severity)) e.push(k + '/severity'); if (!['proven', 'likely', 'unconfirmed'].includes(f.confidence)) e.push(k + '/confidence');
    str(f.title, 300, k + '/title'); str(f.why, 4000, k + '/why'); str(f.fix, 4000, k + '/fix');
    only(f.evidence, ['shot', 'selector', 'file', 'line', 'request', 'response'], k + '/evidence');
    if (f.evidence && !Object.keys(f.evidence).length) e.push(k + '/evidence empty');
    if (f.evidence && f.evidence.line != null && !(Number.isInteger(f.evidence.line) && f.evidence.line >= 1)) e.push(k + '/evidence/line');
  }
  for (const [i, h] of (r.humanChecks || []).entries()) {
    const k = 'humanChecks/' + i;
    only(h, ['id', 'prompt', 'steps', 'verdict', 'note', 'shot'], k);
    if (!ID.test(h.id)) e.push(k + '/id'); str(h.prompt, 500, k + '/prompt');
    if (!Array.isArray(h.steps) || !h.steps.every(s => typeof s === 'string' && s.length >= 1 && s.length <= 500)) e.push(k + '/steps');
    if (h.verdict != null && !['works', 'broken', 'unsure'].includes(h.verdict)) e.push(k + '/verdict');
    if (h.note != null) str(h.note, 4000, k + '/note', 0);
  }
  if (!Array.isArray(r.notChecked) || !r.notChecked.length) e.push('notChecked must not be empty');
  for (const [i, n] of (r.notChecked || []).entries()) { only(n, ['what', 'why'], 'notChecked/' + i); str(n.what, 500, 'notChecked/' + i + '/what'); str(n.why, 1000, 'notChecked/' + i + '/why'); }
  if (r.summary) {
    only(r.summary, ['score0to100', 'counts'], 'summary');
    if (!Number.isInteger(r.summary.score0to100) || r.summary.score0to100 < 0 || r.summary.score0to100 > 100) e.push('summary.score0to100');
    for (const s of SEVERITIES) if (r.summary.counts[s] !== (r.findings || []).filter(f => f.severity === s).length) e.push('summary.counts.' + s + ' does not match findings');
  } else e.push('summary missing');
  const checkIds = new Set((r.checksRun || []).map(c => c.id));
  for (const f of r.findings || []) if (!checkIds.has(f.check)) e.push('finding ' + f.id + ': unknown check ' + f.check);
  const ids = [...(r.findings || []), ...(r.humanChecks || [])].map(x => x.id);
  if (new Set(ids).size !== ids.length) e.push('duplicate finding/humanCheck ids');
  if (/\bsecure\b/i.test(JSON.stringify(r).replace(/not make an app secure/gi, ''))) e.push('report must not claim "secure"');
  return e;
}

// "secure" may only appear in the one fixed honest-claims sentence
export const noSecureWord = s => String(s).replace(/\binsecure\b/gi, 'unsafe').replace(/\bsecure(ly|d)?\b/gi, m => (/^S/.test(m) ? 'Protected' : 'protected'));

export function buildReport({ runId, version, target, aiMode, checks, humanChecks, notChecked }) {
  const seenNc = new Set();
  const nc = [...notChecked, ...ALWAYS_NOT_CHECKED].filter(n => { const k = n.what.toLowerCase(); if (seenNc.has(k)) return false; seenNc.add(k); return true; })
    .map(n => ({ what: noSecureWord(n.what).slice(0, 500), why: n.why === ALWAYS_NOT_CHECKED[5].why ? n.why : noSecureWord(n.why).slice(0, 1000) }));
  const usedIds = new Set(checks.findings.map(f => f.id));
  const hc = humanChecks.filter(h => !usedIds.has(h.id) && usedIds.add(h.id)).map(h => ({ ...h, prompt: noSecureWord(h.prompt).slice(0, 500), steps: h.steps.map(s => noSecureWord(s).slice(0, 500)) }));
  const findings = checks.findings.map(f => ({ ...f, title: noSecureWord(f.title), why: noSecureWord(f.why), fix: noSecureWord(f.fix) }))
    .sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));
  const r = {
    schemaVersion: '1', runId, anvilVersion: version, scannedAt: new Date().toISOString(),
    target: { kind: target.kind, value: String(target.value).slice(0, 2048) },
    mode: { ai: aiMode || 'none' },
    checksRun: checks.checksRun, findings, humanChecks: hc, notChecked: nc,
    summary: summarize(findings, hc),
  };
  return r;
}

// ---------------------------------------------------------------- markdown: fix brief + agent prompts
const SEV_LABEL = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low', info: 'Info' };
const where = f => [f.evidence.file ? f.evidence.file + (f.evidence.line ? ':' + f.evidence.line : '') : null, f.evidence.request || null, f.evidence.selector ? 'selector `' + f.evidence.selector + '`' : null].filter(Boolean).join(' · ');
const md = s => redact(String(s), { aggressive: false }).replace(/\r/g, '');
export const rescanCommand = r => `anvil scan ${/\s/.test(r.target.value) ? '"' + r.target.value + '"' : r.target.value}`;

function ordered(r, polish) {
  const fs = [...r.findings];
  if (polish && polish.order && polish.order.length) fs.sort((a, b) => { const ia = polish.order.indexOf(a.id), ib = polish.order.indexOf(b.id); return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib) || SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity); });
  return fs.filter(f => f.severity !== 'info');
}

export function fixBriefMd(r, polish) {
  const fs = ordered(r, polish);
  const broken = r.humanChecks.filter(h => h.verdict === 'broken' || h.verdict === 'unsure');
  const L = [`# Fix brief - ${md(r.target.value)}`, '', `Anvil run \`${r.runId}\` (${r.scannedAt}). Launch-readiness score ${r.summary.score0to100}/100 for what was checked - not a security rating.`, ''];
  if (polish && polish.intro) L.push(md(polish.intro), '');
  L.push('**Approval convention:** read this brief, then fix only what the user approves. Do not change anything else. When done, re-run `' + rescanCommand(r) + '` and compare.', '');
  if (!fs.length && !broken.length) L.push('No problems were found by the automatic checks. Work through the human checks and the "not checked" list below before launch.', '');
  fs.forEach((f, i) => {
    L.push(`## ${i + 1}. [${SEV_LABEL[f.severity]}] ${md(f.title)}`, '');
    if (where(f)) L.push(`- **Where:** ${md(where(f))}`);
    if (f.evidence.response) L.push(`- **Evidence:** ${md(f.evidence.response)}`);
    if (f.evidence.shot) L.push(`- **Screenshot:** ${f.evidence.shot}`);
    L.push(`- **Confidence:** ${f.confidence}`, `- **Why it matters:** ${md(f.why)}`, `- **Fix:** ${md(f.fix)}`, `- **Finding id:** \`${f.id}\``, '');
  });
  if (broken.length) { L.push('## From the human checks', ''); for (const h of broken) L.push(`- **${h.verdict === 'broken' ? 'Broken' : 'Not sure'}:** ${md(h.prompt)}${h.note ? ' - note: ' + md(h.note) : ''} (\`${h.id}\`)`); L.push(''); }
  L.push('## Not checked', '', ...r.notChecked.map(n => `- **${md(n.what)}:** ${md(n.why)}`), '');
  return L.join('\n');
}

export function promptMd(r, format, polish) {
  const fs = ordered(r, polish).slice(0, 15);
  const list = fs.map((f, i) => `${i + 1}. ${md(f.title)}${f.evidence.file ? ` (${f.evidence.file}${f.evidence.line ? ':' + f.evidence.line : ''})` : ''}\n   Fix: ${md(f.fix)}`).join('\n');
  if (format === 'lovable') return [`Please fix these launch problems that Anvil found in my app. Fix them one at a time, keep everything else working, and do not change the design unless a fix needs it.`, '', list || 'Anvil found no automatic problems. Please double-check sign-up, login and any payment flow still work.', '', fs.some(f => f.check === 'secret-scan') ? 'Important: a secret key was in the front-end code. Move that call to a server function (Edge Function) that reads the key from secrets. I will create a new key myself in the provider dashboard.' : '', 'When you are done, tell me in plain words what you changed for each item.'].filter(x => x !== '').join('\n') + '\n';
  if (format === 'cursor') return [`Fix the following issues from an Anvil launch-readiness scan (run ${r.runId}). Make the smallest change that fixes each one; do not refactor unrelated code. Reference files with @ before editing.`, '', fs.map((f, i) => `${i + 1}. [${f.severity}] ${md(f.title)}\n   ${f.evidence.file ? '@' + f.evidence.file + (f.evidence.line ? ' line ' + f.evidence.line : '') + '\n   ' : ''}Evidence: ${md(f.evidence.response || f.evidence.request || f.evidence.selector || '-')}\n   Fix: ${md(f.fix)}`).join('\n') || 'No automatic findings.', '', `Then run: ${rescanCommand(r)}`].join('\n') + '\n';
  // claude
  return [`You are fixing findings from an Anvil launch-readiness scan (run \`${r.runId}\`, target \`${md(r.target.value)}\`).`, '',
    'Rules:', '- Read the evidence first. Propose the fix for each finding and wait for the user to approve before editing (the approval convention).', '- Change only what a finding needs. Never commit or push.', '- A leaked key must also be rotated by the user at the provider; say so, do not just delete it from code.', '- Never call the app "secure"; say which findings are fixed.', '',
    'Findings (most urgent first):', '', fs.map((f, i) => `${i + 1}. \`${f.id}\` [${f.severity}, ${f.confidence}] ${md(f.title)}\n   - where: ${md(where(f) || '-')}\n   - evidence: ${md(f.evidence.response || '-')}\n   - why: ${md(f.why)}\n   - fix: ${md(f.fix)}`).join('\n') || 'None.', '',
    `After the fixes, re-scan: \`${rescanCommand(r)}\` (or the MCP tool anvil_scan) and report which finding ids are gone.`].join('\n') + '\n';
}

// ---------------------------------------------------------------- report.html (self-contained; shots are relative files in the run folder)
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Same look and logo as the dashboard (dashboard/app.css tokens, ANVIL_PATH mark). Monochrome; status is never shown
// by colour alone: every severity/status has its own glyph, label and weight/border.
const ANVIL_PATH = 'M8 4.5H22.5V9H19L16.5 13.5H19L21.5 19.5H6.5L9 13.5H12L10.5 9C7 9 3.8 7.8 1 5.6C3.3 4.9 5.6 4.5 8 4.5Z';
const SEV_GLYPH = { critical: '!!', high: '!', medium: '▲', low: '–', info: 'i' };
const STATUS_GLYPH = { pass: '✓', fail: '✕', warn: '!', skip: '–' };
export function reportHtml(r, polish) {
  const c = r.summary.counts;
  const chip = s => `<span class="sev sev-${s}"><i aria-hidden="true">${SEV_GLYPH[s]}</i>${SEV_LABEL[s]}</span>`;
  const statusDot = { pass: 'Pass', fail: 'Fail', warn: 'Warn', skip: 'Skipped' };
  const finding = f => `<article class="finding f-${f.severity}" id="${esc(f.id)}">
  <header>${chip(f.severity)}<h3>${esc(f.title)}</h3><span class="conf">${esc(f.confidence)}</span></header>
  <dl>${where(f) ? `<dt>Where</dt><dd><code>${esc(where(f))}</code></dd>` : ''}${f.evidence.response ? `<dt>Evidence</dt><dd><code>${esc(f.evidence.response)}</code></dd>` : ''}
  <dt>Why it matters</dt><dd>${esc(f.why)}</dd><dt>Fix</dt><dd>${esc(f.fix)}</dd></dl>
  ${f.evidence.shot ? `<details><summary>Screenshot</summary><a href="${esc(f.evidence.shot)}"><img loading="lazy" src="${esc(f.evidence.shot)}" alt="Screenshot for: ${esc(f.title)}"></a></details>` : ''}
  <p class="meta">check <code>${esc(f.check)}</code> · id <code>${esc(f.id)}</code></p></article>`;
  const human = h => `<li class="human" data-id="${esc(h.id)}"><p class="q">${esc(h.prompt)}</p><ol>${h.steps.map(s => `<li>${esc(s)}</li>`).join('')}</ol>
  <div class="verdicts" role="group" aria-label="Answer">${['works', 'broken', 'unsure'].map(v => `<button type="button" data-v="${v}" aria-pressed="${h.verdict === v}">${v === 'unsure' ? 'Not sure' : v[0].toUpperCase() + v.slice(1)}</button>`).join('')}</div>
  ${h.note ? `<p class="note">${esc(h.note)}</p>` : ''}<p class="cmd"><code>anvil answer ${esc(r.runId)} ${esc(h.id)} <span class="v">${esc(h.verdict || 'works')}</span></code></p></li>`;
  const fs = r.findings;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Anvil report</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='%230a0a0a' d='${ANVIL_PATH.replace(/ /g, '%20')}'/%3E%3C/svg%3E">
<style>
:root{--bg:#f4f4f4;--chrome:#f7f7f7;--surface:#fff;--surface-2:#fafafa;--sunk:#efefef;--line:#e5e5e5;--line-2:#d4d4d4;--line-3:#a3a3a3;--ink:#0a0a0a;--ink-2:#262626;--ink-3:#525252;--ink-4:#6b6b6b;--on-ink:#fff;--r:8px;--r-s:6px;--shadow-s:0 1px 2px rgba(0,0,0,.06);--shadow-m:0 8px 24px -8px rgba(0,0,0,.18),0 1px 3px rgba(0,0,0,.06);--font:'Inter',ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;--mono:ui-monospace,'SFMono-Regular','Cascadia Code',Consolas,'Liberation Mono',monospace;--c-bg:#0a0a0a;--c-line:#262626;--c-ink:#e5e5e5;--c-ink-4:#8a8a8a;color-scheme:light}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 var(--font);-webkit-font-smoothing:antialiased}
a{color:var(--ink);text-decoration-color:var(--line-3);text-underline-offset:2px}a:hover{text-decoration-color:var(--ink)}
:focus-visible{outline:2px solid var(--ink);outline-offset:2px;border-radius:4px}
code{font-family:var(--mono);font-size:.86em;background:var(--sunk);border-radius:4px;padding:1px 5px;color:var(--ink-2);overflow-wrap:anywhere}
.bar{position:sticky;top:0;z-index:5;background:rgba(247,247,247,.92);border-bottom:1px solid var(--line)}
.bar-in{max-width:960px;margin:0 auto;padding:0 16px;height:52px;display:flex;align-items:center;gap:10px}
.brand{display:inline-flex;align-items:center;gap:8px;font-size:16px;font-weight:750;letter-spacing:-.025em}.brand svg{width:20px;height:20px}
.bar-in .crumb{color:var(--ink-3);font-size:13px;font-weight:500}
main{max-width:960px;margin:0 auto;padding:28px 16px 72px}
h1{font-size:clamp(24px,4.5vw,36px);font-weight:750;line-height:1.1;margin:6px 0 6px;letter-spacing:-.035em;overflow-wrap:anywhere}
h2{font-size:18px;font-weight:700;letter-spacing:-.015em;margin:40px 0 12px;display:flex;align-items:baseline;gap:8px}
.eyebrow{font-family:var(--mono);font-size:12px;color:var(--ink-3)}
.sub{color:var(--ink-3);margin:0 0 20px;font-size:14px}.sub2{color:var(--ink-3);margin:-4px 0 14px;font-size:14px}
.score{display:grid;gap:12px;margin:20px 0}@media (min-width:720px){.score{grid-template-columns:240px 1fr}}
.big{background:var(--surface);border:1px solid var(--line-2);border-radius:10px;box-shadow:var(--shadow-m);padding:16px 18px}
.big b{font-size:56px;font-weight:760;line-height:.95;letter-spacing:-.06em;display:block;font-variant-numeric:tabular-nums}.big b small{font-size:15px;font-weight:600;letter-spacing:0;color:var(--ink-3);margin-left:4px}.big span{display:block;margin-top:8px;color:var(--ink-3);font-size:12.5px}
.counts{display:grid;grid-template-columns:repeat(auto-fill,minmax(112px,1fr));gap:8px;align-content:start}
.counts div{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:10px 12px;display:grid;gap:6px;justify-items:start}.counts b{font-size:24px;font-weight:720;line-height:1;font-variant-numeric:tabular-nums}
.sev{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 8px 0 6px;border-radius:4px;font-size:12px;font-weight:600;white-space:nowrap;border:1px solid var(--line-2);background:var(--surface);color:var(--ink-2)}
.sev i{font-style:normal;font-family:var(--mono);font-size:11px;font-weight:800;min-width:1.2em;text-align:center}
.sev-critical{background:var(--ink);border-color:var(--ink);color:var(--on-ink);font-weight:750}.sev-high{border:1.5px solid var(--ink);color:var(--ink);font-weight:700}
.sev-medium{border:1.5px dashed var(--ink-2);color:var(--ink)}.sev-low,.sev-info{border-color:var(--line);background:var(--surface-2);color:var(--ink-3);font-weight:500}
.finding{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:16px 18px;margin:12px 0}
.finding.f-critical,.finding.f-high{border-color:var(--line-2);box-shadow:inset 3px 0 0 var(--ink)}.finding.f-medium{box-shadow:inset 3px 0 0 var(--line-3)}
.finding header{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.finding h3{font-size:16.5px;font-weight:650;letter-spacing:-.012em;margin:0;flex:1 1 280px;line-height:1.35}.conf{color:var(--ink-3);font-size:12.5px}
dl{display:grid;grid-template-columns:120px minmax(0,1fr);gap:8px 14px;margin:12px 0 4px}dt{color:var(--ink-3);font-size:11px;text-transform:uppercase;letter-spacing:.07em;font-weight:650;padding-top:3px}dd{margin:0;color:var(--ink-2);min-width:0}
@media (max-width:600px){dl{grid-template-columns:1fr;gap:2px}dt{margin-top:8px}}
img{max-width:100%;display:block;border:1px solid var(--line-2);border-radius:var(--r-s);margin-top:8px}.meta{color:var(--ink-3);font-size:12.5px;margin:10px 0 0}
summary{cursor:pointer;font-weight:600;font-size:13.5px;margin-top:6px}
.tablewrap{background:var(--c-bg);border:1px solid var(--c-line);border-radius:10px;overflow-x:auto}
table{width:100%;border-collapse:collapse;font:12.5px/1.6 var(--mono);color:var(--c-ink)}td,th{text-align:left;padding:8px 12px;border-bottom:1px solid var(--c-line)}tr:last-child td{border-bottom:0}
th{color:var(--c-ink-4);font-weight:500}td code{background:none;color:var(--c-ink-4);padding:0}
.st{white-space:nowrap}.st i{font-style:normal;display:inline-block;width:1.4em}.st-fail{color:#fff;font-weight:800}.st-warn{color:#fff;font-weight:700;text-decoration:underline dashed;text-underline-offset:3px}.st-pass{color:#f5f5f5}.st-skip{color:var(--c-ink-4)}
.humans{list-style:none;padding:0;margin:0;display:grid;gap:12px}.human{background:var(--surface);border:1px solid var(--line-2);border-radius:10px;box-shadow:var(--shadow-s);padding:16px 18px}
.human .q{font-weight:650;font-size:16px;margin:0 0 8px}.human ol{margin:0 0 12px;padding-left:22px;color:var(--ink-2);font-size:14px}
.verdicts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;max-width:460px}
.verdicts button{font:inherit;font-size:14px;font-weight:600;height:42px;padding:0 8px;border:1px solid var(--line-2);border-radius:var(--r-s);background:var(--surface);color:var(--ink-2);cursor:pointer;white-space:nowrap}
.verdicts button::before{display:inline-block;width:1.2em;font-weight:800}.verdicts [data-v=works]::before{content:'\\2713'}.verdicts [data-v=broken]::before{content:'\\2715'}.verdicts [data-v=unsure]::before{content:'?'}
.verdicts button:hover{border-color:var(--ink);color:var(--ink)}.verdicts button[aria-pressed=true]{background:var(--ink);border-color:var(--ink);color:var(--on-ink)}
.verdicts button[data-v=unsure][aria-pressed=true]{background:var(--surface);color:var(--ink);border:1.5px dashed var(--ink)}
.note{margin:10px 0 0;padding:8px 12px;background:var(--surface-2);border:1px solid var(--line);border-left:3px solid var(--ink);border-radius:var(--r-s);font-size:14px}
.cmd{margin:12px 0 0}.cmd code{display:block;background:var(--c-bg);color:#f5f5f5;padding:8px 12px;border-radius:var(--r-s);font-size:12.5px}
.nc{list-style:none;padding:16px 18px;margin:0;background:var(--surface-2);border:1px dashed var(--line-3);border-radius:var(--r);display:grid;gap:8px}.nc li{padding-left:22px;position:relative;color:var(--ink-2);font-size:14.5px}.nc li::before{content:'?';position:absolute;left:0;top:0;width:16px;height:16px;margin-top:3px;border:1.5px solid var(--ink-3);border-radius:50%;font:700 10px/13px var(--font);text-align:center;color:var(--ink-3)}
.honest{background:var(--surface);border:1.5px solid var(--ink);border-radius:var(--r);padding:14px 16px;margin-top:20px;font-size:14.5px}
footer{margin-top:40px;padding-top:16px;border-top:1px solid var(--line);color:var(--ink-3);font-size:13px;line-height:1.8}
</style></head><body>
<header class="bar"><div class="bar-in"><span class="brand"><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="${ANVIL_PATH}"/></svg>Anvil</span><span class="crumb">/ launch-readiness report</span></div></header>
<main>
<p class="eyebrow">${esc(r.target.kind)} target</p>
<h1>${esc(r.target.value)}</h1>
<p class="sub">Run <code>${esc(r.runId || '')}</code> · ${esc(r.scannedAt)} · AI: ${esc(r.mode.ai)}</p>
<div class="score"><div class="big"><b>${r.summary.score0to100}<small>/ 100</small></b><span>Launch readiness of what was checked. Not a security rating.</span></div>
<div class="counts">${SEVERITIES.map(s => `<div>${chip(s)}<b>${c[s]}</b></div>`).join('')}<div><span class="sev"><i aria-hidden="true">?</i>Human</span><b>${c.humanPending || 0}</b><span class="conf">to answer</span></div></div></div>
${polish && polish.intro ? `<p>${esc(polish.intro)}</p>` : ''}
<h2>Findings (${fs.length})</h2>
${fs.length ? fs.map(finding).join('\n') : '<p>No problems found by the automatic checks. That is not the same as "nothing is wrong": see the human checks and what was not checked.</p>'}
<h2>Human checks</h2>
<p class="sub2">Things only a person can judge. Click an answer, then run the command shown (or answer through your agent with anvil_record_human). Clicks here are only remembered in this browser.</p>
<ul class="humans">${r.humanChecks.map(human).join('\n')}</ul>
<h2>Checks that ran</h2>
<div class="tablewrap"><table><thead><tr><th>Check</th><th>Result</th><th>Time</th></tr></thead><tbody>
${r.checksRun.map(x => `<tr><td>${esc(x.name)} <code>${esc(x.id)}</code></td><td class="st st-${x.status}"><i aria-hidden="true">${STATUS_GLYPH[x.status]}</i>${statusDot[x.status]}</td><td>${(x.durationMs / 1000).toFixed(1)} s</td></tr>`).join('')}
</tbody></table></div>
<h2>What Anvil did not check</h2>
<ul class="nc">${r.notChecked.map(n => `<li><b>${esc(n.what)}</b>: ${esc(n.why)}</li>`).join('')}</ul>
<div class="honest"><b>Honest claims.</b> This report lists what Anvil checked and found. It does not certify the app; fixing every finding does not mean nothing else is wrong.</div>
<footer>Fix brief: <a href="fix-brief.md">fix-brief.md</a> · prompts: <a href="prompts/claude.md">Claude</a>, <a href="prompts/cursor.md">Cursor</a>, <a href="prompts/lovable.md">Lovable</a> · <a href="report.json">report.json</a> · Re-run: <code>${esc(rescanCommand(r))}</code></footer>
</main>
<script>
(function(){var K='anvil-human-${esc(r.runId || 'run')}',s={};try{s=JSON.parse(localStorage.getItem(K)||'{}')}catch(e){}
document.querySelectorAll('.human').forEach(function(li){var id=li.getAttribute('data-id');function set(v){li.querySelectorAll('button').forEach(function(b){b.setAttribute('aria-pressed',String(b.getAttribute('data-v')===v))});var c=li.querySelector('.cmd .v');if(c)c.textContent=v}
if(s[id])set(s[id]);li.querySelectorAll('button').forEach(function(b){b.addEventListener('click',function(){var v=b.getAttribute('data-v');s[id]=v;try{localStorage.setItem(K,JSON.stringify(s))}catch(e){}set(v)})})})})();
</script></body></html>
`;
}

// writes report.json (+ validation) and every rendered file into runDir; returns the list of files
export async function writeOutputs(runDir, r, polish) {
  const errs = validateReport(r);
  if (errs.length) throw new Error('report.json would not match the schema: ' + errs.slice(0, 5).join('; '));
  await writeJSON(path.join(runDir, 'report.json'), r);
  fs.mkdirSync(path.join(runDir, 'prompts'), { recursive: true });
  fs.writeFileSync(path.join(runDir, 'report.html'), reportHtml(r, polish));
  fs.writeFileSync(path.join(runDir, 'fix-brief.md'), fixBriefMd(r, polish));
  for (const f of ['lovable', 'cursor', 'claude']) fs.writeFileSync(path.join(runDir, 'prompts', f + '.md'), promptMd(r, f, polish));
  if (polish) await writeJSON(path.join(runDir, 'polish.json'), polish);
  return ['report.json', 'report.html', 'fix-brief.md', 'prompts/lovable.md', 'prompts/cursor.md', 'prompts/claude.md'];
}
