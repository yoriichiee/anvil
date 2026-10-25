// Anvil dashboard - plain ES module, no dependencies, no build step.
// See docs/ARCHITECTURE.md. All data is rendered with textContent / DOM APIs only.
// Project details (app name, roles, page and sign-in paths, review commands) arrive in /api/data as env.project.

/* ------------------------------------------------------------------ constants */

const params = new URLSearchParams(location.search);
const BASE = '/anvil'; // Anvil's own routes; every other path is the proxied app under test.
let APP_PREFIX = '/'; // part of the page path before {page}, from env.project.pagePrefix

// project settings from the server (anvil.config.json), with safe fallbacks for older servers / mock data
function proj() {
  const p = (S.data && S.data.env && S.data.env.project) || {};
  const planRoles = [...new Set(((S.data && S.data.plan && S.data.plan.pages) || []).flatMap((x) => x.roles || []))];
  return {
    appName: p.appName || 'the app',
    roles: p.roles && p.roles.length ? p.roles : planRoles.length ? planRoles : ['user'],
    pagePath: p.pagePath || '/{page}',
    pagePrefix: p.pagePrefix || '/',
    pageExample: p.pageExample || (S.data && S.data.plan && S.data.plan.pages && S.data.plan.pages[0] && S.data.plan.pages[0].page) || 'section/page.html',
    loginPath: p.loginPath || null,
    apiBase: p.apiBase || '/api/',
    apiMatch: p.apiMatch || '/api/',
    canReset: !!p.canReset,
    review: { pass: (p.review && p.review.pass) || '/pass {lane}', fix: (p.review && p.review.fix) || '/fix {lane}' },
    chatName: p.chatName || 'team chat',
    helpText: p.helpText || 'Stuck? Ask in Claude Code.',
    commands: p.commands || {},
  };
}
const passCmd = (lane) => proj().review.pass.split('{lane}').join(lane);
const fixCmd = (lane) => proj().review.fix.split('{lane}').join(lane);
const isFixBody = (lane, body) => String(body || '').trimStart().startsWith(fixCmd(lane));
const lineOkFor = (lane, body) => {
  const first = String(body || '').trimStart().split('\n')[0] || '';
  return [passCmd(lane), fixCmd(lane)].some((c) => first === c || first.startsWith(c + ' '));
};
// avatar colour class by the role's position in the role list (6 colours, then repeat)
const avClass = (r) => `av-${Math.max(0, ROLES.indexOf(r)) % 6}`;
const PAGE_OK = /^(?!.*\.\.)[A-Za-z0-9_][A-Za-z0-9_.\/-]*(\?[\w=&%.-]*)?$/;

const AREAS = [
  ['works', 'Does it work'],
  ['roles', 'Right access per role'],
  ['phone', 'On a phone'],
  ['laptop', 'On a laptop'],
  ['stability', 'Stable (tests, build, CI)'],
];
const AREA_NAME = Object.fromEntries(AREAS);

const GROUPS = [
  { name: 'Tests', prefix: 'A1', about: 'The project’s own automatic tests. A failed test is re-run once, then also tried on main to see if this PR caused it.' },
  { name: 'Build', prefix: 'A5', about: 'Builds every page of the app. If the build fails, nothing else can be trusted.' },
  { name: 'CI', prefix: 'A4', about: 'The checks GitHub ran on this PR.' },
  { name: 'Pages', prefix: 'P-', about: 'Each changed page is opened as each allowed role: it must load with no errors and no leftover sample names.' },
  { name: 'Roles', prefix: 'R-', about: 'Asks the server for data as different people. Someone who should be blocked must be blocked.' },
  { name: 'Flags', prefix: 'F-', about: 'Turns the feature flag on and off to see that the feature follows it.' },
  { name: 'Layout', prefix: 'L-', about: 'Opens pages at phone width and looks for sideways scrolling.' },
  { name: 'Accessibility', prefix: 'X-', about: 'Looks for images without descriptions, unnamed buttons and unlabelled inputs. Warnings only.' },
];

const STATUS = {
  pass: { label: 'Passed', tone: 'green', icon: 'check' },
  fail: { label: 'Failed', tone: 'red', icon: 'x' },
  flake: { label: 'Passed on retry', tone: 'amber', icon: 'refresh' },
  preexisting: { label: 'Broken on main too', tone: 'grey', icon: 'info' },
  warn: { label: 'Warning', tone: 'amber', icon: 'alert' },
  skip: { label: 'Skipped', tone: 'grey', icon: 'minus' },
  pending: { label: 'Waiting', tone: 'grey', icon: 'clock' },
  running: { label: 'Running', tone: 'indigo', icon: 'spin' },
  stopped: { label: 'Stopped', tone: 'grey', icon: 'square' },
  notrun: { label: 'Not run', tone: 'grey', icon: 'minus' },
};

const ANSWERS = [
  { id: 'works', label: 'Works', tone: 'green', icon: 'check' },
  { id: 'broken', label: 'Broken', tone: 'red', icon: 'x' },
  { id: 'unsure', label: 'Not sure', tone: 'amber', icon: 'help' },
];

let ROLES = ['user']; // replaced from env.project.roles on every data update
const DEVICES = ['phone', 'tablet', 'laptop'];
const DEVICE_SIZE = { phone: [390, 844], tablet: [820, 1180], laptop: [1440, 900] };

const HEALTH_NAME = { app: 'App under test', gh: 'GitHub CLI', chrome: 'Chrome', claude: 'Claude' };

const VIEWS = [
  { id: 'test', label: 'Test view', icon: 'monitor' },
  { id: 'overview', label: 'Overview', icon: 'home' },
  { id: 'auto', label: 'Auto checks', icon: 'zap' },
  { id: 'manual', label: 'Your checks', icon: 'clipboard' },
  { id: 'screens', label: 'Screens', icon: 'image' },
  { id: 'tools', label: 'Tools', icon: 'wrench' },
  { id: 'complete', label: 'Complete', icon: 'send' },
];

const SCREEN_TIPS = {
  test: 'Test the app right here. Pick a check in the right panel, follow the steps, then answer. Errors the page throws are counted in the red badge automatically.',
  overview: 'Steps 1 and 2 can run at the same time: the automatic checks run on their own while you do your checks.',
  auto: 'Red does not always mean this PR is bad. “Broken on main too” is not the developer’s fault. Use Re-run if something looks like a hiccup.',
  manual: 'Use the “Open as” button on each check: it signs you in as the right person. If something is off, choose Broken and write what you saw, like you would tell a friend.',
  screens: 'Switch on “Include in report” for the 3 to 6 screens that tell the story best. Compare phone and laptop side by side to spot layout problems.',
  tools: 'Need a picture of a page that is not in the list? Type its address, like {example}.',
  complete: 'Be honest with your stars. The score comes mostly from the checks; your rating counts for 30%.',
  sent: 'Paste the short note in {chat}. The full report lives on GitHub.',
};

const ICONS = {
  check: ['M20 6 9 17l-5-5'],
  x: ['M18 6 6 18', 'm6 6 12 12'],
  minus: ['M5 12h14'],
  alert: ['m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3', 'M12 9v4', 'M12 17h.01'],
  info: ['M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20', 'M12 16v-4', 'M12 8h.01'],
  help: ['M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20', 'M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3', 'M12 17h.01'],
  clock: ['M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20', 'M12 6v6l4 2'],
  refresh: ['M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8', 'M21 3v5h-5', 'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16', 'M8 16H3v5'],
  external: ['M15 3h6v6', 'M10 14 21 3', 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6'],
  copy: ['M10 8h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2z', 'M4 16a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2'],
  download: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'm7 10 5 5 5-5', 'M12 15V3'],
  camera: ['M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z', 'M12 10a3 3 0 1 0 0 6a3 3 0 1 0 0-6'],
  phone: ['M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z', 'M12 18h.01'],
  tablet: ['M6 2h12a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z', 'M12 18h.01'],
  laptop: ['M5 5h14a1 1 0 0 1 1 1v10H4V6a1 1 0 0 1 1-1z', 'M2 20h20'],
  image: ['M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z', 'M9 8a1 1 0 1 0 0 2a1 1 0 1 0 0-2', 'm21 15-5-5L5 21'],
  star: ['M12 2.5l2.94 5.96 6.56.95-4.75 4.63 1.12 6.54L12 17.5l-5.87 3.08 1.12-6.54L2.5 9.41l6.56-.95z'],
  menu: ['M4 6h16', 'M4 12h16', 'M4 18h16'],
  panel: ['M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z', 'M15 3v18'],
  sparkles: ['M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z', 'M19 3v4', 'M17 5h4', 'M5 17v4', 'M3 19h4'],
  home: ['M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z'],
  zap: ['M13 2 3 14h9l-1 8 10-12h-9z'],
  clipboard: ['M9 2h6a1 1 0 0 1 1 1v2H8V3a1 1 0 0 1 1-1z', 'M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2', 'm9 14 2 2 4-4'],
  wrench: ['M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94z'],
  send: ['m22 2-7 20-4-9-9-4z', 'M22 2 11 13'],
  arrowLeft: ['M19 12H5', 'm12 19-7-7 7-7'],
  arrowRight: ['M5 12h14', 'm12 5 7 7-7 7'],
  chevLeft: ['m15 18-6-6 6-6'],
  chevRight: ['m9 18 6-6-6-6'],
  user: ['M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2', 'M12 3a4 4 0 1 0 0 8a4 4 0 1 0 0-8'],
  columns: ['M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z', 'M12 3v18'],
  pr: ['M18 15a3 3 0 1 0 0 6a3 3 0 1 0 0-6', 'M6 3a3 3 0 1 0 0 6a3 3 0 1 0 0-6', 'M13 6h3a2 2 0 0 1 2 2v7', 'M6 9v12'],
  reset: ['M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8', 'M3 3v5h5'],
  file: ['M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z', 'M14 2v6h6', 'M16 13H8', 'M16 17H8'],
  ci: ['M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20', 'm8 12 3 3 5-6'],
  paste: ['M9 2h6a1 1 0 0 1 1 1v2H8V3a1 1 0 0 1 1-1z', 'M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2', 'M12 10v7', 'm9 14 3 3 3-3'],
  upload: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'm17 8-5-5-5 5', 'M12 3v12'],
  link: ['M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71', 'M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71'],
  shield: ['M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z'],
  plus: ['M12 5v14', 'M5 12h14'],
  zoom: ['M11 3a8 8 0 1 0 0 16a8 8 0 1 0 0-16', 'm21 21-4.3-4.3', 'M11 8v6', 'M8 11h6'],
  monitor: ['M4 3h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z', 'M8 21h8', 'M12 17v4'],
  rotate: ['M21 12a9 9 0 1 1-3-6.7L21 8', 'M21 3v5h-5'],
  bug: ['M8 2l1.9 1.9', 'M14.1 3.9 16 2', 'M9 7.1V6a3 3 0 1 1 6 0v1.1', 'M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6z', 'M12 20v-9', 'M6.5 13H3', 'M21 13h-3.5', 'M6 17l-2.5 2', 'M18 17l2.5 2', 'M6 9 3.5 7', 'M18 9l2.5-2'],
  clip: ['m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48'],
  grid: ['M4 4h6v6H4z', 'M14 4h6v6h-6z', 'M14 14h6v6h-6z', 'M4 14h6v6H4z'],
  square: ['M7 7h10v10H7z'],
  play: ['M7 4.5v15l12-7.5z'],
  pause: ['M8 5v14', 'M16 5v14'],
  maximize: ['M8 3H5a2 2 0 0 0-2 2v3', 'M21 8V5a2 2 0 0 0-2-2h-3', 'M3 16v3a2 2 0 0 0 2 2h3', 'M16 21h3a2 2 0 0 0 2-2v-3'],
  party: ['M5.8 11.3 2 22l10.7-3.79', 'M4 3h.01', 'M22 8h.01', 'M15 2h.01', 'M22 20h.01', 'm22 2-2.24.75a2.9 2.9 0 0 0-1.96 3.12c.1.86-.57 1.63-1.45 1.63h-.38c-.86 0-1.6.6-1.76 1.44L14 10', 'M11 13c1.93 1.93 2.83 4.17 2 5-.83.83-3.07-.07-5-2-1.93-1.93-2.83-4.17-2-5 .83-.83 3.07.07 5 2z'],
};

/* ------------------------------------------------------------------ tiny DOM helpers */

const SVGNS = 'http://www.w3.org/2000/svg';

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = String(v);
      else if (k === 'style') Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else if (k === 'disabled') el.disabled = !!v;
      else if (k === 'href') el.setAttribute('href', safeUrl(v));
      else if (k === 'src') el.setAttribute('src', safeSrc(v));
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  append(el, kids);
  return el;
}

// replaceChildren() would turn null into the text "null"; this skips empty kids like h() does.
function fill(el, ...kids) {
  if (!el) return el;
  el.textContent = '';
  append(el, kids);
  return el;
}

function append(el, kids) {
  for (const kid of kids) {
    if (kid == null || kid === false || kid === true) continue;
    if (Array.isArray(kid)) append(el, kid);
    else if (kid instanceof Node) el.appendChild(kid);
    else el.appendChild(document.createTextNode(String(kid)));
  }
}

function icon(name, size = 16, cls = '') {
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', 'icon ' + cls);
  if (name === 'spin') {
    svg.classList.add('icon-spin');
    const c = document.createElementNS(SVGNS, 'path');
    c.setAttribute('d', 'M21 12a9 9 0 1 1-6.22-8.56');
    svg.appendChild(c);
    return svg;
  }
  for (const d of ICONS[name] || []) {
    const p = document.createElementNS(SVGNS, 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
  }
  return svg;
}

function safeUrl(u) {
  const s = String(u || '');
  if (/^(https?:|blob:)/i.test(s)) return s;
  if (/^(\/(?!\/)|#|\?)/.test(s)) return s;
  if (/^[a-z0-9._-]+(\/[a-z0-9._-]+)*(\?[^\s]*)?$/i.test(s)) return s; // relative file
  return '#';
}
function safeSrc(u) {
  const s = String(u || '');
  if (/^data:image\/(png|jpeg|svg\+xml)[;,]/i.test(s)) return s;
  return safeUrl(s);
}

const $ = (sel, root = document) => root.querySelector(sel);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round1 = (n) => Math.round(n * 10) / 10;
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '');
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function store(key, val) {
  try {
    if (val === undefined) return JSON.parse(localStorage.getItem('qa:' + key));
    localStorage.setItem('qa:' + key, JSON.stringify(val));
  } catch { return undefined; }
  return val;
}

function timeAgo(iso) {
  if (!iso) return '';
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return '';
  return t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/* ------------------------------------------------------------------ scoring (same rules as report.mjs) */

function score(plan, results, state) {
  const autoPts = { pass: 1, flake: 0.75, warn: 0.5, fail: 0 };
  const manPts = { works: 1, unsure: 0.5, broken: 0 };
  const areas = {};
  for (const [id] of AREAS) areas[id] = { score: 5, passed: 0, total: 0, notes: [], p: 0 };
  const auto = { pass: 0, fail: 0, warn: 0, flake: 0, preexisting: 0, skip: 0 };
  for (const c of results.checks || []) {
    if (c.status in auto) auto[c.status]++;
    const a = areas[c.area];
    if (!a || !(c.status in autoPts)) continue;
    a.total++;
    a.p += autoPts[c.status];
    if (c.status === 'pass' || c.status === 'flake') a.passed++;
    if (c.status === 'fail' || c.status === 'warn') a.notes.push(`${c.name}: ${c.detail}`);
  }
  const manual = { works: 0, broken: 0, unsure: 0, open: 0 };
  let manualBlock = false;
  for (const m of plan.manual || []) {
    const ans = state.manual?.[m.id]?.answer;
    if (!ans) { manual.open++; continue; }
    manual[ans]++;
    const a = areas[m.area];
    if (!a) continue;
    a.total++;
    a.p += manPts[ans];
    if (ans === 'works') a.passed++;
    else a.notes.push(`${m.title}: ${ans === 'broken' ? 'broken' : 'not sure'}${state.manual[m.id].note ? ' - ' + state.manual[m.id].note : ''}`);
    if (ans === 'broken' && (m.area === 'works' || m.area === 'roles')) manualBlock = true;
  }
  for (const a of Object.values(areas)) { a.score = a.total ? round1((5 * a.p) / a.total) : 5; delete a.p; }
  const blockers = (results.checks || []).filter((c) => c.blocker && c.status === 'fail').map((c) => ({ id: c.id, text: `${c.name}: ${c.detail}` }));
  const mean = AREAS.reduce((s, [id]) => s + areas[id].score, 0) / AREAS.length;
  const overall = round1(state.rating ? 0.7 * mean + 0.3 * state.rating : mean);
  return { areas, auto, manual, blockers, overall, decision: blockers.length || manualBlock ? 'fix' : 'final' };
}

function overallWithRating(summary, rating) {
  const mean = AREAS.reduce((s, [id]) => s + (summary.areas?.[id]?.score ?? 5), 0) / AREAS.length;
  return round1(rating ? 0.7 * mean + 0.3 * rating : mean);
}

/* ------------------------------------------------------------------ mock server (in memory) */

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

class MockServer {
  constructor(json) {
    const d = structuredClone(json);
    this.outcomes = d.mock_outcomes || {};
    this.nextPrs = d.mock_next || [];
    delete d.mock_outcomes; delete d.mock_next;
    this.d = d;
    this.d.state.overrides = this.d.state.overrides || {};
    this.blobs = {};
    this.handlers = { progress: [], data: [], control: [], log: [], shot: [] };
    this.session = { events: [], requests: [] };
    this.running = false;
    this.stopReq = false;
    this.chat = '';
    this.log = [];
    this.n = 0;
    // Backfill: the log of checks that already finished before the page opened.
    for (const c of d.results.checks) {
      if (c.status === 'pending' || c.status === 'running') continue;
      for (const t of this.steps(c)) this.logLine(c.id, t.text, t.shot ? 'shot' : 'log', true);
      this.logLine(c.id, `${(STATUS[c.status] || STATUS.pending).label}: ${c.detail || ''}`, 'log', true);
    }
    if (d.results.running) setTimeout(() => this.runChecks(null, true), 900);
  }
  on(type, fn) { this.handlers[type].push(fn); }
  emit(type, payload) { for (const fn of this.handlers[type]) fn(payload); }
  payload() {
    const { plan, results, state, env, health } = this.d;
    const out = structuredClone({ plan, results, state, env, health });
    for (const c of out.results.checks) {
      delete c._final; delete c._ran;
      const ov = state.overrides?.[c.id];
      if (ov) { c.auto_status = c.status; c.status = ov.status; c.override = ov; }
    }
    out.summary = score(out.plan, out.results, out.state);
    return out;
  }
  push() { this.emit('data', this.payload()); }
  logLine(id, text, type = 'log', quiet = false) {
    const l = { n: ++this.n, id, text, at: new Date().toISOString(), type };
    this.log.push(l);
    if (this.log.length > 2000) this.log.shift();
    if (!quiet) this.emit('log', l);
  }

  // Plausible sub-steps per check type (mock only).
  steps(c) {
    const pr = this.d.plan.pr;
    const m = /^[PLX]-(.+?)(?:-([a-z]+))?$/.exec(c.id);
    const out = this.outcomes[c.id] || {};
    const cmds = proj().commands;
    if (c.id === 'A1') return [{ text: cmds.tests || 'npm test' }, { text: 'ok   auth.test.js (24 tests)' }, { text: 'ok   notes.test.js (31 tests)' }, { text: 'FAIL autosave.test.js: expected "Saved", got "Saving"' }, { text: '96 tests so far, 1 failed' }, { text: 'FAIL export.test.js: unknown column title' }, { text: '128 tests, 2 failed' }];
    if (c.id.startsWith('A2-')) return [{ text: `re-running ${c.id.slice(3)}` }, { text: `ok   ${c.id.slice(3)} (6 tests)` }];
    if (c.id.startsWith('A3-')) return [{ text: 'git worktree add (origin/main, temporary)' }, { text: `FAIL ${c.id.slice(3)} on main too` }];
    if (c.id === 'A4') return [{ text: cmds.ci || `gh pr checks ${pr}` }, { text: 'ok   lint' }, { text: 'ok   unit-tests' }, { text: 'ok   build' }];
    if (c.id === 'A5') return [{ text: cmds.build || 'npm run build' }, { text: 'built 24 pages' }, { text: 'build finished in 2.1 s' }];
    if (c.id.startsWith('P-') && m) {
      const shots = out.shots || c.shots || [];
      const failing = (out.status || c.status) === 'fail';
      return [{ text: `${m[1]} as ${m[2]} on phone: loading` }, { text: `${m[1]} as ${m[2]} on phone: loaded in 1.2 s, 0 errors` }, shots[0] ? { text: `screenshot ${shots[0]}`, shot: shots[0] } : null,
        { text: `${m[1]} as ${m[2]} on laptop: loading` }, { text: failing ? `${m[1]} as ${m[2]} on laptop: FAIL ${out.detail || c.detail}` : `${m[1]} as ${m[2]} on laptop: loaded in 0.9 s, 0 errors` }, shots[1] ? { text: `screenshot ${shots[1]}`, shot: shots[1] } : null].filter(Boolean);
    }
    if (c.id.startsWith('L-') && m) return [{ text: `${m[1]} at 390px: measuring page width` }];
    if (c.id.startsWith('X-')) return [{ text: 'axe-core on laptop: images, buttons, links, form labels' }];
    if (c.id.startsWith('R-')) {
      const a = this.d.plan.access.find((x) => `R-${x.id}` === c.id);
      return a ? [{ text: `${a.method} ${proj().apiBase}${a.path} as ${a.as}` }, { text: `answered ${a.method === 'GET' ? (a.expect.includes(200) ? 200 : 403) : 403} (expected ${a.expect.join(' or ')})` }] : [];
    }
    if (c.id.startsWith('F-')) return [{ text: 'flag tool not found: flag check skipped' }];
    return [];
  }

  async runChecks(only, resume = false) {
    const r = this.d.results;
    const prefixes = only ? String(only).split(',').map((x) => x.trim()).filter(Boolean) : null;
    const list = r.checks.filter((c) => (resume ? c.status === 'pending' : !prefixes || prefixes.some((p) => c.id.startsWith(p))));
    if (prefixes) for (const c of list) delete this.d.state.overrides[c.id];
    this.running = true;
    this.stopReq = false;
    r.running = true; r.finished = null; r.stopped = null;
    if (!resume) r.started = new Date().toISOString();
    for (const c of list) { if (!resume) c.status = 'pending'; }
    this.push();
    let done = 0;
    for (const c of list) {
      if (this.stopReq) break;
      c.status = 'running';
      r.current = { id: c.id, label: c.name, started: new Date().toISOString() };
      this.emit('progress', { type: 'progress', id: c.id, label: c.name, done, total: list.length });
      this.push();
      const out = this.outcomes[c.id];
      for (const st of this.steps(c)) {
        await sleep(260 + Math.random() * 320);
        if (this.stopReq) break;
        this.logLine(c.id, st.text, st.shot ? 'shot' : 'log');
        if (st.shot) { this.addShot(st.shot, 'auto'); this.emit('shot', { type: 'shot', id: c.id, file: st.shot }); }
      }
      if (this.stopReq) {
        c.status = 'stopped'; c.detail = 'Stopped before it finished';
        this.logLine(c.id, 'stopped by the tester');
        break;
      }
      await sleep(200);
      if (out) {
        const res = !resume && out.rerun && c._ran ? { ...out, ...out.rerun } : out;
        c.status = res.status; c.detail = res.detail; c.ms = res.ms || 900; c.blocker = !!res.blocker;
        for (const f of out.shots || []) this.addShot(f, 'auto');
        c.shots = out.shots || c.shots;
      } else if (c._final) {
        Object.assign(c, c._final);
      }
      c._ran = true;
      c._final = { status: c.status, detail: c.detail, ms: c.ms, blocker: c.blocker };
      this.logLine(c.id, `${(STATUS[c.status] || STATUS.pending).label}: ${c.detail || ''}`);
      done++;
      this.emit('progress', { type: 'progress', id: c.id, label: c.name, done, total: list.length });
      this.push();
    }
    if (this.stopReq) {
      for (const c of list) if (c.status === 'running') c.status = 'stopped';
      r.stopped = new Date().toISOString();
    } else {
      r.finished = new Date().toISOString();
    }
    this.running = false;
    this.stopReq = false;
    r.running = false; r.current = null;
    this.emit('progress', { type: 'done' });
    this.push();
  }
  addShot(file, source) {
    if (this.d.results.shots.some((s) => s.file === file)) return;
    const m = /shots\/([a-z]+)-([a-z0-9_-]+?)-(phone|tablet|laptop)\.png$/.exec(file);
    if (!m) return;
    const page = this.d.plan.pages.find((p) => p.page.includes(m[2]))?.page || `${m[1]}/${m[2]}.html`;
    this.d.results.shots.push({ file, page, role: m[1], device: m[3], source, at: new Date().toISOString() });
  }

  async handle(method, path, body = {}) {
    await sleep(160 + Math.random() * 200);
    const { plan, results, state } = this.d;
    const [pathOnly, qs] = String(path).split('?');
    const query = new URLSearchParams(qs || '');
    const key = `${method} ${pathOnly}`;
    switch (key) {
      case 'GET /api/data': return this.payload();
      case 'POST /api/run': {
        if (this.running) throw new ApiError(409, 'Checks are already running.');
        for (const c of results.checks) if (!c._final) c._final = { status: c.status, detail: c.detail, ms: c.ms, blocker: c.blocker };
        this.runChecks(body.only || null);
        return { started: true };
      }
      case 'POST /api/manual': {
        const m = plan.manual.find((x) => x.id === body.id);
        if (!m) throw new ApiError(400, 'Unknown check.');
        if (body.answer != null && !['works', 'broken', 'unsure'].includes(body.answer)) throw new ApiError(400, 'Bad answer.');
        const prev = state.manual[body.id] || { shots: [] };
        state.manual[body.id] = { answer: body.answer ?? null, note: String(body.note || ''), shots: prev.shots || [], at: new Date().toISOString() };
        this.push();
        return { ok: true };
      }
      case 'POST /api/manual-shot': {
        if (!/^data:image\/(png|jpeg);base64,/.test(body.dataUrl || '')) throw new ApiError(400, 'Only PNG or JPEG images.');
        if (body.dataUrl.length > 8 * 1024 * 1024 * 1.37) throw new ApiError(413, 'Image is larger than 8 MB.');
        const prev = state.manual[body.id] || { answer: null, note: '', shots: [], at: null };
        const file = `shots/manual-${body.id}-${(prev.shots || []).length + 1}.png`;
        this.blobs[file] = body.dataUrl;
        prev.shots = [...(prev.shots || []), file];
        state.manual[body.id] = prev;
        this.push();
        return { file };
      }
      case 'POST /api/shot': {
        await sleep(1400);
        const slug = String(body.page).replace(/\.html.*$/, '').replace(/[^a-z0-9]+/gi, '_');
        const file = `shots/tool-${body.role}-${slug}-${body.device}-${Date.now() % 100000}.png`;
        results.shots.push({ file, page: body.page, role: body.role, device: body.device, source: 'tool', at: new Date().toISOString() });
        this.push();
        return { file };
      }
      case 'POST /api/include': {
        const set = new Set(state.include_shots);
        if (body.on) set.add(body.file); else set.delete(body.file);
        state.include_shots = [...set];
        this.push();
        return { ok: true };
      }
      case 'POST /api/reset-data': await sleep(900); return { ok: true };
      case 'POST /api/complete': {
        if (results.running) throw new ApiError(409, 'Checks are still running.');
        const open = plan.manual.filter((m) => !state.manual[m.id]?.answer);
        if (open.length) throw new ApiError(409, `${plural(open.length, 'manual check')} not answered yet.`);
        state.rating = body.rating || null;
        state.note_to_dev = String(body.note_to_dev || '');
        await sleep(900);
        const summary = score(plan, results, state);
        const draft = mockDraft(plan, results, state, summary);
        state.draft = draft;
        this.push();
        return { summary, draft };
      }
      case 'POST /api/send': {
        await sleep(1300);
        const summary = score(plan, results, state);
        const urls = body.comments.map((c, i) => `${plan.url}#issuecomment-${2417730 + i}`);
        this.chat = String(body.chat_md || '').replace('{report_url}', urls[0]);
        state.sent = { at: new Date().toISOString(), decision: summary.decision, comments: urls, files: ['report.md', `chat-pr${plan.pr}.md`, 'screens.png'] };
        state.completed = true;
        this.push();
        return { urls, files: state.sent.files, chat_md: this.chat };
      }
      case 'POST /api/session': {
        for (const ev of body.events || []) this.session.events.push({ ...ev, text: ev.text ? String(ev.text).slice(0, 300) : undefined });
        this.session.events = this.session.events.slice(-1000);
        return { ok: true };
      }
      case 'GET /api/session': return structuredClone(this.session);
      case 'POST /api/control': this.emit('control', body); return { ok: true };
      case 'POST /api/view-shot': {
        if (!/^data:image\/(png|jpeg);base64,/.test(body.dataUrl || '')) throw new ApiError(400, 'Only PNG or JPEG images.');
        const file = `shots/view-${Date.now() % 1000000}.png`;
        this.blobs[file] = body.dataUrl;
        results.shots.push({ file, page: body.page, role: body.role, device: body.device, source: 'view', at: new Date().toISOString() });
        if (body.manualId) {
          const prev = state.manual[body.manualId] || { answer: null, note: '', shots: [], at: null };
          prev.shots = [...(prev.shots || []), file];
          state.manual[body.manualId] = prev;
        }
        this.push();
        return { file };
      }
      case 'POST /api/stop': {
        if (!this.running) return { ok: true };
        this.stopReq = true;
        for (let i = 0; i < 100 && this.running; i++) await sleep(100);
        return { ok: true };
      }
      case 'POST /api/override': {
        const chk = results.checks.find((x) => x.id === body.id);
        if (!chk) throw new ApiError(400, 'Unknown check.');
        if (body.status != null && !['pass', 'fail'].includes(body.status)) throw new ApiError(400, 'Bad status.');
        if (body.status == null) delete state.overrides[body.id];
        else state.overrides[body.id] = { status: body.status, note: String(body.note || '').slice(0, 1000), at: new Date().toISOString() };
        this.push();
        return { ok: true };
      }
      case 'GET /api/log': {
        const after = Number(query.get('after') || 0);
        return { lines: this.log.filter((l) => l.n > after), next: this.n };
      }
      case 'GET /api/next': return { prs: [{ number: plan.pr, title: plan.title, url: plan.url, current: true }, ...this.nextPrs] };
      case 'GET /api/chat.md': return this.chat;
      default: throw new ApiError(404, 'Not found');
    }
  }
}

function mockDraft(plan, results, state, summary) {
  const fix = summary.decision === 'fix';
  const stars = '★'.repeat(Math.round(summary.overall)) + '☆'.repeat(5 - Math.round(summary.overall));
  const comments = plan.lanes.map((lane) => {
    const items = plan.manual.filter((m) => m.lane === lane);
    const lines = [fix ? `${fixCmd(lane)} ${summary.blockers[0]?.text.split(':')[0] || 'see issues below'}` : passCmd(lane), 'Expected:'];
    for (const m of items) {
      const a = state.manual[m.id] || {};
      lines.push(`- [${a.answer === 'works' ? 'x' : ' '}] ${m.title}${a.answer !== 'works' && a.note ? ' - ' + a.note : ''}`);
    }
    lines.push('Extras:');
    for (const e of plan.copilot.extras) lines.push(`- [x] ${e}`);
    lines.push('Other:');
    const other = results.checks.filter((c) => c.status === 'fail' || c.status === 'warn');
    if (!other.length) lines.push('- nothing else found');
    for (const c of other) lines.push(`- ${c.name}: ${c.detail}`);
    lines.push(`Tested on: ${plan.commit}, Chrome phone 390x844 + laptop 1440x900, roles ${[...new Set(plan.pages.flatMap((p) => p.roles))].join(' + ')}`);
    lines.push(`Rating: ${stars} ${summary.overall}/5${state.rating ? ` (tester: ${state.rating}/5)` : ''}`);
    if (state.note_to_dev) lines.push(`Note: ${state.note_to_dev}`);
    lines.push('Screenshots: drag `screens.png` here', '', `Tested with Anvil \u00b7 Claude for @${plan.tester}`);
    return { lane, body: lines.join('\n') };
  });
  const chat_md = [
    `**PR #${plan.pr}** ${plan.title} - tested by @${plan.tester}`,
    `${stars} ${summary.overall}/5 - ${fix ? 'sent back to the developer' : 'sent for final review'}`,
    fix ? `${plural(summary.blockers.length + summary.manual.broken, 'issue')} to fix.` : 'Everything expected works.',
    `@${plan.author} @${plan.owner}`,
    'Report: {report_url}',
    `Tested with Anvil \u00b7 Claude for @${plan.tester}`,
  ].join('\n');
  return { comments, chat_md, summary };
}

// Fake screenshot images for mock mode (SVG, all text escaped as XML).
function xml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c])); }
const AV_COLORS = ['#4f46e5', '#0891b2', '#7c3aed', '#db2777', '#059669', '#d97706'];
const roleColor = (r) => AV_COLORS[Math.max(0, ROLES.indexOf(r)) % AV_COLORS.length];
function mockShotSvg(shot) {
  const [w, hgt] = DEVICE_SIZE[shot.device] || DEVICE_SIZE.laptop;
  const color = roleColor(shot.role);
  const narrow = w < 600;
  const pad = narrow ? 20 : 40;
  const title = String(shot.page || '').replace(/^.*\//, '').replace('.html', '');
  let body = '';
  const cols = narrow ? 1 : w < 1000 ? 2 : 3;
  const cw = (w - pad * 2 - (cols - 1) * 20) / cols;
  for (let i = 0; i < (narrow ? 5 : 6); i++) {
    const x = pad + (i % cols) * (cw + 20);
    const y = 190 + Math.floor(i / cols) * 150;
    body += `<rect x="${x}" y="${y}" width="${cw}" height="130" rx="12" fill="#fff" stroke="#e5e7eb"/>`;
    body += `<rect x="${x + 16}" y="${y + 18}" width="${cw * 0.5}" height="12" rx="6" fill="#111827" opacity=".75"/>`;
    body += `<rect x="${x + 16}" y="${y + 44}" width="${cw * 0.75}" height="9" rx="4.5" fill="#9ca3af"/>`;
    body += `<rect x="${x + 16}" y="${y + 62}" width="${cw * 0.6}" height="9" rx="4.5" fill="#d1d5db"/>`;
    body += `<rect x="${x + 16}" y="${y + 92}" width="70" height="22" rx="11" fill="${color}" opacity=".15"/>`;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${hgt}" viewBox="0 0 ${w} ${hgt}">
<rect width="100%" height="100%" fill="#f6f7f9"/>
<rect width="100%" height="64" fill="${color}"/>
<text x="${pad}" y="40" font-family="Inter,Arial,sans-serif" font-size="20" font-weight="700" fill="#fff">${xml(proj().appName)}</text>
<text x="${w - pad}" y="40" text-anchor="end" font-family="Inter,Arial,sans-serif" font-size="15" fill="#fff" opacity=".9">${xml(cap(shot.role))}</text>
<text x="${pad}" y="122" font-family="Inter,Arial,sans-serif" font-size="${narrow ? 26 : 32}" font-weight="700" fill="#111827">${xml(cap(title))}</text>
<text x="${pad}" y="152" font-family="Inter,Arial,sans-serif" font-size="15" fill="#6b7280">${xml(shot.page)} · ${xml(shot.device)} · sample</text>
${body}</svg>`;
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

/* ------------------------------------------------------------------ app state */

const S = {
  mode: 'live',
  fallback: false,
  mock: null,
  data: null,
  view: 'overview',
  progress: null,
  conn: 'ok',
  copilotOpen: store('copilot') ?? true,
  navOpen: false,
  healthOpen: false,
  switchOpen: false,
  noteDrafts: {},
  saveState: {},
  manualFilter: 'all',
  deviceFilter: 'all',
  roleFilter: 'all',
  compare: [],
  lightbox: null,
  completeStage: 'gate',
  rating: null,
  noteToDev: '',
  draft: null,
  sending: false,
  completing: false,
  sendResult: null,
  chatText: null,
  next: null,
  shotForm: { role: null, page: '', other: '', device: 'phone', busy: false, result: null, error: '' },
  previewKey: '',
  resetConfirm: false,
  resetBusy: false,
  lastCard: null,
  pendingRender: false,
};

/* ------------------------------------------------------------------ API */

async function liveApi(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const type = res.headers.get('content-type') || '';
  const payload = type.includes('json') ? await res.json().catch(() => null) : await res.text();
  if (!res.ok) {
    const msg = payload && typeof payload === 'object' ? payload.error || payload.message : '';
    throw new ApiError(res.status, msg || `The QA server answered ${res.status}.`);
  }
  return payload;
}

function api(method, path, body) {
  return S.mode === 'mock' ? S.mock.handle(method, path, body ? structuredClone(body) : undefined) : liveApi(method, BASE + path, body);
}

function shotSrc(file) {
  if (!file) return '';
  if (S.mode === 'mock') {
    if (S.mock.blobs[file]) return S.mock.blobs[file];
    const shot = S.data.results.shots.find((s) => s.file === file) || guessShot(file);
    return mockShotSvg(shot);
  }
  return BASE + '/qa/' + String(file).split('/').map(encodeURIComponent).join('/');
}
function guessShot(file) {
  const m = /([a-z]+)-([a-z0-9_-]+?)-(phone|tablet|laptop)/.exec(file) || [];
  return { page: m[2] ? `${m[1]}/${m[2]}.html` : file, role: m[1] || ROLES[0], device: m[3] || 'laptop' };
}

/* ------------------------------------------------------------------ derived data */

const plan = () => S.data.plan;
const results = () => S.data.results;
const state = () => S.data.state;
const env = () => S.data.env || {};

function checkStatus(c) {
  if (c.status === 'pending' && !results().running) return 'notrun';
  if (S.progress && S.progress.id === c.id && results().running && (c.status === 'pending' || c.status === 'running')) return 'running';
  return c.status;
}

function counts() {
  const checks = results().checks || [];
  const manual = plan().manual || [];
  const ans = (m) => state().manual?.[m.id]?.answer;
  const autoOpen = checks.filter((c) => c.status === 'pending' || c.status === 'running').length;
  const c = {
    autoTotal: checks.length,
    autoOpen,
    autoPass: checks.filter((x) => x.status === 'pass' || x.status === 'flake').length,
    autoFail: checks.filter((x) => x.status === 'fail').length,
    autoWarn: checks.filter((x) => x.status === 'warn').length,
    manTotal: manual.length,
    manOpen: manual.filter((m) => !ans(m)).length,
    manWorks: manual.filter((m) => ans(m) === 'works').length,
    manBroken: manual.filter((m) => ans(m) === 'broken').length,
    manUnsure: manual.filter((m) => ans(m) === 'unsure').length,
  };
  c.passed = c.autoPass + c.manWorks;
  c.failed = c.autoFail + c.manBroken;
  c.todo = c.autoOpen + c.manOpen;
  const total = c.autoTotal + c.manTotal;
  c.pct = total ? Math.round(((total - c.todo) / total) * 100) : 0;
  c.checksDone = !results().running; // stopped counts as finished; not-run checks are listed as "not checked"
  c.ready = c.checksDone && c.manOpen === 0;
  return c;
}

function summary() { return S.data.summary || score(plan(), results(), state()); }

// Sign-in deep link from the project's login path ("{role}", "{page}"); without a page the query part holding
// {page} is dropped. No login path: the page itself. Live: same origin (Anvil proxies the app). Mock: env.origin.
function pageUrl(page) { return proj().pagePath.split('{page}').join(String(page || '').replace(/^\/+/, '')); }
function deepLink(role, page) {
  let t = proj().loginPath;
  let path;
  if (!t) path = pageUrl(page);
  else {
    if (!page) t = t.replace(/([?&])[^?&=#]*=\{page\}(&?)/, (m, sep, amp) => (amp ? sep : '')).split('{page}').join('');
    path = t.split('{role}').join(encodeURIComponent(role)).split('{page}').join(encodeURIComponent(page || ''));
  }
  return S.mode === 'mock' ? `${env().origin || ''}${path}` : path;
}
function roleHome(role) {
  return (plan().pages || []).find((p) => (p.roles || []).includes(role))?.page || (plan().pages || [])[0]?.page || '';
}

function shots() { return results().shots || []; }
function included(file) { return (state().include_shots || []).includes(file); }

/* ------------------------------------------------------------------ toasts */

function toast(msg, tone = 'default') {
  const box = $('#toasts');
  const t = h('div', { class: `toast toast-${tone}` }, icon(tone === 'error' ? 'alert' : tone === 'success' ? 'check' : 'info', 16), h('span', { text: msg }));
  box.appendChild(t);
  setTimeout(() => { t.classList.add('toast-out'); setTimeout(() => t.remove(), 250); }, 4200);
}

async function copyText(text, what = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} to the clipboard`, 'success');
  } catch {
    const ta = h('textarea', { class: 'sr-only', value: text });
    document.body.appendChild(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    toast(ok ? `${what} to the clipboard` : 'Could not copy. Select the text and press Ctrl+C.', ok ? 'success' : 'error');
  }
}

/* ------------------------------------------------------------------ small components */

function badge(status) {
  const s = STATUS[status] || STATUS.pending;
  return h('span', { class: `badge badge-${s.tone}` }, icon(s.icon, 13), s.label);
}

function chip(text, cls = '') { return h('span', { class: `chip ${cls}`, text }); }

function btn(label, { kind = 'secondary', iconName, onClick, disabled, size, title, type = 'button', cls = '', attrs = {} } = {}) {
  return h('button', { type, class: `btn btn-${kind} ${size ? 'btn-' + size : ''} ${cls}`, onClick, disabled, title, ...attrs }, iconName ? icon(iconName, size === 'lg' ? 20 : 16) : null, label ? h('span', { text: label }) : null);
}

function linkBtn(label, href, { kind = 'secondary', iconName = 'external', newTab = true, cls = '', download } = {}) {
  return h('a', { class: `btn btn-${kind} ${cls}`, href, target: newTab ? '_blank' : null, rel: newTab ? 'noopener noreferrer' : null, download }, h('span', { text: label }), iconName ? icon(iconName, 15) : null);
}

function progressBar(pct, label, tone = 'accent') {
  return h('div', { class: `progress progress-${tone}`, role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': pct, 'aria-label': label },
    h('div', { class: 'progress-fill', style: { width: `${Math.max(0, Math.min(100, pct))}%` } }));
}

function stars(value, size = 22, label) {
  const pct = Math.max(0, Math.min(5, value)) / 5 * 100;
  const row = () => h('span', { class: 'stars-row' }, [0, 1, 2, 3, 4].map(() => icon('star', size)));
  return h('span', { class: 'stars', role: 'img', 'aria-label': label || `${value} out of 5 stars` },
    h('span', { class: 'stars-empty' }, row()),
    h('span', { class: 'stars-full', style: { width: `${pct}%` } }, row()));
}

function empty(iconName, title, text, action) {
  return h('div', { class: 'empty' }, h('div', { class: 'empty-icon' }, icon(iconName, 22)), h('h3', { text: title }), text ? h('p', { text }) : null, action || null);
}

function pageHead(title, sub, actions) {
  return h('div', { class: 'page-head' }, h('div', { class: 'page-head-text' }, h('h1', { text: title }), sub ? h('p', { class: 'lead', text: sub }) : null), actions ? h('div', { class: 'page-head-actions' }, actions) : null);
}

function thumb(file, list, cls = '') {
  return h('button', { type: 'button', class: `thumb ${cls}`, 'aria-label': `Open screenshot ${file}`, onClick: () => openLightbox(file, list) },
    h('img', { src: shotSrc(file), alt: '', loading: 'lazy', decoding: 'async' }));
}

/* ------------------------------------------------------------------ top bar */

function renderTopbar() {
  const p = plan();
  const health = S.data.health || [];
  const bad = health.filter((x) => !x.ok);
  const top = $('#topbar');
  fill(top, 
    h('button', { type: 'button', class: 'icon-btn nav-toggle', 'aria-label': 'Open menu', 'aria-expanded': String(S.navOpen), 'aria-controls': 'sidenav', onClick: () => { S.navOpen = !S.navOpen; renderShell(); } }, icon('menu', 20)),
    h('a', { class: 'brand', href: '#overview', 'aria-label': 'Anvil', title: 'Anvil' }, brandMark(24)),
    h('div', { class: 'tb-title' },
      h('div', { class: 'tb-line1' },
        h('a', { class: 'tb-pr', href: env().prUrl || p.url, target: '_blank', rel: 'noopener noreferrer', title: 'Open the pull request on GitHub' }, `PR #${p.pr}`),
        h('span', { class: 'tb-name', text: p.title })),
      h('div', { class: 'tb-line2' },
        h('span', { class: 'tb-people' }, h('span', { text: p.author }), icon('arrowRight', 12), h('span', { text: p.tester })),
        h('span', { class: 'tb-sep', 'aria-hidden': 'true' }, '·'),
        h('code', { class: 'tb-commit', title: 'Commit being tested', text: String(p.commit || '').slice(0, 7) }),
        (p.lanes || []).map((l) => chip(l, 'chip-lane')))),
    h('div', { class: 'tb-right' },
      switchMenu(),
      S.mode === 'mock' ? h('span', { class: 'chip chip-mock', title: S.fallback ? 'The QA server did not answer, so this is sample data.' : 'Sample data (?mock=1)' }, 'Sample data') : null,
      h('div', { class: 'health' },
        h('button', { type: 'button', class: `health-btn ${bad.length ? 'has-bad' : ''}`, 'aria-expanded': String(S.healthOpen), 'aria-controls': 'health-panel', onClick: () => { S.healthOpen = !S.healthOpen; renderTopbar(); },
          'aria-label': bad.length ? `${plural(bad.length, 'problem')} with your setup. Show details` : 'Setup is healthy. Show details' },
          h('span', { class: 'dots' }, health.map((x) => h('span', { class: `dot ${x.ok ? 'dot-ok' : 'dot-bad'}`, title: `${HEALTH_NAME[x.id] || x.id}: ${x.ok ? 'OK' : 'problem'}` }))),
          h('span', { class: 'health-label', text: bad.length ? plural(bad.length, 'problem') : 'All good' })),
        S.healthOpen ? healthPanel(health) : null),
      h('button', { type: 'button', class: `icon-btn copilot-toggle ${S.copilotOpen ? 'is-on' : ''}`, 'aria-label': S.copilotOpen ? 'Hide co-pilot' : 'Show co-pilot', 'aria-expanded': String(S.copilotOpen), 'aria-controls': 'copilot', onClick: toggleCopilot }, icon('sparkles', 18), h('span', { class: 'copilot-toggle-label', text: 'Co-pilot' }))),
  );
}

// Anvil mark: plain black anvil silhouette (horn left, flat face, waist, wide base). Decorative; the link carries the name.
const ANVIL_PATH = 'M8 4.5H22.5V9H19L16.5 13.5H19L21.5 19.5H6.5L9 13.5H12L10.5 9C7 9 3.8 7.8 1 5.6C3.3 4.9 5.6 4.5 8 4.5Z';
function brandMark(size = 22) {
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', 'brand-mark');
  const anvil = document.createElementNS(SVGNS, 'path');
  anvil.setAttribute('d', ANVIL_PATH);
  anvil.setAttribute('fill', 'currentColor');
  svg.append(anvil);
  return svg;
}

// Other PRs assigned to this tester (from /api/next). Switching is done by Claude: "start anvil <n>".
function switchMenu() {
  const others = (S.next || []).filter((n) => Number(n.number) !== Number(plan().pr));
  if (!others.length) return null;
  return h('div', { class: 'switch-pr' },
    h('button', { type: 'button', class: 'btn btn-ghost btn-sm switch-btn', 'aria-expanded': String(S.switchOpen), 'aria-controls': 'switch-panel', onClick: () => { S.switchOpen = !S.switchOpen; S.healthOpen = false; renderTopbar(); } },
      icon('pr', 15), h('span', { class: 'switch-label', text: 'Switch PR' }), h('span', { class: 'nav-badge nb-grey', text: others.length })),
    S.switchOpen ? h('div', { class: 'popover switch-panel', id: 'switch-panel', role: 'dialog', 'aria-label': 'Other PRs assigned to you' },
      h('div', { class: 'popover-head' }, h('strong', { text: 'Also assigned to you' }), h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', onClick: () => { S.switchOpen = false; renderTopbar(); } }, icon('x', 16))),
      h('p', { class: 'muted small', text: 'To test another PR, go back to Claude Code and tell it the command shown. Anvil then reopens on that PR.' }),
      h('ul', { class: 'next-list' }, others.map((n) => h('li', { class: 'next-item' },
        h('div', null, h('a', { href: n.url, target: '_blank', rel: 'noopener noreferrer', class: 'strong-link', text: `#${n.number} ${n.title}` }), h('p', { class: 'muted small' }, 'Tell Claude: ', h('code', { text: `start anvil ${n.number}` }))),
        btn('', { size: 'sm', kind: 'ghost', iconName: 'copy', onClick: () => copyText(`start anvil ${n.number}`, 'Command copied'), attrs: { 'aria-label': `Copy start anvil ${n.number}` } }))))) : null);
}

function healthPanel(health) {
  return h('div', { class: 'popover health-panel', id: 'health-panel', role: 'dialog', 'aria-label': 'Setup health' },
    h('div', { class: 'popover-head' }, h('strong', { text: 'Your setup' }), h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', onClick: () => { S.healthOpen = false; renderTopbar(); } }, icon('x', 16))),
    health.length ? null : h('p', { class: 'muted', text: 'No health information yet.' }),
    health.map((x) => {
      const cmd = /`([^`]+)`/.exec(x.fix || '')?.[1];
      return h('div', { class: `health-item ${x.ok ? '' : 'is-bad'}` },
        h('span', { class: `dot ${x.ok ? 'dot-ok' : 'dot-bad'}`, 'aria-hidden': 'true' }),
        h('div', { class: 'health-body' },
          h('div', { class: 'health-name' }, h('strong', { text: HEALTH_NAME[x.id] || x.id }), h('span', { class: x.ok ? 'ok-text' : 'bad-text', text: x.ok ? 'OK' : 'Needs attention' })),
          h('p', { text: x.message }),
          !x.ok && x.fix ? h('p', { class: 'health-fix' }, h('strong', { text: 'How to fix: ' }), String(x.fix).split('`').map((part, i) => (i % 2 ? h('code', { text: part }) : part))) : null,
          !x.ok ? h('div', { class: 'row gap-s' },
            cmd ? btn('Copy command', { iconName: 'copy', size: 'sm', onClick: () => copyText(cmd, 'Command copied') }) : null,
            btn('Check again', { iconName: 'refresh', size: 'sm', onClick: recheckHealth })) : null));
    }));
}

async function recheckHealth() {
  try {
    const d = await api('GET', '/api/data');
    onData(d);
    const bad = (d.health || []).filter((x) => !x.ok).length;
    toast(bad ? `Still ${plural(bad, 'problem')}. Follow the steps shown.` : 'Everything is working now.', bad ? 'default' : 'success');
  } catch (e) { toast(e.message, 'error'); }
}

function toggleCopilot() {
  S.copilotOpen = !S.copilotOpen;
  store('copilot', S.copilotOpen);
  renderShell();
}

/* ------------------------------------------------------------------ side nav */

function renderNav() {
  const c = counts();
  const sent = !!state().sent;
  const badges = {
    auto: c.autoOpen ? { text: `${c.autoTotal - c.autoOpen}/${c.autoTotal}`, tone: 'indigo' } : c.autoFail ? { text: String(c.autoFail), tone: 'red' } : { text: '✓', tone: 'green' },
    manual: { text: `${c.manTotal - c.manOpen}/${c.manTotal}`, tone: c.manOpen ? 'grey' : 'green' },
    screens: { text: String(shots().length), tone: 'grey' },
  };
  const items = VIEWS.map((v) => (v.id === 'complete' && sent ? { id: 'sent', label: 'Sent', icon: 'check' } : v));
  fill($('#sidenav'), 
    h('div', { class: 'nav-head' }, h('span', { class: 'nav-kicker' }, h('span', { class: 'nav-mark', role: 'img', 'aria-label': 'Anvil' }, brandMark(18)), h('span', { text: `PR #${plan().pr}` })), h('button', { type: 'button', class: 'icon-btn nav-close', 'aria-label': 'Close menu', onClick: () => { S.navOpen = false; renderShell(); } }, icon('x', 18))),
    h('ul', { class: 'nav-list' }, items.map((v) => {
      const b = badges[v.id];
      const current = S.view === v.id || (v.id === 'sent' && S.view === 'complete');
      return h('li', null, h('a', { href: `#${v.id}`, class: `nav-item ${current ? 'is-current' : ''}`, 'aria-current': current ? 'page' : null },
        icon(v.icon, 18), h('span', { class: 'nav-label', text: v.label }), b ? h('span', { class: `nav-badge nb-${b.tone}`, text: b.text }) : null));
    })),
    h('div', { class: 'nav-foot' },
      h('div', { class: 'nav-progress' }, h('div', { class: 'row between' }, h('span', { text: 'Done' }), h('strong', { text: `${c.pct}%` })), progressBar(c.pct, 'Overall progress')),
      h('p', { class: 'nav-help', text: proj().helpText })),
  );
}

/* ------------------------------------------------------------------ co-pilot */

function statusLine() {
  const c = counts();
  if (S.conn === 'lost') return { tone: 'red', text: 'Lost the connection to the QA server. Trying again…' };
  if (results().running || S.progress) {
    const p = S.progress;
    if (p && p.total) return { tone: 'indigo', text: `Running checks: ${p.label || p.id} (${Math.min(p.done + 1, p.total)} of ${p.total})`, spin: true };
    return { tone: 'indigo', text: 'Running automatic checks…', spin: true };
  }
  if (state().sent) return { tone: 'green', text: 'Report sent. Nice work.' };
  if (results().stopped && notChecked().length) return { tone: 'grey', text: `Checks stopped. ${plural(notChecked().length, 'check')} did not run: run them or check them yourself.` };
  if (c.ready) return { tone: 'green', text: S.view === 'complete' ? 'Everything is answered. Rate the PR and send your report.' : 'Everything is answered. Go to Complete to send your report.' };
  if (c.manOpen) return { tone: 'grey', text: `Automatic checks finished. ${plural(c.manOpen, 'check')} of yours left.` };
  return { tone: 'grey', text: 'Automatic checks finished.' };
}

function renderCopilot() {
  const p = plan();
  const cp = p.copilot || {};
  const st = statusLine();
  const section = (title, items, iconName, cls = '') => (items && items.length ? h('section', { class: `cp-section ${cls}` }, h('h3', null, icon(iconName, 15), title), h('ul', null, items.map((t) => h('li', { text: t })))) : null);
  fill($('#copilot'), 
    h('div', { class: 'cp-head' }, h('div', { class: 'cp-title' }, icon('sparkles', 16), h('strong', { text: 'Co-pilot' })), h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Hide co-pilot', onClick: toggleCopilot }, icon('x', 16))),
    h('div', { class: `cp-status tone-${st.tone}`, role: 'status' }, st.spin ? icon('spin', 14) : h('span', { class: 'dot', 'aria-hidden': 'true' }), h('span', { text: st.text })),
    h('div', { class: 'cp-tip' }, h('div', { class: 'cp-tip-k', text: 'Tip for this screen' }), h('p', { text: (SCREEN_TIPS[S.view] || SCREEN_TIPS.overview).replace('{example}', proj().pageExample).replace('{chat}', proj().chatName) })),
    section('What this PR does', cp.summary, 'info'),
    section('Added by the developer', cp.extras, 'plus'),
    section('Security notes', cp.security, 'shield', 'cp-security'),
    section('Testing tips', cp.tips, 'sparkles'),
  );
}

/* ------------------------------------------------------------------ views */

function viewOverview() {
  const p = plan();
  const c = counts();
  const sum = summary();
  const sent = !!state().sent;
  const steps = [
    { title: 'Let the automatic checks finish', text: c.checksDone ? 'All automatic checks have finished.' : `They run by themselves: ${c.autoTotal - c.autoOpen} of ${c.autoTotal} done. You can start step 2 meanwhile.`, done: c.checksDone, go: 'auto', goLabel: 'See auto checks' },
    { title: 'Do your checks in the Test view', text: c.manOpen ? `${c.manTotal - c.manOpen} of ${c.manTotal} answered. Each one says exactly what to click.` : 'All of your checks are answered.', done: !c.manOpen, go: c.manOpen ? 'test' : 'manual', goLabel: c.manOpen ? 'Open Test view' : 'Review answers' },
    { title: 'Complete and send the report', text: sent ? 'Report sent.' : c.ready ? 'Ready. Rate the PR and send the report.' : 'Opens when steps 1 and 2 are done.', done: sent, go: sent ? 'sent' : 'complete', goLabel: sent ? 'See what was sent' : 'Complete testing', locked: !c.ready && !sent },
  ];
  const currentIdx = steps.findIndex((s) => !s.done);
  const cards = [
    { k: 'Passed', v: c.passed, sub: `${c.autoPass} auto · ${c.manWorks} yours`, tone: 'green', iconName: 'check' },
    { k: 'Failed', v: c.failed, sub: c.autoWarn ? `+ ${plural(c.autoWarn, 'warning')}` : 'No warnings', tone: 'red', iconName: 'x' },
    { k: 'To do', v: c.todo, sub: `${c.autoOpen} auto · ${c.manOpen} yours`, tone: 'grey', iconName: 'clock' },
  ];
  const roleLinks = env().roleLinks || {};
  const links = [
    { label: `Pull request #${p.pr}`, href: env().prUrl || p.url, iconName: 'pr', sub: p.branch },
    p.issue ? { label: `Issue #${p.issue.number}`, href: env().issueUrl || p.issue.url, iconName: 'info', sub: 'What was asked for' } : null,
    env().ciUrl ? { label: 'CI checks on GitHub', href: env().ciUrl, iconName: 'ci', sub: 'Build and test runs' } : null,
    p.review_note ? { label: 'Review note', href: env().reviewNoteUrl || '#', iconName: 'file', sub: p.review_note } : null,
  ].filter(Boolean);

  return h('div', { class: 'view' },
    pageHead('Welcome to Anvil', `You are testing PR #${p.pr} “${p.title}” by ${p.author}. Follow the three steps below. Everything you need is right here.`),
    sum.blockers?.length ? h('div', { class: 'alert alert-red', role: 'alert' }, icon('alert', 18), h('div', null, h('strong', { text: `${plural(sum.blockers.length, 'blocker')} found` }), h('ul', null, sum.blockers.map((b) => h('li', { text: b.text }))), h('a', { href: '#auto', text: 'See the details in Auto checks' }))) : null,
    h('div', { class: 'stat-grid' },
      cards.map((x) => h('div', { class: `stat-card tone-${x.tone}` }, h('div', { class: 'stat-top' }, h('span', { class: 'stat-k', text: x.k }), h('span', { class: 'stat-icon' }, icon(x.iconName, 15))), h('div', { class: 'stat-v', text: x.v }), h('div', { class: 'stat-sub', text: x.sub }))),
      h('div', { class: 'stat-card stat-pct' }, h('div', { class: 'stat-top' }, h('span', { class: 'stat-k', text: 'Done' }), h('span', { class: 'stat-icon' }, icon('zap', 15))), h('div', { class: 'stat-v', text: `${c.pct}%` }), progressBar(c.pct, 'Percent done'))),
    h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', { text: 'Start here' }), h('span', { class: 'muted small', text: sent ? 'All done' : `Step ${currentIdx + 1} of 3` })),
      h('ol', { class: 'steps' }, steps.map((s, i) => {
        const st = s.done ? 'done' : i === currentIdx ? 'current' : 'upcoming';
        return h('li', { class: `step step-${st}` },
          h('span', { class: 'step-num', 'aria-hidden': 'true' }, s.done ? icon('check', 15) : String(i + 1)),
          h('div', { class: 'step-body' }, h('h3', null, s.title, h('span', { class: 'sr-only', text: s.done ? ' (done)' : st === 'current' ? ' (current step)' : '' })), h('p', { text: s.text })),
          s.locked ? h('span', { class: 'chip', text: 'Locked' }) : h('a', { class: `btn ${st === 'current' ? 'btn-primary' : 'btn-secondary'} btn-sm`, href: `#${s.go}` }, h('span', { text: s.goLabel }), icon('arrowRight', 14)));
      }))),
    h('div', { class: 'grid-2' },
      h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', { text: 'Focus for this module' }), chip(p.module || 'module', 'chip-accent')),
        p.focus?.length ? h('ul', { class: 'focus-list' }, p.focus.map((f) => h('li', null, icon('arrowRight', 14), h('span', { text: f })))) : empty('info', 'No focus notes', 'Claude did not add focus notes for this PR.')),
      h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', { text: `Open ${proj().appName} as` })),
        h('p', { class: 'muted small', text: `Each button opens ${proj().appName} right here in the Test view, already signed in as that person.` }),
        h('div', { class: 'role-grid' }, ROLES.map((r) => h('button', { type: 'button', class: 'role-btn', onClick: () => { TV.role = r; TV.page = roleHome(r); if (TV.frame && S.view === 'test') tvNavigate({ role: r, page: TV.page }); location.hash = '#test'; } }, h('span', { class: `avatar ${avClass(r)}`, 'aria-hidden': 'true', text: r[0].toUpperCase() }), h('span', { class: 'role-name', text: cap(r) }), icon('monitor', 14)))))),
    h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', { text: 'Links' })),
      h('div', { class: 'link-grid' }, links.map((l) => h('a', { class: 'link-card', href: l.href, target: '_blank', rel: 'noopener noreferrer' }, h('span', { class: 'link-icon' }, icon(l.iconName, 16)), h('span', { class: 'link-text' }, h('strong', { text: l.label }), h('span', { class: 'muted small', text: l.sub || '' })), icon('external', 14))))),
  );
}

/* ---- live run: log console, stop, "check it myself" */

const RUN = {
  log: [], maxN: 0, paused: false, filter: 'all', latest: null,
  stopConfirm: false, stopping: false, expanded: new Set(), mine: null, note: {}, started: {}, busy: {},
};

function checkById(id) { return (results().checks || []).find((c) => c.id === id) || null; }
function notChecked() { return (results().checks || []).filter((c) => (c.status === 'pending' || c.status === 'stopped') && !c.override); }

function currentRun() {
  const cur = results().current;
  if (results().running && cur && cur.id) return { id: cur.id, label: cur.label || checkById(cur.id)?.name || cur.id, started: cur.started || RUN.started[cur.id] };
  const p = S.progress;
  if (results().running && p && p.id) return { id: p.id, label: p.label || p.id, started: RUN.started[p.id] };
  return null;
}

function fmtElapsed(iso) {
  if (!iso) return '';
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  return s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function elapsedEl(iso) { return h('span', { class: 'elapsed js-elapsed', 'data-start': iso || '', text: fmtElapsed(iso) }); }

function lineTone(l) {
  const t = String(l.text || '');
  if (l.type === 'shot') return 'shot';
  if (/\b(FAIL|failed|error|errors?:|stopped)\b/i.test(t) && !/\b0 (failed|errors)\b/i.test(t)) return 'fail';
  if (/^(ok\b|Passed)|\bok\b|loaded in|answered 2\d\d|\bbuilt\b|finished/i.test(t)) return 'ok';
  return 'info';
}
function fmtClock(iso) {
  const d = new Date(iso || Date.now());
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function logLineEl(l, showId = true) {
  return h('div', { class: `log-line lt-${lineTone(l)}` }, h('span', { class: 'log-time', text: fmtClock(l.at) }), showId ? h('span', { class: 'log-id', text: l.id || '' }) : null, h('span', { class: 'log-text', text: l.text }));
}
const matchFilter = (filter, l) => filter === 'all' || l.id === filter || (filter === 'A1' && /^A[23]-/.test(l.id || ''));

function logConsole(filter, cls = '') {
  const lines = RUN.log.filter((l) => matchFilter(filter, l)).slice(-400);
  const el = h('div', { class: `log-console ${cls}`, 'data-filter': filter, role: 'log', 'aria-label': filter === 'all' ? 'Run log' : `Log for ${filter}`, tabindex: 0 },
    lines.length ? lines.map((l) => logLineEl(l, filter === 'all')) : h('div', { class: 'log-empty', text: results().running ? 'Waiting for the first log line\u2026' : 'No log lines yet for this.' }));
  requestAnimationFrame(() => { if (!RUN.paused || cls.includes('check-log')) el.scrollTop = el.scrollHeight; });
  return el;
}

function addLog(lines) {
  const fresh = [];
  for (const l of lines || []) {
    if (!l || !l.text) continue;
    if (l.n != null) { if (l.n <= RUN.maxN) continue; RUN.maxN = l.n; }
    const line = { n: l.n, id: l.id || '', text: String(l.text), at: l.at || new Date().toISOString(), type: l.type || 'log' };
    RUN.log.push(line);
    fresh.push(line);
  }
  if (RUN.log.length > 2000) RUN.log.splice(0, RUN.log.length - 2000);
  if (!fresh.length) return;
  if (S.view === 'auto' && !document.querySelector('.lp-console')) { render(); return; }
  document.querySelectorAll('.log-console').forEach((el) => {
    const f = el.dataset.filter;
    const add = fresh.filter((l) => matchFilter(f, l));
    if (!add.length) return;
    el.querySelector('.log-empty')?.remove();
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    for (const l of add) el.appendChild(logLineEl(l, f === 'all'));
    while (el.childElementCount > 400) el.firstElementChild.remove();
    const follow = el.classList.contains('check-log') ? atBottom : !RUN.paused;
    if (follow) el.scrollTop = el.scrollHeight;
  });
  document.querySelectorAll('.js-log-count').forEach((el) => { el.textContent = plural(RUN.log.length, 'line'); });
  for (const l of fresh) {
    document.querySelectorAll(`.js-check-log-n[data-id="${CSS.escape(l.id)}"]`).forEach((el) => { el.textContent = String(RUN.log.filter((x) => x.id === l.id).length); });
  }
  updateStrip();
}

async function loadLog() {
  try {
    const r = await api('GET', `/api/log?after=${RUN.maxN}`);
    addLog(r.lines || []);
  } catch { /* older server: no log endpoint */ }
}

function onLog(ev) { if (ev) addLog([ev]); }
function onShot(ev) {
  if (!ev || !ev.file) return;
  RUN.latest = { id: ev.id, file: ev.file, at: new Date().toISOString() };
  if (!RUN.log.some((l) => l.type === 'shot' && l.text.includes(ev.file))) addLog([{ id: ev.id, text: `screenshot ${ev.file}`, type: 'shot' }]);
  document.querySelectorAll('.js-live-shot').forEach((el) => el.replaceWith(liveShot()));
}

function latestShot() {
  if (RUN.latest) return RUN.latest;
  const s = [...shots()].reverse().find((x) => x.source === 'auto');
  return s ? { id: '', file: s.file, at: s.at } : null;
}
function liveShot() {
  const s = latestShot();
  if (!s) return h('div', { class: 'live-shot js-live-shot is-empty' }, icon('image', 18), h('span', { class: 'small muted', text: 'The latest screenshot shows here.' }));
  const meta = shots().find((x) => x.file === s.file);
  return h('button', { type: 'button', class: 'live-shot js-live-shot', 'aria-label': 'Open the latest screenshot', onClick: () => openLightbox(s.file, [s.file]) },
    h('img', { src: shotSrc(s.file), alt: '' }),
    h('span', { class: 'live-shot-cap' }, h('span', { class: 'live-dot', 'aria-hidden': 'true' }), meta ? `${meta.page} \u00b7 ${cap(meta.role)} \u00b7 ${cap(meta.device)}` : String(s.file).replace(/^shots\//, '')));
}

function stopControls(compact = false) {
  if (RUN.stopping) return h('span', { class: 'row gap-s small muted' }, icon('spin', 14), 'Stopping\u2026 this can take up to 10 seconds');
  if (RUN.stopConfirm) {
    return h('div', { class: `stop-confirm ${compact ? 'is-compact' : ''}`, role: 'alertdialog', 'aria-label': 'Stop the checks?' },
      h('span', { text: 'Stop the checks? Finished results are kept.' }),
      btn('Keep running', { size: 'sm', kind: 'ghost', onClick: () => { RUN.stopConfirm = false; render(); } }),
      btn('Stop checks', { size: 'sm', kind: 'danger', iconName: 'square', onClick: doStop, cls: 'js-stop-yes' }));
  }
  return btn('Stop', { size: 'sm', kind: 'danger-outline', iconName: 'square', onClick: () => { RUN.stopConfirm = true; render(); $('.js-stop-yes')?.focus(); }, attrs: { 'aria-label': 'Stop the automatic checks' } });
}

async function doStop() {
  RUN.stopConfirm = false; RUN.stopping = true; render();
  try {
    await api('POST', '/api/stop');
    toast('Checks stopped. Finished results are kept.', 'success');
  } catch (e) {
    toast(e.status === 404 ? 'This Anvil server cannot stop checks yet. Ask in Claude Code to stop them.' : e.message, 'error');
  }
  RUN.stopping = false;
  try { onData(await api('GET', '/api/data')); } catch { render(); }
}

function runProgress() {
  const r = results();
  const p = S.progress;
  const checks = r.checks || [];
  if (r.running && p && p.total) return { done: Math.min(p.done, p.total), total: p.total };
  const done = checks.filter((x) => x.status !== 'pending' && x.status !== 'running').length;
  return { done, total: checks.length };
}

function livePanel() {
  const r = results();
  const running = !!r.running;
  const cur = currentRun();
  const pr = runProgress();
  const pct = pr.total ? Math.round((pr.done / pr.total) * 100) : 0;
  const nc = notChecked();
  const ids = [...new Set(RUN.log.map((l) => l.id).filter(Boolean))];
  if (RUN.filter !== 'all' && !ids.includes(RUN.filter)) RUN.filter = 'all';
  const head = running
    ? h('div', { class: 'lp-title' }, icon('spin', 16), h('div', null, h('strong', { text: cur ? `Checking ${cur.label}` : 'Starting the checks\u2026' }), h('div', { class: 'muted small' }, cur ? ['Running for ', elapsedEl(cur.started)] : 'Preparing', ` \u00b7 ${pr.done} of ${pr.total} done`)))
    : r.stopped
      ? h('div', { class: 'lp-title' }, h('span', { class: 'lp-icon is-stopped' }, icon('square', 14)), h('div', null, h('strong', { text: `Stopped at ${timeAgo(r.stopped)}` }), h('div', { class: 'muted small', text: `Finished results are kept. ${nc.length ? `${plural(nc.length, 'check')} did not run.` : ''}` })))
      : h('div', { class: 'lp-title' }, h('span', { class: 'lp-icon is-done' }, icon('check', 14)), h('div', null, h('strong', { text: r.finished ? `All checks finished at ${timeAgo(r.finished)}` : 'Automatic checks' }), h('div', { class: 'muted small', text: `${pr.done} of ${pr.total} done` })));
  const actions = running ? stopControls()
    : h('div', { class: 'row gap-s wrap' },
      nc.length ? btn(`Run remaining (${nc.length})`, { size: 'sm', kind: 'primary', iconName: 'play', onClick: () => rerun(nc.map((x) => x.id).join(',')) }) : null,
      btn('Run again', { size: 'sm', kind: 'secondary', iconName: 'refresh', onClick: () => rerun(null) }));
  const body = (running || RUN.log.length) ? h('div', { class: 'lp-body' },
    h('div', { class: 'lp-log' },
      h('div', { class: 'lp-toolbar' },
        h('label', { class: 'select-wrap' }, h('span', { class: 'sr-only', text: 'Show log for' }), h('select', { class: 'select select-sm', name: 'log-filter', onChange: (e) => { RUN.filter = e.target.value; renderMain(); } },
          h('option', { value: 'all', text: 'All checks' }), ids.map((id) => h('option', { value: id, text: checkById(id)?.name ? `${checkById(id).name}` : id, selected: RUN.filter === id })))),
        h('button', { type: 'button', class: `btn btn-sm btn-ghost ${RUN.paused ? 'is-on' : ''}`, 'aria-pressed': String(RUN.paused), onClick: () => { RUN.paused = !RUN.paused; renderMain(); } }, icon(RUN.paused ? 'play' : 'pause', 14), h('span', { text: RUN.paused ? 'Resume scroll' : 'Pause scroll' })),
        h('span', { class: 'muted small js-log-count', text: plural(RUN.log.length, 'line') })),
      logConsole(RUN.filter, 'lp-console')),
    h('div', { class: 'lp-side' }, h('div', { class: 'mini-h', text: 'Latest screenshot' }), liveShot()))
    : null;
  return h('section', { class: `card live-panel ${running ? 'is-running' : ''}`, 'aria-label': 'Live run' },
    h('div', { class: 'lp-head' }, head, h('div', { class: 'lp-actions' }, actions)),
    progressBar(running ? pct : (pr.total ? Math.round(((pr.total - nc.length) / pr.total) * 100) : 0), 'Run progress', running ? 'accent' : r.stopped ? 'amber' : 'green'),
    body);
}

/* ---- the Test view strip while running */
function updateStrip() {
  if (!TV.strip || S.view !== 'test') return;
  const running = !!results().running;
  TV.strip.hidden = !running && !RUN.stopping;
  if (TV.strip.hidden) { fill(TV.strip, ); return; }
  const cur = currentRun();
  const pr = runProgress();
  const last = [...RUN.log].reverse().find((l) => !cur || l.id === cur.id);
  fill(TV.strip, 
    icon('spin', 14),
    h('strong', { class: 'tvs-label', text: cur ? cur.label : 'Running checks' }),
    cur ? elapsedEl(cur.started) : null,
    last ? h('span', { class: 'tvs-last muted', text: last.text }) : h('span', { class: 'tvs-last' }),
    h('span', { class: 'tvs-bar' }, progressBar(pr.total ? Math.round((pr.done / pr.total) * 100) : 0, 'Run progress')),
    h('span', { class: 'muted small tvs-n', text: `${pr.done}/${pr.total}` }),
    h('a', { class: 'btn btn-ghost btn-sm', href: '#auto' }, icon('file', 14), h('span', { class: 'rb-text', text: 'Log' })),
    stopControls(true),
  );
}

/* ---- "Check it myself" */

// Check ids carry the page either as "member/notes.html" or with / turned into - ("member-notes.html").
function planPage(raw) {
  const pages = plan().pages || [];
  const hit = pages.find((pg) => pg.page === raw || pg.page.replace(/\//g, '-') === raw);
  if (hit) return hit.page;
  if (raw.includes('/')) return raw;
  const folder = ROLES.find((r) => raw.startsWith(r + '-'));
  return folder ? raw.replace(folder + '-', folder + '/') : raw;
}

function checkTarget(x) {
  const p = plan();
  const pr = p.pr;
  const cmds = proj().commands;
  const rerunCmd = { label: 'Run just this check again', cmd: `${cmds.rerun || `anvil-run --pr ${pr}`} --only=${x.id}` };
  let m;
  if ((m = /^([PL])-(.+)-([a-z]+)$/.exec(x.id))) {
    return { kind: 'page', page: planPage(m[2]), role: m[3], device: m[1] === 'L' ? 'phone' : 'laptop',
      look: m[1] === 'L' ? 'At phone width the page must not scroll sideways. Swipe or scroll left and right: nothing should be cut off.' : 'The page loads fully, shows no error message, and has no leftover sample names (like "John Doe"). Check the errors badge in the ribbon too.' };
  }
  if ((m = /^X-(.+)$/.exec(x.id))) {
    const page = planPage(m[1]);
    const role = (p.pages || []).find((pg) => pg.page === page)?.roles?.[0] || ROLES[0];
    return { kind: 'page', page, role, device: 'laptop', look: 'Every button and link says what it does (hover icons: there should be a label), images have descriptions, and form fields have labels.' };
  }
  if ((m = /^R-(.+)$/.exec(x.id))) {
    const a = (p.access || []).find((y) => y.id === m[1]);
    if (a) {
      const role = a.as === 'anon' ? (TV.role || ROLES[0]) : a.as;
      return { kind: 'page', page: roleHome(role), role, device: 'laptop', look: `${a.name}. As ${a.as === 'anon' ? 'a signed-out visitor' : cap(a.as)}, ${a.method} ${a.path} should answer ${[].concat(a.expect).join(' or ')}. Try to reach that data in the app: it must be blocked.` };
    }
  }
  if ((m = /^F-(.+)$/.exec(x.id))) {
    const fl = (p.flags || []).find((y) => y.id === m[1]);
    if (fl) return { kind: 'page', page: roleHome(fl.as), role: fl.as, device: 'laptop', look: `With the feature flag ${fl.flag} off the feature must be hidden; with it on it must work.` };
  }
  if (x.id === 'A1' || /^A[23]-/.test(x.id)) {
    const file = /^A[23]-(.+)$/.exec(x.id)?.[1];
    return { kind: 'cmd', look: file ? `Run the test file ${file} and read its output. "ok" lines passed; "FAIL" lines explain what broke.` : 'Run the project tests and read the last line: it says how many tests ran and how many failed.',
      cmds: [file ? { label: 'Run this test file', cmd: `${cmds.rerun || `anvil-run --pr ${pr}`} --only=A1 --test-filter=${file}` } : cmds.tests ? { label: 'Run the test suite', cmd: cmds.tests } : null, rerunCmd].filter(Boolean) };
  }
  if (x.id === 'A4') return { kind: 'cmd', look: 'Open the CI page on GitHub and see which job is red. Red only for reasons unrelated to the code (for example a timeout) can be marked as pass with a note.', cmds: [{ label: 'List the CI checks', cmd: cmds.ci || `gh pr checks ${pr}` }], link: env().ciUrl };
  if (x.id === 'A5') return { kind: 'cmd', look: 'Run the build. It must end without errors.', cmds: [cmds.build ? { label: 'Build the app', cmd: cmds.build } : null, rerunCmd].filter(Boolean) };
  return { kind: 'cmd', look: 'Run the check again and read its log.', cmds: [rerunCmd] };
}

function openAutoInView(x) {
  const t = checkTarget(x);
  if (t.kind !== 'page') return;
  TV.autoCheck = x.id;
  TV.drawerOpen = true;
  TV.rotated = false;
  if (t.device !== TV.device) { TV.device = t.device; logEvent({ type: 'device', device: t.device }); }
  if (S.view !== 'test') { TV.page = t.page; TV.role = t.role; location.hash = '#test'; }
  else { layoutFrame(); tvNavigate({ page: t.page, role: t.role }); updateTestView(); }
}

function overrideBar(x) {
  const ov = x.override;
  const note = RUN.note[x.id] ?? ov?.note ?? '';
  const busy = !!RUN.busy[x.id];
  return h('div', { class: 'override-bar' },
    h('label', { class: 'field-label', for: `ovn-${x.id}`, text: 'What did you see? (goes into the report)' }),
    h('input', { id: `ovn-${x.id}`, name: `override-note-${x.id}`, class: 'input', type: 'text', value: note, maxlength: 500, placeholder: 'For example: page loads fine, the error was a slow API', onInput: (e) => { RUN.note[x.id] = e.target.value; } }),
    h('div', { class: 'row gap-s wrap' },
      btn('Mark as pass', { size: 'sm', kind: 'ok-outline', iconName: 'check', disabled: busy, onClick: () => setOverride(x.id, 'pass'), cls: ov?.status === 'pass' ? 'is-on' : '' }),
      btn('Mark as fail', { size: 'sm', kind: 'danger-outline', iconName: 'x', disabled: busy, onClick: () => setOverride(x.id, 'fail'), cls: ov?.status === 'fail' ? 'is-on' : '' }),
      ov ? btn('Undo', { size: 'sm', kind: 'ghost', iconName: 'reset', disabled: busy, onClick: () => setOverride(x.id, null) }) : null,
      ov ? h('span', { class: 'small muted', text: `You marked it ${ov.status === 'pass' ? 'passed' : 'failed'} at ${timeAgo(ov.at)}` }) : null));
}

async function setOverride(id, status) {
  const c = checkById(id);
  if (!c) return;
  const note = (RUN.note[id] ?? c.override?.note ?? '').trim();
  if (status === 'fail' && !note) { toast('Please write what you saw, so the developer knows what to fix.', 'error'); document.getElementById(`ovn-${id}`)?.focus(); return; }
  const before = { status: c.status, auto_status: c.auto_status, override: c.override };
  if (status == null) { c.status = c.auto_status || c.status; delete c.override; delete c.auto_status; }
  else { c.auto_status = c.auto_status || c.status; c.status = status; c.override = { status, note, at: new Date().toISOString() }; }
  S.data.summary = score(plan(), results(), state());
  RUN.busy[id] = true;
  render();
  try {
    await api('POST', '/api/override', { id, status, note });
    if (status == null) delete RUN.note[id];
    toast(status == null ? 'Back to the automatic result.' : `Marked as ${status === 'pass' ? 'passed' : 'failed'} by you.`, 'success');
  } catch (e) {
    Object.assign(c, before);
    if (!before.override) { delete c.override; delete c.auto_status; }
    toast(e.status === 404 ? 'This Anvil server cannot save your result yet. Ask in Claude Code.' : e.message, 'error');
  }
  RUN.busy[id] = false;
  render();
}

function minePanel(x) {
  const t = checkTarget(x);
  return h('div', { class: 'mine-panel' },
    h('div', { class: 'row between' }, h('h3', { class: 'mini-h', text: 'Check it yourself' }), h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', onClick: () => { RUN.mine = null; renderMain(); } }, icon('x', 15))),
    h('p', { class: 'small', text: t.look }),
    t.kind === 'page'
      ? h('div', { class: 'row gap-s wrap' }, btn(`Open ${t.page} as ${cap(t.role)} (${t.device})`, { size: 'sm', kind: 'primary', iconName: 'monitor', onClick: () => openAutoInView(x) }))
      : h('div', { class: 'cmd-list' },
        h('p', { class: 'small muted', text: 'Run this in a terminal in the repo folder (or ask Claude Code to run it), then read the output below.' }),
        (t.cmds || []).map((cm) => h('div', { class: 'cmd' }, h('span', { class: 'small muted', text: cm.label }), h('div', { class: 'cmd-row' }, h('code', { class: 'cmd-code', text: cm.cmd }), btn('', { size: 'sm', kind: 'ghost', iconName: 'copy', onClick: () => copyText(cm.cmd, 'Command copied'), attrs: { 'aria-label': `Copy: ${cm.cmd}` } })))),
        t.link ? linkBtn('Open CI on GitHub', t.link, { kind: 'secondary', cls: 'btn-sm' }) : null,
        logConsole(x.id, 'check-log')),
    overrideBar(x));
}

/* ---- auto checks screen */

function viewAuto() {
  const r = results();
  const checks = r.checks || [];
  const running = !!r.running;
  const head = pageHead('Automatic checks', 'These run by themselves and only report facts (tests, the server and the browser). If something looks wrong, use \u201cCheck it myself\u201d and mark the result.');
  if (!checks.length) {
    return h('div', { class: 'view' }, head, livePanel(), empty(running ? 'spin' : 'zap', running ? 'Starting the checks\u2026' : 'No checks yet', running ? 'The first results will appear here in a few seconds.' : 'Press \u201cRun again\u201d to start them.'));
  }
  const groups = GROUPS.map((g) => ({ ...g, items: checks.filter((x) => x.group === g.name) })).filter((g) => g.items.length);
  const other = checks.filter((x) => !GROUPS.some((g) => g.name === x.group));
  if (other.length) groups.push({ name: 'Other', prefix: null, about: '', items: other });
  return h('div', { class: 'view' }, head, livePanel(),
    h('div', { class: 'legend' }, ['pass', 'fail', 'flake', 'preexisting', 'warn', 'skip', 'stopped'].map((s) => badge(s))),
    groups.map((g) => {
      const fails = g.items.filter((x) => x.status === 'fail').length;
      const open = g.items.filter((x) => x.status === 'pending' || x.status === 'running' || (x.status === 'stopped' && !x.override)).length;
      return h('section', { class: 'card group', 'aria-labelledby': `g-${g.name}` },
        h('div', { class: 'card-head' },
          h('div', null, h('h2', { id: `g-${g.name}`, text: g.name }), g.about ? h('p', { class: 'muted small group-about', text: g.about }) : null),
          h('div', { class: 'row gap-s' },
            h('span', { class: `chip ${fails ? 'chip-red' : open ? '' : 'chip-green'}`, text: fails ? `${fails} failed` : open ? (running ? `${open} waiting` : `${open} not run`) : 'All done' }),
            g.prefix ? btn('Re-run', { size: 'sm', kind: 'ghost', iconName: 'refresh', disabled: running, onClick: () => rerun(g.prefix), attrs: { 'aria-label': `Re-run ${g.name} checks` } }) : null)),
        h('ul', { class: 'check-list' }, g.items.map((x) => checkRow(x, running))));
    }));
}

function checkRow(x, running) {
  const st = checkStatus(x);
  const ov = x.override;
  const nLog = RUN.log.filter((l) => l.id === x.id).length;
  const open = RUN.expanded.has(x.id);
  const mine = RUN.mine === x.id;
  const autoSt = x.auto_status || null;
  return h('li', { class: `check st-${st} ${ov ? 'is-mine' : ''}`, id: `chk-${x.id}` },
    h('div', { class: 'check-main' },
      h('div', { class: 'check-top' },
        ov ? h('span', { class: `badge badge-${ov.status === 'pass' ? 'green' : 'red'} badge-mine` }, icon('user', 13), `Checked by you: ${ov.status === 'pass' ? 'Passed' : 'Failed'}`) : badge(st),
        ov && autoSt ? h('s', { class: 'auto-struck', title: 'Automatic result' }, `Auto: ${(STATUS[autoSt] || STATUS.pending).label}`) : null,
        h('span', { class: 'check-name', text: x.name }),
        x.blocker && x.status === 'fail' ? chip('Blocker', 'chip-red-solid') : null),
      ov?.note ? h('p', { class: 'check-note' }, h('strong', { text: 'Your note: ' }), ov.note) : null,
      x.detail ? h('p', { class: `check-detail ${ov ? 'is-struck' : ''}`, text: x.detail }) : st === 'running' ? h('p', { class: 'check-detail muted', text: 'Checking now\u2026' }) : st === 'pending' ? h('p', { class: 'check-detail muted', text: 'Waiting for its turn.' }) : st === 'notrun' ? h('p', { class: 'check-detail muted', text: 'Did not run. Run it, or check it yourself.' }) : null,
      h('div', { class: 'check-meta' }, chip(AREA_NAME[x.area] || x.area || 'general', 'chip-soft'), x.ms ? h('span', { class: 'muted small', text: `${(x.ms / 1000).toFixed(1)} s` }) : null, h('code', { class: 'muted small check-id', text: x.id })),
      x.shots?.length ? h('div', { class: 'thumbs' }, x.shots.slice(0, 4).map((f) => thumb(f, x.shots, 'thumb-sm'))) : null),
    h('div', { class: 'check-actions' },
      h('button', { type: 'button', class: `btn btn-ghost btn-sm ${open ? 'is-on' : ''}`, 'aria-expanded': String(open), onClick: () => { if (open) RUN.expanded.delete(x.id); else RUN.expanded.add(x.id); renderMain(); } },
        icon('file', 14), h('span', { text: 'Log' }), h('span', { class: 'nav-badge nb-grey js-check-log-n', 'data-id': x.id, text: nLog })),
      h('button', { type: 'button', class: `btn btn-sm ${mine ? 'btn-primary' : 'btn-secondary'}`, 'aria-expanded': String(mine), onClick: () => { RUN.mine = mine ? null : x.id; renderMain(); if (!mine) setTimeout(() => document.getElementById(`ovn-${x.id}`)?.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' }), 30); } },
        icon('user', 14), h('span', { text: 'Check it myself' })),
      btn('Re-run', { size: 'sm', kind: 'ghost', iconName: 'refresh', disabled: running, onClick: () => rerun(x.id), attrs: { 'aria-label': `Re-run ${x.name}` } })),
    open || mine ? h('div', { class: 'check-expand' }, open ? logConsole(x.id, 'check-log') : null, mine ? minePanel(x) : null) : null);
}

async function rerun(only) {
  try {
    await api('POST', '/api/run', only ? { only } : {});
    RUN.stopConfirm = false;
    toast(only ? 'Running. Watch the live log above.' : 'Running all checks again.', 'default');
  } catch (e) {
    toast(e.status === 409 ? 'Checks are already running. Wait for them to finish, or stop them first.' : e.message, 'error');
  }
}

function notCheckedCard() {
  const nc = notChecked();
  if (!nc.length) return null;
  return h('section', { class: 'card nc-card' },
    h('div', { class: 'card-head wrap' }, h('h2', null, icon('alert', 16), `Not checked (${nc.length})`),
      btn(`Run remaining (${nc.length})`, { size: 'sm', kind: 'secondary', iconName: 'play', disabled: !!results().running, onClick: () => rerun(nc.map((x) => x.id).join(',')) })),
    h('p', { class: 'muted small', text: 'These automatic checks were stopped or never ran. The report will say "not checked" for them. You can run them, or check them yourself and mark the result.' }),
    h('ul', { class: 'nc-list' }, nc.map((x) => h('li', null, badge(checkStatus(x)), h('span', { class: 'nc-name', text: x.name }), h('a', { class: 'btn btn-ghost btn-sm', href: `#auto/${encodeURIComponent(x.id)}` }, icon('user', 14), h('span', { text: 'Check it myself' }))))));
}
function viewManual() {
  const p = plan();
  const c = counts();
  const items = (p.manual || []).filter((m) => S.manualFilter === 'all' || !state().manual?.[m.id]?.answer);
  const pct = c.manTotal ? Math.round(((c.manTotal - c.manOpen) / c.manTotal) * 100) : 100;
  return h('div', { class: 'view' },
    pageHead('Your checks', 'These need a human. For each one: open the page with the button, follow the steps, then say if it works. If it is broken, write what you saw and add a screenshot.'),
    h('div', { class: 'card manual-progress' },
      h('div', { class: 'row between wrap gap-s' }, h('strong', { text: `${c.manTotal - c.manOpen} of ${c.manTotal} answered` }),
        h('div', { class: 'seg', role: 'group', 'aria-label': 'Show' }, [['all', 'All'], ['open', 'Not answered']].map(([id, label]) => h('button', { type: 'button', class: `seg-btn ${S.manualFilter === id ? 'is-on' : ''}`, 'aria-pressed': String(S.manualFilter === id), onClick: () => { S.manualFilter = id; renderMain(); } }, label)))),
      progressBar(pct, 'Your checks answered', c.manOpen ? 'accent' : 'green'),
      h('div', { class: 'row gap-m wrap small muted' }, h('span', null, h('span', { class: 'dot dot-ok' }), ` ${c.manWorks} works`), h('span', null, h('span', { class: 'dot dot-bad' }), ` ${c.manBroken} broken`), h('span', null, h('span', { class: 'dot dot-warn' }), ` ${c.manUnsure} not sure`))),
    !(p.manual || []).length ? empty('clipboard', 'No manual checks for this PR', 'Claude did not find anything that needs a human. You can go straight to Complete.') : null,
    (p.manual || []).length && !items.length ? empty('check', 'All answered', 'Every check has an answer. Switch to “All” to review them, or go to Complete.', h('a', { class: 'btn btn-primary', href: '#complete' }, 'Go to Complete')) : null,
    items.map((m) => manualCard(m, (p.manual || []).indexOf(m) + 1)),
  );
}

function manualCard(m, num) {
  const saved = state().manual?.[m.id] || {};
  const answer = saved.answer || null;
  const note = S.noteDrafts[m.id] ?? saved.note ?? '';
  const sv = S.saveState[m.id];
  const needsNote = answer === 'broken' || answer === 'unsure';
  // A matching co-pilot tip (phone tips are already covered by the phone-size hint).
  const words = String(m.title).toLowerCase().split(/\W+/).filter((w) => w.length > 4);
  const tip = m.needs === 'phone' ? null : (plan().copilot?.tips || []).find((t) => (m.area === 'roles' && /role/i.test(t)) || words.some((w) => t.toLowerCase().includes(w)));
  const fileInput = h('input', { type: 'file', accept: 'image/png,image/jpeg', class: 'sr-only', id: `file-${m.id}`, onChange: (e) => { const f = e.target.files?.[0]; if (f) uploadManualShot(m.id, f); e.target.value = ''; } });
  return h('article', { class: `card manual ${answer ? 'ans-' + answer : ''}`, id: `m-${m.id}`, 'data-manual-id': m.id, onFocusin: () => { S.lastCard = m.id; } },
    h('div', { class: 'manual-top' },
      h('div', { class: 'row gap-s wrap' }, h('span', { class: 'manual-num', text: `#${num}` }), chip(AREA_NAME[m.area] || m.area, 'chip-soft'), m.lane ? chip(m.lane, 'chip-lane') : null,
        m.needs === 'phone' ? h('span', { class: 'chip chip-amber' }, icon('phone', 12), 'Phone size') : m.needs === 'laptop' ? h('span', { class: 'chip' }, icon('laptop', 12), 'Laptop size') : null),
      h('span', { class: `ans-pill ${answer ? 'ap-' + answer : ''}`, text: answer ? ANSWERS.find((a) => a.id === answer).label : 'Not answered' })),
    h('h2', { class: 'manual-title', text: m.title }),
    m.why ? h('p', { class: 'manual-why' }, h('strong', { text: 'Why it matters: ' }), m.why) : null,
    h('div', { class: 'manual-grid' },
      h('div', null,
        h('h3', { class: 'mini-h', text: 'Steps' }),
        h('ol', { class: 'num-steps' }, (m.steps || []).map((s) => h('li', { text: s }))),
        h('div', { class: 'row gap-s wrap' },
          btn(`Test it as ${cap(m.role)}`, { kind: 'primary', size: 'sm', iconName: 'monitor', onClick: () => openCheckInView(m) }),
          h('a', { class: 'btn btn-ghost btn-sm', href: deepLink(m.role, m.page), target: '_blank', rel: 'noopener noreferrer', title: 'Open in a new tab instead' }, h('span', { text: 'New tab' }), icon('external', 14)),
          m.page ? h('code', { class: 'muted small', text: m.page }) : null),
        m.needs === 'phone' ? h('p', { class: 'hint' }, icon('phone', 14), h('span', { text: 'Do this at phone size: use the Phone button in the Test view, or in a separate tab press F12, then Ctrl+Shift+M, and pick a phone (for example iPhone 12).' })) : null,
        m.needs === 'laptop' ? h('p', { class: 'hint' }, icon('laptop', 14), h('span', { text: 'Do this in a normal, full-size browser window.' })) : null,
        tip ? h('p', { class: 'hint hint-accent' }, icon('sparkles', 14), h('span', { text: tip })) : null),
      h('div', { class: 'good-box' }, h('h3', { class: 'mini-h' }, icon('check', 14), 'What good looks like'), h('p', { text: m.good || 'Works as described in the issue.' }))),
    h('div', { class: 'answer-block' },
      h('div', { class: 'mini-h', id: `q-${m.id}`, text: 'Did it work?' }),
      h('div', { class: 'answer-row', role: 'group', 'aria-labelledby': `q-${m.id}` }, ANSWERS.map((a) => h('button', {
        type: 'button', class: `answer-btn ab-${a.tone} ${answer === a.id ? 'is-on' : ''}`, 'aria-pressed': String(answer === a.id),
        onClick: () => setAnswer(m.id, answer === a.id ? null : a.id),
      }, icon(a.icon, 16), a.label))),
      h('label', { class: 'field-label', for: `note-${m.id}` }, needsNote ? 'What happened? (please describe it for the developer)' : 'Notes (optional)'),
      h('textarea', { id: `note-${m.id}`, class: `textarea ${needsNote && !note.trim() ? 'needs' : ''}`, rows: 3, placeholder: needsNote ? 'For example: the timer started again from 30:00 after I reloaded.' : 'Anything worth telling the developer.', value: note,
        onInput: (e) => { S.noteDrafts[m.id] = e.target.value; scheduleNoteSave(m.id); } }),
      h('div', { class: 'shot-row' },
        (saved.shots || []).map((f) => thumb(f, saved.shots, 'thumb-sm')),
        h('label', { class: 'btn btn-secondary btn-sm', for: `file-${m.id}` }, icon('upload', 14), h('span', { text: 'Attach screenshot' })), fileInput,
        h('div', { class: 'paste-zone', tabindex: 0, role: 'button', 'aria-label': 'Paste a screenshot: focus here and press Ctrl+V', onPaste: (e) => handlePaste(e, m.id) }, icon('paste', 14), h('span', { text: 'Click here, then Ctrl+V to paste' }))),
      h('div', { class: 'save-line small', 'aria-live': 'polite' }, sv === 'saving' ? h('span', { class: 'muted' }, icon('spin', 12), ' Saving…') : sv === 'error' ? h('span', { class: 'bad-text', text: 'Not saved. Check the QA server and try again.' }) : saved.at ? h('span', { class: 'ok-text' }, icon('check', 12), ` Saved ${timeAgo(saved.at)}`) : h('span', { class: 'muted', text: 'Your answer saves by itself.' }))),
  );
}

async function setAnswer(id, answer) {
  const st = state();
  const prev = st.manual[id] ? { ...st.manual[id] } : null;
  const note = S.noteDrafts[id] ?? prev?.note ?? '';
  st.manual[id] = { ...(prev || { shots: [] }), answer, note, at: prev?.at || null };
  S.saveState[id] = 'saving';
  render();
  try {
    await api('POST', '/api/manual', { id, answer, note });
    S.saveState[id] = 'saved';
    if (!state().manual[id]?.at) state().manual[id].at = new Date().toISOString();
    if (answer && !counts().manOpen && counts().checksDone) toast('All checks answered. You can complete testing now.', 'success');
  } catch (e) {
    if (prev) st.manual[id] = prev; else delete st.manual[id];
    S.saveState[id] = 'error';
    toast(e.message, 'error');
  }
  render();
}

const noteTimers = {};
function scheduleNoteSave(id) {
  clearTimeout(noteTimers[id]);
  noteTimers[id] = setTimeout(async () => {
    const answer = state().manual?.[id]?.answer ?? null;
    const note = S.noteDrafts[id] ?? '';
    S.saveState[id] = 'saving'; updateSaveLine(id);
    try {
      await api('POST', '/api/manual', { id, answer, note });
      const cur = state().manual[id] || { answer, shots: [] };
      state().manual[id] = { ...cur, note, at: new Date().toISOString() };
      S.saveState[id] = 'saved';
    } catch (e) { S.saveState[id] = 'error'; toast(e.message, 'error'); }
    updateSaveLine(id);
  }, 700);
}

function updateSaveLine(id) {
  const card = document.getElementById(`m-${id}`);
  if (!card) return;
  const line = card.querySelector('.save-line');
  const sv = S.saveState[id];
  const saved = state().manual?.[id] || {};
  fill(line, sv === 'saving' ? h('span', { class: 'muted' }, icon('spin', 12), ' Saving…') : sv === 'error' ? h('span', { class: 'bad-text', text: 'Not saved. Check the QA server and try again.' }) : h('span', { class: 'ok-text' }, icon('check', 12), ` Saved ${timeAgo(saved.at)}`));
}

function handlePaste(e, id) {
  const items = [...(e.clipboardData?.items || [])];
  const img = items.find((i) => i.kind === 'file' && /^image\/(png|jpeg)$/.test(i.type));
  if (!img) {
    if (e.currentTarget?.classList?.contains('paste-zone')) toast('No image on the clipboard. Take a screenshot first (Win+Shift+S), then paste.', 'default');
    return false;
  }
  e.preventDefault();
  uploadManualShot(id, img.getAsFile());
  return true;
}

async function uploadManualShot(id, file) {
  if (!/^image\/(png|jpeg)$/.test(file.type)) { toast('Please use a PNG or JPEG image.', 'error'); return; }
  if (file.size > 8 * 1024 * 1024) { toast('That image is larger than 8 MB. Crop it and try again.', 'error'); return; }
  const dataUrl = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(file); });
  try {
    toast('Uploading screenshot…');
    const r = await api('POST', '/api/manual-shot', { id, dataUrl });
    const cur = state().manual[id] || { answer: null, note: '', shots: [], at: null };
    if (!(cur.shots || []).includes(r.file)) cur.shots = [...(cur.shots || []), r.file];
    state().manual[id] = cur;
    toast('Screenshot attached', 'success');
    render();
  } catch (e) { toast(e.message, 'error'); }
}

function viewScreens() {
  const all = shots();
  const roles = [...new Set(all.map((s) => s.role))];
  const list = all.filter((s) => (S.deviceFilter === 'all' || s.device === S.deviceFilter) && (S.roleFilter === 'all' || s.role === S.roleFilter));
  const files = list.map((s) => s.file);
  const nIncluded = all.filter((s) => included(s.file)).length;
  const cmp = S.compare.map((f) => all.find((s) => s.file === f)).filter(Boolean);
  return h('div', { class: 'view' },
    pageHead('Screens', 'Every screenshot taken so far. Click one to zoom. Switch on “Include in report” for the ones the developer should see, or tick two to compare them side by side.'),
    h('div', { class: 'toolbar' },
      h('div', { class: 'seg', role: 'group', 'aria-label': 'Device' }, [['all', 'All', null], ...DEVICES.map((d) => [d, cap(d), d])].map(([id, label, ic]) => {
        const n = id === 'all' ? all.length : all.filter((s) => s.device === id).length;
        return h('button', { type: 'button', class: `seg-btn ${S.deviceFilter === id ? 'is-on' : ''}`, 'aria-pressed': String(S.deviceFilter === id), onClick: () => { S.deviceFilter = id; renderMain(); } }, ic ? icon(ic, 14) : null, label, h('span', { class: 'seg-n', text: n }));
      })),
      roles.length > 1 ? h('label', { class: 'select-wrap' }, h('span', { class: 'sr-only', text: 'Role' }), h('select', { class: 'select', name: 'role-filter', onChange: (e) => { S.roleFilter = e.target.value; renderMain(); } }, h('option', { value: 'all', text: 'All roles' }), roles.map((r) => h('option', { value: r, text: cap(r), selected: S.roleFilter === r })))) : null,
      h('span', { class: 'muted small toolbar-note', text: `${nIncluded} in the report${nIncluded ? '' : ' (all auto shots are used if you pick none)'}` })),
    cmp.length ? h('section', { class: 'card compare', 'aria-label': 'Compare screenshots' },
      h('div', { class: 'card-head' }, h('h2', null, icon('columns', 16), cmp.length === 2 ? 'Side by side' : 'Pick one more to compare'), btn('Clear', { size: 'sm', kind: 'ghost', iconName: 'x', onClick: () => { S.compare = []; renderMain(); } })),
      h('div', { class: 'compare-grid' }, cmp.map((s) => h('figure', { class: 'compare-item' }, h('button', { type: 'button', class: 'compare-img', 'aria-label': 'Zoom', onClick: () => openLightbox(s.file, S.compare) }, h('img', { src: shotSrc(s.file), alt: `${s.page} as ${s.role} on ${s.device}` })), h('figcaption', null, shotCaption(s)))))) : null,
    !all.length ? empty('image', 'No screenshots yet', 'They appear here as the automatic checks run. You can also take one yourself in Tools.', h('a', { class: 'btn btn-secondary', href: '#tools' }, 'Open Tools')) : null,
    all.length && !list.length ? empty('image', 'Nothing for this filter', 'Try another device or role.') : null,
    h('div', { class: 'gallery' }, list.map((s) => {
      const inc = included(s.file);
      const cmpOn = S.compare.includes(s.file);
      return h('figure', { class: `shot-card ${inc ? 'is-included' : ''} ${cmpOn ? 'is-compare' : ''}` },
        h('button', { type: 'button', class: `shot-img dev-${s.device}`, 'aria-label': `Zoom ${s.page} as ${s.role} on ${s.device}`, onClick: () => openLightbox(s.file, files) }, h('img', { src: shotSrc(s.file), alt: '', loading: 'lazy', decoding: 'async' }), h('span', { class: 'zoom-hint' }, icon('zoom', 16))),
        h('figcaption', null, shotCaption(s),
          h('div', { class: 'shot-actions' },
            h('label', { class: 'switch' }, h('input', { type: 'checkbox', name: 'include', role: 'switch', checked: inc, onChange: (e) => setInclude(s.file, e.target.checked) }), h('span', { class: 'switch-track', 'aria-hidden': 'true' }), h('span', { text: 'Include in report' })),
            h('label', { class: 'check-label' }, h('input', { type: 'checkbox', name: 'compare', checked: cmpOn, onChange: (e) => toggleCompare(s.file, e.target.checked) }), h('span', { text: 'Compare' })))));
    })));
}

function shotCaption(s) {
  return h('div', { class: 'shot-cap' }, h('span', { class: 'shot-page', text: s.page }), h('span', { class: 'shot-sub' }, icon(s.device in DEVICE_SIZE ? s.device : 'image', 13), h('span', { text: `${cap(s.role)} · ${cap(s.device)}` }), s.source && s.source !== 'auto' ? chip(s.source === 'tool' ? 'clean capture' : s.source === 'view' ? 'exact capture' : s.source, 'chip-soft') : null));
}

function toggleCompare(file, on) {
  S.compare = S.compare.filter((f) => f !== file);
  if (on) { S.compare.push(file); if (S.compare.length > 2) S.compare.shift(); }
  renderMain();
}

async function setInclude(file, on) {
  const st = state();
  const before = [...(st.include_shots || [])];
  st.include_shots = on ? [...new Set([...before, file])] : before.filter((f) => f !== file);
  renderMain();
  try { await api('POST', '/api/include', { file, on }); } catch (e) { st.include_shots = before; renderMain(); toast(e.message, 'error'); }
}

function viewTools() {
  const p = plan();
  const f = S.shotForm;
  const pages = p.pages || [];
  if (!f.page) f.page = pages[0]?.page || '__other';
  const pageVal = f.page === '__other' ? f.other.trim() : f.page;
  const pageOk = PAGE_OK.test(pageVal);
  if (!f.role || !ROLES.includes(f.role)) f.role = ROLES[0];
  const roleLinks = env().roleLinks || {};

  // device preview combos
  const combos = [...new Map(shots().map((s) => [`${s.page}|${s.role}`, { page: s.page, role: s.role }])).values()];
  if (!S.previewKey && combos.length) S.previewKey = `${combos[0].page}|${combos[0].role}`;
  const [pvPage, pvRole] = S.previewKey.split('|');

  return h('div', { class: 'view' },
    pageHead('Tools', `Extra helpers: take a screenshot of any page, preview a page on three devices, copy sign-in links${proj().canReset ? ', or put the test data back to the start' : ''}.`),
    h('div', { class: 'grid-2 tools-grid' },
      h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', null, icon('camera', 16), 'Take a screenshot')),
        h('form', { class: 'form', onSubmit: (e) => { e.preventDefault(); if (pageOk && !f.busy) takeShot(f.role, pageVal, f.device); } },
          h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'Signed in as' }), h('select', { class: 'select', name: 'shot-role', onChange: (e) => { f.role = e.target.value; } }, ROLES.map((r) => h('option', { value: r, text: cap(r), selected: f.role === r })))),
          h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'Page' }), h('select', { class: 'select', name: 'shot-page', onChange: (e) => { f.page = e.target.value; renderMain(); } },
            pages.map((pg) => h('option', { value: pg.page, text: pg.page, selected: f.page === pg.page })), h('option', { value: '__other', text: 'Type another page…', selected: f.page === '__other' }))),
          f.page === '__other' ? h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'Page address' }), h('input', { class: 'input', name: 'shot-other', type: 'text', placeholder: proj().pageExample, value: f.other, autocomplete: 'off', spellcheck: 'false',
            onInput: (e) => { f.other = e.target.value; const ok = PAGE_OK.test(f.other.trim()); const b = $('#shot-go'); if (b) b.disabled = !ok || f.busy; const hint = $('#page-hint'); if (hint) hint.hidden = ok || !f.other; } }),
            h('span', { class: 'field-hint bad-text', id: 'page-hint', hidden: pageOk || !f.other, text: `Use the part after ${APP_PREFIX}, like ${proj().pageExample}` })) : null,
          h('fieldset', { class: 'field' }, h('legend', { class: 'field-label', text: 'Device' }),
            h('div', { class: 'seg' }, DEVICES.map((d) => h('label', { class: `seg-btn ${f.device === d ? 'is-on' : ''}` }, h('input', { type: 'radio', name: 'shot-device', value: d, class: 'sr-only', checked: f.device === d, onChange: () => { f.device = d; renderMain(); } }), icon(d, 14), cap(d))))),
          h('div', { class: 'row gap-s' }, h('button', { type: 'submit', id: 'shot-go', class: 'btn btn-primary', disabled: !pageOk || f.busy }, f.busy ? icon('spin', 16) : icon('camera', 16), h('span', { text: f.busy ? 'Taking screenshot…' : 'Take screenshot' })), f.busy ? h('span', { class: 'muted small', text: 'About 5 seconds' }) : null),
          f.error ? h('p', { class: 'bad-text small', role: 'alert', text: f.error }) : null),
        f.result ? h('div', { class: 'shot-result' },
          h('button', { type: 'button', class: `shot-img dev-${f.result.device}`, 'aria-label': 'Zoom', onClick: () => openLightbox(f.result.file, [f.result.file]) }, h('img', { src: shotSrc(f.result.file), alt: `${f.result.page} as ${f.result.role} on ${f.result.device}` })),
          h('div', { class: 'row between wrap gap-s' }, shotCaption(f.result),
            h('label', { class: 'switch' }, h('input', { type: 'checkbox', name: 'include-result', role: 'switch', checked: included(f.result.file), onChange: (e) => setInclude(f.result.file, e.target.checked) }), h('span', { class: 'switch-track', 'aria-hidden': 'true' }), h('span', { text: 'Include in report' })))) : null),
      h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', null, icon('link', 16), 'Sign-in links')),
        h('p', { class: 'muted small', text: `Each link signs you in to ${proj().appName} as that person. Copy one to use in another browser or a private window.` }),
        h('ul', { class: 'link-rows' }, ROLES.map((r) => {
          const url = roleLinks[r] || deepLink(r, '');
          return h('li', { class: 'link-row' }, h('span', { class: `avatar ${avClass(r)}`, 'aria-hidden': 'true', text: r[0].toUpperCase() }), h('div', { class: 'link-row-text' }, h('strong', { text: cap(r) }), h('code', { class: 'muted small trunc', text: url })),
            btn('', { size: 'sm', kind: 'ghost', iconName: 'copy', onClick: () => copyText(url, `${cap(r)} link copied`), attrs: { 'aria-label': `Copy ${r} sign-in link` } }),
            h('a', { class: 'btn btn-ghost btn-sm', href: url, target: '_blank', rel: 'noopener noreferrer', 'aria-label': `Open ${proj().appName} as ${r}` }, icon('external', 15)));
        })))),
    h('section', { class: 'card' },
      h('div', { class: 'card-head wrap' }, h('h2', null, icon('columns', 16), 'Device preview'),
        combos.length ? h('label', { class: 'select-wrap' }, h('span', { class: 'sr-only', text: 'Page and role' }), h('select', { class: 'select', name: 'preview-key', onChange: (e) => { S.previewKey = e.target.value; renderMain(); } }, combos.map((cb) => h('option', { value: `${cb.page}|${cb.role}`, text: `${cb.page} · ${cap(cb.role)}`, selected: S.previewKey === `${cb.page}|${cb.role}` })))) : null),
      combos.length ? h('div', { class: 'frames' }, DEVICES.map((d) => {
        const s = [...shots()].reverse().find((x) => x.page === pvPage && x.role === pvRole && x.device === d);
        return h('figure', { class: `frame frame-${d}` },
          h('div', { class: 'frame-body' }, s ? h('button', { type: 'button', class: 'frame-screen', 'aria-label': `Zoom ${d} screenshot`, onClick: () => openLightbox(s.file, [s.file]) }, h('img', { src: shotSrc(s.file), alt: `${pvPage} on ${d}` }))
            : h('div', { class: 'frame-empty' }, h('p', { text: `No ${d} screenshot yet` }), btn(`Take ${d} screenshot`, { size: 'sm', iconName: 'camera', disabled: f.busy, onClick: () => takeShot(pvRole, pvPage, d) }))),
          h('figcaption', null, icon(d, 13), `${cap(d)} · ${DEVICE_SIZE[d][0]}×${DEVICE_SIZE[d][1]}`));
      })) : empty('image', 'No screenshots yet', 'Once the checks take screenshots, pick a page here to see it on a phone, a tablet and a laptop.')),
    proj().canReset ? h('section', { class: 'card danger-card' },
      h('div', { class: 'card-head' }, h('h2', null, icon('reset', 16), 'Reset test data')),
      h('p', { class: 'muted small', text: `Puts the test data of ${proj().appName} back to how it was at the start. Use it if the app got messy. Your answers in Anvil are kept.` }),
      S.resetConfirm ? h('div', { class: 'confirm', role: 'alertdialog', 'aria-labelledby': 'reset-q' },
        h('p', { id: 'reset-q' }, h('strong', { text: 'Reset the test data now? ' }), `Anything you created in ${proj().appName} is removed.`),
        h('div', { class: 'row gap-s' }, btn('Cancel', { onClick: () => { S.resetConfirm = false; renderMain(); } }), btn(S.resetBusy ? 'Resetting…' : 'Yes, reset', { kind: 'danger', iconName: S.resetBusy ? 'spin' : 'reset', disabled: S.resetBusy, onClick: resetData, cls: 'js-reset-yes' })))
        : btn('Reset test data', { kind: 'danger-outline', iconName: 'reset', onClick: () => { S.resetConfirm = true; renderMain(); $('.js-reset-yes')?.focus(); } })) : null,
  );
}

async function takeShot(role, page, device) {
  const f = S.shotForm;
  f.busy = true; f.error = '';
  renderMain();
  try {
    const r = await api('POST', '/api/shot', { role, page, device });
    f.result = shots().find((s) => s.file === r.file) || { file: r.file, page, role, device, source: 'tool' };
    if (!shots().some((s) => s.file === r.file)) results().shots.push(f.result);
    toast('Screenshot taken', 'success');
  } catch (e) { f.error = e.message || 'Could not take the screenshot.'; }
  f.busy = false;
  render();
}

async function resetData() {
  S.resetBusy = true; renderMain();
  try { await api('POST', '/api/reset-data'); toast('Test data is back to the start', 'success'); S.resetConfirm = false; } catch (e) { toast(e.message, 'error'); }
  S.resetBusy = false; renderMain();
}

/* ---- complete */

function whatsLeft(c) {
  const out = [];
  if (!c.checksDone) out.push({ text: 'The automatic checks are still running. Wait for them to finish, or stop them in Auto checks.', href: '#auto' });
  const open = (plan().manual || []).filter((m) => !state().manual?.[m.id]?.answer);
  if (open.length) out.push({ text: `${plural(open.length, 'of your checks', 'of your checks')} ${open.length === 1 ? 'has' : 'have'} no answer yet:`, items: open });
  return out;
}

function viewComplete() {
  if (state().sent) { location.hash = '#sent'; return viewSent(); }
  const c = counts();
  if (S.completeStage === 'preview' && S.draft) return viewPreview();
  if (S.completeStage === 'score' && c.ready) return viewScore();
  const left = whatsLeft(c);
  return h('div', { class: 'view' },
    pageHead('Complete testing', 'When everything is checked, you give the PR a rating and send the report. Nothing is posted until you confirm the preview.'),
    h('section', { class: 'card gate' },
      c.ready ? h('div', { class: 'gate-ready' }, h('div', { class: 'gate-icon ok' }, icon('check', 22)), h('div', null, h('h2', { text: 'Everything is checked' }), h('p', { class: 'muted', text: 'All automatic checks finished and every one of your checks has an answer.' })))
        : h('div', null, h('h2', { text: 'Before you can complete' }),
          h('ul', { class: 'left-list' }, left.map((l) => h('li', null, icon('clock', 16), h('div', null, l.href ? h('a', { href: l.href, text: l.text }) : h('span', { text: l.text }),
            l.items ? h('ul', { class: 'left-sub' }, l.items.map((m) => h('li', null, h('a', { href: `#manual/${m.id}`, text: m.title })))) : null))))),
      h('div', { class: 'gate-action' },
        h('button', { type: 'button', class: 'btn btn-primary btn-lg', disabled: !c.ready, 'aria-describedby': 'gate-why', onClick: () => { S.completeStage = 'score'; S.rating = S.rating ?? state().rating ?? null; S.noteToDev = S.noteToDev || state().note_to_dev || ''; renderMain(); scrollTop(); } }, icon('check', 20), h('span', { text: 'Complete testing' })),
        h('p', { class: 'muted small', id: 'gate-why', text: c.ready ? (notChecked().length ? `Next you rate the PR and see the score. ${plural(notChecked().length, 'automatic check')} will be reported as not checked.` : 'Next you rate the PR and see the score.') : `Still left: ${[!c.checksDone ? 'the automatic checks are still running (or stop them)' : null, c.manOpen ? `${plural(c.manOpen, 'manual check')} to answer` : null].filter(Boolean).join(' and ')}.` }))),
    notCheckedCard(),
  );
}

function viewScore() {
  const sum = summary();
  const overall = overallWithRating(sum, S.rating);
  const fix = sum.decision === 'fix';
  const a = sum.auto || {};
  const m = sum.manual || {};
  const ratingLabels = ['Very poor', 'Poor', 'OK', 'Good', 'Excellent'];
  return h('div', { class: 'view' },
    h('a', { class: 'back-link', href: '#complete', onClick: (e) => { e.preventDefault(); S.completeStage = 'gate'; renderMain(); } }, icon('arrowLeft', 14), 'Back'),
    h('section', { class: 'card score-hero' },
      h('div', { class: 'score-stars' }, stars(overall, 40, `Overall score ${overall} out of 5`)),
      h('div', { class: 'score-num' }, h('span', { class: 'score-big', text: overall.toFixed(1) }), h('span', { class: 'muted', text: '/ 5' })),
      h('span', { class: `decision ${fix ? 'decision-fix' : 'decision-final'}` }, icon(fix ? 'alert' : 'check', 16), fix ? 'Needs fixes before final review' : 'Ready for final review'),
      h('p', { class: 'muted score-why', text: fix ? (sum.blockers?.length ? `${plural(sum.blockers.length, 'blocker')} found${m.broken ? ` and ${m.broken} broken in your checks` : ''}. The report goes back to the developer.` : 'Something important is broken in your checks. The report goes back to the developer.') : 'No blockers and nothing important broken. The report goes to the owner for the final review.' })),
    notCheckedCard(),
    sum.blockers?.length ? h('div', { class: 'alert alert-red' }, icon('alert', 18), h('div', null, h('strong', { text: 'Blockers' }), h('ul', null, sum.blockers.map((b) => h('li', { text: b.text }))))) : null,
    h('div', { class: 'grid-2' },
      h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', { text: 'By area' })),
        h('ul', { class: 'area-list' }, AREAS.map(([id, name]) => {
          const ar = sum.areas?.[id] || { score: 5, notes: [], total: 0, passed: 0 };
          const tone = ar.score >= 4 ? 'green' : ar.score >= 2.5 ? 'amber' : 'red';
          return h('li', { class: 'area' },
            h('div', { class: 'row between' }, h('strong', { text: name }), h('span', { class: `area-score t-${tone}`, text: `${Number(ar.score).toFixed(1)}` })),
            progressBar(ar.score / 5 * 100, `${name} score`, tone),
            h('div', { class: 'muted small', text: ar.total ? `${ar.passed} of ${ar.total} fully passed` : 'Nothing to count here' }),
            ar.notes?.length ? h('ul', { class: 'area-notes' }, ar.notes.map((n) => h('li', { text: n }))) : null);
        }))),
      h('div', { class: 'stack' },
        h('section', { class: 'card' },
          h('div', { class: 'card-head' }, h('h2', { text: 'Counts' })),
          h('div', { class: 'count-grid' },
            [['Passed', a.pass, 'green'], ['Failed', a.fail, 'red'], ['Warnings', a.warn, 'amber'], ['Passed on retry', a.flake, 'amber'], ['Broken on main', a.preexisting, 'grey'], ['Skipped', a.skip, 'grey'], ['Not checked', notChecked().length, 'grey'], ['Checked by you', (results().checks || []).filter((x) => x.override).length, 'indigo']].map(([k, v, t]) => h('div', { class: `count t-${t}` }, h('span', { class: 'count-v', text: v ?? 0 }), h('span', { class: 'count-k', text: k }))),
          ),
          h('div', { class: 'count-grid count-grid-3' }, [['Works', m.works, 'green'], ['Broken', m.broken, 'red'], ['Not sure', m.unsure, 'amber']].map(([k, v, t]) => h('div', { class: `count t-${t}` }, h('span', { class: 'count-v', text: v ?? 0 }), h('span', { class: 'count-k', text: `${k} (yours)` }))))),
        h('section', { class: 'card' },
          h('div', { class: 'card-head' }, h('h2', { text: 'Your rating' }), h('span', { class: 'muted small', text: 'Optional, counts for 30%' })),
          h('fieldset', { class: 'rate' }, h('legend', { class: 'sr-only', text: 'Your rating from 1 to 5 stars' }),
            [1, 2, 3, 4, 5].map((n) => h('label', { class: `rate-star ${S.rating && n <= S.rating ? 'is-on' : ''}`, title: ratingLabels[n - 1] },
              h('input', { type: 'radio', name: 'rating', value: n, class: 'sr-only', checked: S.rating === n, onChange: () => { S.rating = n; renderMain(); $(`input[name="rating"][value="${n}"]`)?.focus(); } }),
              icon('star', 32), h('span', { class: 'sr-only', text: `${n} star${n > 1 ? 's' : ''}: ${ratingLabels[n - 1]}` }))),
            h('span', { class: 'rate-label', text: S.rating ? ratingLabels[S.rating - 1] : 'Not rated' }),
            S.rating ? h('button', { type: 'button', class: 'link-btn small', onClick: () => { S.rating = null; renderMain(); } }, 'Clear') : null),
          h('label', { class: 'field-label', for: 'note-dev', text: 'Note to the developer (optional)' }),
          h('textarea', { id: 'note-dev', class: 'textarea', rows: 3, placeholder: 'For example: Great work on the timer. The settings page needs another look.', value: S.noteToDev, onInput: (e) => { S.noteToDev = e.target.value; } })))),
    h('div', { class: 'big-action' },
      h('button', { type: 'button', class: `btn btn-xl ${fix ? 'btn-amber' : 'btn-green'}`, disabled: S.completing, onClick: doComplete },
        S.completing ? icon('spin', 22) : icon('send', 22), h('span', { text: S.completing ? 'Writing the report…' : fix ? 'Send back to developer' : 'Send for final review' })),
      h('p', { class: 'muted small', text: S.completing ? 'Claude is drafting the report. This can take up to a minute and a half.' : 'You will see the report and can edit it before anything is posted.' })),
  );
}

async function doComplete() {
  S.completing = true; renderMain();
  try {
    const r = await api('POST', '/api/complete', { rating: S.rating, note_to_dev: S.noteToDev });
    S.draft = structuredClone(r.draft);
    if (r.summary) S.data.summary = r.summary;
    S.completeStage = 'preview';
    scrollTop();
  } catch (e) {
    toast(e.status === 409 ? `Not ready yet: ${e.message}` : e.message, 'error');
  }
  S.completing = false;
  render();
}

function viewPreview() {
  const d = S.draft;
  const sum = d.summary || summary();
  const fix = sum.decision === 'fix';
  const lineOk = (body, lane) => lineOkFor(lane, body);
  const allOk = (d.comments || []).every((c) => lineOk(c.body, c.lane));
  return h('div', { class: 'view' },
    h('a', { class: 'back-link', href: '#complete', onClick: (e) => { e.preventDefault(); S.completeStage = 'score'; renderMain(); } }, icon('arrowLeft', 14), 'Back to the score'),
    pageHead('Check the report', `This is exactly what will be posted on PR #${plan().pr} on GitHub, one comment per lane. You can edit the text. Keep the first line as it is: the review bot reads it.`),
    (d.comments || []).map((c, i) => {
      const ok = lineOk(c.body, c.lane);
      const cmd = isFixBody(c.lane, c.body) ? fixCmd(c.lane) : passCmd(c.lane);
      return h('section', { class: 'card draft' },
        h('div', { class: 'card-head' }, h('h2', null, `Comment for the `, h('code', { text: c.lane }), ' lane'), h('span', { class: `chip ${isFixBody(c.lane, c.body) ? 'chip-amber' : 'chip-green'}`, text: cmd })),
        h('label', { class: 'sr-only', for: `draft-${i}`, text: `Report for ${c.lane}` }),
        h('textarea', { id: `draft-${i}`, class: `textarea mono ${ok ? '' : 'needs'}`, rows: Math.min(26, Math.max(8, String(c.body).split('\n').length + 1)), value: c.body, spellcheck: 'true',
          onInput: (e) => { c.body = e.target.value; const good = lineOk(c.body, c.lane); e.target.classList.toggle('needs', !good); const w = document.getElementById(`draft-warn-${i}`); if (w) w.hidden = good; const go = $('#confirm-send'); if (go) go.disabled = !d.comments.every((x) => lineOk(x.body, x.lane)) || S.sending; } }),
        h('p', { class: 'bad-text small', id: `draft-warn-${i}`, hidden: ok, text: `The first line must start with ${passCmd(c.lane)} or ${fixCmd(c.lane)}.` }));
    }),
    h('details', { class: 'card chat-draft' }, h('summary', null, icon('send', 15), `Short note for ${proj().chatName} (the link to the report is added after posting)`),
      h('label', { class: 'sr-only', for: 'chat-draft', text: `Note for ${proj().chatName}` }),
      h('textarea', { id: 'chat-draft', class: 'textarea mono', rows: 6, value: d.chat_md || '', onInput: (e) => { d.chat_md = e.target.value; } })),
    h('div', { class: 'big-action' },
      h('button', { type: 'button', id: 'confirm-send', class: `btn btn-xl ${fix ? 'btn-amber' : 'btn-green'}`, disabled: S.sending || !allOk, onClick: doSend },
        S.sending ? icon('spin', 22) : icon('send', 22), h('span', { text: S.sending ? 'Posting to GitHub…' : 'Confirm and post' })),
      h('p', { class: 'muted small', text: `Posts ${plural((d.comments || []).length, 'comment')} on GitHub with your account (gh pr comment). This cannot be undone from here.` })),
  );
}

async function doSend() {
  S.sending = true; renderMain();
  try {
    const r = await api('POST', '/api/send', { comments: S.draft.comments.map((c) => ({ lane: c.lane, body: c.body })), chat_md: S.draft.chat_md || '' });
    S.sendResult = r;
    if (r.chat_md) S.chatText = r.chat_md;
    if (!state().sent) state().sent = { at: new Date().toISOString(), decision: (S.draft.summary || summary()).decision, comments: r.urls || [], files: r.files || [] };
    S.sending = false;
    location.hash = '#sent';
    toast('Report posted on GitHub', 'success');
  } catch (e) {
    S.sending = false;
    toast(e.message || 'Could not post the report.', 'error');
    renderMain();
  }
}

function viewSent() {
  const sent = state().sent;
  if (!sent) {
    return h('div', { class: 'view' }, empty('send', 'Nothing sent yet', 'Finish your checks and send the report from Complete.', h('a', { class: 'btn btn-primary', href: '#complete' }, 'Go to Complete')));
  }
  const p = plan();
  const urls = S.sendResult?.urls || sent.comments || [];
  const fix = sent.decision === 'fix';
  if (S.chatText == null) loadChat();
  if (S.next === undefined) loadNext();
  const chatHref = S.mode === 'mock' ? (S.chatBlob || '#') : BASE + '/api/chat.md';
  const sheetHref = S.mode === 'mock' ? (S.sheetBlob || '#') : BASE + '/qa/screens.png';
  if (S.mode === 'mock' && !S.sheetBlob) makeMockSheet();
  return h('div', { class: 'view' },
    h('section', { class: 'card sent-hero' },
      h('div', { class: `sent-icon ${fix ? 'amber' : ''}` }, icon(fix ? 'send' : 'check', 30)),
      h('h1', { text: fix ? 'Sent back to the developer' : 'Sent for final review' }),
      h('p', { class: 'lead', text: `Your report is posted on PR #${p.pr}. ${fix ? `${p.author} will fix the issues and ask for a re-test.` : `${p.owner} will do the final review.`} Thank you!` }),
      h('div', { class: 'row gap-s wrap center' }, urls.map((u, i) => linkBtn(urls.length > 1 ? `Open comment ${i + 1} (${(p.lanes || [])[i] || ''})` : 'Open the comment on GitHub', u, { kind: i ? 'secondary' : 'primary' })))),
    h('div', { class: 'grid-2' },
      h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', { text: `Note for ${proj().chatName}` })),
        h('p', { class: 'hint hint-accent' }, icon('info', 14), h('span', { text: `Paste this in ${proj().chatName}. The full report is on GitHub.` })),
        S.chatText == null ? h('div', { class: 'skeleton', 'aria-label': 'Loading' }) : h('pre', { class: 'chat-pre', tabindex: 0, text: S.chatText || '(empty)' }),
        h('div', { class: 'row gap-s wrap' },
          btn('Copy', { kind: 'primary', iconName: 'copy', disabled: !S.chatText, onClick: () => copyText(S.chatText, 'Note copied') }),
          h('a', { class: 'btn btn-secondary', href: chatHref, download: `chat-pr${p.pr}.md` }, icon('download', 15), h('span', { text: 'Download .md' })))),
      h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', { text: 'Screenshots sheet' })),
        h('p', { class: 'muted small', text: 'All chosen screenshots on one image. Drag it into the GitHub comment so the developer sees them.' }),
        sheetHref !== '#' ? h('a', { class: 'sheet-preview', href: sheetHref, target: '_blank', rel: 'noopener noreferrer', 'aria-label': 'Open screens.png' }, h('img', { src: sheetHref, alt: 'Contact sheet of the chosen screenshots', onError: (e) => { e.target.closest('.sheet-preview')?.remove(); } })) : null,
        h('a', { class: 'btn btn-secondary', href: sheetHref, download: 'screens.png' }, icon('download', 15), h('span', { text: 'Download screens.png' })))),
    h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', { text: 'Next PR for you' })),
      S.next == null ? h('div', { class: 'skeleton skeleton-row' }) : S.next.length ? h('ul', { class: 'next-list' }, S.next.map((n) => h('li', { class: 'next-item' },
        h('div', null, h('strong', { text: `#${n.number} ${n.title}` }), h('p', { class: 'muted small' }, 'In Claude Code, say ', h('code', { text: `start anvil ${n.number}` }), ' to start.')),
        h('div', { class: 'row gap-s' }, btn('', { size: 'sm', kind: 'ghost', iconName: 'copy', onClick: () => copyText(`start anvil ${n.number}`, 'Command copied'), attrs: { 'aria-label': `Copy start anvil ${n.number}` } }), linkBtn('View', n.url, { kind: 'secondary' })))))
        : empty('party', 'No more PRs waiting for you', 'You are all caught up. You can close this tab.')),
  );
}

async function loadChat() {
  S.chatText = S.sendResult?.chat_md || '';
  if (S.chatText) { if (S.mode === 'mock') makeChatBlob(); return; }
  S.chatText = null;
  try {
    const t = S.mode === 'mock' ? await S.mock.handle('GET', '/api/chat.md') : await (await fetch(BASE + '/api/chat.md')).text();
    S.chatText = String(t || '');
  } catch { S.chatText = ''; }
  if (S.mode === 'mock') makeChatBlob();
  if (S.view === 'sent') renderMain();
}
function makeChatBlob() { S.chatBlob = URL.createObjectURL(new Blob([S.chatText || ''], { type: 'text/markdown' })); }
async function loadNext() {
  S.next = null;
  try { S.next = ((await api('GET', '/api/next')).prs || []).filter((n) => Number(n.number) !== Number(plan().pr)); } catch { S.next = []; }
  if (S.data) renderTopbar();
  if (S.view === 'sent') renderMain();
}
function makeMockSheet() {
  S.sheetBlob = '#';
  const cv = document.createElement('canvas');
  cv.width = 1200; cv.height = 700;
  const g = cv.getContext('2d');
  g.fillStyle = '#f7f8fa'; g.fillRect(0, 0, 1200, 700);
  g.fillStyle = '#111827'; g.font = '600 26px Inter, Arial'; g.fillText(`PR #${plan().pr} screenshots (sample)`, 40, 56);
  const list = (state().include_shots?.length ? state().include_shots : shots().filter((s) => s.source === 'auto').map((s) => s.file)).slice(0, 8);
  list.forEach((f, i) => {
    const x = 40 + (i % 4) * 285, y = 90 + Math.floor(i / 4) * 300;
    g.fillStyle = '#fff'; g.fillRect(x, y, 265, 250); g.strokeStyle = '#e5e7eb'; g.strokeRect(x, y, 265, 250);
    g.fillStyle = '#4f46e5'; g.fillRect(x, y, 265, 36);
    g.fillStyle = '#374151'; g.font = '14px Inter, Arial'; g.fillText(String(f).replace('shots/', '').slice(0, 34), x + 10, y + 276);
  });
  cv.toBlob((b) => { if (b) { S.sheetBlob = URL.createObjectURL(b); if (S.view === 'sent') renderMain(); } }, 'image/png');
}

/* ------------------------------------------------------------------ test view (the app under test inside Anvil) */

const TV_DEVICES = [
  { id: 'phone', label: 'Phone', size: 390 },
  { id: 'tablet', label: 'Tablet', size: 820 },
  { id: 'laptop', label: 'Laptop', size: 1440 },
  { id: 'fit', label: 'Fit', size: null },
];

const TV = {
  root: null, frame: null, wrap: null, canvas: null, ribbon: null, drawer: null, errPop: null,
  role: null, page: null, device: window.innerWidth < 700 ? 'fit' : 'laptop', rotated: false,
  drawerOpen: null, errorsOpen: false, errors: [], currentId: null,
  loading: false, history: [], stream: null, video: null, shotBusy: false, ro: null,
};

const sessionQ = [];
let sessionTimer = null;
function logEvent(ev) {
  const e = { ...ev, at: new Date().toISOString() };
  if (e.text) e.text = String(e.text).slice(0, 300);
  sessionQ.push(e);
  clearTimeout(sessionTimer);
  if (sessionQ.length >= 20) flushSession(); else sessionTimer = setTimeout(flushSession, 1500);
}
async function flushSession() {
  const events = sessionQ.splice(0);
  if (!events.length) return;
  try { await api('POST', '/api/session', { events }); } catch { /* the log is best effort */ }
}
function flushOnExit() {
  if (!sessionQ.length || S.mode !== 'live') return;
  const body = JSON.stringify({ events: sessionQ.splice(0) });
  try { navigator.sendBeacon(BASE + '/api/session', new Blob([body], { type: 'application/json' })); } catch { /* ignore */ }
}

function currentManual() {
  const list = plan().manual || [];
  return list.find((m) => m.id === TV.currentId) || list.find((m) => !state().manual?.[m.id]?.answer) || list[0] || null;
}

function deviceSize() {
  const d = TV.device;
  if (d === 'fit') return null;
  let [w, hgt] = DEVICE_SIZE[d];
  if (TV.rotated && d !== 'laptop') [w, hgt] = [hgt, w];
  return [w, hgt];
}

function frameUrl() { return TV.page ? pageUrl(TV.page) : APP_PREFIX; }

// Navigate the iframe. role given = sign in as that role first (through the project's sign-in link).
function tvNavigate({ page, role, push = true } = {}) {
  const pre = APP_PREFIX.replace(/^\/+/, '');
  if (page != null) { TV.page = String(page).replace(/^\/+/, ''); if (pre && TV.page.startsWith(pre)) TV.page = TV.page.slice(pre.length); }
  const roleChanged = role && role !== TV.role;
  if (role) TV.role = role;
  if (!TV.frame) return;
  TV.loading = true;
  if (S.mode === 'mock') {
    if (push) TV.history.push({ page: TV.page, role: TV.role });
    TV.frame.srcdoc = mockAppHtml(TV.page, TV.role);
  } else {
    TV.frame.src = roleChanged ? deepLink(TV.role, TV.page) : frameUrl();
  }
  if (roleChanged) logEvent({ type: 'role', role: TV.role });
  updateRibbon();
}

function tvBack() {
  if (S.mode === 'mock') {
    if (TV.history.length < 2) { toast('Nothing to go back to.'); return; }
    TV.history.pop();
    const prev = TV.history[TV.history.length - 1];
    tvNavigate({ page: prev.page, role: prev.role, push: false });
    return;
  }
  try { TV.frame.contentWindow.history.back(); } catch { /* cross-origin page: ignore */ }
}

function tvReload() {
  if (S.mode === 'mock') { tvNavigate({ push: false }); return; }
  try { TV.frame.contentWindow.location.reload(); } catch { TV.frame.src = TV.frame.src; }
}

function setDevice(d) {
  if (d === TV.device) return;
  TV.device = d;
  if (d === 'laptop' || d === 'fit') TV.rotated = false;
  logEvent({ type: 'device', device: d });
  layoutFrame();
  updateRibbon();
}

function layoutFrame() {
  if (!TV.canvas || !TV.wrap) return;
  const cs = TV.canvas.getBoundingClientRect();
  const pad = window.innerWidth <= 760 ? 12 : 24;
  const availW = Math.max(200, cs.width - pad * 2);
  const availH = Math.max(200, cs.height - pad * 2 - 28); // 28 = size caption under the frame
  const size = deviceSize();
  const outline = TV.device === 'phone' || TV.device === 'tablet';
  const border = outline ? 8 : 0;
  TV.wrap.dataset.device = TV.device;
  if (!size) {
    Object.assign(TV.frame.style, { width: `${availW}px`, height: `${availH}px`, transform: 'none' });
    Object.assign(TV.wrap.style, { width: `${availW}px`, height: `${availH}px` });
    TV.scale = 1;
    return;
  }
  const [w, hgt] = size;
  const scale = Math.min(1, (availW - border * 2) / w, (availH - border * 2) / hgt);
  TV.scale = scale;
  Object.assign(TV.frame.style, { width: `${w}px`, height: `${hgt}px`, transform: scale < 1 ? `scale(${scale})` : 'none' });
  Object.assign(TV.wrap.style, { width: `${Math.round(w * scale) + border * 2}px`, height: `${Math.round(hgt * scale) + border * 2}px` });
  const lbl = TV.root?.querySelector('.tv-size');
  if (lbl) lbl.textContent = `${w}×${hgt}${scale < 1 ? ` · shown at ${Math.round(scale * 100)}%` : ''}`;
}

function recordError(type, text, extra = {}) {
  const e = { type, text: String(text || '').slice(0, 300), at: new Date().toISOString(), page: TV.page, role: TV.role, ...extra };
  TV.errors.push(e);
  if (TV.errors.length > 200) TV.errors.shift();
  logEvent({ type, text: e.text, url: frameUrl(), role: TV.role, device: TV.device, status: extra.status, path: extra.path, method: extra.method });
  updateRibbon();
}

function fmtArg(a) {
  if (a instanceof Error) return `${a.name}: ${a.message}`;
  if (typeof a === 'string') return a;
  try { return JSON.stringify(a); } catch { return String(a); }
}

// Attach to the (same-origin) page inside the iframe: console errors, uncaught errors, failed API calls.
function hookFrame() {
  let win;
  try { win = TV.frame.contentWindow; void win.document; } catch { return; }
  if (!win || win.__anvilHooked) return;
  win.__anvilHooked = true;
  const origError = win.console.error;
  win.console.error = function anvilConsoleError(...args) {
    recordError('console-error', args.map(fmtArg).join(' '));
    return origError.apply(this, args);
  };
  win.addEventListener('error', (e) => recordError('page-error', e.message || 'Script error'));
  win.addEventListener('unhandledrejection', (e) => recordError('page-error', `Unhandled promise: ${fmtArg(e.reason)}`));
  const isApi = (url) => String(url || '').includes(proj().apiMatch);
  const pathOf = (url) => { try { return new URL(url, win.location.href).pathname; } catch { return String(url); } };
  if (win.fetch) {
    const origFetch = win.fetch;
    win.fetch = async function anvilFetch(input, init) {
      const res = await origFetch.call(this, input, init);
      try {
        const url = typeof input === 'string' ? input : input?.url;
        if (isApi(url) && res.status >= 400) recordError('api-error', `${(init?.method || input?.method || 'GET').toUpperCase()} ${pathOf(url)} answered ${res.status}`, { status: res.status, path: pathOf(url), method: (init?.method || input?.method || 'GET').toUpperCase() });
      } catch { /* never break the page */ }
      return res;
    };
  }
  const XHR = win.XMLHttpRequest;
  if (XHR) {
    const open = XHR.prototype.open;
    XHR.prototype.open = function anvilOpen(method, url, ...rest) {
      this.__anvil = { method, url };
      this.addEventListener('loadend', () => {
        try { if (isApi(url) && this.status >= 400) recordError('api-error', `${String(method).toUpperCase()} ${pathOf(url)} answered ${this.status}`, { status: this.status, path: pathOf(url), method: String(method).toUpperCase() }); } catch { /* ignore */ }
      });
      return open.call(this, method, url, ...rest);
    };
  }
}

function onFrameLoad() {
  TV.loading = false;
  if (S.mode === 'live') {
    try {
      const loc = TV.frame.contentWindow.location;
      const p = loc.pathname.startsWith(APP_PREFIX) ? loc.pathname.slice(APP_PREFIX.length) + loc.search : null;
      if (p) TV.page = p;
    } catch { /* not same origin */ }
  }
  hookFrame();
  if (S.mode === 'mock') wireMockPage();
  logEvent({ type: 'navigate', url: frameUrl(), role: TV.role, device: TV.device });
  updateRibbon();
}

// Mock only: buttons in the placeholder page (no scripts inside it; we attach listeners from here).
function wireMockPage() {
  let doc;
  try { doc = TV.frame.contentDocument; } catch { return; }
  doc.querySelectorAll('[data-nav]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); tvNavigate({ page: a.dataset.nav }); }));
  doc.querySelector('[data-act="console"]')?.addEventListener('click', () => TV.frame.contentWindow.console.error('Sample: note title is undefined for note 12'));
  doc.querySelector('[data-act="api"]')?.addEventListener('click', () => { TV.frame.contentWindow.fetch(`${proj().apiBase}notes?mock=fail`).catch(() => {}); });
  doc.querySelector('[data-act="throw"]')?.addEventListener('click', () => {
    const w = TV.frame.contentWindow;
    w.dispatchEvent(new w.ErrorEvent('error', { message: "Uncaught TypeError: Cannot read properties of undefined (reading 'title')" }));
  });
}

function mockAppHtml(page, role) {
  const pg = (plan().pages || []).find((p) => p.page === page);
  const color = roleColor(role);
  const title = cap(String(page || 'home').replace(/^.*\//, '').replace(/\.html.*$/, ''));
  const links = (plan().pages || []).filter((p) => !role || (p.roles || []).includes(role)).map((p) => `<a href="#" data-nav="${xml(p.page)}" class="${p.page === page ? 'on' : ''}">${xml(cap(p.page.replace(/^.*\//, '').replace('.html', '')))}</a>`).join('');
  const cards = [1, 2, 3, 4, 5, 6].map((i) => `<div class="card"><b>${xml(title)} item ${i}</b><span>Sample data · updated today</span><i></i></div>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${xml(title)}</title><style>
*{box-sizing:border-box}body{margin:0;font-family:Inter,system-ui,Arial,sans-serif;background:#f6f7f9;color:#111827}
header{background:${color};color:#fff;padding:14px 20px;display:flex;justify-content:space-between;align-items:center;gap:12px}
header b{font-size:17px}header span{font-size:13px;background:rgba(255,255,255,.18);padding:3px 10px;border-radius:99px}
nav{display:flex;gap:6px;padding:10px 20px;background:#fff;border-bottom:1px solid #e5e7eb;flex-wrap:wrap}
nav a{font-size:13px;color:#374151;text-decoration:none;padding:5px 10px;border-radius:8px}nav a.on{background:#eef2ff;color:${color};font-weight:600}
main{padding:20px}h1{margin:0 0 4px;font-size:24px}p{margin:0 0 18px;color:#6b7280;font-size:14px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:16px;display:grid;gap:6px}.card span{font-size:12.5px;color:#6b7280}
.card i{display:block;height:8px;border-radius:4px;background:${color};opacity:.18;width:60%}
.helpers{margin-top:22px;border:1px dashed #d1d5db;border-radius:12px;padding:14px;background:#fff}.helpers small{display:block;color:#6b7280;margin-bottom:10px}
button{font:inherit;font-size:13px;border:1px solid #d1d5db;background:#fff;border-radius:8px;padding:7px 11px;margin:0 6px 6px 0;cursor:pointer}
</style></head><body><header><b>${xml(proj().appName)}</b><span>${xml(cap(role || 'signed out'))}</span></header><nav>${links}</nav>
<main><h1>${xml(title)}</h1><p>${xml(page || '')}${pg?.why ? ` · ${xml(pg.why)}` : ''}</p><div class="grid">${cards}</div>
<div class="helpers"><small>Sample mode helpers (only in ?mock=1): make the page misbehave to see Anvil catch it.</small>
<button type="button" data-act="console">Log a console error</button><button type="button" data-act="api">Call an API that fails</button><button type="button" data-act="throw">Throw an error</button></div></main></body></html>`;
}

/* ---- screenshots from the test view */

async function grabStreamFrame() {
  if (!navigator.mediaDevices?.getDisplayMedia) throw new Error('Screen capture is not available in this browser.');
  const live = TV.stream && TV.stream.getVideoTracks().some((t) => t.readyState === 'live');
  if (!live) {
    TV.stream = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: 'browser' }, audio: false, preferCurrentTab: true, selfBrowserSurface: 'include' });
    TV.video = document.createElement('video');
    TV.video.muted = true;
    TV.video.playsInline = true;
    TV.video.srcObject = TV.stream;
    await TV.video.play();
    TV.stream.getVideoTracks()[0].addEventListener('ended', () => { TV.stream = null; });
  }
  // Let popovers/toasts disappear before the frame is taken.
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  await sleep(120);
  const v = TV.video;
  const rect = TV.frame.getBoundingClientRect();
  const sx = v.videoWidth / window.innerWidth;
  const sy = v.videoHeight / window.innerHeight;
  const cw = Math.max(1, Math.round(rect.width * sx));
  const chh = Math.max(1, Math.round(rect.height * sy));
  const cv = document.createElement('canvas');
  cv.width = cw; cv.height = chh;
  cv.getContext('2d').drawImage(v, Math.round(rect.left * sx), Math.round(rect.top * sy), cw, chh, 0, 0, cw, chh);
  return cv.toDataURL('image/png');
}

async function tvScreenshot(attach) {
  if (TV.shotBusy) return;
  const m = attach ? currentManual() : null;
  if (attach && !m) { toast('There is no check to attach to.', 'error'); return; }
  TV.shotBusy = true; TV.errorsOpen = false; updateRibbon();
  fill($('#toasts'), );
  const device = TV.device === 'fit' ? 'laptop' : TV.device;
  try {
    const dataUrl = await grabStreamFrame();
    const r = await api('POST', '/api/view-shot', { dataUrl, page: TV.page, role: TV.role, device: TV.device, manualId: m?.id });
    if (m) {
      const cur = state().manual[m.id] || { answer: null, note: '', shots: [], at: null };
      if (!(cur.shots || []).includes(r.file)) cur.shots = [...(cur.shots || []), r.file];
      state().manual[m.id] = cur;
    }
    logEvent({ type: 'shot', url: frameUrl(), role: TV.role, device: TV.device });
    toast(m ? `Screenshot attached to “${m.title}”` : 'Screenshot saved. Find it in Screens.', 'success');
  } catch (e) {
    if (attach) {
      toast('Could not capture the screen. When Chrome asks, choose this tab and press Share. Or attach a file in Your checks.', 'error');
    } else {
      try {
        toast('Exact capture was not allowed, taking a clean capture instead…');
        await api('POST', '/api/shot', { role: TV.role, page: TV.page, device });
        logEvent({ type: 'shot', url: frameUrl(), role: TV.role, device, text: 'clean capture' });
        toast('Clean capture saved. Find it in Screens.', 'success');
      } catch (e2) { toast(e2.message || 'Could not take the screenshot.', 'error'); }
    }
    void e;
  }
  TV.shotBusy = false;
  render();
}

/* ---- control from Claude Code (SSE `control`) */

function applyControl(c) {
  if (!c || !c.action) return;
  if (S.view !== 'test') location.hash = '#test';
  setTimeout(() => {
    if (c.action === 'navigate') tvNavigate({ page: c.page ?? TV.page, role: c.role || undefined });
    else if (c.action === 'role' && c.role) tvNavigate({ role: c.role });
    else if (c.action === 'device' && c.device) setDevice(TV_DEVICES.some((d) => d.id === c.device) ? c.device : 'laptop');
    else if (c.action === 'reload') tvReload();
    else if (c.action === 'shot') tvScreenshot(false);
    toast(`Claude: ${c.action}${c.page ? ' ' + c.page : ''}${c.role ? ' as ' + c.role : ''}${c.device ? ' on ' + c.device : ''}`);
  }, S.view === 'test' ? 0 : 60);
}

/* ---- build + update */

function openCheckInView(m) {
  TV.currentId = m.id;
  TV.autoCheck = null;
  const want = m.needs === 'phone' ? 'phone' : m.needs === 'laptop' ? 'laptop' : TV.device;
  if (want !== TV.device) { TV.device = want; logEvent({ type: 'device', device: want }); }
  TV.rotated = false;
  if (S.view !== 'test') {
    TV.page = m.page || TV.page; TV.role = m.role || TV.role;
    location.hash = '#test';
  } else {
    layoutFrame();
    tvNavigate({ page: m.page || TV.page, role: m.role || TV.role });
    updateDrawer();
  }
}

function buildTestRoot() {
  const m = currentManual();
  if (!TV.role) TV.role = m?.role || plan().pages?.[0]?.roles?.[0] || ROLES[0];
  if (!TV.page) TV.page = m?.page || roleHome(TV.role);
  if (TV.drawerOpen == null) TV.drawerOpen = window.innerWidth >= 1100;
  TV.ribbon = h('div', { class: 'ribbon', role: 'toolbar', 'aria-label': 'Test view tools' });
  TV.frame = h('iframe', { class: 'tv-frame', title: `${proj().appName} under test`, referrerpolicy: 'same-origin' });
  TV.frame.addEventListener('load', onFrameLoad);
  TV.wrap = h('div', { class: 'tv-device' }, TV.frame);
  TV.canvas = h('div', { class: 'tv-canvas' }, h('div', { class: 'tv-stage' }, TV.wrap, h('div', { class: 'tv-size muted small', 'aria-live': 'polite' })));
  TV.drawer = h('aside', { class: 'tv-drawer', 'aria-label': 'Your checks' });
  TV.errPop = h('div', { class: 'tv-errors-pop' });
  TV.strip = h('div', { class: 'tv-strip', role: 'status', hidden: true });
  TV.root = h('div', { class: 'tv' }, TV.ribbon, TV.strip, TV.errPop, h('div', { class: 'tv-body' }, TV.canvas, TV.drawer));
  TV.ro?.disconnect();
  TV.ro = new ResizeObserver(() => layoutFrame());
  TV.ro.observe(TV.canvas);
  if (S.mode === 'mock') { TV.history = [{ page: TV.page, role: TV.role }]; TV.frame.srcdoc = mockAppHtml(TV.page, TV.role); }
  else TV.frame.src = deepLink(TV.role, TV.page);
  return TV.root;
}

function updateTestView() {
  updateRibbon();
  updateStrip();
  updateDrawer();
  TV.root.dataset.drawer = TV.drawerOpen ? 'open' : 'closed';
  requestAnimationFrame(layoutFrame);
}

function updateRibbon() {
  if (!TV.ribbon || S.view !== 'test') return;
  const c = counts();
  const pages = plan().pages || [];
  const m = currentManual();
  const nErr = TV.errors.length;
  const pageInput = h('input', { class: 'input rb-page', name: 'tv-page', type: 'text', list: 'tv-pages', value: TV.page || '', spellcheck: 'false', autocomplete: 'off', 'aria-label': `Page address, for example ${proj().pageExample}`, placeholder: proj().pageExample,
    onKeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); const v = e.target.value.trim(); if (v) { tvNavigate({ page: v }); e.target.blur(); } } },
    onChange: (e) => { const v = e.target.value.trim(); if (v && v !== TV.page) tvNavigate({ page: v }); } });
  fill(TV.ribbon, 
    h('a', { class: 'rb-brand', href: '#overview', 'aria-label': 'Anvil dashboard', title: 'Anvil dashboard' }, brandMark(22)),
    h('label', { class: 'rb-role' }, h('span', { class: 'sr-only', text: 'Signed in as' }), h('span', { class: `avatar ${avClass(TV.role)}`, 'aria-hidden': 'true', text: (TV.role || '?')[0].toUpperCase() }),
      h('select', { class: 'select rb-select', name: 'tv-role', onChange: (e) => tvNavigate({ role: e.target.value }) }, ROLES.map((r) => h('option', { value: r, text: cap(r), selected: TV.role === r })))),
    h('div', { class: 'rb-pagewrap' }, pageInput, h('datalist', { id: 'tv-pages' }, pages.map((p) => h('option', { value: p.page, label: (p.roles || []).map(cap).join(', ') })))),
    h('div', { class: 'rb-group' },
      h('button', { type: 'button', class: 'icon-btn rb-btn', 'aria-label': 'Back', title: 'Back', onClick: tvBack }, icon('arrowLeft', 16)),
      h('button', { type: 'button', class: 'icon-btn rb-btn', 'aria-label': 'Reload', title: 'Reload', onClick: tvReload }, TV.loading ? icon('spin', 16) : icon('refresh', 16))),
    h('div', { class: 'seg rb-seg', role: 'group', 'aria-label': 'Device size' }, TV_DEVICES.map((d) => h('button', { type: 'button', class: `seg-btn ${TV.device === d.id ? 'is-on' : ''}`, 'aria-pressed': String(TV.device === d.id), title: d.size ? `${d.label} ${d.size}px wide` : 'Fill the space', onClick: () => setDevice(d.id) },
      icon(d.id === 'fit' ? 'maximize' : d.id, 14), h('span', { class: 'rb-dlabel', text: d.label }), d.size ? h('span', { class: 'seg-n rb-dsize', text: d.size }) : null))),
    h('button', { type: 'button', class: `icon-btn rb-btn ${TV.rotated ? 'is-on' : ''}`, 'aria-label': 'Rotate', 'aria-pressed': String(TV.rotated), title: 'Rotate (phone and tablet)', disabled: !(TV.device === 'phone' || TV.device === 'tablet'), onClick: () => { TV.rotated = !TV.rotated; layoutFrame(); updateRibbon(); } }, icon('rotate', 16)),
    h('span', { class: 'rb-spacer' }),
    h('button', { type: 'button', class: 'btn btn-secondary btn-sm rb-shot', disabled: TV.shotBusy, title: 'Exact screenshot of what you see', onClick: () => tvScreenshot(false) }, TV.shotBusy ? icon('spin', 15) : icon('camera', 15), h('span', { class: 'rb-text', text: 'Screenshot' })),
    h('button', { type: 'button', class: 'btn btn-ghost btn-sm', disabled: TV.shotBusy || !m, title: m ? `Screenshot and attach it to “${m.title}”` : 'No check selected', 'aria-label': m ? `Attach a screenshot to ${m.title}` : 'Attach a screenshot', onClick: () => tvScreenshot(true) }, icon('clip', 15), h('span', { class: 'rb-text', text: 'Attach' })),
    h('button', { type: 'button', class: `btn btn-sm rb-errors ${nErr ? 'has-err' : ''}`, 'aria-expanded': String(TV.errorsOpen), 'aria-label': `${plural(nErr, 'error')} seen on this page. Show list`, onClick: () => { TV.errorsOpen = !TV.errorsOpen; updateRibbon(); } }, icon('bug', 15), h('span', { text: nErr })),
    h('button', { type: 'button', class: `btn btn-sm rb-checks ${TV.drawerOpen ? 'is-on' : ''}`, 'aria-expanded': String(!!TV.drawerOpen), 'aria-label': 'Your checks panel', onClick: () => { TV.drawerOpen = !TV.drawerOpen; TV.root.dataset.drawer = TV.drawerOpen ? 'open' : 'closed'; updateRibbon(); requestAnimationFrame(layoutFrame); } }, icon('clipboard', 15), h('span', { text: `${c.manTotal - c.manOpen}/${c.manTotal}` })),
    h('a', { class: 'btn btn-ghost btn-sm', href: '#overview', title: 'Back to the dashboard' }, icon('grid', 15), h('span', { class: 'rb-text', text: 'Dashboard' })),
  );
  // errors drawer
  TV.errPop.hidden = !TV.errorsOpen;
  fill(TV.errPop, !TV.errorsOpen ? '' : h('div', { class: 'popover errors-panel', role: 'dialog', 'aria-label': 'Errors seen in the app' },
    h('div', { class: 'popover-head' }, h('strong', { text: `Errors seen (${nErr})` }), h('div', { class: 'row gap-s' }, nErr ? btn('Clear', { size: 'sm', kind: 'ghost', onClick: () => { TV.errors = []; updateRibbon(); } }) : null, h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', onClick: () => { TV.errorsOpen = false; updateRibbon(); } }, icon('x', 16)))),
    h('p', { class: 'muted small', text: 'Anvil watches the page for script errors and failed API calls. They go into the report as evidence, so you do not need to copy them.' }),
    nErr ? h('ul', { class: 'err-list' }, [...TV.errors].reverse().slice(0, 50).map((e) => h('li', { class: 'err-item' },
      h('div', { class: 'row gap-s wrap' }, chip(e.type === 'api-error' ? `API ${e.status || ''}` : e.type === 'console-error' ? 'Console' : 'Script', e.type === 'api-error' ? 'chip-amber' : 'chip-red'), h('span', { class: 'muted small', text: `${timeAgo(e.at)} · ${cap(e.role || '')} · ${e.page || ''}` })),
      h('code', { class: 'err-text', text: e.text }))))
      : h('div', { class: 'err-empty' }, icon('check', 16), h('span', { text: 'No errors so far.' }))));
}

// Test view drawer while the tester checks an automatic check by hand.
function autoDrawer(x) {
  const t = checkTarget(x);
  const autoSt = x.auto_status || x.status;
  const ov = x.override;
  return h('div', { class: 'tv-drawer-in' },
    h('div', { class: 'row between' }, h('span', { class: 'mini-h', text: 'Checking an automatic check' }), h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close panel', onClick: () => { TV.drawerOpen = false; updateTestView(); } }, icon('x', 16))),
    h('h2', { class: 'tv-title', text: x.name }),
    h('div', { class: 'row gap-s wrap' }, ov ? h('span', { class: `badge badge-${ov.status === 'pass' ? 'green' : 'red'}` }, icon('user', 13), `Checked by you: ${ov.status === 'pass' ? 'Passed' : 'Failed'}`) : null,
      ov ? h('s', { class: 'auto-struck', text: `Auto: ${(STATUS[autoSt] || STATUS.pending).label}` }) : badge(autoSt)),
    x.detail ? h('p', { class: 'small', text: `Automatic result: ${x.detail}` }) : null,
    h('div', { class: 'good-box small' }, h('div', { class: 'mini-h' }, icon('check', 13), 'What to look for'), h('p', { text: t.look })),
    t.kind === 'page' && !(TV.page === t.page && TV.role === t.role) ? btn(`Open ${t.page} as ${cap(t.role)}`, { kind: 'primary', size: 'sm', iconName: 'arrowRight', onClick: () => openAutoInView(x), cls: 'tv-open' }) : null,
    overrideBar(x),
    h('div', { class: 'tv-nav' },
      h('a', { class: 'btn btn-ghost btn-sm', href: `#auto/${encodeURIComponent(x.id)}` }, icon('arrowLeft', 14), h('span', { text: 'Back to Auto checks' })),
      btn('Your checks', { size: 'sm', kind: 'secondary', iconName: 'clipboard', onClick: () => { TV.autoCheck = null; updateDrawer(); } })));
}
function updateDrawer() {
  if (!TV.drawer || S.view !== 'test') return;
  const ac = TV.autoCheck ? checkById(TV.autoCheck) : null;
  if (ac) { fill(TV.drawer, autoDrawer(ac)); return; }
  const list = plan().manual || [];
  const m = currentManual();
  if (!m) {
    fill(TV.drawer, h('div', { class: 'tv-drawer-in' }, empty('clipboard', 'No manual checks', 'There is nothing to test by hand for this PR. Explore freely, then go to Complete.', h('a', { class: 'btn btn-primary', href: '#complete' }, 'Go to Complete'))));
    return;
  }
  TV.currentId = m.id;
  const idx = list.indexOf(m);
  const saved = state().manual?.[m.id] || {};
  const answer = saved.answer || null;
  const note = S.noteDrafts[m.id] ?? saved.note ?? '';
  const needsNote = answer === 'broken' || answer === 'unsure';
  const next = list.slice(idx + 1).find((x) => !state().manual?.[x.id]?.answer) || list[idx + 1] || null;
  const onPage = TV.page === m.page && TV.role === m.role;
  fill(TV.drawer, h('div', { class: 'tv-drawer-in', 'data-manual-id': m.id },
    h('div', { class: 'row between' }, h('span', { class: 'mini-h', text: `Check ${idx + 1} of ${list.length}` }), h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close panel', onClick: () => { TV.drawerOpen = false; updateTestView(); } }, icon('x', 16))),
    h('div', { class: 'tv-dots', role: 'list', 'aria-label': 'All checks' }, list.map((x, i) => {
      const a = state().manual?.[x.id]?.answer;
      return h('button', { type: 'button', role: 'listitem', class: `tv-dot ${a ? 'd-' + a : ''} ${x.id === m.id ? 'is-cur' : ''}`, 'aria-label': `Check ${i + 1}: ${x.title}${a ? ` (${a})` : ''}`, title: x.title, onClick: () => openCheckInView(x) }, String(i + 1));
    })),
    h('h2', { class: 'tv-title', text: m.title }),
    h('div', { class: 'row gap-s wrap' }, chip(AREA_NAME[m.area] || m.area, 'chip-soft'), m.needs === 'phone' ? h('span', { class: 'chip chip-amber' }, icon('phone', 12), 'Phone size') : null, h('span', { class: `ans-pill ${answer ? 'ap-' + answer : ''}`, text: answer ? ANSWERS.find((a) => a.id === answer).label : 'Not answered' })),
    m.why ? h('p', { class: 'small muted', text: m.why }) : null,
    onPage ? h('p', { class: 'hint small' }, icon('check', 14), h('span', { text: `You are on ${m.page} as ${cap(m.role)}.` }))
      : btn(`Open ${m.page || 'the page'} as ${cap(m.role)}`, { kind: 'primary', size: 'sm', iconName: 'arrowRight', onClick: () => openCheckInView(m), cls: 'tv-open' }),
    h('ol', { class: 'num-steps small-steps' }, (m.steps || []).map((s) => h('li', { text: s }))),
    h('div', { class: 'good-box small' }, h('div', { class: 'mini-h' }, icon('check', 13), 'What good looks like'), h('p', { text: m.good || 'Works as described.' })),
    h('div', { class: 'mini-h', id: `tvq-${m.id}`, text: 'Did it work?' }),
    h('div', { class: 'answer-row', role: 'group', 'aria-labelledby': `tvq-${m.id}` }, ANSWERS.map((a) => h('button', { type: 'button', class: `answer-btn ab-${a.tone} ${answer === a.id ? 'is-on' : ''}`, 'aria-pressed': String(answer === a.id), onClick: () => setAnswer(m.id, answer === a.id ? null : a.id) }, icon(a.icon, 15), a.label))),
    h('label', { class: 'field-label', for: `tvnote-${m.id}`, text: needsNote ? 'What happened? (please describe it)' : 'Notes (optional)' }),
    h('textarea', { id: `tvnote-${m.id}`, class: `textarea ${needsNote && !note.trim() ? 'needs' : ''}`, rows: 3, value: note, placeholder: needsNote ? 'What did you see? What did you expect?' : 'Anything worth telling the developer.', onInput: (e) => { S.noteDrafts[m.id] = e.target.value; scheduleNoteSave(m.id); } }),
    (saved.shots || []).length ? h('div', { class: 'thumbs' }, saved.shots.map((f) => thumb(f, saved.shots, 'thumb-sm'))) : null,
    h('div', { class: 'save-line small', 'aria-live': 'polite' }, saved.at ? h('span', { class: 'ok-text' }, icon('check', 12), ` Saved ${timeAgo(saved.at)}`) : h('span', { class: 'muted', text: 'Your answer saves by itself.' })),
    h('div', { class: 'tv-nav' },
      idx > 0 ? btn('Previous', { size: 'sm', kind: 'ghost', iconName: 'chevLeft', onClick: () => openCheckInView(list[idx - 1]) }) : h('span'),
      next ? h('button', { type: 'button', class: `btn btn-sm ${answer ? 'btn-primary' : 'btn-secondary'}`, onClick: () => openCheckInView(next) }, h('span', { text: 'Next check' }), icon('chevRight', 15))
        : counts().ready ? h('a', { class: 'btn btn-primary btn-sm', href: '#complete' }, 'Complete testing', icon('arrowRight', 14)) : h('span', { class: 'muted small', text: 'Last check' })),
  ));
}

/* ------------------------------------------------------------------ lightbox */

function openLightbox(file, list) {
  S.lightbox = { list: list && list.length ? [...list] : [file], idx: Math.max(0, (list || []).indexOf(file)) };
  renderLightbox();
  const dlg = $('#lightbox');
  if (!dlg.open) dlg.showModal();
}

function renderLightbox() {
  const dlg = $('#lightbox');
  const lb = S.lightbox;
  if (!lb) return;
  const file = lb.list[lb.idx];
  const s = shots().find((x) => x.file === file) || { file, page: file.replace(/^shots\//, ''), role: '', device: '' };
  const many = lb.list.length > 1;
  fill(dlg, 
    h('div', { class: 'lb-bar' },
      h('div', { class: 'lb-cap' }, h('strong', { text: s.page }), s.role ? h('span', { class: 'muted', text: ` · ${cap(s.role)} · ${cap(s.device)}` }) : null, many ? h('span', { class: 'muted', text: `  ${lb.idx + 1} / ${lb.list.length}` }) : null),
      h('div', { class: 'row gap-s' },
        s.page && s.role ? h('button', { type: 'button', class: 'btn btn-ghost btn-sm lb-open', onClick: () => { dlg.close(); TV.role = s.role; TV.page = s.page; if (s.device in DEVICE_SIZE) TV.device = s.device; if (S.view === 'test') { layoutFrame(); tvNavigate({ role: s.role, page: s.page }); } else location.hash = '#test'; } }, h('span', { text: 'Open in Test view' }), icon('monitor', 14)) : null,
        h('button', { type: 'button', class: 'icon-btn lb-close', 'aria-label': 'Close', onClick: () => dlg.close() }, icon('x', 20)))),
    h('div', { class: 'lb-stage' },
      many ? h('button', { type: 'button', class: 'lb-nav lb-prev', 'aria-label': 'Previous screenshot', onClick: () => stepLightbox(-1) }, icon('chevLeft', 22)) : null,
      h('img', { class: 'lb-img', src: shotSrc(file), alt: `${s.page} ${s.role ? 'as ' + s.role : ''} ${s.device ? 'on ' + s.device : ''}` }),
      many ? h('button', { type: 'button', class: 'lb-nav lb-next', 'aria-label': 'Next screenshot', onClick: () => stepLightbox(1) }, icon('chevRight', 22)) : null),
  );
}

function stepLightbox(d) {
  const lb = S.lightbox;
  lb.idx = (lb.idx + d + lb.list.length) % lb.list.length;
  renderLightbox();
}

/* ------------------------------------------------------------------ render */

const VIEW_FN = { test: () => null, overview: viewOverview, auto: viewAuto, manual: viewManual, screens: viewScreens, tools: viewTools, complete: viewComplete, sent: viewSent };

function renderShell() {
  const app = $('#app');
  app.dataset.copilot = S.copilotOpen ? 'open' : 'closed';
  app.dataset.nav = S.navOpen ? 'open' : 'closed';
  app.dataset.mode = S.view === 'test' ? 'test' : 'dash';
  const overlay = matchMedia('(max-width: 1199px)').matches;
  const scrim = $('#scrim');
  scrim.hidden = !(S.navOpen || (overlay && S.copilotOpen));
  renderTopbar();
  renderNav();
  renderCopilot();
}

function isEditing() {
  const a = document.activeElement;
  return a && $('#main').contains(a) && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && a.type === 'text'));
}

function renderMain() {
  const main = $('#main');
  const y = window.scrollY;
  const mainY = main.scrollTop;
  if (S.view === 'test') {
    if (!TV.root || !main.contains(TV.root)) fill(main, buildTestRoot());
    updateTestView();
    S.pendingRender = false;
    return;
  }
  const focusedId = document.activeElement && main.contains(document.activeElement) ? document.activeElement.id : null;
  const fn = VIEW_FN[S.view] || viewOverview;
  fill(main, fn());
  window.scrollTo(0, y);
  main.scrollTop = mainY;
  if (focusedId) document.getElementById(focusedId)?.focus({ preventScroll: true });
  S.pendingRender = false;
}

function render() {
  if (!S.data) return;
  renderShell();
  if (isEditing()) { S.pendingRender = true; return; }
  renderMain();
}

function scrollTop() { window.scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' }); $('#main').scrollTop = 0; }

/* ------------------------------------------------------------------ routing + events */

function route() {
  if (!S.data) return;
  const raw = location.hash.replace(/^#/, '');
  const cut = raw.indexOf('/');
  const view = cut < 0 ? raw : raw.slice(0, cut);
  let sub = cut < 0 ? '' : raw.slice(cut + 1);
  try { sub = decodeURIComponent(sub); } catch { /* keep raw */ }
  if (view === 'auto' && sub) { RUN.mine = sub; RUN.expanded.add(sub); }
  let v = VIEW_FN[view] ? view : 'overview';
  if (!raw) v = state().sent ? 'sent' : 'test';
  if (v === 'complete' && state().sent) v = 'sent';
  const changed = v !== S.view;
  S.view = v;
  S.navOpen = false;
  if (matchMedia('(max-width: 1199px)').matches && changed) S.copilotOpen = false;
  if (changed && v !== 'test') { TV.errorsOpen = false; }
  if (v === 'complete' && changed && S.completeStage === 'gate' && state().draft && !S.draft) { /* resume draft */ S.draft = structuredClone(state().draft); S.completeStage = 'preview'; }
  renderShell();
  renderMain();
  if (changed && !reducedMotion()) $('#main > .view')?.classList.add('view-enter');
  if (v === 'test') { if (changed) window.scrollTo(0, 0); }
  if (sub) {
    const el = document.getElementById(`m-${sub}`) || document.getElementById(`chk-${sub}`);
    if (el) { el.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1400); }
  } else if (changed) {
    window.scrollTo(0, 0);
    $('#main').focus({ preventScroll: true });
  }
  document.title = `${(VIEWS.find((x) => x.id === v) || { label: 'Sent' }).label} · PR #${plan().pr} · Anvil`;
}

function applyProject() {
  const p = proj();
  ROLES = p.roles;
  APP_PREFIX = p.pagePrefix;
}

function onData(d) {
  if (!d || !d.plan) return;
  S.data = d;
  applyProject();
  render();
}

function onProgress(ev) {
  if (!ev) return;
  if (ev.type === 'done') S.progress = null;
  else {
    if (ev.id && !RUN.started[ev.id] && ev.type === 'progress') RUN.started[ev.id] = new Date().toISOString();
    S.progress = ev;
  }
  render();
}

function connectLive() {
  let es;
  try { es = new EventSource(BASE + '/api/events'); } catch { return; }
  es.addEventListener('open', () => { if (S.conn !== 'ok') { S.conn = 'ok'; renderShell(); loadLog(); } });
  es.addEventListener('error', () => { S.conn = 'lost'; renderShell(); });
  es.addEventListener('progress', (e) => { try { onProgress(JSON.parse(e.data)); } catch { /* ignore bad line */ } });
  es.addEventListener('data', (e) => { try { onData(JSON.parse(e.data)); } catch { /* ignore */ } });
  es.addEventListener('log', (e) => { try { onLog(JSON.parse(e.data)); } catch { /* ignore */ } });
  es.addEventListener('shot', (e) => { try { onShot(JSON.parse(e.data)); } catch { /* ignore */ } });
  es.addEventListener('control', (e) => { try { applyControl(JSON.parse(e.data)); } catch { /* ignore */ } });
}

function bindGlobal() {
  window.addEventListener('hashchange', route);
  window.addEventListener('pagehide', flushOnExit);
  $('#scrim').addEventListener('click', () => { S.navOpen = false; if (matchMedia('(max-width: 1199px)').matches) S.copilotOpen = false; renderShell(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (S.healthOpen) { S.healthOpen = false; renderTopbar(); $('.health-btn')?.focus(); }
      else if (S.switchOpen) { S.switchOpen = false; renderTopbar(); $('.switch-btn')?.focus(); }
      else if (TV.errorsOpen) { TV.errorsOpen = false; updateRibbon(); $('.rb-errors')?.focus(); }
      else if (S.navOpen) { S.navOpen = false; renderShell(); }
      else if (S.copilotOpen && matchMedia('(max-width: 1199px)').matches) { S.copilotOpen = false; renderShell(); }
    }
    const dlg = $('#lightbox');
    if (dlg.open && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { e.preventDefault(); stepLightbox(e.key === 'ArrowLeft' ? -1 : 1); }
  });
  document.addEventListener('click', (e) => {
    if (S.healthOpen && !e.target.closest('.health')) { S.healthOpen = false; renderTopbar(); }
    if (S.switchOpen && !e.target.closest('.switch-pr')) { S.switchOpen = false; renderTopbar(); }
    if (TV.errorsOpen && !e.target.closest('.errors-panel, .rb-errors')) { TV.errorsOpen = false; updateRibbon(); }
  });
  document.addEventListener('paste', (e) => {
    if (S.view !== 'manual' || e.defaultPrevented) return;
    if (e.target.closest?.('.paste-zone')) return;
    const id = e.target.closest?.('[data-manual-id]')?.dataset.manualId || S.lastCard;
    if (id) handlePaste(e, id);
  });
  $('#main').addEventListener('focusout', () => { setTimeout(() => { if (S.pendingRender && !isEditing()) renderMain(); }, 0); });
  $('#lightbox').addEventListener('click', (e) => { if (e.target.id === 'lightbox') e.target.close(); });
  matchMedia('(max-width: 1199px)').addEventListener('change', () => renderShell());
}

function fatal(msg) {
  fill($('#main'), h('div', { class: 'view' }, h('section', { class: 'card fatal' }, h('div', { class: 'gate-icon bad' }, icon('alert', 22)), h('h1', { text: 'Anvil cannot start' }), h('p', { class: 'lead', text: msg }),
    h('ol', { class: 'num-steps' }, h('li', { text: 'Go back to Claude Code.' }), h('li', null, 'Say ', h('code', { text: 'start anvil' }), ' again. It restarts the Anvil server and opens this page.'), h('li', { text: 'Still broken? Check that the Anvil server is running and that anvil.config.json is valid.' })),
    btn('Try again', { kind: 'primary', iconName: 'refresh', onClick: () => location.reload() }))));
}

async function boot() {
  bindGlobal();
  let data = null;
  if (params.get('mock') !== '1') {
    try { data = await liveApi('GET', BASE + '/api/data'); S.mode = 'live'; } catch { S.fallback = true; }
  }
  if (!data) {
    try {
      const json = await fetch('mock.json', { cache: 'no-store' }).then((r) => { if (!r.ok) throw new Error(); return r.json(); });
      S.mode = 'mock';
      S.mock = new MockServer(json);
      S.mock.on('data', onData);
      S.mock.on('progress', onProgress);
      S.mock.on('control', applyControl);
      S.mock.on('log', onLog);
      S.mock.on('shot', onShot);
      window.anvilMock = { control: (c) => S.mock.handle('POST', '/api/control', c), session: () => S.mock.handle('GET', '/api/session') };
      data = await S.mock.handle('GET', '/api/data');
    } catch {
      fatal('The QA server is not answering.');
      return;
    }
  } else {
    connectLive();
  }
  S.data = data;
  applyProject();
  if (data.state?.draft && !data.state?.sent) S.draft = structuredClone(data.state.draft);
  if (matchMedia('(max-width: 1199px)').matches) S.copilotOpen = false;
  route();
  loadNext();
  loadLog();
  setInterval(() => { document.querySelectorAll('.js-elapsed').forEach((el) => { if (el.dataset.start) el.textContent = fmtElapsed(el.dataset.start); }); }, 1000);
}

boot();
