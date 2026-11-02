/* Anvil landing page behaviour.
   The page is complete without JavaScript. GSAP, ScrollTrigger and Lenis only add motion on top.
   Rules: transforms and opacity only, reduced motion = static finished states (and native scrolling),
   nothing stays hidden if a ScrollTrigger never fires, and if Lenis is missing the page scrolls natively. */
(() => {
  'use strict';
  const root = document.documentElement;
  const $ = (s, c = document) => c.querySelector(s);
  const $$ = (s, c = document) => Array.from(c.querySelectorAll(s));
  const reducedMQ = window.matchMedia('(prefers-reduced-motion: reduce)');

  /* ---------------------------------------------------------------- copy buttons */
  const copyStatus = $('#copy-status');
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (_e) { ok = false; }
      ta.remove();
      return ok;
    }
  }
  function selectText(el) {
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
  $$('[data-copy]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const src = document.getElementById(btn.dataset.copy);
      if (!src) return;
      const ok = await copyText(src.textContent.trim());
      const label = $('.copy-label', btn);
      const use = $('use', btn);
      if (ok) {
        label.textContent = 'Copied';
        use.setAttribute('href', '#i-check');
        btn.classList.add('is-done');
        copyStatus.textContent = 'Command copied to the clipboard.';
      } else {
        selectText(src);
        label.textContent = 'Press Ctrl+C';
        copyStatus.textContent = 'Could not copy automatically. The command is selected; copy it with your keyboard.';
      }
      clearTimeout(btn._t);
      btn._t = setTimeout(() => {
        label.textContent = 'Copy';
        use.setAttribute('href', '#i-copy');
        btn.classList.remove('is-done');
      }, 2000);
    });
  });

  /* ---------------------------------------------------------------- tabs (WAI-ARIA, roving tabindex) */
  function setupTabs(list, onSelect) {
    const tabs = $$('[role="tab"]', list);
    const select = (tab, focus) => {
      tabs.forEach((t) => {
        const on = t === tab;
        t.setAttribute('aria-selected', String(on));
        t.tabIndex = on ? 0 : -1;
        t.classList.toggle('is-on', on);
      });
      onSelect(tab);
      if (focus) tab.focus();
    };
    tabs.forEach((t, i) => {
      t.addEventListener('click', () => select(t));
      t.addEventListener('keydown', (e) => {
        let j = null;
        if (e.key === 'ArrowRight') j = (i + 1) % tabs.length;
        else if (e.key === 'ArrowLeft') j = (i - 1 + tabs.length) % tabs.length;
        else if (e.key === 'Home') j = 0;
        else if (e.key === 'End') j = tabs.length - 1;
        if (j !== null) { e.preventDefault(); select(tabs[j], true); }
      });
    });
    return select;
  }

  const installList = $('#install .tablist');
  let selectInstall = null;
  if (installList) {
    selectInstall = setupTabs(installList, (tab) => {
      $$('[role="tab"]', installList).forEach((t) => {
        const panel = document.getElementById(t.getAttribute('aria-controls'));
        if (panel) panel.hidden = t !== tab;
      });
    });
  }

  const segList = $('.brief .seg');
  if (segList) {
    const intro = $('.brief-intro');
    const panel = $('#pp');
    setupTabs(segList, (tab) => {
      const text = intro.getAttribute('data-intro-' + tab.dataset.fmt);
      if (text) intro.textContent = text;
      panel.setAttribute('aria-labelledby', tab.id);
    });
  }

  /* ---------------------------------------------------------------- platform-aware hero install line */
  if (/Windows/i.test(navigator.userAgent)) {
    const cmd = $('#hero-cmd');
    const label = $('#hero-cmd-label');
    const prompt = $('.hero .cmd-prompt');
    const more = $('.oneliner-foot .small-link');
    if (cmd) cmd.textContent = 'irm https://anvil.horvans.com/install.ps1 | iex';
    if (label) label.textContent = 'Windows PowerShell';
    if (prompt) prompt.textContent = 'PS>';
    if (more) more.textContent = 'macOS, Linux, Claude Code, Codex';
    if (selectInstall) selectInstall($('#t-win'));
  }

  /* ---------------------------------------------------------------- mobile nav */
  const toggle = $('.nav-toggle');
  const links = $('#nav-links');
  const setMenu = (open) => {
    if (!toggle || !links) return;
    toggle.setAttribute('aria-expanded', String(open));
    links.classList.toggle('is-open', open);
  };
  if (toggle && links) {
    toggle.addEventListener('click', () => setMenu(toggle.getAttribute('aria-expanded') !== 'true'));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') { setMenu(false); toggle.focus(); }
    });
    window.matchMedia('(min-width: 900px)').addEventListener('change', (m) => { if (m.matches) setMenu(false); });
  }

  /* ---------------------------------------------------------------- human-check answer buttons */
  const ansBtns = $$('.answer-btn');
  const ansStatus = $('.ans-status');
  const ansLabels = { works: 'Works', broken: 'Broken', unsure: 'Not sure' };
  let userAnswered = false;
  function setAnswer(value, announce) {
    ansBtns.forEach((b) => {
      const on = b.dataset.ans === value;
      b.setAttribute('aria-pressed', String(on));
      b.classList.toggle('is-on', on);
    });
    if (announce && ansStatus) ansStatus.textContent = value ? 'Answer: ' + ansLabels[value] + '.' : 'Answer cleared.';
  }
  ansBtns.forEach((b) => {
    b.addEventListener('click', () => {
      userAnswered = true;
      const wasOn = b.getAttribute('aria-pressed') === 'true';
      setAnswer(wasOn ? null : b.dataset.ans, true);
    });
  });

  /* ---------------------------------------------------------------- in-page links (Lenis-aware) */
  let lenis = null;
  const nav = $('.nav');
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest && e.target.closest('a[href^="#"]');
    if (!a) return;
    const id = decodeURIComponent(a.getAttribute('href').slice(1));
    const target = id && document.getElementById(id);
    if (!target) return;
    e.preventDefault();
    setMenu(false);
    const offset = -((nav ? nav.offsetHeight : 0) + 16);
    if (lenis) lenis.scrollTo(target, { offset, duration: 1.2 });
    else target.scrollIntoView({ behavior: reducedMQ.matches ? 'auto' : 'smooth', block: 'start' });
    if (location.hash !== '#' + id) history.pushState(null, '', '#' + id);
    if (!target.matches('a[href], button, input, select, textarea, [tabindex]')) target.setAttribute('tabindex', '-1');
    target.focus({ preventScroll: true });
  });

  /* ---------------------------------------------------------------- motion */
  const gsap = window.gsap;
  const ScrollTrigger = window.ScrollTrigger;
  if (!gsap || !ScrollTrigger) {
    root.classList.remove('motion-pending');
    return;
  }
  gsap.registerPlugin(ScrollTrigger);

  // Step rail: mark the step being read. A state indicator, not motion, so it runs for everyone.
  $$('.how-step').forEach((step) => {
    ScrollTrigger.create({ trigger: step, start: 'top 60%', end: 'bottom 60%', toggleClass: 'is-current' });
  });

  /* Play `anim` once when `el` scrolls into view; if the page loads already past it, jump to the end. */
  function whenSeen(el, start, anim) {
    if (!el) return;
    ScrollTrigger.create({ trigger: el, start, once: true, onEnter: () => anim.play() });
    requestAnimationFrame(() => {
      if (el.getBoundingClientRect().bottom < 0 && anim.progress() === 0) anim.progress(1);
    });
  }

  /* Smooth wheel scrolling. Touch keeps native scrolling (syncTouch: false). */
  function startLenis() {
    if (typeof window.Lenis !== 'function') return null;
    try {
      const l = new window.Lenis({ lerp: 0.1, smoothWheel: true, syncTouch: false });
      l.on('scroll', ScrollTrigger.update);
      const tick = (time) => l.raf(time * 1000);
      gsap.ticker.add(tick);
      gsap.ticker.lagSmoothing(0);
      lenis = l;
      return () => {
        gsap.ticker.remove(tick);
        gsap.ticker.lagSmoothing(500, 33);
        l.destroy();
        lenis = null;
      };
    } catch (_) {
      lenis = null;
      return null;
    }
  }

  /* The hero screen starts tilted back in 3D and is perfectly straight once it is fully in view. */
  function screenTilt() {
    const stage = $('.stage-persp');
    const screen = $('.stage .screen');
    if (!stage || !screen) return;
    const chips = $$('.shot-chip', screen);
    // Where the screen's bottom edge meets the bottom of the viewport (measured on the untransformed wrapper).
    const straightAt = () => {
      const bottom = stage.getBoundingClientRect().bottom + window.scrollY;
      return Math.max(Math.round(bottom - window.innerHeight), 160);
    };
    const tl = gsap.timeline({
      defaults: { ease: 'none' },
      scrollTrigger: { trigger: stage, start: 0, end: straightAt, scrub: true, invalidateOnRefresh: true },
    });
    tl.fromTo(screen, { rotationX: 22, scale: 0.92, y: 0 }, { rotationX: 0, scale: 1, y: 0, duration: 1 }, 0);
    if (chips.length) {
      tl.fromTo(chips, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.14, stagger: 0.04, ease: 'power2.out' }, 0.82);
    }
    root.classList.remove('motion-pending'); // inline transforms hold the state from here on
  }

  /* Opacity only (never visibility:hidden), so links and buttons in sections that have not
     revealed yet stay in the keyboard tab order. Focus reveals a section at once. */
  function reveals() {
    const els = $$('.rv');
    gsap.set(els, { opacity: 0, y: 22 });
    const show = (batch, instant) => gsap.to(batch, { opacity: 1, y: 0, duration: instant ? 0 : 0.75, ease: 'power3.out', stagger: instant ? 0 : 0.08, overwrite: true });
    ScrollTrigger.batch(els, { start: 'top 92%', once: true, onEnter: (batch) => show(batch) });
    requestAnimationFrame(() => {
      els.forEach((el) => { if (el.getBoundingClientRect().bottom < 0) show(el, true); });
    });
    const onFocus = (e) => {
      const el = e.target.closest && e.target.closest('.rv');
      if (el && parseFloat(getComputedStyle(el).opacity) < 1) show(el, true);
    };
    document.addEventListener('focusin', onFocus);
    return () => document.removeEventListener('focusin', onFocus);
  }

  function humanCheck() {
    const card = $('.manual-card');
    if (!card) return;
    const broken = $('.answer-btn[data-ans="broken"]', card);
    if (!userAnswered) setAnswer(null, false);
    const tl = gsap.timeline({ paused: true });
    tl.to(broken, { scale: 0.95, duration: 0.09, ease: 'power1.out', yoyo: true, repeat: 1 }, 1.1)
      .call(() => { if (!userAnswered) setAnswer('broken', false); }, null, 1.2)
      .fromTo($('.shot-line', card), { autoAlpha: 0, y: 6 }, { autoAlpha: 1, y: 0, duration: 0.4, ease: 'power2.out', immediateRender: false }, 1.25);
    whenSeen(card, 'top 70%', tl);
  }

  function fixLoop() {
    const loop = $('.loop');
    if (!loop) return;
    const nodes = $$('.loop-node', loop);
    const lines = $$('.loop-line > i', loop);
    const prop = getComputedStyle(loop).flexDirection === 'column' ? 'scaleY' : 'scaleX';
    const tl = gsap.timeline({ scrollTrigger: { trigger: loop, start: 'top 88%', end: 'top 50%', scrub: 0.6 } });
    tl.fromTo(nodes[0], { autoAlpha: 0.3 }, { autoAlpha: 1, duration: 0.3 })
      .fromTo(lines[0], { [prop]: 0 }, { [prop]: 1, duration: 1, ease: 'none' })
      .fromTo(nodes[1], { autoAlpha: 0.3 }, { autoAlpha: 1, duration: 0.3 })
      .fromTo(lines[1], { [prop]: 0 }, { [prop]: 1, duration: 1, ease: 'none' })
      .fromTo(nodes[2], { autoAlpha: 0.3, scale: 0.94 }, { autoAlpha: 1, scale: 1, duration: 0.4, ease: 'back.out(2)' });
  }

  function secureStrike() {
    const strike = $('.secure-strike');
    if (!strike) return;
    const tw = gsap.fromTo(strike, { scaleX: 0, rotation: -7 }, { scaleX: 1, rotation: -7, duration: 0.55, ease: 'power3.inOut', delay: 0.35, paused: true });
    whenSeen($('.secure'), 'top 80%', tw);
  }

  const mm = gsap.matchMedia();
  mm.add({ motion: '(prefers-reduced-motion: no-preference)', phone: '(max-width: 480px)' }, (ctx) => {
    const { motion, phone } = ctx.conditions;
    if (!motion) {
      root.classList.remove('motion-pending', 'motion');
      return undefined;
    }
    root.classList.add('motion');
    const stopLenis = startLenis();
    if (phone) root.classList.remove('motion-pending'); // phones: the screen is shown straight, no 3D
    else screenTilt();
    const undoReveals = reveals();
    humanCheck();
    fixLoop();
    secureStrike();
    ScrollTrigger.refresh();
    return () => {
      root.classList.remove('motion');
      if (undoReveals) undoReveals();
      if (stopLenis) stopLenis();
      if (!userAnswered) setAnswer('broken', false);
    };
  });

  // The screenshot's real height is known once it loads; recompute trigger positions then.
  const heroImg = $('.stage .screen-img');
  if (heroImg && !heroImg.complete) heroImg.addEventListener('load', () => ScrollTrigger.refresh(), { once: true });
})();
