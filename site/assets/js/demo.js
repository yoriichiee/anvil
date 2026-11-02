// Anvil demo replay. Loads ./run.json (a recorded report.json, schemaVersion "1") and replays it.
// run.json is treated as untrusted data: every value reaches the page through textContent, never innerHTML,
// and screenshot paths must match a strict relative pattern.
(function () {
  'use strict';

  var SEV = ['critical', 'high', 'medium', 'low', 'info'];
  var SEV_LABEL = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low', info: 'Info' };
  var STATUS_LABEL = { pass: 'Pass', fail: 'Fail', warn: 'Warn', skip: 'Skipped', error: 'Error' };
  var VERDICT_LABEL = { works: 'Works', broken: 'Broken', unsure: 'Not sure' };
  var SHOT_RE = /^shots\/[A-Za-z0-9._-]+\.(png|jpe?g|webp)$/;
  // How a changed human answer moves the recorded score (shown to the reader, not hidden).
  var DELTA = { works: 0, unsure: -3, broken: -10 };

  // Status is never shown by colour alone: every state has a glyph, a label and its own weight/border.
  var STATUS_ICON = { pass: 'i-check', fail: 'i-x', warn: 'i-alert', skip: 'i-minus' };
  var SEV_ICON = { critical: 'i-alert', high: 'i-alert', medium: 'i-alert', low: 'i-minus', info: 'i-minus' };
  var VERDICT_ICON = { works: 'i-check', broken: 'i-x', unsure: 'i-q' };

  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var hasGsap = typeof window.gsap !== 'undefined';
  var $ = function (id) { return document.getElementById(id); };
  var SVG = 'http://www.w3.org/2000/svg';

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function icon(id, size) {
    var svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('class', 'icon'); svg.setAttribute('width', size || 13); svg.setAttribute('height', size || 13); svg.setAttribute('aria-hidden', 'true');
    var use = document.createElementNS(SVG, 'use'); use.setAttribute('href', '#' + id); svg.appendChild(use);
    return svg;
  }
  // <span class="st st-KIND"><svg/>Label</span>
  function stat(kind, iconId, label) {
    var s = el('span', 'st st-' + kind);
    s.appendChild(icon(iconId)); s.appendChild(document.createTextNode(label));
    return s;
  }
  function str(v, max) { v = (v === undefined || v === null) ? '' : String(v); return max && v.length > max ? v.slice(0, max) + '…' : v; }
  function arr(v) { return Array.isArray(v) ? v : []; }

  var run = null, answers = {}, recorded = {}, fmt = 'md';

  fetch('run.json', { cache: 'no-cache' })
    .then(function (r) { if (!r.ok) throw new Error('run.json returned ' + r.status); return r.json(); })
    .then(function (data) {
      if (!data || typeof data !== 'object' || !Array.isArray(data.checksRun) || !Array.isArray(data.findings)) throw new Error('run.json is not an Anvil report');
      run = data;
      render();
    })
    .catch(function (e) {
      var box = $('load-err');
      box.textContent = 'The recorded run could not be loaded (' + e.message + '). Reload the page, or open the report on GitHub.';
      box.hidden = false;
    });

  // ------------------------------------------------------------------ render
  function fmtDate(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return '';
    try {
      return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }).format(d) + ' UTC';
    } catch (e) { return d.toISOString(); }
  }

  function render() {
    var when = fmtDate(run.scannedAt);
    $('rec-label').textContent = 'Recorded run' + (when ? ', ' + when : '');
    var meta = $('run-meta');
    var t = run.target || {};
    [['Target', str(t.value, 200)], ['Kind', str(t.kind, 20)], ['Anvil', str(run.anvilVersion || '', 20)],
     ['AI', str(run.mode && run.mode.ai, 40)], ['Run', str(run.runId || '', 60)]].forEach(function (p) {
      if (!p[1]) return;
      var d = el('div'); d.appendChild(el('dt', null, p[0])); d.appendChild(el('dd', null, p[1])); meta.appendChild(d);
    });

    renderTimeline();
    renderFindings();
    renderHumans();
    renderNotChecked();
    setupTabs();
    update();
    replay();
    $('replay').addEventListener('click', function () { replay(true); });
  }

  // timeline -----------------------------------------------------------------
  var rows = [];
  function renderTimeline() {
    var ol = $('timeline');
    var max = run.checksRun.reduce(function (m, c) { return Math.max(m, +c.durationMs || 0); }, 1);
    var total = 0;
    run.checksRun.forEach(function (c) {
      var ms = Math.max(0, +c.durationMs || 0); total += ms;
      var st = STATUS_LABEL[c.status] ? c.status : 'skip';
      var li = el('li', 'tl-row'); li.setAttribute('data-status', st);
      var nm = el('div', 'tl-name'); nm.appendChild(el('b', null, str(c.name || c.id, 120))); nm.appendChild(el('code', null, str(c.id, 100)));
      var tr = el('div', 'tl-track'); var fill = el('div', 'tl-fill'); tr.appendChild(fill);
      var ratio = st === 'skip' && !ms ? 0.02 : Math.max(0.03, ms / max);
      fill.style.setProperty('--w', String(ratio));
      var time = el('span', 'tl-time num', st === 'skip' && !ms ? '—' : (ms / 1000).toFixed(2) + 's');
      var chip = stat(st, STATUS_ICON[st], STATUS_LABEL[st]);
      li.appendChild(nm); li.appendChild(tr); li.appendChild(time); li.appendChild(chip);
      ol.appendChild(li);
      rows.push({ li: li, fill: fill, chip: chip, ratio: ratio, ms: ms });
    });
    $('tl-total').textContent = run.checksRun.length + ' checks · ' + (total / 1000).toFixed(1) + 's of browser and scan time';
  }

  // findings -----------------------------------------------------------------
  var cards = [];
  function renderFindings() {
    var box = $('findings');
    var list = run.findings.slice().sort(function (a, b) { return SEV.indexOf(a.severity) - SEV.indexOf(b.severity); });
    if (!list.length) { box.appendChild(el('p', 'lead', 'No findings in this run.')); return; }
    var names = {}; run.checksRun.forEach(function (c) { names[c.id] = c.name; });
    list.forEach(function (f) {
      var sev = SEV.indexOf(f.severity) >= 0 ? f.severity : 'info';
      var art = el('article', 'fd'); art.setAttribute('data-sev', sev);
      var top = el('div', 'fd-top');
      top.appendChild(stat(sev, SEV_ICON[sev], SEV_LABEL[sev]));
      top.appendChild(el('span', 'chip chip-soft', str(names[f.check] || f.check, 80)));
      if (f.confidence) top.appendChild(el('span', 'fd-conf', 'Confidence: ' + str(f.confidence, 20)));
      art.appendChild(top);
      art.appendChild(el('h3', null, str(f.title, 200)));
      var cols = el('div', 'fd-cols');
      var left = el('div'); left.className = 'fd-left';
      var ev = f.evidence || {};
      var dl = el('dl', 'ev');
      var where = ev.file ? str(ev.file, 200) + (ev.line ? ':' + (+ev.line) : '') : '';
      [['File', where], ['Selector', str(ev.selector, 200)], ['Request', str(ev.request, 300)], ['Response', str(ev.response, 400)]].forEach(function (p) {
        if (!p[1]) return;
        var d = el('div'); d.appendChild(el('dt', null, p[0])); d.appendChild(el('dd', null, p[1])); dl.appendChild(d);
      });
      if (dl.childNodes.length) left.appendChild(dl);
      if (ev.shot && SHOT_RE.test(ev.shot)) left.appendChild(shotButton(ev.shot, f.title));
      var right = el('div', 'fd-text');
      var w = el('div'); w.appendChild(el('p', 'mini-h', 'Why it matters')); w.appendChild(el('p', null, str(f.why, 2000)));
      var x = el('div'); x.appendChild(el('p', 'mini-h', 'Fix')); x.appendChild(el('p', null, str(f.fix, 2000)));
      right.appendChild(w); right.appendChild(x);
      cols.appendChild(left); cols.appendChild(right);
      art.appendChild(cols);
      box.appendChild(art);
      cards.push(art);
    });
  }

  function shotButton(path, title) {
    var b = el('button', 'shot-btn'); b.type = 'button';
    var img = el('img'); img.src = path; img.alt = 'Screenshot: ' + str(title, 120); img.loading = 'lazy'; img.width = 320; img.height = 160;
    img.addEventListener('error', function () { b.remove(); });
    var cap = el('span'); cap.appendChild(icon('i-image', 12)); cap.appendChild(document.createTextNode(path.replace(/^shots\//, '') + ' · open'));
    b.appendChild(img); b.appendChild(cap);
    b.addEventListener('click', function () { openShot(path, title); });
    return b;
  }
  function openShot(path, title) {
    var dlg = $('shot-dlg');
    $('shot-dlg-t').textContent = path.replace(/^shots\//, '');
    var img = $('shot-dlg-img'); img.src = path; img.alt = 'Screenshot: ' + str(title, 120);
    if (dlg.showModal) dlg.showModal(); else window.open(path, '_blank', 'noopener');
  }
  $('shot-close').addEventListener('click', function () { $('shot-dlg').close(); });
  $('shot-dlg').addEventListener('click', function (e) { if (e.target === e.currentTarget) e.currentTarget.close(); });

  // human checks -------------------------------------------------------------
  function renderHumans() {
    var box = $('humans');
    var list = arr(run.humanChecks);
    if (!list.length) { box.appendChild(el('p', 'lead', 'This run had no human checks.')); return; }
    if (list.some(function (h) { return VERDICT_LABEL[h.verdict]; })) {
      $('human-lead').textContent = 'The recorded answers are already selected. Change any of them: the score and the fix brief below update as you go.';
    }
    list.forEach(function (h, i) {
      var id = str(h.id, 100);
      var v = VERDICT_LABEL[h.verdict] ? h.verdict : null;
      recorded[id] = v; answers[id] = v;
      var art = el('article', 'hc'); art.setAttribute('data-id', id);
      var top = el('div', 'hc-top');
      top.appendChild(el('span', 'manual-num', 'Check ' + (i + 1) + ' of ' + list.length));
      var rec = el('span', 'hc-state'); top.appendChild(rec);
      art.appendChild(top);
      art.appendChild(el('h3', null, str(h.prompt, 500)));
      var ol = el('ol', 'num-steps'); arr(h.steps).slice(0, 20).forEach(function (s) { var li = el('li'); li.appendChild(el('span', null, str(s, 500))); ol.appendChild(li); }); art.appendChild(ol);
      if (h.note) { var nb = el('div', 'hc-note'); nb.appendChild(el('p', 'mini-h', 'Tester note')); nb.appendChild(el('p', null, str(h.note, 500))); art.appendChild(nb); }
      var g = el('div', 'answer-row hc-btns'); g.setAttribute('role', 'group'); g.setAttribute('aria-label', 'Your answer: ' + str(h.prompt, 120));
      ['works', 'broken', 'unsure'].forEach(function (k) {
        var b = el('button', 'answer-btn'); b.type = 'button'; b.setAttribute('data-ans', k);
        b.appendChild(icon(VERDICT_ICON[k], 15)); b.appendChild(document.createTextNode(VERDICT_LABEL[k]));
        b.addEventListener('click', function () {
          answers[id] = answers[id] === k ? null : k;      // click again to clear
          paintHuman(art, id); update(true);
        });
        g.appendChild(b);
      });
      art.appendChild(g);
      box.appendChild(art);
      paintHuman(art, id);
    });
  }
  function paintHuman(art, id) {
    var v = answers[id];
    art.setAttribute('data-pending', String(!v));
    art.querySelectorAll('.answer-btn').forEach(function (b) {
      var on = b.getAttribute('data-ans') === v;
      b.setAttribute('aria-pressed', String(on)); b.classList.toggle('is-on', on);
    });
    var slot = art.querySelector('.hc-state');
    slot.textContent = '';
    var changed = v !== recorded[id];
    slot.appendChild(v
      ? stat(v === 'works' ? 'pass' : v === 'broken' ? 'fail' : 'warn', VERDICT_ICON[v], (changed ? 'Your answer: ' : 'Recorded: ') + VERDICT_LABEL[v])
      : stat('warn', 'i-q', 'Needs your answer'));
  }

  function renderNotChecked() {
    var ul = $('not-checked');
    arr(run.notChecked).forEach(function (n) {
      var li = el('li');
      li.appendChild(icon('i-q', 15));
      var t = el('span'); t.appendChild(el('b', null, str(n.what, 200))); t.appendChild(document.createTextNode(': ' + str(n.why, 600)));
      li.appendChild(t);
      ul.appendChild(li);
    });
  }

  // score, verdict, brief ----------------------------------------------------
  function counts() {
    var c = { critical: 0, high: 0, medium: 0, low: 0, info: 0, works: 0, broken: 0, unsure: 0, pending: 0 };
    run.findings.forEach(function (f) { if (c[f.severity] !== undefined) c[f.severity]++; });
    Object.keys(answers).forEach(function (k) { var v = answers[k]; if (v) c[v]++; else c.pending++; });
    return c;
  }
  function score() {
    var base = run.summary && typeof run.summary.score0to100 === 'number' ? run.summary.score0to100 : null;
    if (base === null) return { n: null, delta: 0, base: null };
    var delta = 0;
    Object.keys(answers).forEach(function (k) {
      var now = answers[k] ? DELTA[answers[k]] : 0, was = recorded[k] ? DELTA[recorded[k]] : 0;
      delta += now - was;
    });
    return { n: Math.max(0, Math.min(100, base + delta)), delta: delta, base: base };
  }

  var shown = null;
  function update(animate) {
    var c = counts(), s = score();
    var out = $('score');
    if (s.n === null) { out.textContent = '–'; }
    else if (animate && hasGsap && !reduce && shown !== null && shown !== s.n) {
      var o = { v: shown };
      gsap.to(o, { v: s.n, duration: 0.6, ease: 'power2.out', onUpdate: function () { out.textContent = Math.round(o.v); } });
      gsap.fromTo(out, { scale: 1.08 }, { scale: 1, duration: 0.5, ease: 'back.out(3)' });
    } else out.textContent = s.n;
    shown = s.n;
    $('score-why').textContent = s.base === null ? '' :
      'Recorded score ' + s.base + (s.delta ? '. Your answers moved it ' + (s.delta > 0 ? '+' : '−') + Math.abs(s.delta) + '.' : '. Change an answer: Broken −10, Not sure −3.');

    var blockers = [];
    if (c.critical) blockers.push(c.critical + ' critical');
    if (c.high) blockers.push(c.high + ' high');
    if (c.broken) blockers.push(c.broken + ' broken human check' + (c.broken > 1 ? 's' : ''));
    var v, glyph;
    if (blockers.length) { v = 'Not ready to launch: ' + blockers.join(', ') + '.'; glyph = 'fail'; }
    else if (c.pending || c.unsure) { v = 'No blockers found yet. ' + (c.pending + c.unsure) + ' human check' + (c.pending + c.unsure > 1 ? 's are' : ' is') + ' still open.'; glyph = 'open'; }
    else { v = 'No blockers in what was checked. Read the "not checked" list before you launch.'; glyph = 'pass'; }
    var vd = $('verdict'); vd.textContent = '';
    var sg = el('span', 'sg sg-' + glyph); sg.appendChild(icon(glyph === 'fail' ? 'i-x' : glyph === 'pass' ? 'i-check' : 'i-q', 12));
    vd.appendChild(sg); vd.appendChild(el('span', null, v));

    var ul = $('counts'); ul.textContent = '';
    [['critical', c.critical, 1], ['high', c.high, 1], ['medium', c.medium], ['low', c.low], ['works', c.works], ['broken', c.broken, 1], ['not sure', c.unsure], ['unanswered', c.pending]].forEach(function (p) {
      var li = el('li', p[2] && p[1] ? 'is-hot' : null); li.appendChild(el('b', null, String(p[1]))); li.appendChild(document.createTextNode(' ' + p[0])); ul.appendChild(li);
    });
    $('brief-out').textContent = brief(fmt);
  }

  function items() {
    var list = run.findings.slice().sort(function (a, b) { return SEV.indexOf(a.severity) - SEV.indexOf(b.severity); }).map(function (f) {
      var ev = f.evidence || {};
      return { sev: f.severity, title: str(f.title, 200), where: ev.file ? str(ev.file, 200) + (ev.line ? ':' + (+ev.line) : '') : (ev.selector ? str(ev.selector, 200) : ''),
        why: str(f.why, 2000), fix: str(f.fix, 2000), id: str(f.id, 100) };
    });
    arr(run.humanChecks).forEach(function (h) {
      var v = answers[str(h.id, 100)];
      if (v === 'broken' || v === 'unsure') {
        list.push({ sev: v === 'broken' ? 'high' : 'medium', human: v, title: (v === 'broken' ? 'Human check failed: ' : 'Human check unclear: ') + str(h.prompt, 300), where: '',
          why: h.note ? 'Tester note: ' + str(h.note, 500) : (v === 'broken' ? 'A person followed the steps and it did not work.' : 'A person could not tell whether it works.'),
          fix: 'Steps to reproduce: ' + arr(h.steps).map(function (s, i) { return (i + 1) + ') ' + str(s, 300); }).join(' '), id: str(h.id, 100) });
      }
    });
    return list;
  }

  function brief(kind) {
    var L = items(), t = run.target || {}, when = fmtDate(run.scannedAt), nc = arr(run.notChecked);
    var lines = [];
    if (kind === 'md') {
      lines.push('# Fix brief: ' + str(t.value, 200));
      lines.push('Recorded run ' + when + (run.runId ? ' (' + str(run.runId, 60) + ')' : '') + '. ' + L.length + ' item' + (L.length === 1 ? '' : 's') + ', most serious first.');
      lines.push('');
      L.forEach(function (x, i) {
        lines.push('## ' + (i + 1) + '. [' + x.sev + '] ' + x.title);
        if (x.where) lines.push('Where: ' + x.where);
        lines.push('Why: ' + x.why);
        lines.push('Fix: ' + x.fix);
        lines.push('');
      });
      lines.push('## Not checked in this run');
      nc.forEach(function (n) { lines.push('- ' + str(n.what, 200) + ': ' + str(n.why, 600)); });
      lines.push('');
      lines.push('Approve each fix before it is applied, then rescan.');
    } else if (kind === 'lovable') {
      lines.push('A launch check found these problems in my app. Please fix them one at a time, in this order. After each one, tell me in plain words what you changed. Do not change anything else.');
      lines.push('');
      L.forEach(function (x, i) {
        lines.push((i + 1) + '. ' + x.title);
        if (x.where) lines.push('   Where: ' + x.where);
        lines.push('   Why it matters: ' + x.why);
        lines.push('   What to do: ' + x.fix);
        lines.push('');
      });
      lines.push('If a fix needs a secret key, do not put the key in front-end code. Tell me which setting to add instead.');
    } else if (kind === 'cursor') {
      lines.push('Fix these launch-check findings. Keep each change minimal and scoped to the file listed. Add or update a test where a fix changes server behaviour. Stop and ask if a fix needs a design decision.');
      lines.push('');
      L.forEach(function (x, i) {
        lines.push('- [' + x.sev + '] ' + x.title + (x.where ? '  (' + x.where + ')' : ''));
        lines.push('  fix: ' + x.fix);
      });
    } else {
      lines.push('Use the anvil MCP tools for this.');
      if (run.runId) lines.push('1. Read the report: anvil_get_report{runId: "' + str(run.runId, 60) + '"}.');
      else lines.push('1. Read the latest report with anvil_get_report.');
      lines.push('2. For each item below, most serious first: explain the change, show me the diff, and wait for my approval before you apply it.');
      lines.push('3. When all approved fixes are in, run anvil_scan again on ' + str(t.value, 200) + ' and show me what changed.');
      lines.push('');
      L.forEach(function (x, i) {
        lines.push((i + 1) + '. [' + x.sev + '] ' + x.title + (x.where ? ' (' + x.where + ')' : ''));
        lines.push('   ' + x.fix);
      });
      lines.push('');
      lines.push('Do not describe the app as secure afterwards. Say which checks pass.');
    }
    return lines.join('\n');
  }

  function setupTabs() {
    var tabs = Array.prototype.slice.call(document.querySelectorAll('.brief-win [role="tab"]'));
    function select(tab, focus) {
      tabs.forEach(function (t) { var on = t === tab; t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1; });
      $('brief-panel').setAttribute('aria-labelledby', tab.id);
      fmt = tab.getAttribute('data-fmt');
      $('brief-out').textContent = brief(fmt);
      if (focus) tab.focus();
    }
    tabs.forEach(function (t, i) {
      t.addEventListener('click', function () { select(t); });
      t.addEventListener('keydown', function (e) {
        var j = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : null;
        if (j === null) return;
        e.preventDefault(); select(tabs[(j + tabs.length) % tabs.length], true);
      });
    });
  }

  // replay ---------------------------------------------------------------------
  var tl = null;
  function replay(fromButton) {
    if (!hasGsap || reduce) return;      // final state is already on the page
    if (tl) tl.kill();
    rows.forEach(function (r) {
      r.li.classList.remove('is-live');
      gsap.set(r.li, { opacity: 0.35 });
      gsap.set(r.fill, { scaleX: 0 });
      gsap.set(r.chip, { autoAlpha: 0, scale: 0.6 });
    });
    gsap.set(cards, { autoAlpha: 0, y: 16 });
    tl = gsap.timeline();
    rows.forEach(function (r) {
      var d = Math.min(1.1, Math.max(0.25, r.ms / 1000 * 0.3));
      tl.to(r.li, { opacity: 1, duration: 0.15, onStart: function () { r.li.classList.add('is-live'); } })
        .to(r.fill, { scaleX: r.ratio, duration: d, ease: 'power1.inOut' })
        .to(r.chip, { autoAlpha: 1, scale: 1, duration: 0.25, ease: 'back.out(2.5)', onStart: function () { r.li.classList.remove('is-live'); } });
    });
    if (window.ScrollTrigger && !fromButton) {
      // play the timeline when it is on screen, findings when they are on screen
      tl.pause();
      ScrollTrigger.create({ trigger: '#timeline', start: 'top 85%', once: true, onEnter: function () { tl.play(); } });
    }
    tl.to(cards, { autoAlpha: 1, y: 0, duration: 0.5, stagger: 0.12, ease: 'power3.out' });
    if (fromButton) document.getElementById('timeline').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
})();
