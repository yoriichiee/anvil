// admin/dashboard.html - workspace overview
import { $, esc, api, boot, fail, avatar, fmtDate, fmtTime, tags } from './app.js';

try {
  const { me, flags } = await boot();
  const [{ notes }, { team }, tagRes] = await Promise.all([api('notes'), api('team'), flags.ff_tags ? api('tags') : Promise.resolve(null)]);
  const hour = new Date().getHours();
  $('#greeting').textContent = `${hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'}, ${me.user.name.split(' ')[0]}`;
  const shared = notes.filter(n => n.shared).length;
  const words = notes.reduce((a, n) => a + n.words, 0);
  const tagCard = tagRes
    ? `<div class="card stat"><div class="label">Tags in use</div><div class="value">${tagRes.tags.length}</div><div class="hint">most used: ${esc(tagRes.tags[0] ? '#' + tagRes.tags[0].tag : 'none yet')}</div></div>`
    : `<div class="card stat"><div class="label">Words written</div><div class="value">${words.toLocaleString('en-US')}</div><div class="hint">across all notes</div></div>`;
  $('#content').innerHTML = `
    <section class="grid stats" aria-label="Workspace numbers">
      <div class="card stat"><div class="label">Notes</div><div class="value">${notes.length}</div><div class="hint">in ${esc(me.workspace)}</div></div>
      <div class="card stat"><div class="label">Shared with guests</div><div class="value">${shared}</div><div class="hint">${notes.length - shared} team only</div></div>
      <div class="card stat"><div class="label">Team members</div><div class="value">${team.length}</div><div class="hint">${team.filter(u => u.role === 'guest').length} guest</div></div>
      ${tagCard}
    </section>
    <div class="grid two">
      <section class="card" aria-labelledby="recent-h">
        <div class="card-head"><h2 id="recent-h">Recently updated</h2><span class="muted small">last ${Math.min(5, notes.length)} notes</span></div>
        <ul class="list">${notes.slice(0, 5).map(n => `
          <li>${avatar(n.owner, n.owner_name, 'sm')}
            <div class="grow"><div class="title">${esc(n.title)} ${n.shared ? '<span class="pill pill-shared">shared</span>' : ''}</div>
              <div class="meta">${esc(n.owner_name)} · ${esc(fmtTime(n.updated))}</div>${n.tags ? `<div>${tags(n.tags)}</div>` : ''}</div></li>`).join('')}
        </ul>
      </section>
      <section class="card" aria-labelledby="team-h">
        <div class="card-head"><h2 id="team-h">Team</h2><a class="small" href="/app/admin/team.html">Manage team</a></div>
        <ul class="list">${team.map(u => `
          <li>${avatar(u.id, u.name, 'sm')}<div class="grow"><div class="title">${esc(u.name)}</div><div class="meta">${esc(u.title)}</div></div>
            <span class="pill pill-${esc(u.role)}">${esc(u.role)}</span></li>`).join('')}
        </ul>
        <p class="muted small">Workspace created ${esc(fmtDate(team[0].joined))}</p>
      </section>
    </div>`;
} catch (e) { fail($('#content'), e); }
