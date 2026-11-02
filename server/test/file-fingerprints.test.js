import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { computeFileHashes } from '../src/file-fingerprints.js';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

test('fingerprints hash the entire file with bounded reads and exclude changed ID3 metadata', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tunecloud-fingerprints-'));
  try {
    const audio = Buffer.alloc(600 * 1024, 75);
    const tag = Buffer.alloc(300 * 1024, 55);
    const header = Buffer.from([73, 68, 51, 3, 0, 0, (tag.length >>> 21) & 127, (tag.length >>> 14) & 127, (tag.length >>> 7) & 127, tag.length & 127]);
    const tail = Buffer.alloc(128); tail.write('TAG');
    const file = path.join(dir, 'song.mp3');
    const contents = Buffer.concat([header, tag, audio, tail]);
    await fs.writeFile(file, contents);
    const original = await computeFileHashes(file);
    assert.deepEqual(original, { contentHash: hash(contents), audioHash: hash(audio), audioPayloadSize: audio.length });
    contents[20] ^= 255;
    await fs.writeFile(file, contents);
    const renamed = await computeFileHashes(file);
    assert.notEqual(renamed.contentHash, original.contentHash);
    assert.equal(renamed.audioHash, original.audioHash);
    contents[header.length + tag.length + 10] ^= 255;
    await fs.writeFile(file, contents);
    assert.notEqual((await computeFileHashes(file)).audioHash, original.audioHash);
    assert.equal((await computeFileHashes(path.join(dir, 'missing'))).contentHash, null);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('FLAC frame fingerprints survive title changes but distinguish different recordings', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tunecloud-flac-'));
  try {
    const file = path.join(dir, 'track.flac');
    const frames = Buffer.alloc(4096, 87);
    const contents = Buffer.concat([Buffer.from('fLaC'), Buffer.from([0,0,0,34]), Buffer.alloc(34), Buffer.from([132,0,0,8]), Buffer.from('oldtitle'), frames]);
    await fs.writeFile(file, contents);
    const original = await computeFileHashes(file);
    assert.equal(original.audioHash, hash(frames));
    assert.equal(original.audioPayloadSize, frames.length);
    contents.write('newtitle', 46);
    await fs.writeFile(file, contents);
    const renamed = await computeFileHashes(file);
    assert.equal(renamed.audioHash, original.audioHash);
    assert.notEqual(renamed.contentHash, original.contentHash);
    contents[contents.length - 10] ^= 255;
    await fs.writeFile(file, contents);
    assert.notEqual((await computeFileHashes(file)).audioHash, original.audioHash);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
