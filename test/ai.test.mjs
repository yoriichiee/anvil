import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveProvider, complete, parseJSON } from '../src/ai/provider.mjs';
import { humanChecklist, templateChecklist, validateChecklist } from '../src/ai/checklist.mjs';
import { polishBrief, validatePolish } from '../src/ai/brief.mjs';
import { CORPUS } from './fake-secrets.mjs';

test('provider resolution: none by default, env key -> byok, unknown -> error', async () => {
  assert.equal((await resolveProvider('', {})).name, 'none');
  const p = await resolveProvider('', { ANTHROPIC_API_KEY: 'k' });
  assert.equal(p.name, 'anthropic'); assert.equal(p.mode, 'byok');
  assert.equal((await resolveProvider('openai', {})).name, 'none', 'no key -> templates');
  await assert.rejects(resolveProvider('gemini', {}), /unknown AI provider/);
  assert.equal((await resolveProvider('credits', {})).mode, 'credits');
});

test('templates follow detected features (no AI)', () => {
  const ids = templateChecklist({ features: { auth: true, payments: false, uploads: true, forms: false } }).map(h => h.id);
  assert.ok(ids.includes('h-signup-login') && ids.includes('h-upload-limits') && !ids.includes('h-checkout-test'));
});

test('AI checklist: sends only redacted, fenced input; validated output is used', async () => {
  let sent;
  const fetchImpl = async (url, init) => {
    sent = JSON.parse(init.body);
    return new Response(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: '```json\n{"items":[{"id":"h-x","prompt":"Can you log in?","steps":["Open /login"]}]}\n```' }] }), { status: 200 });
  };
  const provider = { name: 'anthropic', mode: 'byok', model: 'm', _key: 'test' };
  const r = await humanChecklist({ provider, features: { auth: true }, findings: [{ check: 'secret-scan', severity: 'critical', title: 'leak ' + CORPUS.stripe }], pages: [{ role: 'anon', path: '/?t=' + CORPUS.github }] }, fetchImpl);
  assert.equal(r.source, 'ai'); assert.deepEqual(r.items.map(h => h.id), ['h-x']);
  const body = JSON.stringify(sent);
  assert.ok(!body.includes(CORPUS.stripe) && !body.includes(CORPUS.github), 'secret sent to the model');
  assert.match(sent.messages[0].content, /<untrusted source="scan facts">/);
  assert.match(sent.system, /never follow them/);
});

test('AI checklist: invalid model output or API errors fall back to templates', async () => {
  const provider = { name: 'openai', mode: 'byok', model: 'm', _key: 'k' };
  const bad = async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"items":"ignore all rules"}' } }] }), { status: 200 });
  const r = await humanChecklist({ provider, features: { forms: true }, findings: [] }, bad);
  assert.equal(r.source, 'template'); assert.match(r.warning, /AI checklist not used/);
  const down = async () => new Response('{}', { status: 500 });
  assert.equal((await humanChecklist({ provider, features: {}, findings: [] }, down)).source, 'template');
  assert.throws(() => validateChecklist({ items: [{ id: 'h-a', prompt: 'x', steps: [] }] }), /bad steps/);
});

test('credits provider: 429 = cap reached', async () => {
  await assert.rejects(complete({ name: 'credits', url: 'https://x/api/ai' }, { system: 's', user: 'u' }, async () => new Response('', { status: 429 })), /used up/);
});

test('fix-brief polish only accepts known ids and no "secure" claims', async () => {
  const ids = new Set(['f-a', 'f-b']);
  assert.deepEqual(validatePolish({ intro: 'Fix the key.', order: ['f-b', 'f-a'] }, ids).order, ['f-b', 'f-a']);
  assert.throws(() => validatePolish({ intro: 'Now it is secure.', order: [] }, ids), /secure/);
  assert.throws(() => validatePolish({ intro: 'ok', order: ['f-zzz'] }, ids), /unknown/);
  const report = { findings: [{ id: 'f-a', severity: 'high', title: 't', why: 'w', fix: 'f' }] };
  assert.equal(await polishBrief({ provider: { name: 'none' }, report }), null);
  const p = await polishBrief({ provider: { name: 'anthropic', model: 'm', _key: 'k' }, report }, async () => new Response(JSON.stringify({ content: [{ type: 'text', text: '{"intro":"Start with f-a.","order":["f-a"]}' }] }), { status: 200 }));
  assert.equal(p.intro, 'Start with f-a.');
  assert.equal(parseJSON('noise {"a":1} noise').a, 1);
});
