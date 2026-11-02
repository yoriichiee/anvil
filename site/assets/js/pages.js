/* Anvil site: shared behaviour for the inner pages (mobile nav, copy buttons).
   Same markup and behaviour as the landing page; copy is delegated so buttons rendered later
   (add-on cards, the demo fix brief) work too. The pages are complete without JavaScript. */
(function () {
  'use strict';
  var doc = document;

  /* ---------------------------------------------------------------- mobile nav */
  var toggle = doc.querySelector('.nav-toggle');
  var links = doc.getElementById('nav-links');
  function setMenu(open) {
    if (!toggle || !links) return;
    toggle.setAttribute('aria-expanded', String(open));
    links.classList.toggle('is-open', open);
  }
  if (toggle && links) {
    toggle.addEventListener('click', function () { setMenu(toggle.getAttribute('aria-expanded') !== 'true'); });
    links.addEventListener('click', function (e) { if (e.target.closest('a')) setMenu(false); });
    doc.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') { setMenu(false); toggle.focus(); }
    });
    if (window.matchMedia) {
      var mq = window.matchMedia('(min-width: 900px)');
      var onMq = function (m) { if (m.matches) setMenu(false); };
      if (mq.addEventListener) mq.addEventListener('change', onMq); else if (mq.addListener) mq.addListener(onMq);
    }
  }

  /* ---------------------------------------------------------------- copy buttons */
  var status = doc.getElementById('copy-status');
  if (!status) {
    status = doc.createElement('p');
    status.className = 'sr-only'; status.id = 'copy-status'; status.setAttribute('aria-live', 'polite');
    doc.body.appendChild(status);
  }
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
      var ta = doc.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
      doc.body.appendChild(ta); ta.select();
      var ok = false;
      try { ok = doc.execCommand('copy'); } catch (e) { ok = false; }
      ta.remove();
      if (ok) resolve(); else reject(new Error('copy failed'));
    });
  }
  function selectText(el) {
    var r = doc.createRange(); r.selectNodeContents(el);
    var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
  }
  doc.addEventListener('click', function (e) {
    var btn = e.target.closest && e.target.closest('button.copy-btn');
    if (!btn) return;
    var id = btn.getAttribute('data-copy');
    var src = id ? doc.getElementById(id) : null;
    if (!src) { var box = btn.closest('.cmd-box'); src = box && box.querySelector('.cmd-text'); }
    if (!src) return;
    var label = btn.querySelector('.copy-label');
    var use = btn.querySelector('use');
    var was = label ? label.textContent : '';
    copyText(src.textContent.trim()).then(function () {
      if (label) label.textContent = 'Copied';
      if (use) use.setAttribute('href', '#i-check');
      btn.classList.add('is-done');
      status.textContent = 'Copied to the clipboard.';
    }, function () {
      selectText(src);
      if (label) label.textContent = 'Press Ctrl+C';
      status.textContent = 'Could not copy automatically. The text is selected; copy it with your keyboard.';
    }).then(function () {
      clearTimeout(btn._t);
      btn._t = setTimeout(function () {
        if (label) label.textContent = was;
        if (use) use.setAttribute('href', '#i-copy');
        btn.classList.remove('is-done');
      }, 2000);
    });
  });
})();
