// Anvil - the browser pass shared by page-load, overflow, axe, role-access and the bundle secret scan. One crawl per
// scan: for each role (signed out first, then each configured role) it signs in with the role's GET login link, follows
// same-origin links (never logout / delete / reset style links), and on every page records: HTTP status, console
// errors, uncaught exceptions, CSP blocks, failed requests, width at 390 px (phone) and 1366 px (laptop), axe results,
// a screenshot per device, the API GETs the page made, and the JS it loaded (for the secret scan). Read-only: the
// browser only navigates (GET); nothing is clicked or submitted.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';
import { launch as launchSystem, measureWidth } from '../lib.mjs';

export const VIEWPORTS = {
  phone: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  laptop: { width: 1366, height: 768, deviceScaleFactor: 1 },
};
export const AXE_RULES = ['image-alt', 'input-image-alt', 'button-name', 'link-name', 'label', 'select-name', 'html-has-lang', 'document-title', 'frame-title', 'aria-valid-attr'];
const DANGEROUS = /log-?out|sign-?out|sign-?off|delete|remove|destroy|reset|unsubscribe|revoke|cancel|deactivate|purge|wipe|\/login|sign-?in|\/auth\//i;
const NOT_PAGE = /\.(png|jpe?g|gif|svg|webp|ico|pdf|zip|gz|tgz|mp4|mp3|wav|woff2?|ttf|css|js|mjs|json|xml|txt|csv)$/i;
const req = createRequire(import.meta.url);

export async function launchBrowser(log = () => {}) {
  try { return await launchSystem(); }
  catch (e1) {
    for (const channel of ['chrome', 'msedge']) { try { return await chromium.launch({ channel, headless: true }); } catch {} }
    try { return await chromium.launch({ headless: true }); }   // after `npx playwright install chromium`
    catch { log('no browser: ' + e1.message); throw new Error('No Chrome or Edge found. Install one, set ANVIL_CHROME to its path, or run: npx playwright install chromium'); }
  }
}

const shotFile = (p, role, device) => (p.replace(/^\/+/, '').replace(/\.html?$/, '').replace(/[^a-z0-9-]+/gi, '-').replace(/^-+|-+$/g, '') || 'home') + '-' + role + '-' + device + '.png';

// opts: { origin, startUrl, roles: [{ name, login?, start? }], maxPages, shotsDir, exclude: [regex strings], log }
export async function crawl(opts) {
  const { origin, shotsDir, log = () => {} } = opts;
  const maxPages = opts.maxPages || 8, maxTotal = opts.maxTotal || 30;
  const extraExclude = (opts.exclude || []).map(s => { try { return new RegExp(s, 'i'); } catch { return null; } }).filter(Boolean);
  const axeSrc = fs.readFileSync(req.resolve('axe-core/axe.min.js'), 'utf8');
  const out = { pages: [], apiByRole: {}, bundles: [], roles: [], errors: [] };
  const bundleSeen = new Set(); let bundleBytes = 0;
  fs.mkdirSync(shotsDir, { recursive: true });
  const browser = await launchBrowser(log);
  let total = 0;
  try {
    for (const role of [{ name: 'anon' }, ...(opts.roles || [])]) {
      const r = { name: role.name, signedIn: role.name === 'anon' ? null : false, error: null, pages: 0 };
      out.roles.push(r);
      const api = out.apiByRole[role.name] = new Set();
      const ctxs = {};
      try {
        for (const d of ['laptop', 'phone']) {
          const v = VIEWPORTS[d];
          ctxs[d] = await browser.newContext({ viewport: { width: v.width, height: v.height }, deviceScaleFactor: v.deviceScaleFactor, isMobile: !!v.isMobile, hasTouch: !!v.hasTouch, ignoreHTTPSErrors: false });
        }
        let start = role.start ? new URL(role.start, origin).href : opts.startUrl;
        if (role.login) {
          for (const d of ['laptop', 'phone']) {
            const p = await ctxs[d].newPage();
            try {
              const resp = await p.goto(new URL(role.login, origin).href, { waitUntil: 'domcontentloaded', timeout: 20000 });
              if (resp && resp.status() >= 400) throw new Error('sign-in link answered ' + resp.status());
              if (d === 'laptop' && !role.start) start = p.url();
            } finally { await p.close().catch(() => {}); }
          }
          r.signedIn = true;
          log('role ' + role.name + ': signed in, starting at ' + new URL(start).pathname);
        }
        const queue = [start], seen = new Set();
        while (queue.length && r.pages < maxPages && total < maxTotal) {
          const url = queue.shift();
          const u = new URL(url);
          if (u.origin !== origin) continue;
          const key = u.pathname;
          if (seen.has(key)) continue;
          seen.add(key);
          const page = { role: role.name, path: u.pathname + u.search, finalPath: null, status: null, devices: {}, axe: null, links: [] };
          for (const device of ['laptop', 'phone']) {
            const dv = page.devices[device] = { shot: null, sw: null, iw: VIEWPORTS[device].width, outer: [], errors: [], uncaught: [], csp: [], failed: [] };
            const p = await ctxs[device].newPage();
            p.on('console', m => { if (m.type() === 'error') { const t = m.text().slice(0, 300); (/Content Security Policy|Refused to (load|execute|apply|connect|frame)/.test(t) ? dv.csp : dv.errors).push(t); } });
            p.on('pageerror', e => dv.uncaught.push(String(e && e.message || e).slice(0, 300)));
            p.on('requestfailed', q => { try { dv.failed.push({ status: 0, method: q.method(), url: q.url().slice(0, 400), type: q.resourceType(), error: (q.failure() || {}).errorText || 'failed' }); } catch {} });
            p.on('response', async res => {
              try {
                const q = res.request(), ru = new URL(res.url());
                if (res.status() >= 400) dv.failed.push({ status: res.status(), method: q.method(), url: res.url().slice(0, 400), type: q.resourceType() });
                if (ru.origin === origin && ['fetch', 'xhr'].includes(q.resourceType()) && q.method() === 'GET' && res.status() < 400) api.add(ru.pathname + ru.search);
                if (device === 'laptop' && q.resourceType() === 'script' && res.status() < 400 && !bundleSeen.has(res.url()) && bundleBytes < 6e6) {
                  bundleSeen.add(res.url());
                  const body = await res.text().catch(() => '');
                  if (body && body.length < 2e6) { bundleBytes += body.length; out.bundles.push({ url: res.url(), path: ru.origin === origin ? ru.pathname : res.url(), sameOrigin: ru.origin === origin, text: body }); }
                }
              } catch {}
            });
            try {
              const resp = await p.goto(url, { waitUntil: 'networkidle', timeout: 25000 }).catch(async e => { if (/Timeout/i.test(e.message)) return null; throw e; });
              await p.waitForTimeout(500);
              if (device === 'laptop') {
                page.status = resp ? resp.status() : null;
                const fu = new URL(p.url()); page.finalPath = fu.origin === origin ? fu.pathname + fu.search : p.url();
                const html = await p.content().catch(() => '');
                if (html && !bundleSeen.has('inline:' + url)) { bundleSeen.add('inline:' + url); out.bundles.push({ url, path: u.pathname + ' (HTML)', sameOrigin: true, text: html.slice(0, 1e6) }); }
                page.links = await p.evaluate(() => [...document.querySelectorAll('a[href]')].map(a => ({ href: a.href, text: (a.textContent || '').trim().slice(0, 60) })).slice(0, 300)).catch(() => []);
                try {
                  await p.evaluate(axeSrc);   // evaluate is not subject to the page's CSP
                  page.axe = await p.evaluate(rules => window.axe.run(document, { runOnly: { type: 'rule', values: rules }, resultTypes: ['violations'] })
                    .then(r => r.violations.map(x => ({ id: x.id, impact: x.impact, help: x.help, n: x.nodes.length, targets: x.nodes.slice(0, 3).map(nd => (nd.target || []).join(' ')), html: (x.nodes[0] && x.nodes[0].html || '').slice(0, 200) }))), AXE_RULES);
                } catch (e) { page.axe = null; page.axeError = String(e.message || e).slice(0, 200); }
              }
              const m = await measureWidth(p, VIEWPORTS[device].width);
              dv.sw = m.sw; dv.outer = m.outer;
              const file = shotFile(page.finalPath && page.finalPath.startsWith('/') ? page.finalPath.split('?')[0] : u.pathname, role.name, device);
              await p.screenshot({ path: path.join(shotsDir, file), fullPage: true, timeout: 15000 }).then(() => { dv.shot = 'shots/' + file; }).catch(() => {});
            } catch (e) {
              dv.loadError = String(e && e.message || e).split('\n')[0].slice(0, 300);
            } finally { await p.close().catch(() => {}); }
          }
          // the same page reached through a redirect: keep one
          if (page.finalPath && page.finalPath !== page.path && out.pages.some(x => x.role === role.name && x.finalPath === page.finalPath)) { seen.add(new URL(page.finalPath, origin).pathname); continue; }
          if (page.finalPath && page.finalPath.startsWith('/')) seen.add(new URL(page.finalPath, origin).pathname);
          out.pages.push(page); r.pages++; total++;
          log(`page ${role.name} ${page.finalPath || page.path}: HTTP ${page.status ?? '-'}`);
          for (const l of page.links) {
            let lu; try { lu = new URL(l.href); } catch { continue; }
            if (lu.origin !== origin || !/^https?:$/.test(lu.protocol)) continue;
            if (DANGEROUS.test(lu.pathname + ' ' + l.text) || NOT_PAGE.test(lu.pathname) || extraExclude.some(re => re.test(lu.pathname))) continue;
            lu.hash = '';
            if (!seen.has(lu.pathname) && !queue.includes(lu.href)) queue.push(lu.href);
          }
        }
      } catch (e) { r.error = String(e && e.message || e).split('\n')[0].slice(0, 300); out.errors.push(role.name + ': ' + r.error); log('role ' + role.name + ': ' + r.error); }
      finally { for (const c of Object.values(ctxs)) await c.close().catch(() => {}); }
    }
  } finally { await browser.close().catch(() => {}); }
  return out;
}

// one browser, one signed-in context per role; get(role, path, method) sends a same-origin GET/HEAD from a page of
// that context so its cookies apply. -> { status, code, bytes, json }
export async function roleSessions({ origin, loginFor }) {
  const browser = await launchBrowser();
  const ctxs = new Map();
  async function ctxFor(role) {
    if (ctxs.has(role)) return ctxs.get(role);
    const p = (async () => {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      const login = role && role !== 'anon' ? loginFor(role) : null;
      if (login) { const r = await page.goto(new URL(login, origin).href, { waitUntil: 'domcontentloaded', timeout: 20000 }); if (r && r.status() >= 400) throw new Error('sign-in as ' + role + ' answered ' + r.status()); }
      else await page.goto(origin + '/', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
      return page;
    })();
    ctxs.set(role, p);
    return p;
  }
  return {
    async get(role, p, method = 'GET') {
      method = String(method).toUpperCase();
      if (method !== 'GET' && method !== 'HEAD') throw new Error('only GET and HEAD are sent');
      const u = new URL(p, origin);
      if (u.origin !== origin) throw new Error('not same-origin: ' + p);
      const page = await ctxFor(role);
      return page.evaluate(async ({ url, method }) => {
        const r = await fetch(url, { method, credentials: 'same-origin', cache: 'no-store', redirect: 'manual', headers: { Accept: 'application/json' } });
        const t = method === 'HEAD' ? '' : await r.text();
        let code = ''; try { const j = JSON.parse(t); code = j && typeof j.error === 'string' ? j.error : ''; } catch {}
        return { status: r.status, code, bytes: t.length, json: /^\s*[[{]/.test(t) };
      }, { url: u.href, method });
    },
    async close() { await browser.close().catch(() => {}); },
  };
}

