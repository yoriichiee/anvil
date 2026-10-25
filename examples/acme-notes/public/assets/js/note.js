// member/note.html - create (POST /api/notes) or edit (?id=n2 -> GET + PATCH /api/notes/:id) a note
import { $, api, boot, fail, toast, fmtTime } from './app.js';

const form = $('#form');
const F = { title: $('#title'), body: $('#body'), shared: $('#shared'), tags: $('#tags') };
const countWords = () => { const n = F.body.value.trim() ? F.body.value.trim().split(/\s+/).length : 0; $('#count').textContent = n === 1 ? '1 word' : n + ' words'; };
const showMeta = note => {
  $('#heading').textContent = note.title;
  $('#meta').textContent = `By ${note.owner_name} · last saved ${fmtTime(note.updated)}`;
  document.title = note.title + ' · Acme Notes';
};

try {
  const { flags } = await boot();
  let id = new URLSearchParams(location.search).get('id');
  if (id && !/^n\d{1,6}$/.test(id)) id = null;
  if (flags.ff_tags) $('#tags-field').hidden = false;
  if (id) {
    const { note } = await api('notes/' + id);
    F.title.value = note.title;
    F.body.value = note.body;
    F.shared.checked = note.shared;
    if (note.tags) F.tags.value = note.tags.join(', ');
    showMeta(note);
  }
  countWords();
  F.body.addEventListener('input', countWords);
  $('#content').hidden = true;
  form.hidden = false;

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const status = $('#status'), btn = $('#save');
    if (!F.title.value.trim()) { status.textContent = 'Give the note a title first.'; F.title.focus(); return; }
    const body = { title: F.title.value, body: F.body.value, shared: F.shared.checked };
    if (flags.ff_tags) body.tags = F.tags.value.split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
    btn.disabled = true; status.textContent = 'Saving…';
    try {
      const { note } = id ? await api('notes/' + id, { method: 'PATCH', body }) : await api('notes', { method: 'POST', body });
      if (!id) { id = note.id; history.replaceState(null, '', '?id=' + encodeURIComponent(id)); }
      showMeta(note);
      status.textContent = 'Saved.';
      toast('Note saved');
    } catch (err) {
      status.textContent = err.message;
    } finally { btn.disabled = false; }
  });
} catch (e) { fail($('#content'), e); }
