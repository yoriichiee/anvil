// Renders ../registry/index.json. Registry entries come from community packs: text only (textContent), no HTML.
(function () {
  'use strict';
  var box = document.getElementById('packs');
  var status = document.getElementById('reg-status');
  var ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
  var SVG = 'http://www.w3.org/2000/svg';
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = String(text); return n; }
  function s(v, max) { v = v == null ? '' : String(v); return v.length > max ? v.slice(0, max) + '…' : v; }
  function icon(id, size) {
    var svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('class', 'icon'); svg.setAttribute('width', size || 15); svg.setAttribute('height', size || 15); svg.setAttribute('aria-hidden', 'true');
    var use = document.createElementNS(SVG, 'use'); use.setAttribute('href', '#' + id); svg.appendChild(use);
    return svg;
  }

  fetch('../registry/index.json', { cache: 'no-cache' })
    .then(function (r) { if (!r.ok) throw new Error('status ' + r.status); return r.json(); })
    .then(function (reg) {
      var packs = reg && Array.isArray(reg.packs) ? reg.packs.filter(function (p) { return p && ID_RE.test(p.id); }) : [];
      status.textContent = '';
      status.appendChild(icon(packs.length ? 'i-check' : 'i-q', 14));
      status.appendChild(document.createTextNode(packs.length
        ? packs.length + ' pack' + (packs.length === 1 ? '' : 's') + ' listed' + (reg.stub ? '. Preview: these seed packs are still in review and not installable yet.' : '.')
        : 'No packs are listed yet.'));
      packs.slice(0, 200).forEach(function (p) {
        // The registry (addons-spec build-index.mjs) lists {latest, versions:[{version, kinds, checks, humanChecks}]};
        // flatten the latest version onto the pack so both shapes render.
        if (Array.isArray(p.versions)) {
          var lv = p.versions.filter(function (v) { return v && v.version === p.latest; })[0] || p.versions[0] || {};
          p = { id: p.id, name: p.name, author: p.author, license: p.license, description: p.description, tags: p.tags,
            version: p.version || p.latest || lv.version, kinds: p.kinds || lv.kinds, checks: typeof p.checks === 'number' ? p.checks : lv.checks,
            humanChecks: typeof p.humanChecks === 'number' ? p.humanChecks : lv.humanChecks };
        }
        var li = el('li', 'pack-live');
        var top = el('div', 'pack-top');
        top.appendChild(el('code', 'pack-id', s(p.id, 64)));
        top.appendChild(el('span', 'chip chip-lane', 'v' + s(p.version, 20)));
        li.appendChild(top);
        li.appendChild(el('h2', 'pack-name', s(p.name || p.id, 80)));
        li.appendChild(el('p', 'pack-by', s(p.author, 80) + ' · ' + s(p.license, 40)));
        li.appendChild(el('p', null, s(p.description, 500)));
        if (Array.isArray(p.tags) && p.tags.length) {
          var tg = el('div', 'pack-tags');
          p.tags.slice(0, 12).forEach(function (t) { tg.appendChild(el('span', 'chip chip-soft', s(t, 32))); });
          li.appendChild(tg);
        }
        var bits = [];
        if (typeof p.checks === 'number') bits.push(p.checks + ' check' + (p.checks === 1 ? '' : 's'));
        if (typeof p.humanChecks === 'number') bits.push(p.humanChecks + ' human check' + (p.humanChecks === 1 ? '' : 's'));
        if (Array.isArray(p.kinds) && p.kinds.length) bits.push(p.kinds.slice(0, 6).map(function (k) { return s(k, 20); }).join(', '));
        if (bits.length) li.appendChild(el('p', 'pack-kinds', bits.join(' · ')));
        var cmd = el('div', 'cmd-box');
        var pr = el('span', 'cmd-prompt', '$'); pr.setAttribute('aria-hidden', 'true'); cmd.appendChild(pr);
        cmd.appendChild(el('code', 'cmd-text', 'anvil addon add ' + p.id));
        var b = el('button', 'copy-btn'); b.type = 'button'; b.setAttribute('aria-label', 'Copy the install command for ' + s(p.id, 64));
        b.appendChild(icon('i-copy')); b.appendChild(el('span', 'copy-label', 'Copy'));
        cmd.appendChild(b);
        li.appendChild(cmd);
        box.appendChild(li);
      });
    })
    .catch(function () {
      status.textContent = 'The registry could not be loaded. Try again in a minute.';
    });
})();
