// Anvil - shared helpers for run.mjs (writes results), server.mjs and report.mjs. See docs/ARCHITECTURE.md.
// Browser = the installed Chrome/Edge through playwright-core (never downloads one).
// Project details (origin, sign-in, page and API paths, roles) come from anvil.config.json via makeLib(cfg, root).
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { origin as originOf, loginPath, pagePath, apiContextPath, dataDir, envOf } from './config.mjs';

export const DEVICES = {
  phone: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  tablet: { width: 820, height: 1180, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  laptop: { width: 1440, height: 900, deviceScaleFactor: 1 },
};

// shots/<page without extension, / -> -><-role>-<device>.png (the role is in the name so two roles on one page do not clash)
export const shotName = (rel, role, device) => String(rel).replace(/\.html?$/, '').replace(/[^a-z0-9-]+/gi, '-') + '-' + role + '-' + device + '.png';

export async function readJSON(file, fallback = null) {
  try { return JSON.parse((await fsp.readFile(file, 'utf8')).replace(/^\uFEFF/, '')); } catch { return fallback; }   // BOM: Windows PowerShell 5 writes one
}
// atomic: write a temp file next to it, then rename over (retried: Windows refuses while a reader has the file open)
export async function writeJSON(file, obj) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(obj, null, 2) + '\n');
  for (let i = 0; ; i++) {
    try { await fsp.rename(tmp, file); return; }
    catch (e) { if (i >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) { await fsp.rm(tmp, { force: true }); throw e; } await new Promise(r => setTimeout(r, 50)); }
  }
}

export const browserPath = () => [envOf('CHROME'), 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'), 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/usr/bin/microsoft-edge', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'].find(p => p && fs.existsSync(p)) || null;

export async function launch() {
  const exe = browserPath();
  if (!exe) throw new Error('No Chrome or Edge found (set ANVIL_CHROME to its path)');
  return chromium.launch({ executablePath: exe, headless: true });
}

// page width on a phone -> { sw, iw, outer }: sw = the document's scroll width, iw = the emulated screen width.
// Measured against the screen width, not innerWidth: with isMobile Chrome widens the layout viewport to fit wide
// content (innerWidth == scrollWidth) unless the page sets minimum-scale=1, which would hide sideways scrolling.
export function measureWidth(page, screenWidth = DEVICES.phone.width) {
  return page.evaluate(W => {
    const wide = [];
    for (const el of document.body.querySelectorAll('*')) { const r = el.getBoundingClientRect(); if (r.right > W + 1 && r.width > 0 && getComputedStyle(el).position !== 'fixed') wide.push(el); if (wide.length > 200) break; }
    const outer = wide.filter(el => !wide.includes(el.parentElement)).slice(0, 3)
      .map(el => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''));
    return { sw: Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0), iw: W, outer };
  }, screenWidth);
}

// everything that needs the project config
export function makeLib(cfg, root) {
  const ORIGIN = originOf(cfg);
  const ROLES = cfg.roles.list;
  const API_MATCH = cfg.app.api_match || '/api/';
  const appUrl = rel => ORIGIN + pagePath(cfg, rel);
  const roleLink = (role, rel) => { const p = loginPath(cfg, role, rel); return p ? ORIGIN + p : appUrl(rel || ''); };

  // the page list of the build: <app dir>/<manifest> -> manifest[manifest_key] (null when not configured / not readable)
  const manifestPages = () => {
    const b = cfg.build;
    if (!b || !b.manifest) return null;
    const dir = (b.app_dir_env && process.env[b.app_dir_env]) || (b.app_dir ? path.resolve(root, b.app_dir) : null);
    if (!dir) return null;
    try { const j = JSON.parse(fs.readFileSync(path.join(dir, b.manifest), 'utf8').replace(/^\uFEFF/, '')); return b.manifest_key ? j[b.manifest_key] || {} : j; }
    catch { return null; }
  };

  // signed-in context for a role from roles.list; 'anon' = signed out. device = key of DEVICES
  async function roleContext(browser, role, device = 'laptop') {
    const d = DEVICES[device] || DEVICES.laptop;
    const ctx = await browser.newContext({ viewport: { width: d.width, height: d.height }, deviceScaleFactor: d.deviceScaleFactor, isMobile: !!d.isMobile, hasTouch: !!d.hasTouch });
    if (role !== 'anon') {
      if (!ROLES.includes(role)) { await ctx.close(); throw new Error('unknown role ' + role); }
      const lp = loginPath(cfg, role, '');
      if (lp) {
        const p = await ctx.newPage();
        const r = await p.goto(ORIGIN + lp, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await p.close();
        if (r && r.status() >= 400) { await ctx.close(); throw new Error('sign-in as ' + role + ' answered ' + r.status()); }
      }
    }
    return ctx;
  }

  // collects console errors, uncaught exceptions, CSP blocks and failed API calls of one page
  function watch(page) {
    const out = { errors: [], uncaught: [], csp: [], api: [] };
    page.on('console', m => { if (m.type() === 'error') (/Content Security Policy|Refused to/.test(m.text()) ? out.csp : out.errors).push(m.text().slice(0, 300)); });
    page.on('pageerror', e => out.uncaught.push(String(e && e.message || e).slice(0, 300)));
    page.on('response', r => { const u = r.url(); if (u.includes(API_MATCH) && r.status() >= 400) out.api.push(r.status() + ' ' + r.request().method() + ' ' + u.replace(ORIGIN, '')); });
    return out;
  }

  // open an app page and let it settle; -> { response, final } (final = path after redirects)
  async function openPage(page, rel) {
    const response = await page.goto(appUrl(rel), { waitUntil: 'networkidle', timeout: 25000 });
    await page.waitForTimeout(600);
    return { response, final: page.url().replace(ORIGIN, '') };
  }

  // one full-page png of <rel> as <role> on <device>; out = absolute file path. Pass context to reuse a signed-in one.
  async function screenshot({ browser, role, page, device = 'laptop', out, context }) {
    let ctx = context, own = false, p;
    try {
      if (!ctx) { ctx = await roleContext(browser, role, device); own = true; }
      p = await ctx.newPage();
      await openPage(p, page);
      await fsp.mkdir(path.dirname(out), { recursive: true });
      await p.screenshot({ path: out, fullPage: true });
      return { file: out, ok: true, error: null };
    } catch (e) {
      return { file: out, ok: false, error: String(e && e.message || e).slice(0, 300) };
    } finally {
      if (p) await p.close().catch(() => {});
      if (own && ctx) await ctx.close().catch(() => {});
    }
  }

  // is the app answering? -> { ok, message }
  async function appUp() {
    try {
      const r = await fetch(ORIGIN + (cfg.app.health_path || '/'), { signal: AbortSignal.timeout(5000), redirect: 'manual' });
      return { ok: r.status < 500, message: 'HTTP ' + r.status };
    } catch (e) { return { ok: false, message: String(e && e.cause && e.cause.code || e.message) }; }
  }

  return { cfg, root, ORIGIN, ROLES, API_MATCH, API_BASE: cfg.app.api_base, CONTEXT_PATH: apiContextPath(cfg),
    QA_DIR: pr => dataDir(cfg, root, pr), appUrl, roleLink, manifestPages, roleContext, watch, openPage, screenshot, appUp, shotName, launch };
}
