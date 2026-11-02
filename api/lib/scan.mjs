// Static-only repo scan for GitHub mode: secret regex/entropy + Supabase/Firebase rules lint.
// Never executes or imports anything from the repo. Every secret is redacted before it is
// stored in a finding; raw matched values never leave this module.
import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { readTar } from './tar.mjs';
import { SECRET_RULES, GENERIC_ASSIGN, isPlaceholder, shannon, redactMatch } from './secrets.mjs';
import { sha256hex, HttpError } from './http.mjs';

export const LIMITS = {
  maxEntryBytes: 1024 * 1024,        // files bigger than this are skipped (and listed)
  maxUnpackedBytes: 300 * 1024 * 1024,
  maxEntries: 25000,
  maxFindings: 60,
  deadlineMs: 20000,
};

const SKIP_DIRS = /(^|\/)(node_modules|\.git|bower_components|vendor|\.venv|venv|__pycache__|\.next\/cache|coverage)\//;
const SKIP_EXT = /\.(png|jpe?g|gif|webp|avif|ico|bmp|tiff?|psd|svgz|mp3|mp4|m4a|mov|avi|webm|ogg|wav|flac|pdf|zip|gz|tgz|bz2|xz|7z|rar|jar|war|class|so|dylib|dll|exe|bin|o|a|wasm|woff2?|ttf|otf|eot|sqlite|db|pyc)$/i;
const LOCKFILE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|composer\.lock|Gemfile\.lock|poetry\.lock|Cargo\.lock|go\.sum)$/;
const DOC = /\.(md|mdx|rst|txt|adoc)$/i;
const ENV_FILE = /(^|\/)\.env(\.[\w.-]+)?$/;
const ENV_TEMPLATE = /\.(example|sample|template|dist|defaults?)$/i;

const SEV_WEIGHT = { critical: 40, high: 20, medium: 8, low: 3, info: 0 };

/** Strip GitHub's "<owner>-<repo>-<sha>/" root folder and refuse odd paths. */
export function repoPath(p) {
  const s = String(p).replace(/\\/g, '/');
  const i = s.indexOf('/');
  const rel = i >= 0 ? s.slice(i + 1) : '';
  if (!rel || rel.startsWith('/') || rel.split('/').includes('..')) return null;
  return rel.slice(0, 1024);
}

function lineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return (pos) => {
    let lo = 0; let hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= pos) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
}

function looksBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export class RepoScanner {
  constructor({ now = Date.now, limits = LIMITS } = {}) {
    this.now = now;
    this.limits = limits;
    this.started = now();
    this.secretHits = new Map(); // key -> {rule, file, line, redacted, count, files:Set}
    this.rulesFindings = [];
    this.skippedLarge = [];
    this.filesScanned = 0;
    this.entries = 0;
    this.truncated = null;
    this.sql = []; // {path, text}
    this.signals = { firebase: false, supabase: false, firebaseRules: [], supabaseSql: [], rtdbRules: [] };
    this.timing = { secret: 0, rules: 0 };
  }

  timeUp() { return this.now() - this.started > this.limits.deadlineMs; }

  /** Feed one file. `data` is a Buffer (or null when skipped upstream). */
  addFile(rawPath, data, size) {
    this.entries++;
    if (this.entries > this.limits.maxEntries) { this.truncated ||= `more than ${this.limits.maxEntries} files`; return; }
    const path = repoPath(rawPath);
    if (!path) return;
    if (SKIP_DIRS.test(path) || SKIP_EXT.test(path)) return;
    if (!data) { this.skippedLarge.push({ path, size }); return; }
    if (looksBinary(data)) return;
    const text = data.toString('utf8');
    this.filesScanned++;

    let t = this.now();
    this.#secrets(path, text);
    this.timing.secret += this.now() - t;

    t = this.now();
    this.#rulesSignals(path, text);
    this.timing.rules += this.now() - t;
  }

  #hit(rule, path, line, raw, extra = {}) {
    const key = `${rule.id}:${sha256hex(raw)}`;
    const prev = this.secretHits.get(key);
    if (prev) { prev.count++; prev.files.add(path); return; }
    this.secretHits.set(key, {
      rule, file: path, line, redacted: redactMatch(raw, rule.keep), count: 1, files: new Set([path]), ...extra,
    });
  }

  #secrets(path, text) {
    const lineOf = lineIndex(text);
    for (const rule of SECRET_RULES) {
      const re = new RegExp(rule.re.source, rule.re.flags);
      let m;
      while ((m = re.exec(text))) {
        const v = m[0];
        if (/(.)\1{11,}/.test(v) || /x{8,}/i.test(v)) continue; // obvious placeholder like sk_live_xxxxxxxx
        if (rule.check && !rule.check(v)) continue;
        this.#hit(rule, path, lineOf(m.index), v);
      }
    }
    if (ENV_FILE.test(path) && !ENV_TEMPLATE.test(path)) {
      const lines = text.split('\n');
      const idx = lines.findIndex((l) => /^\s*(export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*\S/.test(l) && !/^\s*#/.test(l));
      if (idx >= 0) {
        this.#hit(ENV_RULE, path, idx + 1, `envfile:${path}`, { redacted: '(values not shown)' });
      }
    }
    if (LOCKFILE.test(path) || DOC.test(path)) return;
    const re = new RegExp(GENERIC_ASSIGN.source, GENERIC_ASSIGN.flags);
    let m;
    while ((m = re.exec(text))) {
      const v = m[1];
      if (isPlaceholder(v) || shannon(v) < 3.5 || !/\d/.test(v) || !/[A-Za-z]/.test(v)) continue;
      // Skip if a specific rule already covers this exact value.
      if (SECRET_RULES.some((r) => new RegExp(r.re.source, r.re.flags.replace('g', '')).test(v))) continue;
      this.#hit(GENERIC_RULE, path, lineOf(m.index), v);
    }
  }

  #rulesSignals(path, text) {
    const base = path.split('/').pop();
    if (/firebase(?:app)?\.(?:com|io)|initializeApp\(|from ["']firebase\//.test(text) || base === 'firebase.json') this.signals.firebase = true;
    if (/supabase\.co\b|@supabase\/supabase-js|createClient\(/.test(text) || path.startsWith('supabase/')) this.signals.supabase = true;

    if (/\.rules$/.test(base) && /service\s+(cloud\.firestore|firebase\.storage)/.test(text)) {
      this.signals.firebaseRules.push(path);
      this.#lintFirebaseRules(path, text);
    } else if (base === 'database.rules.json' || (/rules.*\.json$/.test(base) && /"\.(read|write)"/.test(text))) {
      this.signals.rtdbRules.push(path);
      this.#lintRtdb(path, text);
    } else if (/\.sql$/i.test(base) && /(^|\/)supabase\//.test(path)) {
      this.signals.supabaseSql.push(path);
      this.sql.push({ path, text });
    }
  }

  #rule(kind, severity, confidence, path, line, title, why, fix) {
    this.rulesFindings.push({ kind, severity, confidence, file: path, line, title, why, fix });
  }

  #lintFirebaseRules(path, text) {
    const lineOf = lineIndex(text);
    const service = /firebase\.storage/.test(text) ? 'Storage' : 'Firestore';
    const allow = /allow\s+([a-z ,]{1,80}?)\s*(?::\s*if\s+([^;]{1,400}))?;/g;
    let m;
    while ((m = allow.exec(text))) {
      const ops = m[1].replace(/\s+/g, ' ').trim();
      const cond = (m[2] || '').trim();
      const writes = /write|create|update|delete/.test(ops);
      const line = lineOf(m.index);
      if (!cond || /^true$/.test(cond)) {
        this.#rule('open', writes ? 'critical' : 'high', 'likely', path, line,
          `${service} rules let anyone ${writes ? 'read and change' : 'read'} data (allow ${ops}${cond ? ': if true' : ''})`,
          `This rule has no real condition, so anyone on the internet who knows your project ID can ${writes ? 'read, overwrite or delete' : 'read'} the matching documents without signing in.`,
          'Replace it with a condition tied to the signed-in user, e.g. allow read, write: if request.auth != null && request.auth.uid == userId; then test it in the Firebase emulator.');
      } else if (/request\.time\s*<\s*timestamp\.date\(/.test(cond)) {
        this.#rule('test-mode', 'high', 'likely', path, line,
          `${service} rules are still in test mode (open until a date)`,
          'Test-mode rules allow anyone to read and write until the date passes, then lock everyone out, including your app.',
          'Write real per-user rules before launch instead of extending the date.');
      } else if (/^request\.auth\s*!=\s*null$/.test(cond) && /match\s+\/\{document=\*\*\}/.test(text.slice(Math.max(0, m.index - 400), m.index))) {
        this.#rule('any-user', 'medium', 'unconfirmed', path, line,
          `${service} rules let any signed-in user ${writes ? 'change' : 'read'} every document`,
          'Anyone can create an account and then reach all documents, including other users\' data.',
          'Scope each collection to its owner (request.auth.uid == resource.data.ownerId) instead of a single catch-all rule.');
      }
    }
  }

  #lintRtdb(path, text) {
    let rules;
    try { rules = JSON.parse(text.replace(/^\s*\/\/.*$/gm, '')); } catch { return; }
    const root = rules && rules.rules;
    if (!root || typeof root !== 'object') return;
    const lineOf = lineIndex(text);
    for (const op of ['.read', '.write']) {
      const v = root[op];
      const line = lineOf(Math.max(0, text.indexOf(`"${op}"`)));
      if (v === true || v === 'true') {
        this.#rule('open', op === '.write' ? 'critical' : 'high', 'likely', path, line,
          `Realtime Database rules let anyone ${op === '.write' ? 'write' : 'read'} the whole database`,
          `"${op}": true at the root applies to every path, without sign-in.`,
          'Remove the root rule and add per-path rules that check auth.uid.');
      } else if (typeof v === 'string' && /^auth\s*!=\s*null$/.test(v.trim())) {
        this.#rule('any-user', 'medium', 'unconfirmed', path, line,
          `Realtime Database lets any signed-in user ${op === '.write' ? 'write' : 'read'} everything`,
          'Any account, including one an attacker creates, reaches all data.',
          'Scope rules per path, e.g. "$uid": { ".read": "auth.uid === $uid" }.');
      }
    }
  }

  #lintSupabase() {
    const ident = '((?:"?[A-Za-z_][\\w$]*"?\\.)?"?[A-Za-z_][\\w$]*"?)';
    const norm = (n) => { const p = n.replace(/"/g, '').toLowerCase().split('.'); return p.length === 1 ? `public.${p[0]}` : p.join('.'); };
    const created = new Map();
    const enabled = new Set();
    for (const { path, text } of this.sql) {
      const lineOf = lineIndex(text);
      const ct = new RegExp(`create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?${ident}`, 'gi');
      let m;
      while ((m = ct.exec(text))) {
        const name = norm(m[1]);
        if (name.startsWith('public.') && !created.has(name)) created.set(name, { path, line: lineOf(m.index) });
      }
      const en = new RegExp(`alter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?${ident}\\s+enable\\s+row\\s+level\\s+security`, 'gi');
      while ((m = en.exec(text))) enabled.add(norm(m[1]));
      const dis = new RegExp(`alter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?${ident}\\s+disable\\s+row\\s+level\\s+security`, 'gi');
      while ((m = dis.exec(text))) {
        this.#rule('rls-disabled', 'high', 'likely', path, lineOf(m.index),
          `Row level security is switched off for ${norm(m[1])}`,
          'With RLS off, the anon key in your front end can read and change every row in this table.',
          `Run alter table ${norm(m[1])} enable row level security; and add policies for the access you need.`);
      }
      const pol = /create\s+policy\s+("[^"]{1,120}"|\w{1,120})\s+on\s+([\w."]{1,120})([\s\S]{0,400}?)(?:using|with\s+check)\s*\(\s*true\s*\)/gi;
      while ((m = pol.exec(text))) {
        const writes = /for\s+(all|insert|update|delete)/i.test(m[3]);
        this.#rule('policy-true', writes ? 'high' : 'medium', 'unconfirmed', path, lineOf(m.index),
          `Policy ${m[1].replace(/"/g, '')} on ${norm(m[2])} allows every row${writes ? ' to be changed' : ''}`,
          'A policy of (true) applies to every row for every caller it targets. That is fine for public read-only data, risky for anything else.',
          'Limit it, e.g. using (auth.uid() = user_id), or confirm the table is meant to be public.');
      }
    }
    for (const [name, at] of created) {
      if (enabled.has(name)) continue;
      this.#rule('rls-missing', 'high', 'likely', at.path, at.line,
        `Table ${name} is created without row level security`,
        'Supabase exposes public tables through its API. Without RLS, anyone with your anon key (it is in your front end) can read and write every row.',
        `Add alter table ${name} enable row level security; in a migration, then add policies for each role.`);
    }
  }

  /** Finish and return report pieces. */
  finish() {
    const t = this.now();
    this.#lintSupabase();
    this.timing.rules += this.now() - t;
    return this;
  }
}

const ENV_RULE = {
  id: 'env-file', keep: 0, severity: 'high', confidence: 'likely',
  title: 'A .env file with values is committed to the repo',
  why: '.env files usually hold database URLs, API keys and passwords. Once committed, everyone with read access (and the git history) has them.',
  fix: 'Remove the file from git (git rm --cached), add .env* to .gitignore, rotate every value it held, and commit a .env.example with empty values instead.',
};
const GENERIC_RULE = {
  id: 'generic-secret', keep: 0, severity: 'medium', confidence: 'unconfirmed',
  title: 'Possible hard-coded secret (password / token / key assignment)',
  why: 'A value that looks random is assigned to a name like secret, password or token. If it is real, anyone who can read the code has it.',
  fix: 'If this is a real credential, rotate it and read it from an environment variable on the server instead. If it is a fake or public value, you can ignore this.',
};

/** Stream-scan a .tar.gz file on disk. */
export async function scanTarGz(filePath, { now = Date.now, limits = LIMITS } = {}) {
  const scanner = new RepoScanner({ now, limits });
  const gunzip = createGunzip();
  const src = createReadStream(filePath).pipe(gunzip);
  let unpacked = 0;
  let commit = null;
  async function* counted() {
    for await (const chunk of src) {
      unpacked += chunk.length;
      if (unpacked > limits.maxUnpackedBytes) {
        scanner.truncated ||= `unpacked size over ${Math.round(limits.maxUnpackedBytes / 1048576)} MB`;
        src.destroy();
        return;
      }
      yield chunk;
    }
  }
  try {
    for await (const e of readTar(counted(), { maxEntryBytes: limits.maxEntryBytes })) {
      if (!commit && e.global && /^[0-9a-f]{40}$/.test(e.global.comment || '')) commit = e.global.comment;
      if (e.type === 'file') scanner.addFile(e.path, e.data, e.size);
      if (scanner.timeUp()) { scanner.truncated ||= 'the scan time limit was reached'; break; }
      if (scanner.truncated) break;
    }
  } catch (err) {
    // Hitting the unpacked-size cap cuts the stream mid-entry; that is an expected stop.
    if (!scanner.truncated) throw new HttpError(422, 'bad_archive', 'GitHub sent an archive Anvil could not read.');
  } finally {
    src.destroy();
  }
  scanner.commit = commit;
  return scanner.finish();
}

function idSafe(s) { return String(s).toLowerCase().replace(/[^a-z0-9._:-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'x'; }

/**
 * Build a report.json (schemas/report.schema.json, schemaVersion "1") from a finished scanner.
 */
export function buildReport(scanner, { owner, repo, ref, scannedAt, anvilVersion = '0.2.0' }) {
  const findings = [];
  let n = 0;
  const hits = [...scanner.secretHits.values()].sort((a, b) => SEV_WEIGHT[b.rule.severity] - SEV_WEIGHT[a.rule.severity]);
  for (const h of hits) {
    n++;
    const others = h.count > 1 ? ` The same value appears ${h.count - 1} more time(s)${h.files.size > 1 ? ` across ${h.files.size} files` : ''}.` : '';
    findings.push({
      id: `f-secret-${idSafe(h.rule.id)}-${n}`,
      check: 'secret-scan',
      severity: h.rule.severity,
      title: h.rule.title,
      evidence: { file: h.file, line: h.line, response: `matched ${h.redacted}` },
      why: `${h.rule.why}${others}`,
      fix: h.rule.fix,
      confidence: h.rule.confidence || 'likely',
    });
  }
  let r = 0;
  for (const f of scanner.rulesFindings) {
    r++;
    findings.push({
      id: `f-rules-${idSafe(f.kind)}-${r}`,
      check: 'rules-lint',
      severity: f.severity,
      title: f.title.slice(0, 300),
      evidence: { file: f.file, line: f.line },
      why: f.why,
      fix: f.fix,
      confidence: f.confidence,
    });
  }
  const order = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  const dropped = Math.max(0, findings.length - scanner.limits.maxFindings);
  findings.length = Math.min(findings.length, scanner.limits.maxFindings);

  const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0, humanPending: 0, humanBroken: 0 };
  for (const f of findings) counts[f.severity]++;
  const penalty = findings.reduce((s, f) => s + SEV_WEIGHT[f.severity], 0);

  const sig = scanner.signals;
  const rulesFiles = sig.firebaseRules.length + sig.rtdbRules.length + sig.supabaseSql.length;
  const secretFail = findings.some((f) => f.check === 'secret-scan' && f.severity !== 'info');
  const rulesFail = findings.some((f) => f.check === 'rules-lint');

  const checksRun = [
    { id: 'secret-scan', name: 'Secret scan (repo files, regex + entropy)', status: secretFail ? 'fail' : findings.some((f) => f.check === 'secret-scan') ? 'warn' : 'pass', durationMs: Math.round(scanner.timing.secret) },
    { id: 'rules-lint', name: 'Supabase / Firebase rules (static read of rules files)', status: rulesFiles ? (rulesFail ? 'fail' : 'pass') : 'skip', durationMs: Math.round(scanner.timing.rules) },
  ];

  const notChecked = [
    { what: 'The running app (pages, console errors, layout on phones, accessibility, role access)', why: 'GitHub mode never runs your code or opens your site. Run Anvil locally (anvil scan) for browser checks.' },
    { what: 'Human checks (sign-up, payments, sharing)', why: 'These need a person clicking through the real app; they are part of local mode.' },
    { what: 'Git history and other branches', why: `Only the files at ${ref} were scanned. A secret removed in a later commit is still in history and must be rotated.` },
    { what: 'Live database rules', why: rulesFiles ? 'Rules were read from files in the repo; the rules actually deployed to Firebase/Supabase may differ.' : (sig.firebase || sig.supabase) ? 'Supabase or Firebase is used, but no rules files are in the repo, so the deployed rules could not be read.' : 'No Supabase or Firebase rules files were found.' },
    { what: 'Secrets in formats Anvil has no pattern for', why: 'The scan matches known key formats and random-looking assignments; custom tokens can slip through.' },
    { what: 'Overall security', why: 'Passing these checks does not make an app secure. Anvil reports what it checked and found, nothing more.' },
  ];
  if (scanner.skippedLarge.length) {
    const list = scanner.skippedLarge.slice(0, 5).map((s) => s.path).join(', ');
    notChecked.push({ what: `${scanner.skippedLarge.length} file(s) over ${Math.round(scanner.limits.maxEntryBytes / 1024)} KB`, why: `Large files were skipped: ${list}${scanner.skippedLarge.length > 5 ? ', ...' : ''}`.slice(0, 1000) });
  }
  if (scanner.truncated) notChecked.push({ what: 'Part of the repository', why: `The scan stopped early because ${scanner.truncated}. Run anvil scan locally for a full pass.` });
  if (dropped) notChecked.push({ what: `${dropped} more finding(s)`, why: `Only the first ${scanner.limits.maxFindings} findings are listed, most severe first.` });

  const ts = new Date(scannedAt);
  return {
    schemaVersion: '1',
    runId: `gh-${ts.toISOString().replace(/[:.]/g, '-')}`,
    anvilVersion,
    scannedAt: ts.toISOString(),
    target: { kind: 'github', value: `${owner}/${repo}@${ref}${scanner.commit ? ` (${scanner.commit.slice(0, 12)})` : ''}` },
    mode: { ai: 'none' },
    checksRun,
    findings,
    humanChecks: [],
    notChecked,
    summary: { score0to100: Math.max(0, 100 - penalty), counts },
  };
}
