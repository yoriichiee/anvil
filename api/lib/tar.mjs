// Minimal streaming tar reader (ustar + pax + GNU long names). Read-only: it never writes
// entries to disk, never follows links, and only buffers regular files up to maxEntryBytes.

class ChunkReader {
  constructor(iterable) {
    this.it = iterable[Symbol.asyncIterator]();
    this.bufs = [];
    this.len = 0;
    this.done = false;
  }
  async #fill(n) {
    while (this.len < n && !this.done) {
      const { value, done } = await this.it.next();
      if (done) { this.done = true; break; }
      const b = Buffer.isBuffer(value) ? value : Buffer.from(value);
      if (b.length) { this.bufs.push(b); this.len += b.length; }
    }
  }
  #take(n) {
    const out = Buffer.allocUnsafe(n);
    let o = 0;
    while (o < n) {
      const b = this.bufs[0];
      const k = Math.min(b.length, n - o);
      b.copy(out, o, 0, k);
      o += k;
      if (k === b.length) this.bufs.shift(); else this.bufs[0] = b.subarray(k);
    }
    this.len -= n;
    return out;
  }
  /** Returns exactly n bytes, null at clean EOF, throws on a truncated read. */
  async read(n) {
    await this.#fill(n);
    if (this.len === 0 && this.done) return null;
    if (this.len < n) throw new Error('tar: unexpected end of archive');
    return this.#take(n);
  }
  async skip(n) {
    while (n > 0) {
      if (this.len === 0) {
        await this.#fill(1);
        if (this.len === 0) throw new Error('tar: unexpected end of archive');
      }
      const b = this.bufs[0];
      const k = Math.min(b.length, n);
      if (k === b.length) this.bufs.shift(); else this.bufs[0] = b.subarray(k);
      this.len -= k;
      n -= k;
    }
  }
}

function cstr(buf, start, len) {
  const s = buf.subarray(start, start + len);
  const z = s.indexOf(0);
  return (z >= 0 ? s.subarray(0, z) : s).toString('utf8');
}

function octal(buf, start, len) {
  const s = cstr(buf, start, len).trim();
  if (!s) return 0;
  if (!/^[0-7]+$/.test(s)) throw new Error('tar: bad numeric field');
  return parseInt(s, 8);
}

function parseSize(buf) {
  if (buf[124] & 0x80) {
    // GNU base-256: big-endian, first byte's top bit is the flag.
    let n = buf[124] & 0x7f;
    for (let i = 125; i < 136; i++) {
      n = n * 256 + buf[i];
      if (n > Number.MAX_SAFE_INTEGER) throw new Error('tar: entry too large');
    }
    return n;
  }
  return octal(buf, 124, 12);
}

function checksumOk(buf) {
  const stored = octal(buf, 148, 8);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : buf[i];
  return sum === stored;
}

function isZeroBlock(buf) {
  for (let i = 0; i < 512; i++) if (buf[i] !== 0) return false;
  return true;
}

export function parsePax(body) {
  const out = {};
  let i = 0;
  while (i < body.length) {
    const sp = body.indexOf(0x20, i);
    if (sp < 0) break;
    const len = parseInt(body.subarray(i, sp).toString('ascii'), 10);
    if (!Number.isFinite(len) || len <= 0 || i + len > body.length) break;
    const rec = body.subarray(sp + 1, i + len - 1).toString('utf8'); // drop trailing \n
    const eq = rec.indexOf('=');
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

const TYPES = { '0': 'file', '\0': 'file', '': 'file', '7': 'file', '1': 'link', '2': 'symlink', '3': 'char', '4': 'block', '5': 'dir', '6': 'fifo' };
const META_MAX = 1024 * 1024;

/**
 * @param {AsyncIterable<Uint8Array>} chunks  decompressed tar bytes
 * @param {{maxEntryBytes?: number}} [opts]
 * @yields {{path:string, type:string, size:number, data:Buffer|null, skipped?:string, global?:object}}
 */
export async function* readTar(chunks, { maxEntryBytes = 1024 * 1024 } = {}) {
  const r = new ChunkReader(chunks);
  let pending = {};
  let global = {};
  for (;;) {
    const hdr = await r.read(512);
    if (!hdr) return;
    if (isZeroBlock(hdr)) return; // end-of-archive marker
    if (!checksumOk(hdr)) throw new Error('tar: bad header checksum');
    const flag = String.fromCharCode(hdr[156] || 0);
    let size = parseSize(hdr);
    const padded = Math.ceil(size / 512) * 512;

    if (flag === 'x' || flag === 'g' || flag === 'L' || flag === 'K') {
      if (size > META_MAX) throw new Error('tar: metadata header too large');
      const body = (await r.read(padded) || Buffer.alloc(0)).subarray(0, size);
      if (flag === 'x') Object.assign(pending, parsePax(body));
      else if (flag === 'g') global = { ...global, ...parsePax(body) };
      else if (flag === 'L') pending.path = cstr(body, 0, body.length);
      else pending.linkpath = cstr(body, 0, body.length);
      continue;
    }

    const name = cstr(hdr, 0, 100);
    const magic = cstr(hdr, 257, 6);
    const prefix = magic.startsWith('ustar') ? cstr(hdr, 345, 155) : '';
    const path = pending.path || (prefix ? `${prefix}/${name}` : name);
    if (pending.size !== undefined) {
      const s = Number(pending.size);
      if (!Number.isSafeInteger(s) || s < 0) throw new Error('tar: bad pax size');
      size = s;
    }
    const realPadded = Math.ceil(size / 512) * 512;
    pending = {};
    const type = TYPES[flag] || 'other';

    if (type === 'file' && size <= maxEntryBytes) {
      const body = size ? await r.read(realPadded) : Buffer.alloc(0);
      if (size && !body) throw new Error('tar: unexpected end of archive');
      yield { path, type, size, data: body.subarray(0, size), global };
    } else {
      if (realPadded) await r.skip(realPadded);
      yield { path, type, size, data: null, skipped: type === 'file' ? 'too-large' : undefined, global };
    }
  }
}
