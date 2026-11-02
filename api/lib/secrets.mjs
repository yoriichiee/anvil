// Secret patterns shared by the repo scanner and the redactor.
// Every quantifier is bounded so the patterns stay linear on hostile input.

/**
 * @typedef {{id:string, re:RegExp, keep:number|((m:string)=>number), severity:string, title:string,
 *   why:string, fix:string, confidence?:string, check?:(m:string)=>boolean}} SecretRule
 */

function jwtPayload(token) {
  try {
    const part = token.split('.')[1];
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch { return null; }
}

const ROTATE = 'Treat it as leaked: revoke or roll it at the provider now, then load it from an environment variable or secret store on the server side only. Deleting the line is not enough, because it stays in git history.';

/** @type {SecretRule[]} */
export const SECRET_RULES = [
  {
    id: 'stripe-live-secret', re: /\b(?:sk|rk)_live_[0-9A-Za-z]{16,247}\b/g, keep: 8, severity: 'critical',
    title: 'Live Stripe secret key committed to the repo',
    why: 'A live secret or restricted key (sk_live_ / rk_live_) can create charges, refund payments and read customer data. Anyone who can read this repo or the shipped bundle can use it.',
    fix: `Roll the key in the Stripe dashboard. ${ROTATE} Only publishable keys (pk_live_) belong in front-end code.`,
  },
  {
    id: 'stripe-test-secret', re: /\b(?:sk|rk)_test_[0-9A-Za-z]{16,247}\b/g, keep: 8, severity: 'medium',
    title: 'Stripe test secret key committed to the repo',
    why: 'Test keys cannot move real money, but they expose your test data and usually sit next to the place the live key will go.',
    fix: `Roll the test key and read it from an environment variable on the server. ${ROTATE}`,
  },
  {
    id: 'aws-secret-key', re: /aws_?secret_?access_?key["']?\s{0,5}[:=]\s{0,5}["']?[A-Za-z0-9/+=]{40}\b/gi, keep: 0, severity: 'critical',
    title: 'AWS secret access key committed to the repo',
    why: 'An AWS secret key gives whatever access its IAM user has, often enough to run up a large bill or read data.',
    fix: `Deactivate the access key in IAM now. ${ROTATE} Prefer IAM roles over long-lived keys.`,
  },
  {
    id: 'aws-access-key-id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, keep: 4, severity: 'high',
    title: 'AWS access key ID committed to the repo',
    why: 'The key ID alone cannot sign requests, but its secret is often nearby (other files, history, CI logs).',
    fix: `Check where the matching secret key lives, deactivate the pair if it was ever committed. ${ROTATE}`,
  },
  {
    id: 'github-token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,251}\b|\bgithub_pat_[A-Za-z0-9_]{22,251}\b/g,
    keep: (m) => (m.startsWith('github_pat_') ? 11 : 4), severity: 'critical',
    title: 'GitHub token committed to the repo',
    why: 'A GitHub token can read or push to every repo its owner can reach.',
    fix: `Revoke it at github.com/settings/tokens. ${ROTATE}`,
  },
  {
    id: 'anthropic-key', re: /\bsk-ant-(?:api|admin)\d{2}-[A-Za-z0-9_-]{20,300}/g, keep: 7, severity: 'critical',
    title: 'Anthropic API key committed to the repo',
    why: 'Anyone with this key can spend your Anthropic credits.',
    fix: `Delete the key in the Anthropic console. ${ROTATE}`,
  },
  {
    id: 'openai-key', re: /\bsk-(?:proj-|svcacct-|admin-)[A-Za-z0-9_-]{20,300}|\bsk-[A-Za-z0-9]{20,60}T3BlbkFJ[A-Za-z0-9]{20,60}\b/g,
    keep: (m) => (m.startsWith('sk-proj-') ? 8 : 3), severity: 'critical',
    title: 'OpenAI API key committed to the repo',
    why: 'Anyone with this key can spend your OpenAI credits.',
    fix: `Revoke the key in the OpenAI dashboard. ${ROTATE}`,
  },
  {
    id: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,250}/g, keep: 5, severity: 'high',
    title: 'Slack token committed to the repo',
    why: 'A Slack token can read or post messages in your workspace.',
    fix: `Revoke it in your Slack app settings. ${ROTATE}`,
  },
  {
    id: 'sendgrid-key', re: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g, keep: 3, severity: 'critical',
    title: 'SendGrid API key committed to the repo',
    why: 'A SendGrid key lets anyone send email as you, which gets your domain blocked as spam.',
    fix: `Delete the key in SendGrid. ${ROTATE}`,
  },
  {
    id: 'private-key', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g, keep: 0, severity: 'critical',
    title: 'Private key committed to the repo',
    why: 'A private key lets anyone impersonate the server, user or signer it belongs to.',
    fix: `Replace the key pair and revoke the old one wherever it is trusted. ${ROTATE}`,
  },
  {
    id: 'supabase-service-role', re: /\beyJ[A-Za-z0-9_-]{10,2000}\.eyJ[A-Za-z0-9_-]{10,4000}\.[A-Za-z0-9_-]{10,2000}/g, keep: 0, severity: 'critical',
    check: (m) => { const p = jwtPayload(m); return !!p && p.role === 'service_role'; },
    title: 'Supabase service_role key committed to the repo',
    why: 'The service_role key skips every row level security policy. Anyone holding it can read and change all data in the project.',
    fix: `Roll the JWT secret / service key in Supabase (Project Settings > API). ${ROTATE} The browser must only ever use the anon key.`,
  },
  {
    id: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g, keep: 4, severity: 'info', confidence: 'unconfirmed',
    title: 'Google API key in the repo (often fine for Firebase web config)',
    why: 'Firebase web config keys are meant to be public; protection comes from Firebase rules and API key restrictions. A Google Maps or other paid-API key without restrictions can be abused for billing.',
    fix: 'In Google Cloud console > Credentials, restrict this key to your domains and only the APIs it needs.',
  },
];

/** Generic `secret = "..."` style assignments; only reported when the value looks random. */
export const GENERIC_ASSIGN = /\b(?:secret|password|passwd|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|service[_-]?key)["']?\s{0,5}[:=]\s{0,5}["'`]([^"'`\s]{12,200})["'`]/gi;

const PLACEHOLDER = /x{4,}|example|placeholder|your[_-]|changeme|change[_-]me|dummy|sample|<[^>]*>|\$\{|process\.env|import\.meta|redacted|\*{3,}|todo|replace|insert|^test|test$|\.{3}/i;

export function isPlaceholder(v) {
  if (PLACEHOLDER.test(v)) return true;
  if (/^(.)\1+$/.test(v)) return true;
  return false;
}

export function shannon(s) {
  const f = new Map();
  for (const c of s) f.set(c, (f.get(c) || 0) + 1);
  let h = 0;
  for (const n of f.values()) { const p = n / s.length; h -= p * Math.log2(p); }
  return h;
}

export function redactMatch(m, keep) {
  const k = typeof keep === 'function' ? keep(m) : keep;
  const kept = m.slice(0, Math.min(k, Math.max(0, m.length - 8)));
  return `${kept}[REDACTED ${m.length - kept.length} chars]`;
}
