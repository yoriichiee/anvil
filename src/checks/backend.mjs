// Anvil - Supabase / Firebase rules probe. Read-only GETs, only against config found in the user's own code, only with
// the public key the app itself ships (never a service_role / secret key). Row values are never stored or printed.
//   Supabase: GET <url>/rest/v1/<table>?select=*&limit=1 with the anon key -> rows returned = table readable by anyone.
//   Firebase: GET <databaseURL>/.json?shallow=true (Realtime Database) and Firestore REST documents/<collection>.
import { jwtRole } from '../redact.mjs';
import { skip } from './skip.mjs';

const T = 8000;
async function get(fetchImpl, url, headers = {}) {
  const r = await fetchImpl(url, { method: 'GET', headers: { Accept: 'application/json', ...headers }, redirect: 'manual', signal: AbortSignal.timeout(T) });
  let body = null; try { body = JSON.parse(await r.text()); } catch {}
  return { status: r.status, body };
}
const publicKey = k => (k.startsWith('sb_publishable_') ? true : (jwtRole(k) || {}).role === 'anon');
const redactUrl = u => u.replace(/([?&]key=)[^&]+/, '$1[public key]');

export const backendProbe = {
  id: 'supabase-firebase', name: 'Supabase / Firebase rules probe', needs: 'source',
  async run(ctx) {
    if (!ctx.source) throw skip('No source folder was scanned, so no Supabase or Firebase config was found to probe.');
    const a = ctx.source.analysis, f = ctx.fetch || globalThis.fetch;
    const sb = a.supabase, fb = a.firebase;
    const hasSb = sb.urls.length > 0, hasFb = fb.projectIds.length > 0 || fb.databaseURLs.length > 0;
    if (!hasSb && !hasFb) throw skip('No Supabase or Firebase config was found in the scanned code, so the read-only rules probe was skipped.');
    if (ctx.opts && ctx.opts.noProbe) throw skip('Probes were turned off (--no-probe).');
    const findings = [], notChecked = [];
    let probed = 0;
    if (hasSb) {
      const key = sb.anonKeys.find(publicKey);
      if (!key) notChecked.push({ what: 'Supabase tables', why: 'Found the project URL but no anon/publishable key in the code, so nothing was probed (Anvil never uses a service_role key).' });
      else if (!sb.tables.length) notChecked.push({ what: 'Supabase tables', why: 'No .from("table") calls were found in the code, so there was nothing to probe.' });
      else {
        const url = sb.urls[0];
        for (const t of sb.tables.slice(0, 20)) {
          let r; try { r = await get(f, `${url}/rest/v1/${encodeURIComponent(t.name)}?select=*&limit=1`, { apikey: key, Authorization: 'Bearer ' + key }); probed++; }
          catch (e) { notChecked.push({ what: 'Supabase table ' + t.name, why: 'The probe failed: ' + String(e.message).slice(0, 160) }); continue; }
          ctx.log(`supabase ${t.name}: ${r.status}`);
          if (r.status === 200 && Array.isArray(r.body) && r.body.length > 0)
            findings.push({ id: 'f-supabase-open-' + t.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), severity: 'high', title: `Anyone can read the "${t.name}" table with your public anon key`,
              evidence: { file: t.file, line: t.line, request: `GET ${url}/rest/v1/${t.name}?select=*&limit=1 (anon key from your code, signed out)`, response: `200 OK, ${r.body.length} row returned (values not shown)` },
              why: 'The anon key is in every visitor\'s browser. With row-level security off (or a policy that allows everyone), anyone can download this table, not just your app.',
              fix: `In Supabase, enable RLS on "${t.name}" (alter table ${t.name} enable row level security;) and add policies that only let the right users read rows, e.g. using (auth.uid() = user_id). Re-run Anvil to confirm the probe gets no rows.`,
              confidence: 'proven' });
          else if (r.status === 200 && Array.isArray(r.body)) notChecked.push({ what: `Supabase table "${t.name}"`, why: 'The anon probe got 0 rows. Either RLS blocks it or the table is empty; Anvil cannot tell which.' });
        }
      }
    }
    if (hasFb) {
      for (const db of fb.databaseURLs.slice(0, 3)) {
        let r; try { r = await get(f, `${db}/.json?shallow=true`); probed++; } catch (e) { notChecked.push({ what: 'Firebase Realtime Database', why: 'The probe failed: ' + String(e.message).slice(0, 160) }); continue; }
        ctx.log(`firebase rtdb: ${r.status}`);
        if (r.status === 200 && r.body !== null && typeof r.body === 'object' && Object.keys(r.body).length)
          findings.push({ id: 'f-firebase-rtdb-open', severity: 'high', title: 'Your Firebase Realtime Database can be read without signing in',
            evidence: { request: `GET ${db}/.json?shallow=true (signed out)`, response: `200 OK, ${Object.keys(r.body).length} top-level keys (values not shown)` },
            why: 'The database rules allow public reads at the root, so anyone can download everything in it.',
            fix: 'In the Firebase console > Realtime Database > Rules, replace ".read": true with rules that check auth (e.g. "auth != null" plus per-user paths).', confidence: 'proven' });
      }
      const pid = fb.projectIds[0], key = fb.apiKeys[0];
      if (pid && fb.collections.length) for (const c of fb.collections.slice(0, 15)) {
        const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(pid)}/databases/(default)/documents/${encodeURIComponent(c.name)}?pageSize=1` + (key ? '&key=' + key : '');
        let r; try { r = await get(f, url); probed++; } catch (e) { notChecked.push({ what: 'Firestore collection ' + c.name, why: 'The probe failed: ' + String(e.message).slice(0, 160) }); continue; }
        ctx.log(`firestore ${c.name}: ${r.status}`);
        if (r.status === 200 && r.body && Array.isArray(r.body.documents) && r.body.documents.length)
          findings.push({ id: 'f-firestore-open-' + c.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), severity: 'high', title: `Anyone can read the Firestore "${c.name}" collection`,
            evidence: { file: c.file, line: c.line, request: 'GET ' + redactUrl(url) + ' (signed out)', response: '200 OK, 1 document returned (values not shown)' },
            why: 'Your security rules let signed-out visitors list this collection, so anyone can download it.',
            fix: `In firestore.rules, restrict match /${c.name}/{id} to signed-in users who own the document (allow read: if request.auth != null && request.auth.uid == resource.data.uid).`, confidence: 'proven' });
      } else if (pid) notChecked.push({ what: 'Firestore collections', why: 'No collection names were found in the code, so nothing was probed.' });
    }
    notChecked.push({ what: 'Database write rules', why: 'Anvil only sends read-only GETs; it never tries to insert, update or delete rows.' });
    if (!probed) return { status: 'skip', findings, notChecked };
    return { findings, notChecked };
  },
};
