#!/usr/bin/env node
// Validates fixtures/sample-report.json against schemas/report.schema.json, plus a few
// cross-field rules JSON Schema cannot express. Usage: node fixtures/validate-sample.mjs [report.json ...]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Ajv from 'ajv';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const load = (p) => JSON.parse(readFileSync(p, 'utf8'));
const ajv = new Ajv({ allErrors: true, strict: false });
ajv.addFormat('date-time', (s) => !Number.isNaN(Date.parse(s)) && /^\d{4}-\d{2}-\d{2}T/.test(s));
const validate = ajv.compile(load(join(root, 'schemas', 'report.schema.json')));
const validateAddon = ajv.compile(load(join(root, 'schemas', 'anvil-addon.schema.json')));
{
  const a = load(join(root, 'fixtures', 'sample-addon.json'));
  if (!validateAddon(a)) { console.error('FAIL fixtures/sample-addon.json', validateAddon.errors); process.exit(1); }
  // a POST probe must be rejected
  const bad = structuredClone(a); bad.checks[1].match.method = 'POST';
  if (validateAddon(bad)) { console.error('FAIL addon schema accepted a POST probe'); process.exit(1); }
  console.log('ok   fixtures/sample-addon.json (+ POST probe rejected)');
}

export function crossCheck(r) {
  const errs = [];
  const checkIds = new Set(r.checksRun.map((c) => c.id));
  for (const f of r.findings) if (!checkIds.has(f.check)) errs.push(`finding ${f.id}: unknown check "${f.check}"`);
  for (const sev of ['critical', 'high', 'medium', 'low', 'info']) {
    const n = r.findings.filter((f) => f.severity === sev).length;
    if (r.summary.counts[sev] !== n) errs.push(`summary.counts.${sev}=${r.summary.counts[sev]} but ${n} findings`);
  }
  const ids = [...r.findings, ...r.humanChecks].map((x) => x.id);
  if (new Set(ids).size !== ids.length) errs.push('duplicate finding/humanCheck ids');
  if (/\bsecure\b/i.test(JSON.stringify(r).replace(/not make an app secure/gi, ''))) errs.push('report must not claim "secure"');
  return errs;
}

const files = process.argv.slice(2);
if (!files.length) files.push(join(root, 'fixtures', 'sample-report.json'));
let bad = 0;
for (const f of files) {
  const r = load(f);
  const ok = validate(r);
  const errs = ok ? crossCheck(r) : validate.errors.map((e) => `${e.instancePath || '/'} ${e.message}`);
  if (errs.length) { bad++; console.error(`FAIL ${f}\n  ${errs.join('\n  ')}`); } else console.log(`ok   ${f}`);
}
process.exit(bad ? 1 : 0);
