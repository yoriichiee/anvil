// Anvil - AI provider adapter (plain fetch, no SDKs). Used ONLY to (a) write the human checklist and (b) polish the fix
// brief. Every call: input is redacted + fenced as <untrusted> by the caller (src/redact.mjs forAI), output must be JSON
// and is validated by the caller; any failure falls back to templates.
//   provider: none | anthropic | openai | openrouter | credits     (--ai flag, or ANVIL_AI)
//   key:      ANTHROPIC_API_KEY / OPENAI_API_KEY / OPENROUTER_API_KEY, or the OS keychain via @napi-rs/keyring
//             (service "anvil", account = provider name) when that optional package is installed.
//   model:    ANVIL_AI_MODEL overrides the default per provider.
//   credits:  the hosted capped free credits (POST $ANVIL_CREDITS_URL, default https://anvil.horvans.com/api/ai);
//             429 = cap reached -> templates.

export const PROVIDERS = ['none', 'anthropic', 'openai', 'openrouter', 'credits'];
const ENV_KEY = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', openrouter: 'OPENROUTER_API_KEY' };
const DEFAULT_MODEL = { anthropic: 'claude-opus-5-5', openai: 'gpt-5-mini', openrouter: 'anthropic/claude-haiku-4.5' };

let keyring;   // undefined = not tried, null = unavailable
async function keyringGet(account) {
  if (keyring === undefined) { try { keyring = (await import('@napi-rs/keyring')).Entry; } catch { keyring = null; } }
  if (!keyring) return null;
  try { return new keyring('anvil', account).getPassword() || null; } catch { return null; }
}
export async function keyringSet(account, secret) {
  if (keyring === undefined) { try { keyring = (await import('@napi-rs/keyring')).Entry; } catch { keyring = null; } }
  if (!keyring) throw new Error('@napi-rs/keyring is not installed; set ' + (ENV_KEY[account] || 'the key') + ' in the environment instead');
  new keyring('anvil', account).setPassword(secret);
}
export const keyringAvailable = async () => { if (keyring === undefined) { try { keyring = (await import('@napi-rs/keyring')).Entry; } catch { keyring = null; } } return !!keyring; };

// which provider would run; never returns the key itself to callers outside this module
export async function resolveProvider(name = process.env.ANVIL_AI, env = process.env) {
  let p = String(name || '').toLowerCase();
  if (!p) p = env.ANTHROPIC_API_KEY ? 'anthropic' : env.OPENAI_API_KEY ? 'openai' : env.OPENROUTER_API_KEY ? 'openrouter' : 'none';
  if (!PROVIDERS.includes(p)) throw new Error('unknown AI provider "' + p + '" (use ' + PROVIDERS.join(', ') + ')');
  if (p === 'none') return { name: 'none', mode: 'none' };
  if (p === 'credits') return { name: 'credits', mode: 'credits', url: env.ANVIL_CREDITS_URL || 'https://anvil.horvans.com/api/ai', token: env.ANVIL_CREDITS_TOKEN || null };
  const key = env[ENV_KEY[p]] || (await keyringGet(p));
  if (!key) return { name: 'none', mode: 'none', warning: `no ${p} key (set ${ENV_KEY[p]} or store it with "anvil key set ${p}"); using templates` };
  return { name: p, mode: 'byok', model: env.ANVIL_AI_MODEL || DEFAULT_MODEL[p], _key: key };
}

const TIMEOUT = 60000;
// -> raw text of the model's answer. system/user are already redacted + fenced by the caller.
export async function complete(provider, { system, user, maxTokens = 2000 }, fetchImpl = globalThis.fetch) {
  if (!provider || provider.name === 'none') throw new Error('AI is off');
  let r, j;
  if (provider.name === 'anthropic') {
    r = await fetchImpl('https://api.anthropic.com/v1/messages', { method: 'POST', signal: AbortSignal.timeout(TIMEOUT),
      headers: { 'content-type': 'application/json', 'x-api-key': provider._key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: provider.model, max_tokens: maxTokens, system, output_config: { effort: 'low' }, messages: [{ role: 'user', content: user }] }) });
    j = await r.json().catch(() => null);
    if (!r.ok) throw new Error('anthropic ' + r.status + ': ' + String(j && j.error && j.error.message || '').slice(0, 200));
    if (j.stop_reason === 'refusal') throw new Error('the model declined');
    return (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  }
  if (provider.name === 'openai' || provider.name === 'openrouter') {
    const url = provider.name === 'openai' ? 'https://api.openai.com/v1/chat/completions' : 'https://openrouter.ai/api/v1/chat/completions';
    r = await fetchImpl(url, { method: 'POST', signal: AbortSignal.timeout(TIMEOUT),
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + provider._key, ...(provider.name === 'openrouter' ? { 'HTTP-Referer': 'https://anvil.horvans.com', 'X-Title': 'Anvil' } : {}) },
      body: JSON.stringify({ model: provider.model, max_completion_tokens: maxTokens, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }) });
    j = await r.json().catch(() => null);
    if (!r.ok) throw new Error(provider.name + ' ' + r.status + ': ' + String(j && j.error && j.error.message || '').slice(0, 200));
    return String(j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content || '');
  }
  if (provider.name === 'credits') {
    r = await fetchImpl(provider.url, { method: 'POST', signal: AbortSignal.timeout(TIMEOUT), credentials: 'include',
      headers: { 'content-type': 'application/json', ...(provider.token ? { authorization: 'Bearer ' + provider.token } : {}) },
      body: JSON.stringify({ task: 'anvil', system, user, maxTokens }) });
    if (r.status === 429) throw new Error('free AI credits used up for now (429); using templates');
    j = await r.json().catch(() => null);
    if (!r.ok) throw new Error('credits ' + r.status);
    return String(j && j.text || '');
  }
  throw new Error('unknown provider');
}

// first JSON object in a model answer (tolerates ```json fences) -> object, or throws
export function parseJSON(text) {
  const s = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('no JSON object in the answer');
  return JSON.parse(s.slice(a, b + 1));
}
