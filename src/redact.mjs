// Anvil - redaction (deny by default). Everything that leaves the machine (LLM calls, `doctor --share`) or lands in a
// report goes through here. Known secret formats are masked by pattern; any other long high-entropy token is masked
// too, so an unknown key format is hidden rather than leaked. If redaction itself fails, callers get an error and must
// not send anything (see forAI()).

// id, label, regex (global), keepPrefix: how many leading chars are safe to show (the public prefix of the format)
export const SECRET_PATTERNS = [
  { id: 'private-key', label: 'Private key', re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]{0,8000}?-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g, keep: 0, severity: 'critical' },
  { id: 'aws-access-key', label: 'AWS access key id', re: /\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g, keep: 4, severity: 'critical' },
  { id: 'aws-secret-key', label: 'AWS secret access key', re: /(?<=aws_?secret_?access_?key\W{0,6}|aws_?secret\W{0,6})[A-Za-z0-9/+=]{40}\b/gi, keep: 0, severity: 'critical' },
  { id: 'stripe-secret', label: 'Stripe secret key', re: /\b(?:sk|rk)_live_[0-9A-Za-z]{16,}\b/g, keep: 8, severity: 'critical' },
  { id: 'stripe-test-secret', label: 'Stripe test secret key', re: /\b(?:sk|rk)_test_[0-9A-Za-z]{16,}\b/g, keep: 8, severity: 'medium' },
  { id: 'stripe-webhook', label: 'Stripe webhook secret', re: /\bwhsec_[0-9A-Za-z]{24,}\b/g, keep: 6, severity: 'high' },
  // Anvil's own fake demo key (examples/acme-notes billing.js). It plays a leaked Stripe secret key in the demo, but its
  // prefix is not a Stripe format, so GitHub push protection and other secret scanners never mistake it for a real key.
  { id: 'stripe-demo-secret', label: 'Stripe secret key (Anvil demo key)', re: /\bsk_anvildemo_[0-9A-Za-z]{16,}\b/g, keep: 13, severity: 'critical' },
  { id: 'github-token', label: 'GitHub token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[0-9A-Za-z]{36,}\b|\bgithub_pat_[0-9A-Za-z_]{40,}\b/g, keep: 4, severity: 'critical' },
  { id: 'anthropic-key', label: 'Anthropic API key', re: /\bsk-ant-(?:api|admin)\d{0,2}-[0-9A-Za-z_-]{20,}\b/g, keep: 7, severity: 'critical' },
  { id: 'openai-key', label: 'OpenAI API key', re: /\bsk-(?:proj-|svcacct-|admin-)?(?!ant-)[0-9A-Za-z_-]{32,}\b/g, keep: 3, severity: 'critical' },
  { id: 'openrouter-key', label: 'OpenRouter API key', re: /\bsk-or-v1-[0-9a-f]{32,}\b/g, keep: 9, severity: 'critical' },
  { id: 'supabase-secret', label: 'Supabase secret key', re: /\bsb_secret_[0-9A-Za-z_-]{20,}\b/g, keep: 10, severity: 'critical' },
  { id: 'supabase-publishable', label: 'Supabase publishable key (public by design)', re: /\bsb_publishable_[0-9A-Za-z_-]{20,}\b/g, keep: 15, severity: 'info' },
  { id: 'google-api-key', label: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g, keep: 4, severity: 'info' },   // Firebase web keys are public by design
  { id: 'slack-token', label: 'Slack token', re: /\bxox[abposr]-[0-9A-Za-z-]{10,}\b/g, keep: 5, severity: 'high' },
  { id: 'twilio-key', label: 'Twilio API key', re: /\bSK[0-9a-f]{32}\b/g, keep: 2, severity: 'high' },
  { id: 'sendgrid-key', label: 'SendGrid API key', re: /\bSG\.[0-9A-Za-z_-]{22}\.[0-9A-Za-z_-]{43}\b/g, keep: 3, severity: 'high' },
  { id: 'jwt', label: 'JSON Web Token', re: /\beyJ[0-9A-Za-z_-]{8,}\.eyJ[0-9A-Za-z_-]{8,}\.[0-9A-Za-z_-]{8,}\b/g, keep: 0, severity: 'info' },   // classified by jwtRole()
  { id: 'db-url', label: 'Database URL with password', re: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:@/'"]+:[^\s@/'"]+@[^\s'"]+/g, keep: 0, severity: 'critical' },
];

// key = "long random value" assignments the format list does not know
const GENERIC_ASSIGN = /\b([A-Za-z0-9_]*(?:secret|token|passw(?:or)?d|api[_-]?key|private[_-]?key|client[_-]?secret|access[_-]?key)[A-Za-z0-9_]*)\b["']?\s*[:=]\s*["'`]([^"'`\s]{12,200})["'`]/gi;
const LONG_TOKEN = /[A-Za-z0-9_\-+/=]{32,}/g;

export function entropy(s) {
  const n = s.length; if (!n) return 0;
  const f = {}; for (const c of s) f[c] = (f[c] || 0) + 1;
  let h = 0; for (const k in f) { const p = f[k] / n; h -= p * Math.log2(p); }
  return h;
}
// a random-looking token, not a word, path, hash-like hex of a file name, or a CSS/base64 data blob marker
export function looksRandom(s) {
  if (s.length < 16) return false;
  if (/^[a-z]+(?:[-_][a-z]+)*$/i.test(s)) return false;                      // words-with-dashes
  if (/^(?:https?:|\/|\.\/)/.test(s)) return false;
  if (/[/._-]/.test(s) && s.split(/[/._-]+/).every(seg => /^[A-Za-z]*$/.test(seg) || /^\d+$/.test(seg))) return false;   // paths / identifiers made of words
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/].filter(r => r.test(s)).length;
  if (classes < 2) return false;
  return entropy(s) >= (s.length >= 32 ? 3.5 : 3.2);
}

// decodes the payload of a JWT (no verification); -> { role, iss, ref } or null
export function jwtRole(tok) {
  try {
    const p = JSON.parse(Buffer.from(tok.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return p && typeof p === 'object' ? { role: typeof p.role === 'string' ? p.role : null, iss: typeof p.iss === 'string' ? p.iss : null, ref: typeof p.ref === 'string' ? p.ref : null } : null;
  } catch { return null; }
}

// "sk_live_[REDACTED 24 chars]"
export function mask(value, keep = 0) {
  const v = String(value);
  const k = Math.min(keep, Math.max(0, v.length - 8));
  return v.slice(0, k) + '[REDACTED ' + (v.length - k) + ' chars]';
}

// every secret-looking match in text -> [{ id, label, severity, index, length, value }] (value: callers must never print it)
export function findSecrets(text, { generic = true } = {}) {
  const s = String(text ?? '');
  const out = [], taken = [];
  const overlaps = (a, b) => taken.some(([x, y]) => a < y && b > x);
  for (const p of SECRET_PATTERNS) {
    p.re.lastIndex = 0;
    for (const m of s.matchAll(p.re)) {
      const a = m.index, b = a + m[0].length;
      if (overlaps(a, b)) continue;
      let { id, label, severity } = p;
      if (id === 'jwt') {
        const j = jwtRole(m[0]);
        if (j && j.role === 'service_role') { id = 'supabase-service-role'; label = 'Supabase service_role key'; severity = 'critical'; }
        else if (j && j.role === 'anon') { id = 'supabase-anon'; label = 'Supabase anon key (public by design)'; severity = 'info'; }
      }
      taken.push([a, b]); out.push({ id, label, severity, index: a, length: m[0].length, value: m[0], keep: p.keep });
    }
  }
  if (generic) {
    GENERIC_ASSIGN.lastIndex = 0;
    for (const m of s.matchAll(GENERIC_ASSIGN)) {
      const val = m[2], a = m.index + m[0].lastIndexOf(val), b = a + val.length;
      if (overlaps(a, b) || !looksRandom(val) || /^(?:process\.env|import\.meta|\$\{|<|%)/.test(val) || /x{6,}|\*{4,}|your[_-]|example|placeholder|changeme|REDACTED/i.test(val)) continue;
      taken.push([a, b]); out.push({ id: 'generic-secret', label: 'Possible secret in "' + m[1].slice(0, 40) + '"', severity: 'medium', index: a, length: val.length, value: val, keep: 0 });
    }
  }
  return out.sort((x, y) => x.index - y.index);
}

// masks every known secret, every key = "random value" assignment and (deny by default) every other long random token
export function redact(text, { aggressive = true } = {}) {
  let s = String(text ?? '');
  const hits = findSecrets(s);
  for (let i = hits.length - 1; i >= 0; i--) { const h = hits[i]; s = s.slice(0, h.index) + mask(h.value, h.keep) + s.slice(h.index + h.length); }
  if (aggressive) s = s.replace(LONG_TOKEN, t => (looksRandom(t) && !/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(t) ? mask(t, 0) : t));   // git/sha hashes stay readable
  return s;
}

// deep copy of a JSON value with every string redacted
export function redactDeep(v, opts) {
  if (typeof v === 'string') return redact(v, opts);
  if (Array.isArray(v)) return v.map(x => redactDeep(x, opts));
  if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = /secret|token|password|api[_-]?key|authorization|cookie/i.test(k) && typeof x === 'string' && x ? '[REDACTED]' : redactDeep(x, opts); return o; }
  return v;
}

// true when text still contains something that looks like a secret (used as the last gate before any upload)
export const stillSecret = text => findSecrets(text).some(h => h.severity !== 'info') || (String(text).match(LONG_TOKEN) || []).some(t => looksRandom(t) && !/\[REDACTED/.test(t) && !/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(t));

// the only way repo/run text reaches a model: redacted, fenced as untrusted, gate re-checked. Throws on any failure,
// and the caller then makes no LLM call (deny by default).
export function forAI(text, label = 'data') {
  let r;
  try { r = redact(text); } catch (e) { throw new Error('redaction failed, nothing sent: ' + (e && e.message)); }
  if (typeof r !== 'string' || stillSecret(r)) throw new Error('redaction gate: text still looks secret, nothing sent');
  const safe = r.replace(/<\/?untrusted[^>]*>/gi, '[fence]');   // the content cannot close its own fence
  return `<untrusted source="${String(label).replace(/[^a-z0-9 ._-]/gi, '')}">\n${safe}\n</untrusted>`;
}

// home folder -> ~, user name -> <user> (for diagnostics)
export function scrubPaths(s, home = process.env.USERPROFILE || process.env.HOME || '', user = process.env.USERNAME || process.env.USER || '') {
  let out = String(s);
  if (home) out = out.split(home).join('~').split(home.replace(/\\/g, '/')).join('~');
  if (user && user.length > 2) out = out.replace(new RegExp(user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '<user>');
  return out;
}
