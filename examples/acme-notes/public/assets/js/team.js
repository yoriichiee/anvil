// admin/team.html - team list with a client-side search
import { $, esc, api, boot, fail, avatar, fmtDate, fmtTime } from './app.js';

try {
  await boot();
  const { team } = await api('team');
  const render = q => {
    const list = team.filter(u => !q || [u.name, u.email, u.role, u.title].join(' ').toLowerCase().includes(q));
    $('#count').textContent = list.length === team.length ? `${team.length} people` : `${list.length} of ${team.length} people`;
    $('#content').innerHTML = list.length ? `<ul class="list">${list.map(u => `
      <li class="team-row">${avatar(u.id, u.name)}
        <div class="who"><div class="title">${esc(u.name)} <span class="pill pill-${esc(u.role)}">${esc(u.role)}</span></div>
          <div class="email">${esc(u.title)} · ${esc(u.email)}</div></div>
        <div class="side"><span>Active ${esc(fmtTime(u.active))}</span><br><span>Joined ${esc(fmtDate(u.joined))}</span></div></li>`).join('')}</ul>`
      : '<p class="muted">Nobody matches that search.</p>';
  };
  render('');
  $('#q').addEventListener('input', e => render(e.target.value.trim().toLowerCase()));
} catch (e) { fail($('#content'), e); }
