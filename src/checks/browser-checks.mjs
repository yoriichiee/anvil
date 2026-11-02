// Anvil - checks that read the shared browser crawl: page load + console errors + failed requests, sideways scroll at
// 390 px and 1366 px, and axe-core basics. Facts from the browser only; each finding carries a screenshot.

const shortUrl = (u, origin) => String(u).replace(origin, '') || '/';
const quoteParts = msg => String(msg).split(/["'`]/).map(s => s.trim()).filter(s => s.length >= 8).sort((a, b) => b.length - a.length);
const roleLabel = r => (r === 'anon' ? 'signed out' : 'as ' + r);
const slug = s => String(s).toLowerCase().replace(/\.html?\b/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'home';

function locateMessage(ctx, msg) {
  for (const part of [msg, ...quoteParts(msg)]) { const at = ctx.locate(part, /\.(m?[jt]sx?|vue|svelte|html?)$/); if (at) return at; }
  return null;
}

export const pageLoad = {
  id: 'page-load', name: 'Page load and console errors', needs: 'browser',
  async run(ctx) {
    const c = await ctx.crawl();
    const findings = [], origin = ctx.origin;
    const errs = new Map(), fails = new Map();
    for (const p of c.pages) {
      const where = (p.finalPath || p.path) + ' (' + roleLabel(p.role) + ')';
      const lap = p.devices.laptop || {}, ph = p.devices.phone || {};
      if (p.status >= 400 || lap.loadError) {
        findings.push({ severity: p.status >= 500 || lap.loadError ? 'high' : 'medium', title: `${p.finalPath || p.path} does not load ${roleLabel(p.role)}` + (p.status ? ` (HTTP ${p.status})` : ''),
          evidence: { shot: lap.shot, request: `GET ${p.path} (${roleLabel(p.role)})`, response: lap.loadError || `HTTP ${p.status}` },
          why: 'A page reached from a link in your app fails to open. People who follow that link see an error page.',
          fix: 'Open the page yourself, read the server log for this request, and fix the route or remove the link.', confidence: 'proven' });
        continue;
      }
      for (const [kind, list] of [['uncaught', [...(lap.uncaught || []), ...(ph.uncaught || [])]], ['console', [...(lap.errors || []), ...(ph.errors || [])]], ['csp', [...(lap.csp || []), ...(ph.csp || [])]]]) {
        for (const m of new Set(list)) {
          if (kind === 'console' && /^Failed to load resource/.test(m)) continue;   // reported as a failed request below
          const k = kind + '|' + m;
          if (!errs.has(k)) errs.set(k, { kind, msg: m, pages: [], shot: lap.shot, first: p.finalPath || p.path });
          const e = errs.get(k); if (!e.pages.includes(where)) e.pages.push(where);
        }
      }
      for (const f of [...(lap.failed || []), ...(ph.failed || [])]) {
        if (f.type === 'document' && f.url.startsWith(origin) && f.status < 500) continue;   // the page itself is judged above
        if (/\/favicon\.ico(\?|$)/.test(f.url) && f.status === 404) continue;                 // browsers ask for it on their own
        const k = f.status + ' ' + f.method + ' ' + shortUrl(f.url, origin).split('?')[0];
        if (!fails.has(k)) fails.set(k, { ...f, pages: [], shot: lap.shot });
        const e = fails.get(k); if (!e.pages.includes(where)) e.pages.push(where);
      }
    }
    for (const e of errs.values()) {
      const at = e.kind === 'csp' ? null : locateMessage(ctx, e.msg);
      const pages = e.pages.slice(0, 4).join(', ') + (e.pages.length > 4 ? ` and ${e.pages.length - 4} more` : '');
      const eid = 'f-' + e.kind + '-' + slug(e.first);
      if (e.kind === 'uncaught') findings.push({ id: eid, severity: 'medium', title: `Uncaught error on ${e.pages.length} page${e.pages.length > 1 ? 's' : ''}: ${e.msg.slice(0, 120)}`,
        evidence: { shot: e.shot, ...(at || {}), response: 'pageerror: ' + e.msg + ' | on ' + pages },
        why: 'An exception nobody caught usually means part of the page stopped working (a button that does nothing, a list that never loads).',
        fix: 'Reproduce it with DevTools open, fix the code that throws, and handle the failure (show a message instead of crashing).', confidence: 'proven' });
      else if (e.kind === 'csp') findings.push({ id: eid, severity: 'low', title: 'Content Security Policy blocked something on ' + pages.slice(0, 120),
        evidence: { shot: e.shot, response: e.msg + ' | on ' + pages }, why: 'The browser refused to load or run something your page asked for, so that part of the page may be missing.',
        fix: 'Either allow the source in your CSP (if you trust it) or stop loading it.', confidence: 'proven' });
      else findings.push({ id: eid, severity: 'low', title: `console.error on ${pages.slice(0, 120)}: ${e.msg.slice(0, 120)}`,
        evidence: { shot: e.shot, ...(at || {}), response: 'console.error: ' + e.msg },
        why: 'Errors in the console either mean something is broken or they hide real errors from you and your error tracker.',
        fix: 'Fix the cause, or stop logging it as an error if it is expected.', confidence: 'proven' });
    }
    for (const [k, f] of fails) {
      const same = f.url.startsWith(origin);
      const sev = f.status >= 500 ? 'medium' : 'low';
      findings.push({ id: 'f-request-' + slug(shortUrl(f.url, origin).split('?')[0]), severity: sev, title: `${f.status ? 'HTTP ' + f.status : 'Failed'}: ${f.method} ${shortUrl(f.url, origin).slice(0, 140)}`,
        evidence: { shot: f.shot, request: `${f.method} ${shortUrl(f.url, origin)} (${f.type})`, response: (f.status ? 'HTTP ' + f.status : f.error) + ' | on ' + f.pages.slice(0, 4).join(', ') },
        why: f.status >= 500 ? 'The server crashed answering a request your page makes, so that part of the page does not work.' : same ? 'Your page asks for something the server refuses or cannot find, so a part of the page may be missing or broken.' : 'A third-party request failed; that feature may not work for your users.',
        fix: f.status >= 500 ? 'Look at the server log for this request and fix the error.' : 'Check the path is right and that this role is meant to call it; remove the request if it is not needed.', confidence: 'proven' });
    }
    return { findings, notChecked: c.errors.length ? [{ what: 'Some roles could not be crawled', why: c.errors.join('; ').slice(0, 900) }] : [] };
  },
};

export const overflow = {
  id: 'overflow', name: 'Sideways scroll at 390px and 1366px', needs: 'browser',
  async run(ctx) {
    const c = await ctx.crawl();
    const groups = new Map();
    for (const p of c.pages) for (const device of ['phone', 'laptop']) {
      const d = p.devices[device];
      if (!d || d.sw == null || d.loadError || !(d.sw > d.iw + 1)) continue;
      const sel = d.outer[0] || 'body';
      const k = device + '|' + sel;
      if (!groups.has(k)) groups.set(k, { device, sel, worst: d, page: p, pages: [] });
      const g = groups.get(k);
      g.pages.push((p.finalPath || p.path) + ' (' + roleLabel(p.role) + ')');
      if (d.sw > g.worst.sw) { g.worst = d; g.page = p; }
    }
    const findings = [];
    for (const g of groups.values()) {
      const cls = (/\.([A-Za-z0-9_-]+)/.exec(g.sel) || [])[1];
      const idm = (/#([A-Za-z0-9_-]+)/.exec(g.sel) || [])[1];
      const at = (cls && ctx.locate('.' + cls, /\.(css|scss|less|sass)$/)) || (idm && ctx.locate('#' + idm, /\.(css|scss|less|sass)$/)) || null;
      const phone = g.device === 'phone';
      const others = g.pages.filter(x => !x.startsWith((g.page.finalPath || g.page.path) + ' '));
      findings.push({ id: 'f-overflow-' + slug(g.page.finalPath || g.page.path) + '-' + g.device, severity: 'medium', title: `${g.page.finalPath || g.page.path} scrolls sideways on a ${phone ? 'phone' : 'laptop'} (${g.worst.sw}px wide at ${g.worst.iw}px)`,
        evidence: { shot: g.worst.shot, selector: g.worst.outer.join(', ') || undefined, ...(at || {}), response: others.length ? 'also on: ' + others.join(', ') : undefined },
        why: `The element ${g.sel} is wider than the ${g.worst.iw}px screen, so the whole page slides left and right. ${phone ? 'On phones this is usually the first thing people notice.' : 'Laptop users see a horizontal scrollbar.'}`,
        fix: (phone && !g.worst.outer.length ? 'If the page has no <meta name="viewport" content="width=device-width, initial-scale=1">, add it. ' : '') + `Let ${g.sel} shrink or wrap (max-width: 100%), or put it in a container with overflow-x: auto${phone ? ', or switch to a stacked layout below 640px' : ''}.`, confidence: 'proven' });
    }
    return findings;
  },
};

export const axe = {
  id: 'axe', name: 'Accessibility (axe-core)', needs: 'browser',
  async run(ctx) {
    const c = await ctx.crawl();
    const groups = new Map(), notChecked = [];
    for (const p of c.pages) {
      if (!p.axe) { if (p.axeError) notChecked.push({ what: 'Accessibility of ' + (p.finalPath || p.path), why: 'axe-core could not run: ' + p.axeError }); continue; }
      for (const v of p.axe) {
        const k = v.id + '|' + (p.finalPath || p.path);
        if (groups.has(k)) continue;
        groups.set(k, { v, p });
      }
    }
    const findings = [];
    for (const { v, p } of groups.values()) {
      const target = v.targets[0] || '';
      const srcm = /src="([^"]{3,200})"/.exec(v.html || '');
      const at = (srcm && ctx.locate(srcm[1], /\.(html?|[jt]sx?|vue|svelte|astro)$/)) || null;
      findings.push({ id: 'f-axe-' + v.id + '-' + slug(p.finalPath || p.path), severity: ['critical', 'serious'].includes(v.impact) && v.id !== 'image-alt' ? 'medium' : 'low',
        title: `${v.help} (${v.id}, ${v.n} on ${p.finalPath || p.path})`.slice(0, 300),
        evidence: { shot: (p.devices.laptop || {}).shot, selector: v.targets.join(', ') || undefined, ...(at || {}), response: (v.html || '').slice(0, 300) || undefined },
        why: 'People using a screen reader or keyboard cannot use this part of the page as intended (axe rule ' + v.id + ').',
        fix: v.id === 'image-alt' ? 'Add alt text that says what the image shows, or alt="" when it is only decoration.' : v.id === 'label' ? 'Give the field a <label for=...> or an aria-label.' : v.id.endsWith('-name') ? 'Give it a visible text or an aria-label that says what it does.' : 'See https://dequeuniversity.com/rules/axe/4.10/' + v.id + ' for ' + target,
        confidence: 'likely' });
    }
    return { findings, notChecked };
  },
};
