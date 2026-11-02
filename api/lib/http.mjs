// Small HTTP helpers for API Gateway HTTP API (payload format 2.0) events.
// No secrets, cookies or request bodies are ever logged from here.
import { timingSafeEqual, createHash, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';

export class HttpError extends Error {
  constructor(status, code, message, extra) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.publicMessage = message || code;
    this.extra = extra;
  }
}

const BASE_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

export function json(status, body, { headers = {}, cookies } = {}) {
  const res = {
    statusCode: status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...BASE_HEADERS, ...headers },
    body: JSON.stringify(body),
  };
  if (cookies && cookies.length) res.cookies = cookies;
  return res;
}

export function html(status, markup, { cookies } = {}) {
  const res = {
    statusCode: status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
      ...BASE_HEADERS,
    },
    body: markup,
  };
  if (cookies && cookies.length) res.cookies = cookies;
  return res;
}

export function redirect(location, { cookies } = {}) {
  const res = { statusCode: 302, headers: { location, ...BASE_HEADERS }, body: '' };
  if (cookies && cookies.length) res.cookies = cookies;
  return res;
}

export function errorResponse(err) {
  const body = { error: err.code, message: err.publicMessage };
  if (err.extra) Object.assign(body, err.extra);
  const headers = {};
  if (err.status === 429 && err.extra && err.extra.retryAfterSeconds) headers['retry-after'] = String(err.extra.retryAfterSeconds);
  return json(err.status, body, { headers });
}

/** Lower-cased header lookup (HTTP API already lower-cases, but be defensive). */
export function header(event, name) {
  const h = event.headers || {};
  const want = name.toLowerCase();
  if (h[want] !== undefined) return h[want];
  for (const k of Object.keys(h)) if (k.toLowerCase() === want) return h[k];
  return undefined;
}

export function parseCookies(event) {
  const out = {};
  const parts = [];
  if (Array.isArray(event.cookies)) parts.push(...event.cookies);
  const raw = header(event, 'cookie');
  if (raw) parts.push(...String(raw).split(';'));
  for (const p of parts) {
    const i = p.indexOf('=');
    if (i <= 0) continue;
    const k = p.slice(0, i).trim();
    const v = p.slice(i + 1).trim();
    if (k && !(k in out)) out[k] = v;
  }
  return out;
}

/** Cookie that only HTTPS same-site requests carry. `__Host-` prefix forces Secure + Path=/ + no Domain. */
export function setCookie(name, value, maxAgeSeconds) {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`;
}
export function clearCookie(name) {
  return `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export function method(event) {
  return String(event.requestContext?.http?.method || event.httpMethod || 'GET').toUpperCase();
}

export function path(event) {
  let p = String(event.rawPath || event.requestContext?.http?.path || '/');
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

export function query(event) {
  return event.queryStringParameters || {};
}

export function readJson(event, maxBytes = 16 * 1024) {
  const ct = String(header(event, 'content-type') || '').toLowerCase();
  if (!ct.startsWith('application/json')) throw new HttpError(415, 'unsupported_media_type', 'Send JSON (Content-Type: application/json).');
  let raw = event.body || '';
  if (event.isBase64Encoded) raw = Buffer.from(raw, 'base64').toString('utf8');
  if (Buffer.byteLength(raw, 'utf8') > maxBytes) throw new HttpError(413, 'body_too_large', `Request body is larger than ${maxBytes} bytes.`);
  let data;
  try { data = JSON.parse(raw || '{}'); } catch { throw new HttpError(400, 'bad_json', 'Request body is not valid JSON.'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new HttpError(400, 'bad_json', 'Request body must be a JSON object.');
  return data;
}

export function safeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ''), 'utf8');
  const bb = Buffer.from(String(b ?? ''), 'utf8');
  if (ba.length !== bb.length || ba.length === 0) return false;
  return timingSafeEqual(ba, bb);
}

export function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}
export function randomToken(bytes = 32) {
  return b64url(randomBytes(bytes));
}
export function sha256hex(s) {
  return createHash('sha256').update(String(s)).digest('hex');
}
export function sha256b64url(s) {
  return createHash('sha256').update(String(s)).digest('base64url');
}

/**
 * Viewer IP. Behind CloudFront the API Gateway sourceIp is the edge, so prefer the
 * CloudFront-Viewer-Address header (ip:port), which CloudFront always overwrites.
 */
export function clientIp(event) {
  const v = header(event, 'cloudfront-viewer-address');
  if (v) {
    const s = String(v).trim();
    const ip = s.includes(':') ? s.slice(0, s.lastIndexOf(':')).replace(/^\[|\]$/g, '') : s;
    if (isIP(ip)) return ip;
  }
  const src = event.requestContext?.http?.sourceIp;
  return src && isIP(src) ? src : 'unknown';
}

export function corsHeaders(event, allowedOrigins) {
  const origin = header(event, 'origin');
  if (origin && allowedOrigins.includes(origin)) {
    return {
      'access-control-allow-origin': origin,
      'access-control-allow-credentials': 'true',
      vary: 'Origin',
    };
  }
  return { vary: 'Origin' };
}
