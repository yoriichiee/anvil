// Static stand-in for acme-notes settings.js. Keeps DEMO BUG 4 on purpose: an empty optional field is
// reported with console.error on every load. Saving is disabled: this snapshot has no server.
(function () {
  var seed = { workspace: 'Acme Inc', reply_to: '', default_visibility: 'team', retention_days: 90, weekly_digest: true };
  Object.keys(seed).forEach(function (key) {
    if (seed[key] === '') console.error('settings: field "' + key + '" is empty');
  });
  var form = document.getElementById('form');
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    document.getElementById('status').textContent = 'Not saved: this is a static snapshot with no server.';
  });
})();
