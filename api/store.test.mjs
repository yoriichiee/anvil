import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DynamoStore, MemoryStore } from './lib/store.mjs';
import { KmsCrypto, SecretsLoader } from './lib/aws.mjs';

function recorder(reply = () => ({})) {
  const calls = [];
  const send = async (service, op, input) => { calls.push({ service, op, input }); return reply(service, op, input); };
  send.calls = calls;
  return send;
}

test('DynamoStore.consume sends one conditional transaction for all counters', async () => {
  const send = recorder();
  const s = new DynamoStore({ send, table: 'anvil-main', now: () => 1_000_000_000_000 });
  const r = await s.consume([{ pk: 'cnt#ai#user#1', sk: 'm#2026-11', cap: 3, ttlSeconds: 100 }, { pk: 'cnt#ai#global', sk: 'd#2026-11-02', cap: 200, ttlSeconds: 100 }]);
  assert.deepEqual(r, { ok: true });
  const c = send.calls[0];
  assert.equal(c.op, 'TransactWriteItems');
  assert.equal(c.input.TransactItems.length, 2);
  const u = c.input.TransactItems[0].Update;
  assert.equal(u.TableName, 'anvil-main');
  assert.equal(u.ConditionExpression, 'attribute_not_exists(#n) OR #n < :cap');
  assert.equal(u.ExpressionAttributeValues[':cap'].N, '3');
  assert.equal(u.ExpressionAttributeValues[':ttl'].N, String(1_000_000_000 + 100));
});

test('DynamoStore.consume maps TransactionCanceled to the capped counter index', async () => {
  const send = recorder(() => {
    throw Object.assign(new Error('cancelled'), { name: 'TransactionCanceledException', CancellationReasons: [{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }] });
  });
  const s = new DynamoStore({ send, table: 't' });
  assert.deepEqual(await s.consume([{ pk: 'a', sk: 'b', cap: 1, ttlSeconds: 1 }, { pk: 'c', sk: 'd', cap: 1, ttlSeconds: 1 }]), { ok: false, index: 1 });
});

test('DynamoStore ignores expired items even before TTL deletion runs', async () => {
  const send = recorder((svc, op) => (op === 'GetItem' ? { Item: { pk: { S: 'x' }, sk: { S: 'session' }, data: { S: '{"uid":1}' }, ttl: { N: '10' } } } : {}));
  const s = new DynamoStore({ send, table: 't', now: () => 20_000 });
  assert.equal(await s.getSession('h'), null);
  const s2 = new DynamoStore({ send, table: 't', now: () => 5_000 });
  assert.deepEqual((await s2.getSession('h')).data, { uid: 1 });
});

test('DynamoStore.takeOAuthState deletes and returns the old item', async () => {
  const send = recorder((svc, op) => (op === 'DeleteItem' ? { Attributes: { data: { S: '{"verifier":"v"}' }, ttl: { N: '999999999999' } } } : {}));
  const s = new DynamoStore({ send, table: 't' });
  assert.deepEqual(await s.takeOAuthState('h'), { verifier: 'v' });
  assert.equal(send.calls[0].input.ReturnValues, 'ALL_OLD');
  assert.deepEqual(send.calls[0].input.Key, { pk: { S: 'oauth#h' }, sk: { S: 'state' } });
});

test('MemoryStore caps are atomic across counters', async () => {
  const s = new MemoryStore();
  const cs = [{ pk: 'u', sk: 'm', cap: 2, ttlSeconds: 60 }, { pk: 'g', sk: 'd', cap: 3, ttlSeconds: 60 }];
  assert.equal((await s.consume(cs)).ok, true);
  assert.equal((await s.consume(cs)).ok, true);
  assert.deepEqual(await s.consume(cs), { ok: false, index: 0 });
  assert.equal(await s.getCount('g', 'd'), 2, 'global must not move when user cap blocks');
});

test('KmsCrypto passes the encryption context both ways', async () => {
  const send = recorder((svc, op, input) => (op === 'Encrypt' ? { CiphertextBlob: Buffer.from('ct') } : { Plaintext: Buffer.from('plain') }));
  const k = new KmsCrypto({ send, keyId: 'alias/anvil' });
  const ct = await k.encrypt('plain', { uid: '1' });
  assert.equal(await k.decrypt(ct, { uid: '1' }), 'plain');
  assert.deepEqual(send.calls.map((c) => [c.op, c.input.EncryptionContext.uid, c.input.KeyId]), [['Encrypt', '1', 'alias/anvil'], ['Decrypt', '1', 'alias/anvil']]);
});

test('SecretsLoader caches and validates the GitHub parameter', async () => {
  let n = 0;
  const send = async () => { n++; return { Parameter: { Value: JSON.stringify({ appId: '1', clientId: 'c', clientSecret: 's', appSlug: 'anvil' }) } }; };
  const l = new SecretsLoader({ send });
  await l.github('/anvil/github');
  await l.github('/anvil/github');
  assert.equal(n, 1);
  const bad = new SecretsLoader({ send: async () => ({ Parameter: { Value: '{"clientId":"c"}' } }) });
  await assert.rejects(bad.github('/x'), /missing clientSecret/);
  const raw = new SecretsLoader({ send: async () => ({ Parameter: { Value: ' key-value \n' } }) });
  assert.equal(await raw.anthropicKey('/a'), 'key-value');
});
