// Deny-by-default redaction for text that leaves for an LLM.
// redactForModel() either returns cleaned text or throws; callers must not send anything on throw.
import { SECRET_RULES, GENERIC_ASSIGN, shannon } from './secrets.mjs';

const LONG_TOKEN = /[A-Za-z0-9+/_=-]{32,1000}/g;
const BEARER = /\b(authorization|bearer)\b(["']?\s{0,5}[:=]?\s{0,5}["']?)(?:bearer\s+)?[A-Za-z0-9._~+/=-]{8,2000}/gi;
const URL_CREDS = /\b([a-z][a-z0-9+.-]{1,20}:\/\/)[^\s/:@]{1,200}:[^\s/@]{1,200}@/gi;

export function redactText(input) {
  if (typeof input !== 'string') throw new TypeError('redact: input must be a string');
  let s = input;
  for (const rule of SECRET_RULES) {
    s = s.replace(new RegExp(rule.re.source, rule.re.flags), (m) => (rule.check && !rule.check(m) ? m : '[REDACTED]'));
  }
  s = s.replace(new RegExp(GENERIC_ASSIGN.source, GENERIC_ASSIGN.flags), (m, v) => m.replace(v, '[REDACTED]'));
  s = s.replace(BEARER, (m, a, b) => `${a}${b}[REDACTED]`);
  s = s.replace(URL_CREDS, (m, scheme) => `${scheme}[REDACTED]@`);
  // Anything long and random-looking that we do not recognise is dropped too.
  s = s.replace(LONG_TOKEN, (m) => (shannon(m) >= 4 && /\d/.test(m) && /[A-Za-z]/.test(m) ? '[REDACTED]' : m));
  return s;
}

/** Throws if anything that looks like a secret survives a second pass. */
export function redactForModel(input) {
  const out = redactText(input);
  for (const rule of SECRET_RULES) {
    const re = new RegExp(rule.re.source, rule.re.flags.replace('g', ''));
    const m = out.match(re);
    if (m && (!rule.check || rule.check(m[0]))) throw new Error('redaction left a secret behind');
  }
  return out;
}
