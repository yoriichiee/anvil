// Anvil - secret scan of the source (git-ignored folders skipped) and of what the browser gets (built bundle folders,
// plus the JS and HTML the crawl downloaded). Known formats by pattern, unknown ones by "key = random value" entropy.
// Values are never stored: evidence shows a masked form (sk_live_[REDACTED 24 chars]).
import fs from 'node:fs';
import crypto from 'node:crypto';
import { findSecrets, mask } from '../redact.mjs';
import { browserExposure, isEnvFile, lineOf } from '../source.mjs';
import { skip } from './skip.mjs';

const STRIPE_FIX = 'Roll the key in the Stripe dashboard now (treat it as leaked). Move every call that needs it to a server route that reads it from an environment variable; only the publishable key (pk_live_) belongs in the browser.';
const FIX = {
  'stripe-secret': STRIPE_FIX,
  'stripe-demo-secret': STRIPE_FIX,
  'aws-access-key': 'Deactivate the key in IAM now and create a new one. Keep AWS keys on the server (environment variables or a role), never in front-end code or the repo.',
  'aws-secret-key': 'Deactivate the key pair in IAM now and create a new one. Keep it in environment variables on the server only.',
  'github-token': 'Revoke the token at github.com/settings/tokens now. Use a server-side secret or a GitHub App instead.',
  'openai-key': 'Revoke the key in the OpenAI dashboard now. Call the API from a server route that reads the key from an environment variable.',
  'anthropic-key': 'Revoke the key in the Anthropic console now. Call the API from a server route that reads the key from an environment variable.',
  'openrouter-key': 'Revoke the key in OpenRouter now and call it from the server only.',
  'supabase-service-role': 'Rotate the service_role key in Supabase (Project settings > API) now. The browser must only ever get the anon/publishable key; service_role skips every row-level security rule.',
  'supabase-secret': 'Rotate the secret key in Supabase now. Only the publishable key belongs in front-end code.',
  'private-key': 'Treat the key as compromised: replace it and remove it from the code and from git history.',
  'db-url': 'Change the database password now and load the connection string from an environment variable on the server.',
};
const isTesty = rel => /(^|\/)(test|tests|__tests__|spec|fixtures?|examples?\/.*\/tests?)\//i.test(rel) || /\.(test|spec)\.[a-z]+$/i.test(rel);
const downgrade = { critical: 'high', high: 'high', medium: 'medium', low: 'low', info: 'info' };

export const secretScan = {
  id: 'secret-scan', name: 'Secret scan (source + built bundle)', needs: 'any',
  async run(ctx) {
    const groups = new Map();   // hash(value) -> group
    const note = (h, where) => {
      const key = crypto.createHash('sha256').update(h.value).digest('hex').slice(0, 16);
      if (!groups.has(key)) groups.set(key, { h, masked: mask(h.value, h.keep), places: [] });
      groups.get(key).places.push(where);
    };
    let scanned = 0;
    const fw = ctx.source && ctx.source.framework;
    if (ctx.source) for (const f of ctx.source.files) {
      if (f.size > 2e6) continue;
      let t; try { t = fs.readFileSync(f.abs, 'utf8'); } catch { continue; }
      scanned++;
      const env = isEnvFile(f.rel);
      for (const h of findSecrets(t, { generic: !/\.(md|txt|lock)$|package-lock\.json$/.test(f.rel) })) {
        if (h.severity === 'info') continue;
        note(h, { kind: env ? 'env' : 'file', rel: f.rel, line: lineOf(t, h.index), exposure: f.bundle ? 'yes' : browserExposure(f.rel, fw), testy: isTesty(f.rel), doc: /\.(md|txt)$/i.test(f.rel) });
      }
    }
    const crawl = ctx.origin ? await ctx.crawl().catch(() => null) : null;
    if (crawl) for (const b of crawl.bundles) {
      scanned++;
      for (const h of findSecrets(b.text, { generic: true })) {
        if (h.severity === 'info') continue;
        note(h, { kind: 'served', rel: b.path, line: lineOf(b.text, h.index), exposure: 'yes', sameOrigin: b.sameOrigin });
      }
    }
    if (!scanned) throw skip('No source folder and no downloaded JavaScript to scan.');
    const findings = [];
    for (const g of groups.values()) {
      const { h } = g;
      const served = g.places.find(p => p.kind === 'served');
      const shipped = g.places.find(p => p.exposure === 'yes' && p.kind !== 'env') || served;
      const likely = !shipped && g.places.find(p => p.exposure === 'likely');
      const env = g.places.find(p => p.kind === 'env');
      const onlyTests = g.places.every(p => p.testy || p.doc);
      const first = (shipped && shipped.kind !== 'served' ? shipped : null) || likely || env || g.places.find(p => p.kind === 'file') || served;
      let severity = h.severity, title, why, confidence = 'proven';
      // keep brand names and acronyms as written (Stripe, AWS, GitHub, JSON); only plain leading words are lower-cased
      const noun = /^(Private|Possible|Database)\b/.test(h.label) ? h.label[0].toLowerCase() + h.label.slice(1) : h.label;
      if (shipped) { title = `${h.label} is shipped to every browser`; why = `Anyone who opens DevTools on your site can copy this ${noun} and use it as you.`; }
      else if (likely) { title = `${h.label} is in front-end code`; why = 'This file is most likely bundled into the JavaScript your users download, so the value would be public.'; confidence = 'likely'; }
      else if (env) { severity = downgrade[severity]; title = `${h.label} in ${env.rel}, which is not git-ignored`; why = 'This .env file would be committed with the code, so everyone with access to the repo (or a public copy of it) gets the value.'; }
      else { severity = downgrade[severity]; title = `${h.label} hard-coded in ${first.rel}`; why = 'Secrets in source code end up in git history, logs and copies of the repo. Keep them in environment variables.'; }
      if (onlyTests) { severity = 'low'; confidence = 'unconfirmed'; title += ' (test or docs file)'; why += ' It is in a test or docs file, so it may be a fake value; check it.'; }
      if (h.id === 'generic-secret' && confidence === 'proven') confidence = 'likely';
      if (h.id === 'stripe-test-secret' && severity !== 'low') severity = 'medium';
      const also = g.places.filter(p => p !== first).map(p => (p.kind === 'served' ? 'served at ' : '') + p.rel + (p.line ? ':' + p.line : '')).slice(0, 5);
      findings.push({ id: 'f-secret-' + h.id, severity, title,
        evidence: {
          ...(first.kind !== 'served' ? { file: first.rel, line: first.line } : {}),
          ...(served ? { request: 'GET ' + served.rel } : {}),
          response: (served ? '200 OK, body contains ' : 'contains ') + g.masked + (also.length ? ' (also in ' + also.join(', ') + ')' : ''),
        },
        why, fix: FIX[h.id] || 'Treat the value as leaked: rotate it with the provider, then load it from an environment variable on the server and remove it from the code.', confidence });
    }
    const notChecked = [{ what: 'Secrets in git history', why: 'Only the current files (and what the browser downloaded) were scanned, not older commits.' }];
    if (ctx.source && ctx.source.truncated) notChecked.push({ what: 'Part of the source tree', why: 'The project has more files than the scan limit; the rest were not scanned.' });
    return { findings, notChecked };
  },
};
