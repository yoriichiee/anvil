// member/notes.html - the notes table (DEMO BUG 1 lives in the CSS: .notes-table, see app.css and DEMO-BUGS.md)
import { $, esc, api, boot, fail, fmtDate, tags } from './app.js';

try {
  const { flags } = await boot();
  const [{ notes }, tagRes] = await Promise.all([api('notes'), flags.ff_tags ? api('tags') : Promise.resolve(null)]);
  $('#sub').textContent = `${notes.length} notes from your team, newest first.`;
  if (tagRes && tagRes.tags.length) {
    const bar = $('#tagbar');
    bar.innerHTML = '<span class="muted small">Tags:</span> ' + tagRes.tags.map(t => `<span class="tag">${esc(t.tag)} · ${t.count}</span>`).join('');
    bar.hidden = false;
  }
  const withTags = !!flags.ff_tags;
  $('#content').innerHTML = `<div class="card table-card">
    <table class="notes-table">
      <caption class="sr-only">Team notes</caption>
      <thead><tr><th scope="col">Title</th><th scope="col">Owner</th>${withTags ? '<th scope="col">Tags</th>' : ''}<th scope="col">Visibility</th><th scope="col">Last updated</th><th scope="col" class="num">Words</th></tr></thead>
      <tbody>${notes.map(n => `<tr>
        <td class="t"><a href="/app/member/note.html?id=${encodeURIComponent(n.id)}">${esc(n.title)}</a></td>
        <td>${esc(n.owner_name)}</td>
        ${withTags ? `<td>${tags(n.tags)}</td>` : ''}
        <td>${n.shared ? '<span class="pill pill-shared">Team + guests</span>' : '<span class="pill">Team only</span>'}</td>
        <td>${esc(fmtDate(n.updated))}</td>
        <td class="num">${n.words}</td></tr>`).join('')}</tbody>
    </table></div>`;
} catch (e) { fail($('#content'), e); }
