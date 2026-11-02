// Anvil - static look at a project folder (never runs it): file list (git-ignored and vendor folders skipped, built
// bundles included), framework + start command, features (auth, payments, uploads, forms), Supabase / Firebase config
// and the tables / collections the code reads. All repo content is treated as untrusted data.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ALWAYS_SKIP = new Set(['node_modules', '.git', '.anvil', '.qa', '.cache', 'coverage', '.turbo', '.parcel-cache', '.venv', 'venv', '__pycache__', 'vendor', 'bower_components', '.idea', '.vscode']);
export const BUNDLE_DIRS = ['dist', 'build', 'out', '.next/static', '.output/public', '.svelte-kit/output/client', '.vercel/output/static', 'public/build'];
const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.vue', '.svelte', '.astro', '.html', '.htm', '.css', '.scss', '.json', '.env', '.yml', '.yaml', '.toml', '.md', '.txt', '.py', '.rb', '.php', '.go', '.java', '.kt', '.cs', '.sh', '.ps1', '.sql', '.xml', '.ini', '.conf', '.properties', '.map', '']);
const MAX_FILE = 2 * 1024 * 1024, MAX_FILES = 6000;
export const posix = p => p.split(path.sep).join('/');

// tiny .gitignore matcher (root + nested files; no negation) - used when git is not available
function globToRe(g) {
  let s = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') { if (g[i + 1] === '*') { s += '.*'; i++; if (g[i + 1] === '/') i++; } else s += '[^/]*'; }
    else if (c === '?') s += '[^/]';
    else s += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return s;
}
function readIgnore(dirAbs, relBase) {
  let txt; try { txt = fs.readFileSync(path.join(dirAbs, '.gitignore'), 'utf8'); } catch { return []; }
  const rules = [];
  for (let line of txt.split(/\r?\n/)) {
    line = line.trim(); if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const dirOnly = line.endsWith('/'); line = line.replace(/\/+$/, '');
    const anchored = line.startsWith('/') || line.includes('/'); line = line.replace(/^\/+/, '');
    const base = relBase ? relBase + '/' : '';
    const re = new RegExp('^' + (anchored ? globToRe(base + line) : (base ? globToRe(base) + '(?:.*/)?' : '(?:.*/)?') + globToRe(line)) + '(?:/.*)?$');
    rules.push({ re, dirOnly });
  }
  return rules;
}

function gitList(root) {
  const r = spawnSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 || !r.stdout) return null;
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8', windowsHide: true });
  if (top.status !== 0) return null;
  return r.stdout.split('\0').filter(Boolean);   // relative to root (git prints paths relative to cwd)
}

// -> { files: [{ rel, abs, size, bundle }], ignoredDirs: [], truncated }
export function listFiles(root) {
  root = path.resolve(root);
  const files = [], seen = new Set(), ignoredDirs = new Set();
  let truncated = false;
  const add = (abs, bundle) => {
    const rel = posix(path.relative(root, abs));
    if (seen.has(rel) || rel.split('/').some(seg => ALWAYS_SKIP.has(seg))) return;
    let st; try { st = fs.statSync(abs); } catch { return; }
    if (!st.isFile() || st.size > MAX_FILE) return;
    if (!TEXT_EXT.has(path.extname(abs).toLowerCase()) && !/^\.env/.test(path.basename(abs))) return;
    if (files.length >= MAX_FILES) { truncated = true; return; }
    seen.add(rel); files.push({ rel, abs, size: st.size, bundle });
  };
  const isBundle = rel => BUNDLE_DIRS.some(b => rel === b || rel.startsWith(b + '/'));
  const viaGit = gitList(root);
  if (viaGit) for (const rel of viaGit) add(path.join(root, rel), isBundle(posix(rel)));
  else {
    const rules = [];
    (function walk(dirAbs, rel) {
      rules.push(...readIgnore(dirAbs, rel));
      let ents; try { ents = fs.readdirSync(dirAbs, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const r = rel ? rel + '/' + e.name : e.name;
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) {
          if (ALWAYS_SKIP.has(e.name)) continue;
          if (rules.some(x => x.re.test(r))) { ignoredDirs.add(r); continue; }
          walk(path.join(dirAbs, e.name), r);
        } else if (!rules.some(x => !x.dirOnly && x.re.test(r))) add(path.join(dirAbs, e.name), isBundle(r));
      }
    })(root, '');
  }
  // built bundles are what browsers get: scanned even when git-ignored
  for (const b of BUNDLE_DIRS) {
    const abs = path.join(root, b);
    if (!fs.existsSync(abs)) continue;
    (function walk(d) { let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of ents) { if (e.isSymbolicLink()) continue; const p = path.join(d, e.name); if (e.isDirectory()) { if (!ALWAYS_SKIP.has(e.name)) walk(p); } else add(p, true); } })(abs);
  }
  return { files, ignoredDirs: [...ignoredDirs], truncated };
}

// is an .env-style file ignored by git? (an .env file that is listed = committed)
export const isEnvFile = rel => /(^|\/)\.env(\.[a-z0-9_-]+)?$/i.test(rel) && !/\.(example|sample|template|dist)$/i.test(rel);

// will this file reach the browser? 'yes' | 'likely' | 'no'
export function browserExposure(rel, framework) {
  if (BUNDLE_DIRS.some(b => rel.startsWith(b + '/'))) return 'yes';
  if (/(^|\/)(public|static|www|assets)\//.test(rel) || /\.html?$/.test(rel)) return 'yes';
  if (/(^|\/)(server|api|functions|supabase\/functions|backend|scripts|migrations|test|tests|__tests__)\//.test(rel) || /server\.[cm]?[jt]s$/.test(rel) || /\.server\.[jt]sx?$/.test(rel)) return 'no';
  if (framework && framework.client && /^(src|app|pages|components|lib)\//.test(rel) && /\.(m?[jt]sx?|vue|svelte|astro)$/.test(rel)) return 'likely';
  return 'no';
}

export function lineOf(text, index) { let n = 1; for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) n++; return n; }

// package.json -> { name, client, kind, script, cmd, port }
export function detectFramework(root) {
  let pkg = null;
  try { pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8').replace(/^﻿/, '')); } catch {}
  if (!pkg) {
    if (fs.existsSync(path.join(root, 'index.html'))) return { kind: 'static', client: true, staticDir: '.' };
    for (const d of ['dist', 'build', 'out', 'public']) if (fs.existsSync(path.join(root, d, 'index.html'))) return { kind: 'static', client: true, staticDir: d };
    return null;
  }
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const scripts = pkg.scripts || {};
  const table = [
    ['next', 'next', 3000], ['nuxt', 'nuxt', 3000], ['@remix-run/dev', 'remix', 5173], ['astro', 'astro', 4321], ['@sveltejs/kit', 'sveltekit', 5173],
    ['react-scripts', 'cra', 3000], ['@angular/core', 'angular', 4200], ['vite', 'vite', 5173], ['parcel', 'parcel', 1234], ['express', 'express', 3000],
  ];
  const hit = table.find(([d]) => deps[d]) || [null, 'node', 3000];
  const script = ['dev', 'start', 'serve', 'preview'].find(s => scripts[s]) || null;
  let port = hit[2];
  const m = script && /(?:--port[ =]|-p\s+|PORT=)(\d{2,5})/.exec(scripts[script]);
  if (m) port = Number(m[1]);
  return { kind: hit[1], name: pkg.name || null, client: hit[1] !== 'express' && hit[1] !== 'node', script, port, hasDeps: Object.keys(deps).length > 0, cmd: script ? ['npm', 'run', script] : null };
}

const FEATURES = {
  auth: /\b(sign[ _-]?in|sign[ _-]?up|log[ _-]?in|logout|password|auth\.|useAuth|getSession|signInWith|passport|next-auth|clerk|supabase\.auth)\b/i,
  payments: /\b(stripe|checkout|paypal|razorpay|lemonsqueezy|paddle|braintree|subscription|billing)\b/i,
  uploads: /type=["']file["']|\bupload|multer|formidable|storage\.from\(|\bFormData\b/i,
  forms: /<form\b|onSubmit|handleSubmit|addEventListener\(\s*["']submit/i,
};

// one pass over the files: features, backend config, referenced tables
export function analyze(root, { files } = {}) {
  root = path.resolve(root);
  files = files || listFiles(root).files;
  const features = { auth: 0, payments: 0, uploads: 0, forms: 0 };
  const supabase = { urls: new Set(), anonKeys: new Set(), tables: new Map() };
  const firebase = { projectIds: new Set(), databaseURLs: new Set(), apiKeys: new Set(), collections: new Map() };
  for (const f of files) {
    if (f.size > 600 * 1024 || /\.(md|map)$/.test(f.rel)) continue;
    let t; try { t = fs.readFileSync(f.abs, 'utf8'); } catch { continue; }
    const code = /\.(m?[jt]sx?|cjs|vue|svelte|astro|html?)$/.test(f.rel);
    if (code) for (const k in FEATURES) if (FEATURES[k].test(t)) features[k]++;
    for (const m of t.matchAll(/https:\/\/([a-z0-9]{20})\.supabase\.co\b/g)) supabase.urls.add('https://' + m[1] + '.supabase.co');
    for (const m of t.matchAll(/\b(?:VITE_|NEXT_PUBLIC_|PUBLIC_|EXPO_PUBLIC_|REACT_APP_)?SUPABASE_(?:ANON_KEY|PUBLISHABLE_KEY|KEY)\s*=\s*["']?(eyJ[0-9A-Za-z_.-]+|sb_publishable_[0-9A-Za-z_-]+)/g)) supabase.anonKeys.add(m[1]);
    for (const m of t.matchAll(/["'](eyJ[0-9A-Za-z_-]{8,}\.eyJ[0-9A-Za-z_-]{8,}\.[0-9A-Za-z_-]{8,}|sb_publishable_[0-9A-Za-z_-]{20,})["']/g)) supabase.anonKeys.add(m[1]);
    if (code) for (const m of t.matchAll(/(\bstorage\s*)?\.from\(\s*["'`]([A-Za-z_][A-Za-z0-9_]{0,62})["'`]\s*\)/g)) {
      if (m[1]) continue;   // storage bucket, not a table
      const line = lineOf(t, m.index);
      if (!supabase.tables.has(m[2])) supabase.tables.set(m[2], { file: f.rel, line });
    }
    for (const m of t.matchAll(/projectId\s*:\s*["']([a-z0-9-]{4,40})["']/g)) firebase.projectIds.add(m[1]);
    for (const m of t.matchAll(/databaseURL\s*:\s*["'](https:\/\/[a-z0-9.-]+(?:firebaseio\.com|firebasedatabase\.app))\/?["']/g)) firebase.databaseURLs.add(m[1]);
    if (/firebase/i.test(t)) for (const m of t.matchAll(/apiKey\s*:\s*["'](AIza[0-9A-Za-z_-]{35})["']/g)) firebase.apiKeys.add(m[1]);
    if (code) for (const m of t.matchAll(/(?:collection\(\s*[A-Za-z_$][\w$]*\s*,\s*|\.collection\(\s*)["'`]([A-Za-z0-9_-]{1,60})["'`]/g)) if (!firebase.collections.has(m[1])) firebase.collections.set(m[1], { file: f.rel, line: lineOf(t, m.index) });
  }
  return {
    features: Object.fromEntries(Object.entries(features).map(([k, v]) => [k, v > 0])),
    supabase: { urls: [...supabase.urls], anonKeys: [...supabase.anonKeys], tables: [...supabase.tables].map(([name, at]) => ({ name, ...at })) },
    firebase: { projectIds: [...firebase.projectIds], databaseURLs: [...firebase.databaseURLs], apiKeys: [...firebase.apiKeys], collections: [...firebase.collections].map(([name, at]) => ({ name, ...at })) },
  };
}

// first "needle" in the CSS / JS sources -> { file, line } (maps browser evidence back to code)
export function locate(files, needle, exts = /\.(css|scss|less|m?[jt]sx?|vue|svelte|html?)$/) {
  if (!needle || needle.length < 3) return null;
  for (const f of files) {
    if (f.bundle || !exts.test(f.rel) || f.size > 600 * 1024) continue;
    let t; try { t = fs.readFileSync(f.abs, 'utf8'); } catch { continue; }
    const i = t.indexOf(needle);
    if (i >= 0) return { file: f.rel, line: lineOf(t, i) };
  }
  return null;
}
