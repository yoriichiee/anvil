// admin/settings.html - workspace settings form (GET + PATCH /api/settings)
import { $, api, boot, fail, toast } from './app.js';

const form = $('#form');
const fill = s => {
  form.workspace.value = s.workspace;
  form.reply_to.value = s.reply_to;
  form.default_visibility.value = s.default_visibility;
  form.retention_days.value = String(s.retention_days);
  form.weekly_digest.checked = !!s.weekly_digest;
  // DEMO BUG 4 (intentional, see DEMO-BUGS.md): an empty optional field is reported with console.error,
  // so the page logs an error on every load while "Reply-to email" is empty (it is empty in the seed data).
  // The fix is to show a gentle hint instead (or nothing - the field is optional).
  for (const [key, value] of Object.entries(s)) if (value === '') console.error(`settings: field "${key}" is empty`);
};

try {
  await boot();
  const { settings } = await api('settings');
  fill(settings);
  $('#content').hidden = true;
  form.hidden = false;
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const btn = $('#save'), status = $('#status');
    btn.disabled = true; status.textContent = 'Saving…';
    try {
      const { settings: saved } = await api('settings', { method: 'PATCH', body: {
        workspace: form.workspace.value, reply_to: form.reply_to.value.trim(), default_visibility: form.default_visibility.value,
        retention_days: Number(form.retention_days.value), weekly_digest: form.weekly_digest.checked } });
      fill(saved);
      status.textContent = 'All changes saved.';
      toast('Settings saved');
    } catch (err) {
      status.textContent = err.message;
    } finally { btn.disabled = false; }
  });
} catch (e) { fail($('#content'), e); }
