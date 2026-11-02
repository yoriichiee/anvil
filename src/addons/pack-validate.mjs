// pack-validate.mjs - zero-dependency validator + regex guard for anvil-addon.json packs.
//
// This file is shared verbatim with the add-on registry repo
// (addons-spec/repo-template/scripts/pack-validate.mjs); a test keeps the two copies identical.
// Edit it here, then copy it over.
//
// validatePack(obj)   -> { ok, errors[] }   mirrors schemas/anvil-addon.schema.json (draft-07)
// lintPack(obj)       -> { ok, errors[] }   policy rules on top of the schema (unique ids, same-site paths, ReDoS lint)
// checkPack(obj)      -> both of the above
// lintRegex(src)      -> string[]           static + adversarial ReDoS lint for one pattern
// compileRegex(src)   -> { source, flags }  "(?i)" prefix -> i flag; nothing else is supported
// safeMatchAll(...)   -> runs a regex inside node:vm with a hard timeout (V8 interrupts backtracking)
//
// Packs are untrusted input. Nothing in a pack is ever executed as code.

import vm from 'node:vm';

export const REGEX_MAX_LEN = 300;           // stricter than the schema's 500
export const REGEX_MAX_UNBOUNDED = 4;       // * + {n,} per pattern
export const REGEX_MAX_BOUND = 1000;        // {n,m}: m <= 1000
export const LINT_TIMEOUT_MS = 250;         // per adversarial input
const ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const LOCAL_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TAG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$/;
const RANGE_RE = /^[\^~>=<]*\d+(\.\d+){0,2}$/;
const PATH_RE = /^\/[^\s]{0,500}$/u;
const KINDS = ['page', 'dom', 'axe', 'secret-pattern', 'rules-probe', 'http'];
const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'];
const TOP_KEYS = ['$schema', 'id', 'name', 'version', 'author', 'license', 'anvil', 'description', 'tags', 'checks', 'humanChecks'];
const TOP_REQUIRED = ['id', 'name', 'version', 'author', 'license', 'anvil', 'description', 'tags', 'checks'];
const CHECK_KEYS = ['id', 'kind', 'severity', 'title', 'match', 'why', 'fix', 'required'];
const CHECK_REQUIRED = ['id', 'kind', 'severity', 'title', 'match', 'why', 'fix'];
const MATCH_KEYS = ['path', 'selector', 'regex', 'status', 'method'];
const HUMAN_KEYS = ['id', 'prompt', 'steps', 'screenshot'];

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const ulen = s => [...s].length;   // JSON Schema counts code points
const isInt = v => typeof v === 'number' && Number.isInteger(v);

function str(errors, at, v, { min = 0, max = Infinity, re } = {}) {
  if (typeof v !== 'string') { errors.push(`${at}: must be a string`); return false; }
  const n = ulen(v);
  if (n < min) errors.push(`${at}: must be at least ${min} character(s)`);
  if (n > max) errors.push(`${at}: must be at most ${max} characters`);
  if (re && !re.test(v)) errors.push(`${at}: does not match ${re}`);
  return true;
}
function keys(errors, at, o, allowed, required) {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) errors.push(`${at}: unknown field "${k}"`);
  for (const k of required) if (!(k in o)) errors.push(`${at}: missing required field "${k}"`);
}

export function validatePack(pack) {
  const errors = [];
  if (!isObj(pack)) return { ok: false, errors: ['pack: must be a JSON object'] };
  keys(errors, 'pack', pack, TOP_KEYS, TOP_REQUIRED);
  if ('$schema' in pack) str(errors, '$schema', pack.$schema);
  if ('id' in pack) str(errors, 'id', pack.id, { re: ID_RE });
  if ('name' in pack) str(errors, 'name', pack.name, { min: 1, max: 80 });
  if ('version' in pack) str(errors, 'version', pack.version, { re: SEMVER_RE });
  if ('author' in pack) str(errors, 'author', pack.author, { min: 1, max: 120 });
  if ('license' in pack) str(errors, 'license', pack.license, { min: 1, max: 60 });
  if ('anvil' in pack) str(errors, 'anvil', pack.anvil, { re: RANGE_RE });
  if ('description' in pack) str(errors, 'description', pack.description, { min: 1, max: 500 });
  if ('tags' in pack) {
    if (!Array.isArray(pack.tags)) errors.push('tags: must be an array');
    else {
      if (pack.tags.length > 12) errors.push('tags: at most 12 items');
      if (new Set(pack.tags.map(t => JSON.stringify(t))).size !== pack.tags.length) errors.push('tags: items must be unique');
      pack.tags.forEach((t, i) => str(errors, `tags[${i}]`, t, { re: TAG_RE }));
    }
  }
  if ('checks' in pack) {
    if (!Array.isArray(pack.checks)) errors.push('checks: must be an array');
    else {
      if (pack.checks.length > 50) errors.push('checks: at most 50 items');
      pack.checks.forEach((c, i) => validateCheck(errors, `checks[${i}]`, c));
    }
  }
  if ('humanChecks' in pack) {
    if (!Array.isArray(pack.humanChecks)) errors.push('humanChecks: must be an array');
    else {
      if (pack.humanChecks.length > 30) errors.push('humanChecks: at most 30 items');
      pack.humanChecks.forEach((h, i) => {
        const at = `humanChecks[${i}]`;
        if (!isObj(h)) { errors.push(`${at}: must be an object`); return; }
        keys(errors, at, h, HUMAN_KEYS, ['id', 'prompt', 'steps']);
        if ('id' in h) str(errors, `${at}.id`, h.id, { re: LOCAL_ID_RE });
        if ('prompt' in h) str(errors, `${at}.prompt`, h.prompt, { min: 1, max: 500 });
        if ('steps' in h) {
          if (!Array.isArray(h.steps)) errors.push(`${at}.steps: must be an array`);
          else {
            if (h.steps.length < 1) errors.push(`${at}.steps: at least 1 item`);
            if (h.steps.length > 20) errors.push(`${at}.steps: at most 20 items`);
            h.steps.forEach((s, j) => str(errors, `${at}.steps[${j}]`, s, { min: 1, max: 500 }));
          }
        }
        if ('screenshot' in h && typeof h.screenshot !== 'boolean') errors.push(`${at}.screenshot: must be a boolean`);
      });
    }
  }
  return { ok: errors.length === 0, errors };
}

function validateCheck(errors, at, c) {
  if (!isObj(c)) { errors.push(`${at}: must be an object`); return; }
  keys(errors, at, c, CHECK_KEYS, CHECK_REQUIRED);
  // required: true = report a missing page/feature as a finding. Default (false): a page, dom or axe check whose
  // page is not there (404/410) is skipped and listed under notChecked as "feature not detected".
  if ('required' in c && typeof c.required !== 'boolean') errors.push(`${at}.required: must be true or false`);
  if ('id' in c) str(errors, `${at}.id`, c.id, { re: LOCAL_ID_RE });
  if ('kind' in c && !KINDS.includes(c.kind)) errors.push(`${at}.kind: must be one of ${KINDS.join(', ')}`);
  if ('severity' in c && !SEVERITIES.includes(c.severity)) errors.push(`${at}.severity: must be one of ${SEVERITIES.join(', ')}`);
  if ('title' in c) str(errors, `${at}.title`, c.title, { min: 1, max: 200 });
  if ('why' in c) str(errors, `${at}.why`, c.why, { min: 1, max: 2000 });
  if ('fix' in c) str(errors, `${at}.fix`, c.fix, { min: 1, max: 2000 });
  if (!('match' in c)) return;
  const m = c.match, ma = `${at}.match`;
  if (!isObj(m)) { errors.push(`${ma}: must be an object`); return; }
  keys(errors, ma, m, MATCH_KEYS, []);
  if (Object.keys(m).length < 1) errors.push(`${ma}: must have at least one field`);
  if ('path' in m) str(errors, `${ma}.path`, m.path, { re: PATH_RE });
  if ('selector' in m) str(errors, `${ma}.selector`, m.selector, { min: 1, max: 500 });
  if ('regex' in m) str(errors, `${ma}.regex`, m.regex, { min: 1, max: 500 });
  if ('status' in m) {
    const okCode = v => isInt(v) && v >= 100 && v <= 599;
    const s = m.status;
    if (Array.isArray(s)) {
      if (s.length < 1 || s.length > 10 || !s.every(okCode)) errors.push(`${ma}.status: must be 1-10 HTTP status codes (100-599)`);
    } else if (!okCode(s)) errors.push(`${ma}.status: must be an HTTP status code (100-599) or an array of them`);
  }
  if ('method' in m && !['GET', 'HEAD'].includes(m.method)) errors.push(`${ma}.method: must be GET or HEAD (probes never change state)`);
  // kind-conditional rules (schema allOf)
  if (['http', 'rules-probe', 'page'].includes(c.kind) && !('path' in m)) errors.push(`${ma}: kind "${c.kind}" requires "path"`);
  if (c.kind === 'dom' && !('selector' in m)) errors.push(`${ma}: kind "dom" requires "selector"`);
  if (c.kind === 'secret-pattern' && !('regex' in m)) errors.push(`${ma}: kind "secret-pattern" requires "regex"`);
  if (!['http', 'rules-probe'].includes(c.kind) && 'method' in m) errors.push(`${ma}: "method" is only allowed for kind http / rules-probe`);
}

// ---- policy lint (on top of the schema) ----------------------------------------------------------

export function lintPack(pack) {
  const errors = [];
  if (!isObj(pack)) return { ok: false, errors: ['pack: must be a JSON object'] };
  const seen = new Set();
  for (const [i, c] of (Array.isArray(pack.checks) ? pack.checks : []).entries()) {
    if (!isObj(c)) continue;
    if (seen.has(c.id)) errors.push(`checks[${i}].id: duplicate id "${c.id}"`);
    seen.add(c.id);
    const m = isObj(c.match) ? c.match : {};
    if (typeof m.path === 'string') {
      // The schema allows "//host" and "/\host", which browsers and URL() treat as another host.
      if (m.path.startsWith('//') || m.path.includes('\\')) errors.push(`checks[${i}].match.path: must stay on the target site (no "//" prefix, no backslashes)`);
      if (/[\u0000-\u001f\u007f]/.test(m.path)) errors.push(`checks[${i}].match.path: control characters are not allowed`);
    }
    if (typeof m.regex === 'string') for (const e of lintRegex(m.regex)) errors.push(`checks[${i}].match.regex: ${e}`);
  }
  const hseen = new Set();
  for (const [i, h] of (Array.isArray(pack.humanChecks) ? pack.humanChecks : []).entries()) {
    if (!isObj(h)) continue;
    if (hseen.has(h.id)) errors.push(`humanChecks[${i}].id: duplicate id "${h.id}"`);
    hseen.add(h.id);
  }
  if (Array.isArray(pack.checks) && pack.checks.length + (Array.isArray(pack.humanChecks) ? pack.humanChecks.length : 0) === 0)
    errors.push('pack: needs at least one check or human check');
  // Honest claims: pack text flows into reports, and Anvil reports never call anything "secure".
  const texts = [pack.name, pack.description,
    ...(Array.isArray(pack.checks) ? pack.checks.flatMap(c => isObj(c) ? [c.title, c.why, c.fix] : []) : []),
    ...(Array.isArray(pack.humanChecks) ? pack.humanChecks.flatMap(h => isObj(h) ? [h.prompt, ...(Array.isArray(h.steps) ? h.steps : [])] : []) : [])];
  if (texts.some(t => typeof t === 'string' && /\b(secure|unhackable|bulletproof|guaranteed)\b/i.test(t)))
    errors.push('pack: text must not claim "secure", "unhackable", "bulletproof" or "guaranteed" (Anvil only reports what it checked)');
  return { ok: errors.length === 0, errors };
}

export function checkPack(pack) {
  const v = validatePack(pack);
  const l = v.ok ? lintPack(pack) : { errors: [] };   // lint assumes a schema-valid shape
  const errors = [...v.errors, ...l.errors];
  return { ok: errors.length === 0, errors };
}

// ---- regex guard ---------------------------------------------------------------------------------

// Packs write JS regex source. The only flag syntax is an optional leading "(?i)".
export function compileRegex(src) {
  let source = src, flags = '';
  if (source.startsWith('(?i)')) { source = source.slice(4); flags = 'i'; }
  return { source, flags };
}

function parseQuant(s, i) {
  const c = s[i];
  if (c === '*' || c === '+') return { len: 1, min: c === '+' ? 1 : 0, max: Infinity };
  if (c === '?') return { len: 1, min: 0, max: 1 };
  if (c === '{') {
    const m = /^\{(\d+)(,(\d*))?\}/.exec(s.slice(i, i + 24));
    if (m) return { len: m[0].length, min: +m[1], max: m[2] ? (m[3] === '' ? Infinity : +m[3]) : +m[1] };
  }
  return null;
}

// Static lint: rejects the shapes behind almost all catastrophic backtracking.
//   - nested repetition: (a+)+  (a{1,8})*  ((ab)+)+
//   - repeated alternation: (a|ab)+   (use a character class instead)
//   - backreferences, huge bounds, too many unbounded quantifiers, overlong patterns
//   - patterns that match the empty string (they would flag every file)
// Then an adversarial run under a timeout catches what the static pass misses.
export function lintRegex(src) {
  const errs = [];
  if (typeof src !== 'string' || src.length === 0) return ['must be a non-empty string'];
  if (src.length > REGEX_MAX_LEN) errs.push(`longer than ${REGEX_MAX_LEN} characters`);
  const { source: s, flags } = compileRegex(src);
  let re;
  try { re = new RegExp(s, flags); } catch (e) { return [...errs, `does not compile: ${e.message}`]; }

  const stack = [{ rep: false, alt: false }];
  let unbounded = 0, i = 0;
  const add = m => { if (!errs.includes(m)) errs.push(m); };
  while (i < s.length) {
    const c = s[i];
    let group = null;
    if (c === '\\') {
      const n = s[i + 1] || '';
      if (/[1-9]/.test(n) || (n === 'k' && s[i + 2] === '<')) add('backreferences are not allowed');
      i += 2;
    } else if (c === '[') {
      i++;
      if (s[i] === '^') i++;
      if (s[i] === ']') i++;
      while (i < s.length && s[i] !== ']') i += s[i] === '\\' ? 2 : 1;
      i++;
    } else if (c === '(') {
      const pre = /^\((\?(:|=|!|<=|<!|<[A-Za-z_$][\w$]*>))?/.exec(s.slice(i))[0];
      stack.push({ rep: false, alt: false });
      i += pre.length;
      continue;
    } else if (c === ')') {
      group = stack.pop();
      if (stack.length === 0) { add('unbalanced parenthesis'); stack.push({ rep: false, alt: false }); }
      i++;
    } else if (c === '|') {
      stack[stack.length - 1].alt = true;
      i++;
      continue;
    } else {
      i++;
    }
    const q = parseQuant(s, i);
    const top = stack[stack.length - 1];
    if (q) {
      i += q.len;
      if (s[i] === '?') i++;
      if (q.min > REGEX_MAX_BOUND || (q.max !== Infinity && q.max > REGEX_MAX_BOUND)) add(`quantifier bound over ${REGEX_MAX_BOUND}`);
      if (q.max === Infinity) unbounded++;
      const repeats = q.max > 1;
      if (group && repeats) {
        if (group.rep) add('nested quantifiers (a repeated group that itself contains a repeat) can backtrack catastrophically');
        if (group.alt) add('repeated alternation like (a|ab)+ can backtrack catastrophically; use a character class');
      }
      if (repeats) top.rep = true;
    }
    if (group) {
      if (group.rep) top.rep = true;
      if (group.alt || group.altInside) top.altInside = true;
      if (q && q.max > 1 && group.altInside) add('repeated alternation like (a|ab)+ can backtrack catastrophically; use a character class');
    }
  }
  if (stack.length !== 1) add('unbalanced parenthesis');
  if (unbounded > REGEX_MAX_UNBOUNDED) add(`more than ${REGEX_MAX_UNBOUNDED} unbounded quantifiers (*, +, {n,})`);
  try { if (re.test('')) add('matches the empty string'); } catch { /* ignore */ }
  if (errs.length) return errs;

  // Adversarial run: long runs of characters the pattern is likely to accept, ending in a mismatch.
  const lit = (s.match(/[A-Za-z0-9_]/g) || []).slice(0, 12);
  const prefix = (/^[A-Za-z0-9_\-:"']+/.exec(s.replace(/^\^/, '')) || [''])[0];
  const seeds = [...new Set(['a', 'A', '0', ' ', '_', '-', '.', '/', ':', '=', '"', "'", 'aB3', 'a ', '\n', ...lit])];
  for (const seed of seeds) {
    const body = seed.repeat(Math.ceil(5000 / seed.length));
    for (const input of [body + '\u0000!', prefix + body + '\u0000!']) {
      const r = safeMatchAll(s, flags, input, { timeoutMs: LINT_TIMEOUT_MS, max: 5 });
      if (r.timedOut) return [`possible catastrophic backtracking (timed out on ${JSON.stringify(seed)} x ${body.length})`];
    }
  }
  return errs;
}

// Runs a regex over text inside a dedicated vm context with a hard timeout.
// Returns { matches: [[index, length], ...], timedOut }.
const vmCtx = vm.createContext(Object.create(null));
const vmScript = new vm.Script(`(function () {
  var re = new RegExp(__src, __flags), out = [], m, n = 0;
  while (n < __max && (m = re.exec(__text)) !== null) {
    out.push(m.index + ':' + m[0].length); n++;
    if (m[0].length === 0) re.lastIndex++;
  }
  return out.join(',');
})()`);
export function safeMatchAll(source, flags, text, { timeoutMs = 500, max = 50 } = {}) {
  vmCtx.__src = String(source);
  vmCtx.__flags = String(flags || '').replace(/[^imsu]/g, '') + 'g';
  vmCtx.__text = String(text);
  vmCtx.__max = max;
  try {
    const out = vmScript.runInContext(vmCtx, { timeout: timeoutMs });
    const matches = out ? out.split(',').map(p => p.split(':').map(Number)) : [];
    return { matches, timedOut: false };
  } catch (e) {
    if (e && e.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') return { matches: [], timedOut: true };
    throw e;
  } finally {
    vmCtx.__text = '';
  }
}

// ---- small semver helpers (shared by the CLI and the index builder) -------------------------------

export function parseSemver(v) {
  const m = SEMVER_RE.exec(String(v));
  return m ? { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].slice(1) : '' } : null;
}
export function compareSemver(a, b) {
  const x = parseSemver(a), y = parseSemver(b);
  if (!x || !y) return String(a).localeCompare(String(b));
  for (const k of ['major', 'minor', 'patch']) if (x[k] !== y[k]) return x[k] - y[k];
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}
// Supports what the schema allows: "^0.2", "~0.2.1", ">=0.2", "0.2.0", "<1".
export function satisfiesRange(version, range) {
  const v = parseSemver(version);
  const m = /^([\^~]|>=|<=|>|<|=)?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(String(range).trim());
  if (!v || !m) return false;
  const op = m[1] || '=', R = [+m[2], m[3] != null ? +m[3] : null, m[4] != null ? +m[4] : null];
  const base = `${R[0]}.${R[1] ?? 0}.${R[2] ?? 0}`;
  const cmp = compareSemver(`${v.major}.${v.minor}.${v.patch}`, base);
  switch (op) {
    case '>=': return cmp >= 0;
    case '>': return cmp > 0;
    case '<=': return cmp <= 0;
    case '<': return cmp < 0;
    case '~': return cmp >= 0 && v.major === R[0] && (R[1] == null || v.minor === R[1]);
    case '^':
      if (cmp < 0) return false;
      if (R[0] !== 0) return v.major === R[0];
      if (R[1] == null) return v.major === 0;
      if (R[1] !== 0 || R[2] == null) return v.major === 0 && v.minor === R[1];
      return v.major === 0 && v.minor === 0 && v.patch === R[2];
    default:
      return v.major === R[0] && (R[1] == null || v.minor === R[1]) && (R[2] == null || v.patch === R[2]);
  }
}
