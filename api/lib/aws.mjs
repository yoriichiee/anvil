// AWS access through one tiny `send(service, op, input)` function so the rest of the code
// (and the tests) never import the SDK. The SDK v3 clients ship in the Lambda Node 20 runtime;
// they are imported lazily so unit tests run without them installed.

const SERVICES = {
  ddb: { pkg: '@aws-sdk/client-dynamodb', client: 'DynamoDBClient' },
  kms: { pkg: '@aws-sdk/client-kms', client: 'KMSClient' },
  ssm: { pkg: '@aws-sdk/client-ssm', client: 'SSMClient' },
};

export function createAwsSend() {
  const mods = {};
  const clients = {};
  return async function send(service, op, input) {
    const spec = SERVICES[service];
    if (!spec) throw new Error(`unknown AWS service ${service}`);
    if (!mods[service]) mods[service] = await import(spec.pkg);
    const mod = mods[service];
    if (!clients[service]) clients[service] = new mod[spec.client]({});
    const Cmd = mod[`${op}Command`];
    if (!Cmd) throw new Error(`unknown ${service} op ${op}`);
    return clients[service].send(new Cmd(input));
  };
}

/** Envelope-free KMS encryption for small payloads (< 4 KB): GitHub user + refresh tokens. */
export class KmsCrypto {
  constructor({ send, keyId }) {
    if (!keyId) throw new Error('KMS_KEY_ID is not set');
    this.send = send;
    this.keyId = keyId;
  }
  async encrypt(plaintext, context) {
    const r = await this.send('kms', 'Encrypt', {
      KeyId: this.keyId,
      Plaintext: Buffer.from(plaintext, 'utf8'),
      EncryptionContext: context,
    });
    return Buffer.from(r.CiphertextBlob).toString('base64');
  }
  async decrypt(ciphertextB64, context) {
    const r = await this.send('kms', 'Decrypt', {
      KeyId: this.keyId,
      CiphertextBlob: Buffer.from(ciphertextB64, 'base64'),
      EncryptionContext: context,
    });
    return Buffer.from(r.Plaintext).toString('utf8');
  }
}

/** SSM SecureString reader with a 5-minute in-memory cache. Values are never logged. */
export class SecretsLoader {
  constructor({ send, now = Date.now, ttlMs = 5 * 60 * 1000 }) {
    this.send = send; this.now = now; this.ttlMs = ttlMs; this.cache = new Map();
  }
  async raw(name) {
    const hit = this.cache.get(name);
    if (hit && hit.exp > this.now()) return hit.value;
    const r = await this.send('ssm', 'GetParameter', { Name: name, WithDecryption: true });
    const value = r?.Parameter?.Value;
    if (!value) throw new Error(`SSM parameter ${name} is empty`);
    this.cache.set(name, { value, exp: this.now() + this.ttlMs });
    return value;
  }
  async github(name) {
    let cfg;
    try { cfg = JSON.parse(await this.raw(name)); } catch { throw new Error(`SSM parameter ${name} is not JSON`); }
    for (const k of ['clientId', 'clientSecret', 'appSlug']) {
      if (!cfg || typeof cfg[k] !== 'string' || !cfg[k]) throw new Error(`SSM parameter ${name} is missing ${k}`);
    }
    return cfg;
  }
  async anthropicKey(name) {
    const v = (await this.raw(name)).trim();
    if (v.startsWith('{')) {
      try { const j = JSON.parse(v); if (j.apiKey) return String(j.apiKey); } catch { /* fall through */ }
      throw new Error(`SSM parameter ${name} JSON has no apiKey`);
    }
    return v;
  }
}
