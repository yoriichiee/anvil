// Anvil - project configuration (anvil.config.json at the root of the repo under test).
// Pure functions only (no browser, no network): loadConfig, findConfig, resolveRoot, fill, loginPath, pagePath, ...
// Every project-specific detail (how to start / sign in to / reset the app, how to build and test it, flag tooling,
// roles, review commands) lives in the config. A section that is missing turns the matching checks into a clear `skip`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const CONFIG_FILE = 'anvil.config.json';

// a path inside a page / API route: no "..", no scheme, no backslash
export const SAFE_PAGE = /^(?!.*\.\.)[A-Za-z0-9_][A-Za-z0-9_.\/-]*$/;
export const SAFE_PAGE_QS = /^(?!.*\.\.)[A-Za-z0-9_][A-Za-z0-9_.\/-]*(\?[A-Za-z0-9=&_%.-]*)?$/;

const DEFAULTS = {
  name: 'the app',
  data_dir: '.qa',
  focus_doc: null,
  github: { repo: null, testing_label: 'needs-testing' },
  server: { port: 8795 },
  app: {
    origin: 'http://127.0.0.1:3000', origin_env: null, start_command: null,
    health_path: '/', api_context_path: null, page_path: '/{page}', page_pattern: null, page_example: null,
    api_base: '/api/', api_match: '/api/', login_path: null, reset_path: null, sample_names: null,
  },
  roles: { list: ['user'], default: null, folder_map: {} },
  build: null,
  tests: null,
  flags: null,
  review: {
    lanes: ['app'], ui_lane: 'ui', default_lane: 'app',
    pass_command: '/pass {lane}', fix_command: '/fix {lane}',
    process_doc: null, owner: null, chat_name: 'team chat', help_text: 'Stuck? Ask in Claude Code.',
    signature: 'Tested with Anvil · Claude for @{tester}', recheck_command: 'anvil-run --pr {pr}',
  },
};

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
function merge(base, over) {
  if (!isObj(base) || !isObj(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = v === undefined ? base[k] : merge(base[k], v);
  return out;
}

export class ConfigError extends Error {}

// validates the shape (the JSON Schema in schemas/ documents the same rules) and fills the defaults
export function normalizeConfig(raw, file = CONFIG_FILE) {
  if (!isObj(raw)) throw new ConfigError(`${file}: must be a JSON object`);
  const c = merge(DEFAULTS, raw);
  const err = m => { throw new ConfigError(`${file}: ${m}`); };
  const str = (v, k) => { if (v != null && typeof v !== 'string') err(`${k} must be a string`); };
  const cmd = (v, k) => { if (v != null && typeof v !== 'string' && !(Array.isArray(v) && v.length && v.every(x => typeof x === 'string'))) err(`${k} must be a string or a non-empty list of strings`); };
  const re = (v, k) => { if (v == null) return; str(v, k); try { new RegExp(v, 'm'); } catch (e) { err(`${k} is not a valid regex: ${e.message}`); } };
  str(c.name, 'name'); str(c.data_dir, 'data_dir'); str(c.focus_doc, 'focus_doc');
  if (c.data_dir.includes('..')) err('data_dir must stay inside the repo');
  if (c.github.repo != null && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(c.github.repo)) err('github.repo must look like owner/name');
  if (!Number.isInteger(c.server.port) || c.server.port < 1 || c.server.port > 65535) err('server.port must be a port number');
  for (const k of ['origin', 'health_path', 'page_path', 'api_base', 'api_match', 'login_path', 'reset_path', 'api_context_path', 'origin_env', 'start_command', 'page_example']) str(c.app[k], 'app.' + k);
  if (!/^https?:\/\/[^/]+$/.test(String(c.app.origin).replace(/\/+$/, ''))) err('app.origin must look like http://127.0.0.1:3000');
  if (!String(c.app.page_path).includes('{page}')) err('app.page_path must contain {page}');
  if (c.app.login_path != null && !c.app.login_path.includes('{role}')) err('app.login_path must contain {role}');
  re(c.app.page_pattern, 'app.page_pattern'); re(c.app.sample_names, 'app.sample_names');
  if (!Array.isArray(c.roles.list) || !c.roles.list.length || !c.roles.list.every(r => /^[a-z][a-z0-9_-]{0,30}$/.test(r))) err('roles.list must be a non-empty list of lower-case role names');
  if (c.roles.list.includes('anon')) err('"anon" is reserved (signed out); do not list it in roles.list');
  if (c.roles.default != null && !c.roles.list.includes(c.roles.default)) err('roles.default must be one of roles.list');
  if (!isObj(c.roles.folder_map) || !Object.values(c.roles.folder_map).every(r => c.roles.list.includes(r))) err('roles.folder_map values must be roles from roles.list');
  if (c.build) { if (!isObj(c.build)) err('build must be an object'); cmd(c.build.command, 'build.command'); if (!c.build.command) err('build.command is required when build is set'); }
  if (c.tests) {
    if (!isObj(c.tests)) err('tests must be an object');
    cmd(c.tests.command, 'tests.command'); if (!c.tests.command) err('tests.command is required when tests is set');
    for (const k of ['summary_regex', 'file_section_end_regex', 'fail_name_regex', 'ok_line_regex', 'fail_line_regex', 'log_line_regex']) re(c.tests[k], 'tests.' + k);
    if (c.tests.filter_args != null && !(Array.isArray(c.tests.filter_args) && c.tests.filter_args.every(x => typeof x === 'string'))) err('tests.filter_args must be a list of strings');
  }
  if (c.flags) {
    if (!isObj(c.flags)) err('flags must be an object');
    cmd(c.flags.command, 'flags.command'); if (!c.flags.command) err('flags.command is required when flags is set');
    re(c.flags.list_regex, 'flags.list_regex'); re(c.flags.flag_pattern, 'flags.flag_pattern');
  }
  const rv = c.review;
  if (!Array.isArray(rv.lanes) || !rv.lanes.length || !rv.lanes.every(l => /^[a-z][a-z0-9_-]{0,20}$/.test(l))) err('review.lanes must be a non-empty list of lower-case lane names');
  for (const k of ['pass_command', 'fix_command']) { str(rv[k], 'review.' + k); if (!String(rv[k]).includes('{lane}')) err(`review.${k} must contain {lane}`); }
  if (fill(rv.pass_command, { lane: 'x' }) === fill(rv.fix_command, { lane: 'x' })) err('review.pass_command and review.fix_command must differ');
  if (!String(rv.signature).includes('{tester}')) err('review.signature must contain {tester}');
  c.app.origin = String(c.app.origin).replace(/\/+$/, '');
  return c;
}

export function loadConfig(file) {
  const abs = path.resolve(file);
  let text;
  try { text = fs.readFileSync(abs, 'utf8').replace(/^﻿/, ''); } catch (e) { throw new ConfigError(`cannot read ${abs}: ${e.code || e.message}`); }
  let raw; try { raw = JSON.parse(text); } catch (e) { throw new ConfigError(`${abs} is not valid JSON: ${e.message}`); }
  const c = normalizeConfig(raw, abs);
  Object.defineProperty(c, '_file', { value: abs, enumerable: false });
  return c;
}

// anvil.config.json in <start> or the nearest parent folder
export function findConfig(start = process.cwd()) {
  let d = path.resolve(start);
  for (;;) {
    const f = path.join(d, CONFIG_FILE);
    if (fs.existsSync(f)) return f;
    const p = path.dirname(d);
    if (p === d) return null;
    d = p;
  }
}

// repo root = --root; else the config's folder when it contains <start> or sits inside it (the normal case: the
// config is at the repo root, or a sub-project such as examples/acme-notes); else the nearest folder with .git above
// <start> (a config kept outside the repo); else the config's folder
export function resolveRoot({ root, start = process.cwd(), configFile } = {}) {
  if (root) return path.resolve(root);
  const inside = (a, b) => { const r = path.relative(b, a); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
  if (configFile) {
    const cd = path.dirname(path.resolve(configFile)), s = path.resolve(start);
    if (inside(s, cd) || inside(cd, s)) return cd;
  }
  let d = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
    const p = path.dirname(d);
    if (p === d) break;
    d = p;
  }
  return configFile ? path.dirname(path.resolve(configFile)) : path.resolve(start);
}

// --config <file> | --config=<file> | ANVIL_CONFIG | search upward from cwd
export function configFromArgs(argv = process.argv.slice(2), env = process.env) {
  const v = argValue(argv, 'config');
  const f = typeof v === 'string' ? v : env.ANVIL_CONFIG || findConfig();
  if (!f) throw new ConfigError(`no ${CONFIG_FILE} found in this folder or above it (pass --config <file>)`);
  return loadConfig(f);
}

export function argValue(argv, k) {
  const i = argv.findIndex(a => a === '--' + k || a.startsWith('--' + k + '='));
  if (i < 0) return undefined;
  const a = argv[i];
  return a.includes('=') ? a.slice(a.indexOf('=') + 1) : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true);
}

// env var with the ANVIL_ name first, the older QA_ name second
export const envOf = (k, env = process.env) => env['ANVIL_' + k] ?? env['QA_' + k];

// ---- templates -------------------------------------------------------------------------------------------------
// {name} -> vars.name; {env:NAME} / {env:NAME|default} -> environment; {tmp} -> os.tmpdir(). Unknown names stay.
export function fill(tpl, vars = {}, env = process.env) {
  let s = String(tpl ?? '');
  s = s.replace(/\{([a-z_]+)\}/g, (m, k) => (k === 'tmp' ? os.tmpdir() : vars[k] != null ? String(vars[k]) : m));
  s = s.replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)(?:\|([^}]*))?\}/g, (m, k, d) => env[k] ?? d ?? '');
  return s;
}

// a command (list = spawned directly, string = run through the shell) with its templates filled;
// list items that become empty (e.g. "{filter}" with no filter) are dropped
export function fillCommand(command, vars, env = process.env) {
  if (typeof command === 'string') {
    const q = v => (/[\s"]/.test(String(v)) ? '"' + String(v).replace(/"/g, '\\"') + '"' : String(v));
    const qv = Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, v == null ? v : q(v)]));
    return { shell: true, cmd: fill(command, qv, env).replace(/\s+/g, ' ').trim(), args: [] };
  }
  const out = command.map(a => fill(a, vars, env)).filter(a => a !== '');
  return { shell: false, cmd: out[0], args: out.slice(1) };
}

const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// sign-in path for a role; without a page, a query parameter holding {page} is dropped (?next={page})
export function loginPath(cfg, role, page) {
  const t = cfg.app.login_path;
  if (!t) return null;
  let s = t;
  if (!page) s = s.replace(/([?&])[^?&=#]*=\{page\}(&?)/, (m, sep, amp) => (amp ? sep : '')).replace(/\{page\}/g, '');
  return fill(s, { role: encodeURIComponent(role), page: page ? encodeURIComponent(page) : '' });
}
export const pagePath = (cfg, page) => fill(cfg.app.page_path, { page: String(page || '').replace(/^\/+/, '') });
export const pagePrefix = cfg => cfg.app.page_path.split('{page}')[0];
export const apiContextPath = cfg => cfg.app.api_context_path || cfg.app.health_path || '/';
export const origin = (cfg, env = process.env) => String((cfg.app.origin_env && env[cfg.app.origin_env]) || cfg.app.origin).replace(/\/+$/, '');
export const pageRegex = cfg => (cfg.app.page_pattern ? new RegExp(cfg.app.page_pattern) : SAFE_PAGE);
export const sampleRegex = cfg => (cfg.app.sample_names ? new RegExp(cfg.app.sample_names) : null);
export const startHint = cfg => cfg.app.start_command || `start ${cfg.name} (see app.start_command in ${CONFIG_FILE})`;

// default role of a page = folder_map[first folder], else the folder itself when it is a role, else roles.default
export function roleForPage(cfg, page) {
  const top = String(page).split('/')[0];
  return cfg.roles.folder_map[top] || (cfg.roles.list.includes(top) ? top : cfg.roles.default || cfg.roles.list[0]);
}

// review command lines
export const passLine = (cfg, lane) => fill(cfg.review.pass_command, { lane });
export const fixLine = (cfg, lane) => fill(cfg.review.fix_command, { lane });
export const signature = (cfg, tester) => fill(cfg.review.signature, { tester });
export function commandRegex(cfg, lane) {
  return new RegExp('^(?:' + esc(passLine(cfg, lane)) + '|' + esc(fixLine(cfg, lane)) + ')(?:\\s|$)');
}
export const isFixBody = (cfg, lane, body) => String(body || '').trimStart().startsWith(fixLine(cfg, lane));
// lane that issues of an auto check go to: phone/laptop areas -> the UI lane, everything else -> the default lane
export const laneForArea = (cfg, area) => (area === 'phone' || area === 'laptop' ? cfg.review.ui_lane : cfg.review.default_lane);

// owner/name: config github.repo, else the git remote "origin" when it points at GitHub
export function repoSlug(cfg, root) {
  if (cfg.github.repo) return cfg.github.repo;
  try {
    const r = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8', windowsHide: true });
    const m = /github\.com[:/]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\s*$/.exec(r.stdout || '');
    return m ? m[1] : null;
  } catch { return null; }
}

export const dataDir = (cfg, root, pr) => path.join(root, cfg.data_dir, 'pr-' + String(pr).replace(/[^0-9]/g, ''));

// what the dashboard needs to know about the project (no secrets, no paths outside the repo)
export function uiConfig(cfg, { repo = cfg.github.repo, pr = 0 } = {}) {
  const text = (command, vars) => { if (!command) return null; const c = fillCommand(command, vars); return [c.cmd, ...c.args].join(' '); };
  const vars = { root: '.', pr, build: `${cfg.data_dir}/pr-${pr}/build`, qa: `${cfg.data_dir}/pr-${pr}`, filter: '' };
  return {
    commands: {
      rerun: fill(cfg.review.recheck_command, { pr }),
      tests: cfg.tests ? text(cfg.tests.command, vars) : null,
      build: cfg.build ? text(cfg.build.command, vars) : null,
      ci: repo ? `gh pr checks ${pr} -R ${repo}` : null,
    },
    appName: cfg.name, roles: [...cfg.roles.list], pagePath: cfg.app.page_path, pagePrefix: pagePrefix(cfg),
    pageExample: cfg.app.page_example || null, loginPath: cfg.app.login_path || null, apiBase: cfg.app.api_base,
    apiMatch: cfg.app.api_match, canReset: !!cfg.app.reset_path, startCommand: cfg.app.start_command || null,
    review: { lanes: [...cfg.review.lanes], pass: cfg.review.pass_command, fix: cfg.review.fix_command },
    chatName: cfg.review.chat_name, helpText: cfg.review.help_text,
  };
}
