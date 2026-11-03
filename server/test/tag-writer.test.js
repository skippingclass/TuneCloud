import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { parseFile } from 'music-metadata';
import { writeAudioTags } from '../src/tag-writer.js';
import { computeFileHashes } from '../src/file-fingerprints.js';

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const pictures = meta => (meta.common.picture || []).map(p => ({ format: p.format, hash: hash(p.data) }));

// Compare encoded audio independently of the metadata writer. Fixtures contain a
// single audio stream; Ogg headers/comments and MP4 atoms aren't audio packets.
async function audioHash(file, format) {
  if (format === 'flac' || format === 'mp3') return (await computeFileHashes(file)).audioHash;
  const data = await fs.readFile(file);
  if (format === 'm4a') {
    const chunks = [];
    for (let offset = 0; offset + 8 <= data.length;) {
      const size = data.readUInt32BE(offset);
      assert.ok(size >= 8);
      if (data.toString('ascii', offset + 4, offset + 8) === 'mdat') chunks.push(data.subarray(offset + 8, offset + size));
      offset += size;
    }
    assert.ok(chunks.length);
    return hash(Buffer.concat(chunks));
  }
  const packets = [];
  let pieces = [];
  for (let offset = 0; offset < data.length;) {
    assert.equal(data.toString('ascii', offset, offset + 4), 'OggS');
    const segments = data[offset + 26];
    let cursor = offset + 27 + segments;
    for (let index = 0; index < segments; index++) {
      const length = data[offset + 27 + index];
      pieces.push(data.subarray(cursor, cursor + length));
      cursor += length;
      if (length < 255) { packets.push(Buffer.concat(pieces)); pieces = []; }
    }
    offset = cursor;
  }
  const audio = packets.slice(format === 'opus' ? 2 : 3);
  assert.ok(audio.length);
  return hash(Buffer.concat(audio));
}

for (const format of ['mp3', 'flac', 'opus', 'ogg', 'm4a']) {
  test(`${format}: staged writes preserve encoded audio, artwork and unrelated tags, and clear artist aliases`, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tunecloud-tags-'));
    const file = path.join(dir, 'staged.uuid.tmp');
    try {
      await fs.copyFile(new URL(`./fixtures/tags/sample.${format}`, import.meta.url), file);
      const original = await parseFile(file);
      const audio = await audioHash(file, format);
      assert.equal(original.common.artist, 'Original artist');
      assert.equal(original.common.track.of, 12);
      assert.equal(original.common.picture.length, 1);
      writeAudioTags(file, format, { title: 'Только название 🎵' });
      const titleOnly = await parseFile(file);
      const beforeCommon = { ...original.common, picture: pictures(original) };
      const afterCommon = { ...titleOnly.common, picture: pictures(titleOnly) };
      delete beforeCommon.title; delete afterCommon.title;
      assert.deepEqual(afterCommon, beforeCommon);
      assert.equal(titleOnly.common.title, 'Только название 🎵');
      assert.equal(await audioHash(file, format), audio);

      writeAudioTags(file, format, { title: 'Название 曲名 🎵', artist: 'Исполнитель', album: 'Альбом', genre: 'Жанр', year: 2025, trackNumber: 7 });
      const edited = await parseFile(file);
      assert.equal(edited.common.title, 'Название 曲名 🎵');
      assert.equal(edited.common.artist, 'Исполнитель');
      assert.deepEqual(edited.common.artists, ['Исполнитель']);
      assert.equal(edited.common.album, 'Альбом');
      assert.deepEqual(edited.common.genre, ['Жанр']);
      assert.equal(edited.common.year, 2025);
      assert.deepEqual(edited.common.track, { no: 7, of: 12 });
      for (const key of ['albumartist', 'albumartists', 'composer', 'comment', 'copyright', 'disk', 'lyrics']) {
        assert.deepEqual(edited.common[key], original.common[key], key);
      }
      if (['flac', 'opus', 'ogg'].includes(format)) {
        assert.ok(edited.native.vorbis.some(t => t.id === 'TUNECLOUD_TEST_CUSTOM' && t.value === 'Preserved custom value'));
      }
      assert.deepEqual(pictures(edited), pictures(original));
      assert.equal(await audioHash(file, format), audio);

      writeAudioTags(file, format, { title: '', artist: '', album: '', genre: '', year: null, trackNumber: null });
      const cleared = await parseFile(file);
      for (const key of ['title', 'artist', 'album', 'year']) assert.ok(!cleared.common[key], key);
      assert.ok(!cleared.common.artists?.length);
      assert.ok(!cleared.common.genre?.length);
      assert.deepEqual(cleared.common.track, { no: null, of: 12 });
      assert.equal(cleared.common.albumartist, original.common.albumartist);
      assert.deepEqual(pictures(cleared), pictures(original));
      assert.equal(await audioHash(file, format), audio);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });
}
