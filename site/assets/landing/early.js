/* Runs in <head>, before first paint (the site's CSP is script-src 'self', so this cannot be inline).
   Adds .js (shows the mobile menu button). On the landing page (data-motion) it also arms the motion
   states; if the animation script never takes over (blocked, failed, slow), the page falls back to
   its finished, fully visible state. */
(function () {
  var d = document.documentElement;
  var me = document.currentScript;
  d.classList.add('js');
  if (me && me.hasAttribute('data-motion') && window.matchMedia && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    d.classList.add('motion-pending');
    setTimeout(function () { if (!d.classList.contains('motion')) d.classList.remove('motion-pending'); }, 3000);
  }
})();
