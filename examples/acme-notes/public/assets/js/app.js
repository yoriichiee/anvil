// Acme Notes - shared page code: API helper (with the CSRF header), top bar, small formatting helpers.
// Everything rendered from data goes through esc(). No inline styles or scripts (strict CSP).

export const $ = (sel, root = document) => root.querySelector(sel);
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let csrf = null;

export async function api(route, { method = 'GET', body } = {}) {
  const headers = { Accept: 'application/json' };
  if (method !== 'GET') { headers['Content-Type'] = 'application/json'; headers['X-CSRF-Token'] = csrf || ''; }
  const r = await fetch('/api/' + route, { method, headers, credentials: 'same-origin', cache: 'no-store', body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null;
  try { data = await r.json(); } catch { /* empty body */ }
  if (r.status === 401) { location.assign('/dev/'); throw new Error('Signed out'); }
  if (!r.ok) {
    const e = new Error((data && (data.message || data.error)) || 'Request failed (' + r.status + ')');
    e.status = r.status; e.code = data && data.error;
    throw e;
  }
  return data;
}

const NAV = {
  admin: [['admin/dashboard.html', 'Dashboard'], ['admin/team.html', 'Team'], ['admin/settings.html', 'Settings']],
  member: [['member/notes.html', 'Notes'], ['member/note.html', 'New note']],
  guest: [['guest/shared.html', 'Shared with me']],
};

export const initials = name => String(name).split(/\s+/).map(p => p[0] || '').join('').slice(0, 2).toUpperCase();
export const avatar = (id, name, cls = '') => `<span class="avatar ${esc(id)} ${cls}" aria-hidden="true">${esc(initials(name))}</span>`;

// GET /api/me, remember the CSRF token, draw the top bar. -> { me, flags }
export async function boot() {
  const [me, flags] = await Promise.all([api('me'), api('flags')]);
  csrf = me.csrf;
  let here = location.pathname.replace(/^\/app\//, '');
  if (here === 'member/note.html' && new URLSearchParams(location.search).has('id')) here = 'member/notes.html';   // editing = still "Notes"
  const links = (NAV[me.user.role] || []).map(([href, label]) =>
    `<a href="/app/${href}"${href === here ? ' aria-current="page"' : ''}>${esc(label)}</a>`).join('');
  $('#topbar').innerHTML = `<div class="topbar-inner">
    <a class="brand" href="/app/${esc(me.home)}"><span class="brand-mark" aria-hidden="true"></span><span>Acme Notes <small>${esc(me.workspace)}</small></span></a>
    <nav class="nav" aria-label="Main">${links}</nav>
    <div class="user">
      <div class="user-name">${esc(me.user.name)}<span>${esc(me.user.role)}</span></div>
      ${avatar(me.user.id, me.user.name)}
      <a class="signout" href="/dev/logout">Sign out</a>
    </div></div>`;
  return { me, flags };
}

export function fail(where, e) {
  // shown on the page, not in the console: a failed load is a visible state, not a crash
  where.innerHTML = `<div class="error-box" role="alert">Could not load this page: ${esc(e && e.message || e)}</div>`;
}

let toastTimer;
export function toast(text) {
  let el = $('#toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; el.className = 'toast'; el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite'); document.body.append(el); }
  el.textContent = text;
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

const DATE = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const TIME = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
export const fmtDate = iso => DATE.format(new Date(iso));
export const fmtTime = iso => TIME.format(new Date(iso));
export const tags = list => (list || []).map(t => `<span class="tag">${esc(t)}</span>`).join('');
