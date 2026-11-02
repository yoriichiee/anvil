// Persistence for the anvil-main table (pk/sk, TTL attribute "ttl").
// Two implementations share one interface: DynamoStore (prod) and MemoryStore (tests/local).
//
// Key layout (all strings; secrets never stored in key attributes):
//   oauth#<sha256(state)>        / state          -> {data: {verifier}}                TTL 10 min
//   sess#<sha256(sessionId)>     / session        -> {data: {uid, login, ..., tok}}    TTL 7 days
//   cnt#ai#user#<githubId>       / m#YYYY-MM      -> {n}                               TTL ~40 days
//   cnt#ai#global                / d#YYYY-MM-DD   -> {n}                               TTL 2 days
//   cnt#scan#user#<githubId>     / d#YYYY-MM-DD   -> {n}
//   cnt#scan#global              / d#YYYY-MM-DD   -> {n}
//   cnt#demo#ip#<sha256(ip)>     / d#YYYY-MM-DD   -> {n}
//   cnt#demo#global              / d#YYYY-MM-DD   -> {n}
// DynamoDB TTL deletion is lazy, so every read also checks `ttl` itself.

const nowSec = (now) => Math.floor(now() / 1000);

export class DynamoStore {
  /** @param {{send:(service:string, op:string, input:object)=>Promise<any>, table:string, now?:()=>number}} o */
  constructor({ send, table, now = Date.now }) {
    if (!table) throw new Error('TABLE_NAME is not set');
    this.send = send;
    this.table = table;
    this.now = now;
  }

  #key(pk, sk) { return { pk: { S: pk }, sk: { S: sk } }; }

  async #putData(pk, sk, data, ttlSeconds) {
    await this.send('ddb', 'PutItem', {
      TableName: this.table,
      Item: { ...this.#key(pk, sk), data: { S: JSON.stringify(data) }, ttl: { N: String(nowSec(this.now) + ttlSeconds) } },
    });
  }

  #unpack(item) {
    if (!item || !item.data) return null;
    const ttl = Number(item.ttl?.N || 0);
    if (ttl && ttl <= nowSec(this.now)) return null;
    try { return { data: JSON.parse(item.data.S), ttl }; } catch { return null; }
  }

  async putOAuthState(stateHash, data, ttlSeconds) { await this.#putData(`oauth#${stateHash}`, 'state', data, ttlSeconds); }

  /** One-time read: deletes the state and returns what it held (or null). */
  async takeOAuthState(stateHash) {
    const r = await this.send('ddb', 'DeleteItem', {
      TableName: this.table, Key: this.#key(`oauth#${stateHash}`, 'state'), ReturnValues: 'ALL_OLD',
    });
    const u = this.#unpack(r?.Attributes);
    return u ? u.data : null;
  }

  async putSession(idHash, data, ttlSeconds) { await this.#putData(`sess#${idHash}`, 'session', data, ttlSeconds); }

  async getSession(idHash) {
    const r = await this.send('ddb', 'GetItem', { TableName: this.table, Key: this.#key(`sess#${idHash}`, 'session'), ConsistentRead: true });
    return this.#unpack(r?.Item);
  }

  /** Replace session data but keep its original expiry. */
  async updateSession(idHash, data) {
    await this.send('ddb', 'UpdateItem', {
      TableName: this.table,
      Key: this.#key(`sess#${idHash}`, 'session'),
      UpdateExpression: 'SET #d = :d',
      ConditionExpression: 'attribute_exists(pk)',
      ExpressionAttributeNames: { '#d': 'data' },
      ExpressionAttributeValues: { ':d': { S: JSON.stringify(data) } },
    });
  }

  async deleteSession(idHash) {
    await this.send('ddb', 'DeleteItem', { TableName: this.table, Key: this.#key(`sess#${idHash}`, 'session') });
  }

  async getCount(pk, sk) {
    const r = await this.send('ddb', 'GetItem', { TableName: this.table, Key: this.#key(pk, sk), ConsistentRead: true });
    const item = r?.Item;
    if (!item) return 0;
    const ttl = Number(item.ttl?.N || 0);
    if (ttl && ttl <= nowSec(this.now)) return 0;
    return Number(item.n?.N || 0);
  }

  /**
   * Atomically increment every counter by 1, but only if ALL are below their caps.
   * @param {{pk:string, sk:string, cap:number, ttlSeconds:number}[]} counters
   * @returns {Promise<{ok:true} | {ok:false, index:number}>} index = first counter at its cap
   */
  async consume(counters) {
    const exp = (c) => String(nowSec(this.now) + c.ttlSeconds);
    try {
      await this.send('ddb', 'TransactWriteItems', {
        TransactItems: counters.map((c) => ({
          Update: {
            TableName: this.table,
            Key: this.#key(c.pk, c.sk),
            UpdateExpression: 'SET #t = if_not_exists(#t, :ttl) ADD #n :one',
            ConditionExpression: 'attribute_not_exists(#n) OR #n < :cap',
            ExpressionAttributeNames: { '#n': 'n', '#t': 'ttl' },
            ExpressionAttributeValues: { ':one': { N: '1' }, ':cap': { N: String(c.cap) }, ':ttl': { N: exp(c) } },
          },
        })),
      });
      return { ok: true };
    } catch (err) {
      if (err && (err.name === 'TransactionCanceledException' || err.code === 'TransactionCanceledException')) {
        const reasons = err.CancellationReasons || [];
        const idx = reasons.findIndex((r) => r && r.Code === 'ConditionalCheckFailed');
        if (idx >= 0) return { ok: false, index: idx };
      }
      throw err;
    }
  }

  /** Best-effort give-back after an upstream failure. */
  async refund(counters) {
    await Promise.allSettled(counters.map((c) => this.send('ddb', 'UpdateItem', {
      TableName: this.table,
      Key: this.#key(c.pk, c.sk),
      UpdateExpression: 'ADD #n :m',
      ConditionExpression: '#n > :z',
      ExpressionAttributeNames: { '#n': 'n' },
      ExpressionAttributeValues: { ':m': { N: '-1' }, ':z': { N: '0' } },
    })));
  }
}

/** In-memory store with the same semantics. Used by tests and `node api/dev-server` style experiments. */
export class MemoryStore {
  constructor({ now = Date.now } = {}) { this.now = now; this.items = new Map(); }
  #k(pk, sk) { return `${pk}\u0000${sk}`; }
  #live(v) { return v && (!v.ttl || v.ttl > nowSec(this.now)) ? v : null; }
  async putOAuthState(h, data, ttl) { this.items.set(this.#k(`oauth#${h}`, 'state'), { data, ttl: nowSec(this.now) + ttl }); }
  async takeOAuthState(h) {
    const k = this.#k(`oauth#${h}`, 'state');
    const v = this.#live(this.items.get(k));
    this.items.delete(k);
    return v ? structuredClone(v.data) : null;
  }
  async putSession(h, data, ttl) { this.items.set(this.#k(`sess#${h}`, 'session'), { data: structuredClone(data), ttl: nowSec(this.now) + ttl }); }
  async getSession(h) { const v = this.#live(this.items.get(this.#k(`sess#${h}`, 'session'))); return v ? { data: structuredClone(v.data), ttl: v.ttl } : null; }
  async updateSession(h, data) {
    const k = this.#k(`sess#${h}`, 'session');
    const v = this.items.get(k);
    if (!v) throw Object.assign(new Error('gone'), { name: 'ConditionalCheckFailedException' });
    v.data = structuredClone(data);
  }
  async deleteSession(h) { this.items.delete(this.#k(`sess#${h}`, 'session')); }
  async getCount(pk, sk) { const v = this.#live(this.items.get(this.#k(pk, sk))); return v ? v.n : 0; }
  async consume(counters) {
    for (let i = 0; i < counters.length; i++) {
      const c = counters[i];
      const v = this.#live(this.items.get(this.#k(c.pk, c.sk)));
      if (v && v.n >= c.cap) return { ok: false, index: i };
    }
    for (const c of counters) {
      const k = this.#k(c.pk, c.sk);
      const v = this.#live(this.items.get(k)) || { n: 0, ttl: nowSec(this.now) + c.ttlSeconds };
      v.n += 1;
      this.items.set(k, v);
    }
    return { ok: true };
  }
  async refund(counters) {
    for (const c of counters) { const v = this.items.get(this.#k(c.pk, c.sk)); if (v && v.n > 0) v.n -= 1; }
  }
}
