// GitHub App user-authorization flow + the few REST calls GitHub mode needs.
// Tokens are passed in, never stored or logged here.
import { createWriteStream } from 'node:fs';
import { HttpError } from './http.mjs';

const API = 'https://api.github.com';
const UA = 'anvil-api (+https://anvil.horvans.com)';

export const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
export const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
export const REF_RE = /^[A-Za-z0-9._\/-]{1,200}$/;

export function validRepoInput(owner, repo, ref) {
  if (typeof owner !== 'string' || !OWNER_RE.test(owner)) return 'owner';
  if (typeof repo !== 'string' || !REPO_RE.test(repo) || repo === '.' || repo === '..') return 'repo';
  if (ref !== undefined && ref !== null && ref !== '') {
    if (typeof ref !== 'string' || !REF_RE.test(ref) || ref.includes('..') || ref.startsWith('/') || ref.endsWith('/') || ref.endsWith('.lock')) return 'ref';
  }
  return null;
}

/** https://github.com/owner/repo[.git][/tree/<ref>] -> {owner, repo, ref?} or null. */
export function parseRepoUrl(input) {
  if (typeof input !== 'string' || input.length > 400) return null;
  let u;
  try { u = new URL(input.trim()); } catch { return null; }
  if (u.protocol !== 'https:' || (u.hostname !== 'github.com' && u.hostname !== 'www.github.com') || u.username || u.password || u.port) return null;
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/, '');
  let ref;
  if (parts[2] === 'tree' && parts.length > 3) ref = decodeURIComponent(parts.slice(3).join('/'));
  else if (parts.length > 2) return null;
  if (validRepoInput(owner, repo, ref)) return null;
  return { owner, repo, ref };
}

const encRef = (ref) => ref.split('/').map(encodeURIComponent).join('/');

export class GitHub {
  constructor({ fetch: f = globalThis.fetch, timeoutMs = 10000 } = {}) {
    this.fetch = f;
    this.timeoutMs = timeoutMs;
  }

  #headers(token) {
    const h = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': UA };
    if (token) h.authorization = `Bearer ${token}`;
    return h;
  }

  async #api(path, token, { allow404 = false } = {}) {
    const res = await this.fetch(`${API}${path}`, { headers: this.#headers(token), signal: AbortSignal.timeout(this.timeoutMs) });
    if (res.status === 404 && allow404) return null;
    if (res.status === 401) throw new HttpError(401, 'github_reauth', 'Your GitHub sign-in expired. Sign in again.');
    if (res.status === 403 || res.status === 429) {
      const remaining = res.headers.get('x-ratelimit-remaining');
      if (remaining === '0' || res.status === 429) throw new HttpError(503, 'github_rate_limited', 'GitHub is rate-limiting Anvil right now. Try again in a few minutes.');
      if (allow404) return null;
    }
    if (!res.ok) throw new HttpError(502, 'github_error', `GitHub answered ${res.status}.`);
    return res.json();
  }

  authorizeUrl({ clientId, redirectUri, state, codeChallenge }) {
    const q = new URLSearchParams({
      client_id: clientId, redirect_uri: redirectUri, state,
      code_challenge: codeChallenge, code_challenge_method: 'S256', allow_signup: 'true',
    });
    return `https://github.com/login/oauth/authorize?${q}`;
  }

  async #token(params) {
    const res = await this.fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    let j = null;
    try { j = await res.json(); } catch { /* handled below */ }
    if (!res.ok || !j || j.error || !j.access_token) {
      // GitHub's error codes are safe to surface (bad_verification_code, incorrect_client_credentials...).
      const code = j && typeof j.error === 'string' ? j.error.replace(/[^a-z_]/g, '').slice(0, 60) : `http_${res.status}`;
      throw new HttpError(502, 'github_token_error', `GitHub refused the sign-in (${code}).`);
    }
    return j;
  }

  /** @returns {Promise<{access:string, refresh:string|null, accessExp:number|null, refreshExp:number|null}>} */
  async exchangeCode({ clientId, clientSecret, code, redirectUri, codeVerifier, now = Date.now() }) {
    const j = await this.#token({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri, code_verifier: codeVerifier });
    return toTokens(j, now);
  }

  async refresh({ clientId, clientSecret, refreshToken, now = Date.now() }) {
    const j = await this.#token({ client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token', refresh_token: refreshToken });
    return toTokens(j, now);
  }

  /** Best-effort: revoke one user token (DELETE /applications/{client_id}/token). */
  async revoke({ clientId, clientSecret, token }) {
    try {
      await this.fetch(`${API}/applications/${encodeURIComponent(clientId)}/token`, {
        method: 'DELETE',
        headers: { ...this.#headers(null), authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`, 'content-type': 'application/json' },
        body: JSON.stringify({ access_token: token }),
        signal: AbortSignal.timeout(5000),
      });
    } catch { /* ignore */ }
  }

  async user(token) {
    const u = await this.#api('/user', token);
    return { id: Number(u.id), login: String(u.login), name: u.name ? String(u.name).slice(0, 200) : null, avatarUrl: typeof u.avatar_url === 'string' ? u.avatar_url : null };
  }

  /** Repos the user can reach through installations of this GitHub App. */
  async repos(token, { maxRepos = 300 } = {}) {
    const inst = await this.#api('/user/installations?per_page=100', token);
    const out = [];
    let truncated = false;
    for (const i of inst.installations || []) {
      for (let page = 1; page <= 3; page++) {
        const r = await this.#api(`/user/installations/${Number(i.id)}/repositories?per_page=100&page=${page}`, token);
        for (const repo of r.repositories || []) {
          if (out.length >= maxRepos) { truncated = true; break; }
          out.push({
            owner: repo.owner?.login, name: repo.name, fullName: repo.full_name, private: !!repo.private,
            defaultBranch: repo.default_branch, installationId: Number(i.id), updatedAt: repo.pushed_at || repo.updated_at || null,
          });
        }
        if (truncated || (r.repositories || []).length < 100) break;
      }
      if (truncated) break;
    }
    return { repos: out, installations: (inst.installations || []).length, truncated };
  }

  /** Repo metadata or null when it does not exist / is not visible to this token. */
  async repo(token, owner, repo) {
    const r = await this.#api(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, token, { allow404: true });
    if (!r) return null;
    return { private: !!r.private, defaultBranch: String(r.default_branch || 'main'), sizeKb: Number(r.size || 0), fullName: String(r.full_name) };
  }

  /**
   * Download the repo tarball at `ref` to destPath, aborting above maxBytes.
   * The API answers 302 -> codeload.github.com; we follow it by hand so the token is never
   * sent anywhere except api.github.com.
   */
  async downloadTarball(token, owner, repo, ref, destPath, maxBytes) {
    const first = await this.fetch(`${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tarball/${encRef(ref)}`, {
      headers: this.#headers(token), redirect: 'manual', signal: AbortSignal.timeout(this.timeoutMs),
    });
    let res = first;
    if (first.status >= 300 && first.status < 400) {
      const loc = first.headers.get('location');
      let u;
      try { u = new URL(loc); } catch { throw new HttpError(502, 'github_error', 'GitHub sent a bad download link.'); }
      if (u.protocol !== 'https:' || u.hostname !== 'codeload.github.com') throw new HttpError(502, 'github_error', 'GitHub sent an unexpected download host.');
      res = await this.fetch(u.toString(), { headers: { 'user-agent': UA }, redirect: 'error', signal: AbortSignal.timeout(20000) });
    }
    if (res.status === 404) throw new HttpError(404, 'ref_not_found', 'That branch, tag or commit was not found.');
    if (!res.ok || !res.body) throw new HttpError(502, 'github_error', `Download failed (${res.status}).`);
    const len = Number(res.headers.get('content-length') || 0);
    if (len > maxBytes) throw new HttpError(413, 'repo_too_large', `The repo archive is over ${Math.round(maxBytes / 1048576)} MB. Use local mode (anvil scan) for big repos.`);

    const out = createWriteStream(destPath, { mode: 0o600 });
    let total = 0;
    try {
      for await (const chunk of res.body) {
        total += chunk.length;
        if (total > maxBytes) throw new HttpError(413, 'repo_too_large', `The repo archive is over ${Math.round(maxBytes / 1048576)} MB. Use local mode (anvil scan) for big repos.`);
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      }
    } finally {
      await new Promise((r) => out.end(r));
    }
    return total;
  }
}

function toTokens(j, now) {
  return {
    access: String(j.access_token),
    refresh: j.refresh_token ? String(j.refresh_token) : null,
    accessExp: j.expires_in ? now + Number(j.expires_in) * 1000 : null,
    refreshExp: j.refresh_token_expires_in ? now + Number(j.refresh_token_expires_in) * 1000 : null,
  };
}
