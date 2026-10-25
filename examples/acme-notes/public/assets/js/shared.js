// guest/shared.html - read-only cards of the notes shared with guests
import { $, esc, api, boot, fail, avatar, fmtDate, tags } from './app.js';

const excerpt = s => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > 160 ? t.slice(0, 157).replace(/\s+\S*$/, '') + '…' : t; };

try {
  const { me } = await boot();
  const { notes } = await api('notes');
  $('#hero-text').textContent = `Notes the ${me.workspace} team has shared with guests. You can read them here; only the team can edit them.`;
  $('#content').innerHTML = notes.length ? `<div class="shared-grid">${notes.map(n => `
    <article class="card shared-card">
      <h2>${esc(n.title)}</h2>
      <div class="meta">${avatar(n.owner, n.owner_name, 'sm')}<span>${esc(n.owner_name)} · ${esc(fmtDate(n.updated))}</span></div>
      ${n.tags && n.tags.length ? `<div>${tags(n.tags)}</div>` : ''}
      <p class="excerpt">${esc(excerpt(n.body))}</p>
      <details><summary>Read the full note</summary><p class="full">${esc(n.body)}</p></details>
    </article>`).join('')}</div>`
    : '<div class="card empty"><h2>Nothing shared yet</h2><p class="muted">When the team shares a note with guests, it shows up here.</p></div>';
} catch (e) { fail($('#content'), e); }
