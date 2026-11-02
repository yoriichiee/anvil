import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readTar } from './lib/tar.mjs';
import { makeTar, chunked } from './_testkit.mjs';

async function all(buf, opts, chunk) {
  const out = [];
  for await (const e of readTar(chunked(buf, chunk), opts)) out.push(e);
  return out;
}

test('reads ustar files, dirs, pax and GNU long names across odd chunk sizes', async () => {
  const long = `root-abc/${'deep/'.repeat(30)}file.txt`;
  const tar = makeTar([
    { path: 'root-abc/', type: '5' },
    { path: 'root-abc/a.txt', content: 'hello' },
    { path: long, content: 'pax path', pax: true },
    { path: `${long}.gnu`, content: 'gnu path', gnuLong: true },
    { path: 'root-abc/empty.txt', content: '' },
  ], { globalComment: 'a'.repeat(40) });
  for (const size of [1, 7, 511, 512, 513, 4096]) {
    const es = await all(tar, {}, size);
    assert.deepEqual(es.map((e) => e.path), ['root-abc/', 'root-abc/a.txt', long, `${long}.gnu`, 'root-abc/empty.txt']);
    assert.equal(es[1].data.toString(), 'hello');
    assert.equal(es[2].data.toString(), 'pax path');
    assert.equal(es[3].data.toString(), 'gnu path');
    assert.equal(es[4].data.length, 0);
    assert.equal(es[1].global.comment, 'a'.repeat(40));
  }
});

test('skips files over maxEntryBytes without buffering them', async () => {
  const tar = makeTar([{ path: 'r/big.bin', content: Buffer.alloc(5000, 1) }, { path: 'r/small', content: 'x' }]);
  const es = await all(tar, { maxEntryBytes: 1000 });
  assert.equal(es[0].data, null);
  assert.equal(es[0].skipped, 'too-large');
  assert.equal(es[1].data.toString(), 'x');
});

test('symlinks are reported, never followed', async () => {
  const tar = makeTar([{ path: 'r/link', type: '2' }]);
  const es = await all(tar);
  assert.equal(es[0].type, 'symlink');
  assert.equal(es[0].data, null);
});

test('rejects a corrupted header checksum', async () => {
  const tar = makeTar([{ path: 'r/a', content: 'x' }]);
  tar[10] ^= 0xff;
  await assert.rejects(all(tar), /checksum/);
});

test('rejects a truncated archive', async () => {
  const tar = makeTar([{ path: 'r/a', content: 'x'.repeat(2000) }]);
  await assert.rejects(all(tar.subarray(0, 1024)), /unexpected end/);
});
