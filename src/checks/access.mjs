// Anvil - role access. Runs only when roles (with GET sign-in links) are configured.
//  1. Rules you wrote (scan config `access`: { as, path, expect: [403], name? }): sent as GET from a page signed in as
//     that role. Got a 2xx where a refusal was expected -> proven finding.
//  2. Inferred: API GETs that pages of a more trusted role made are replayed as each less trusted role (roles are
//     listed most trusted first; signed out is last). Signed out getting data -> finding (likely); another role getting
//     data -> a human check ("is this intended?"), because Anvil cannot know your rules.
// Only GET is ever sent; rules with other methods become human checks.
import { skip } from './skip.mjs';
import { roleSessions } from './crawl.mjs';

const ok = s => s >= 200 && s < 300;
const label = r => (r === 'anon' ? 'a signed-out visitor' : 'a ' + r);

export const roleAccess = {
  id: 'role-access', name: 'Role access (who can read what)', needs: 'browser',
  async run(ctx) {
    const cfg = ctx.config || {};
    const roles = (cfg.roles || []).filter(r => r.login);
    if (!roles.length) throw skip('No roles with sign-in links are configured (scan config "roles"), so access rules between roles were not tested.');
    if (!ctx.origin) throw skip('No running URL to test against.');
    const crawl = await ctx.crawl().catch(() => null);
    const findings = [], humanChecks = [], notChecked = [];
    const s = await roleSessions({ origin: ctx.origin, loginFor: name => (roles.find(r => r.name === name) || {}).login });
    try {
      const rules = cfg.access || [];
      for (const a of rules) {
        const method = String(a.method || 'GET').toUpperCase();
        const expect = [].concat(a.expect || [401, 403]).map(Number);
        if (method !== 'GET' && method !== 'HEAD') {
          humanChecks.push({ id: 'h-access-' + String(a.id || a.path).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60), prompt: `Does the app refuse ${method} ${a.path} for ${label(a.as)}?`,
            steps: [`Sign in as ${a.as}`, `Try the action that sends ${method} ${a.path}`, `It should be refused (${expect.join(' or ')})`] });
          continue;
        }
        let r;
        try { r = await s.get(a.as, a.path, method); } catch (e) { notChecked.push({ what: `${a.as} ${method} ${a.path}`, why: 'Could not send it: ' + String(e.message).slice(0, 200) }); continue; }
        ctx.log(`access ${a.as} GET ${a.path} -> ${r.status} (expected ${expect.join('/')})`);
        if (expect.includes(r.status)) continue;
        const seg = String(a.path).split('?')[0].split('/').filter(Boolean).pop() || '';
        const at = seg ? (ctx.locate(`'${seg}'`, /(server|api|routes?|handlers?|functions?)[^/]*\.(m?[jt]s|py|rb|php|go)$|\/(api|server|routes)\/.*\.(m?[jt]s|py|rb|php|go)$/) || ctx.locate(`"${seg}"`, /\.(m?[jt]s|py|rb|php|go)$/)) : null;
        const leaked = ok(r.status);
        findings.push({ id: 'f-access-' + String(a.id || (a.as + '-' + a.path)).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60),
          severity: leaked ? (a.as === 'anon' ? 'critical' : 'high') : 'low',
          title: leaked ? `${label(a.as)[0].toUpperCase() + label(a.as).slice(1)} can read ${a.path} (${a.name || 'should be refused'})` : `${a.as} GET ${a.path}: got ${r.status}, expected ${expect.join(' or ')}`,
          evidence: { ...(at || {}), request: `GET ${a.path} (${a.as === 'anon' ? 'signed out' : 'signed in as ' + a.as})`, response: `${r.status}${r.code ? ' ' + r.code : ''}, ${r.bytes} bytes (expected ${expect.join(' or ')})` },
          why: leaked ? `Your rule says ${label(a.as)} must not read this, but the server answered with data. Hiding a page in the menu is not protection; anyone can send this request.` : 'The server answered differently than your rule expects. It may be fine, but the rule and the app disagree.',
          fix: leaked ? `In the handler for ${a.path}, check the signed-in role on the server and answer ${expect[0]} for ${a.as}. Add a test that ${label(a.as)} gets ${expect[0]}.` : 'Decide which is right and update the app or the rule.',
          confidence: 'proven' });
      }
      // inferred replays
      if (crawl) {
        const order = [...roles.map(r => r.name), 'anon'];
        const replayed = new Set(rules.map(a => a.as + ' ' + a.path));
        let budget = 40;
        for (let i = 1; i < order.length; i++) {
          const who = order[i];
          const own = crawl.apiByRole[who] || new Set();
          const theirs = new Set(); for (let j = 0; j < i; j++) for (const p of crawl.apiByRole[order[j]] || []) theirs.add(p);
          for (const p of theirs) {
            if (own.has(p) || replayed.has(who + ' ' + p) || budget-- <= 0) continue;
            replayed.add(who + ' ' + p);
            let r; try { r = await s.get(who, p); } catch { continue; }
            if (!ok(r.status) || !r.json || r.bytes < 3) continue;
            if (who === 'anon') findings.push({ id: 'f-access-anon-' + p.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60), severity: 'medium',
              title: `A signed-out visitor gets data from ${p}`, evidence: { request: `GET ${p} (signed out)`, response: `${r.status}, ${r.bytes} bytes of JSON (values not shown)` },
              why: 'Pages for signed-in users load this, and the server also answers people who are not signed in. If it is not meant to be public, anyone on the internet can read it.',
              fix: `Require a session for ${p} on the server (answer 401 when signed out), unless the data is meant to be public.`, confidence: 'likely' });
            else humanChecks.push({ id: ('h-access-' + who + '-' + p.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')).slice(0, 90),
              prompt: `Should ${label(who)} be able to read ${p}? Anvil got ${r.status} with ${r.bytes} bytes; only pages of more trusted roles use it.`.slice(0, 500),
              steps: [`Sign in as ${who}`, `Open ${p} in the address bar (a GET request)`, 'If you see data that this role should not see, answer Broken'] });
          }
        }
      }
    } finally { await s.close(); }
    if (!(cfg.access || []).length) notChecked.push({ what: 'Explicit access rules', why: 'No "access" rules are configured, so Anvil only compared what each role\'s own pages use; it cannot know which data each role may read.' });
    return { findings, humanChecks, notChecked };
  },
};
