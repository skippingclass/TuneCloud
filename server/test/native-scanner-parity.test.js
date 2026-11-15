import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { computeFileHashesJs } from '../src/file-fingerprints.js';
import { listAudioFilesJs } from '../src/scanner.js';
import { createNativeScannerClient } from '../src/native-scanner.js';

const binaryPath = process.env.RUST_SCANNER_BIN || fileURLToPath(new URL('../native/scanner/target/release/tunecloud-scanner', import.meta.url));
const nativeAvailable = await fs.access(binaryPath, constants.X_OK).then(() => true, () => false);
// CI sets rust explicitly: a missing binary must fail, never silently skip parity.
const skip = !nativeAvailable && process.env.SCANNER_ENGINE !== 'rust'
  ? 'Build the helper with npm run scanner:build to run native parity tests'
  : false;
const hash = buffer => crypto.createHash('sha256').update(buffer).digest('hex');

function listing(files) {
  return files.map(file => ({
    path: file.path,
    size: file.size,
    mtimeMs: file.mtime.getTime(),
    dev: file.dev,
    ino: file.ino,
    nlink: file.nlink,
    birthtimeMs: file.birthtimeMs,
  })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

function client(t, workers = 4) {
  const native = createNativeScannerClient({ engine: 'rust', binaryPath, workers });
  t.after(() => native.close());
  return native;
}

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tunecloud-native-parity-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function id3(body, { version = 3, footer = false } = {}) {
  const size = body.length;
  const header = Buffer.from([73, 68, 51, version, 0, footer ? 16 : 0,
    (size >>> 21) & 127, (size >>> 14) & 127, (size >>> 7) & 127, size & 127]);
  return Buffer.concat([header, body, ...(footer ? [Buffer.alloc(10)] : [])]);
}

test('Rust fingerprints match JavaScript for all eight checked-in audio formats', { skip }, async t => {
  const native = client(t);
  const formats = ['mp3', 'flac', 'ogg', 'wav', 'm4a', 'aac', 'wma', 'opus'];
  const fixtureRoot = fileURLToPath(new URL('fixtures/tags', import.meta.url));
  assert.deepEqual(listing(await native.listAudioFiles(fixtureRoot)), listing(await listAudioFilesJs(fixtureRoot)));
  await Promise.all(formats.map(async extension => {
    const file = fileURLToPath(new URL(`fixtures/tags/sample.${extension}`, import.meta.url));
    const [expected, actual, contents] = await Promise.all([
      computeFileHashesJs(file), native.computeFileHashes(file), fs.readFile(file),
    ]);
    assert.equal(expected.contentHash, hash(contents), extension);
    assert.deepEqual(actual, expected, extension);
  }));
  assert.equal(native.getInfo().engine, 'rust');
  assert.equal(native.getInfo().state, 'ready');
});

test('Rust fingerprints preserve JavaScript behavior for ID3, FLAC, corrupt and empty files', { skip }, async t => {
  const directory = await temporaryDirectory(t);
  const native = client(t, 1);
  const audio = Buffer.alloc(600 * 1024, 87);
  const tail = Buffer.alloc(128); tail.write('TAG');
  const streaminfo = Buffer.concat([Buffer.from([0, 0, 0, 34]), Buffer.alloc(34)]);
  const flac = Buffer.concat([Buffer.from('fLaC'), streaminfo, Buffer.from([132, 0, 0, 8]), Buffer.from('oldtitle'), audio]);
  const excessiveFlac = Buffer.concat([Buffer.from('fLaC'), streaminfo,
    ...Array.from({ length: 1024 }, () => Buffer.from([1, 0, 0, 0])), Buffer.from([129, 0, 0, 0]), audio]);
  const cases = new Map([
    ['empty', Buffer.alloc(0)],
    ['one-byte', Buffer.from([255])],
    ['truncated-id3', Buffer.from('ID3\x03')],
    ['truncated-id3-body', Buffer.concat([Buffer.from([73, 68, 51, 3, 0, 0, 0, 0, 127, 127]), Buffer.from('short')])],
    ['invalid-id3-size', Buffer.concat([Buffer.from([73, 68, 51, 3, 0, 0, 128, 0, 0, 0]), audio])],
    ['invalid-id3-version', Buffer.concat([id3(Buffer.from('tag'), { version: 5 }), audio])],
    ['id3-only', id3(Buffer.from('tag'))],
    ['id3v24-footer', Buffer.concat([id3(Buffer.from('tag'), { version: 4, footer: true }), audio, tail])],
    ['id3v23-footer-flag', Buffer.concat([id3(Buffer.from('tag'), { version: 3, footer: true }), audio])],
    ['chained-id3', Buffer.concat([id3(Buffer.from('one')), id3(Buffer.from('two')), audio, tail])],
    ['excessive-id3', Buffer.concat([...Array.from({ length: 33 }, () => id3(Buffer.alloc(0))), audio])],
    ['mp3-id3v1', Buffer.concat([Buffer.from([255, 251]), audio, tail])],
    ['plain-tag-tail', Buffer.concat([audio, tail])],
    ['valid-flac', flac],
    ['id3-flac', Buffer.concat([id3(Buffer.from('tag')), flac])],
    ['flac-no-audio', Buffer.concat([Buffer.from('fLaC'), Buffer.from([128, 0, 0, 34]), Buffer.alloc(34)])],
    ['truncated-flac-header', Buffer.from('fLaC\x80\x00')],
    ['truncated-flac-block', Buffer.concat([Buffer.from('fLaC'), Buffer.from([128, 0, 0, 34]), Buffer.alloc(12)])],
    ['flac-no-last-block', Buffer.concat([Buffer.from('fLaC'), streaminfo])],
    ['flac-invalid-type', Buffer.concat([Buffer.from('fLaC'), streaminfo, Buffer.from([255, 0, 0, 0]), audio])],
    ['flac-invalid-first-block', Buffer.concat([Buffer.from('fLaC'), Buffer.from([128, 0, 0, 33]), Buffer.alloc(33), audio])],
    ['excessive-flac-blocks', excessiveFlac],
  ]);
  await Promise.all([...cases].map(async ([name, contents]) => {
    const file = path.join(directory, `${name}.mp3`);
    await fs.writeFile(file, contents);
    const expected = await computeFileHashesJs(file);
    assert.equal(expected.contentHash, contents.length ? hash(contents) : null, name);
    assert.deepEqual(await native.computeFileHashes(file), expected, name);
  }));
  for (const file of [directory, path.join(directory, 'missing.mp3')]) {
    assert.deepEqual(await native.computeFileHashes(file), await computeFileHashesJs(file));
  }
});

test('Rust listing matches lexical paths, stat identity, hidden files and confined symlinks', { skip }, async t => {
  const directory = await temporaryDirectory(t);
  const root = path.join(directory, 'music [FLAC]');
  const outside = path.join(directory, 'outside');
  await fs.mkdir(root);
  await fs.mkdir(outside);
  await fs.mkdir(path.join(root, 'Album [Live]'));
  await fs.mkdir(path.join(root, '.hidden'));
  const mainFile = path.join(root, 'Album [Live]', '01 — Песня.MP3');
  await fs.writeFile(mainFile, 'synthetic audio');
  await fs.writeFile(path.join(root, '02.flac'), 'synthetic FLAC');
  await fs.writeFile(path.join(root, 'notes.txt'), 'not audio');
  await fs.writeFile(path.join(root, '.secret.mp3'), 'hidden file');
  await fs.writeFile(path.join(root, '.hidden', 'song.mp3'), 'hidden directory');
  await fs.writeFile(path.join(outside, 'private.mp3'), 'outside root');
  await fs.link(mainFile, path.join(root, 'hardlink.mp3'));
  await fs.symlink(mainFile, path.join(root, 'alias.mp3'));
  await fs.symlink(path.join(outside, 'private.mp3'), path.join(root, 'outside.mp3'));
  await fs.symlink(outside, path.join(root, 'outside-directory'));
  await fs.symlink(path.join(root, 'Album [Live]'), path.join(root, 'album-alias'));
  await fs.symlink(root, path.join(root, 'Album [Live]', 'cycle'));
  const lexicalRoot = path.join(directory, 'library-alias [FLAC]');
  await fs.symlink(root, lexicalRoot);
  const native = client(t);
  for (const library of [root, lexicalRoot]) {
    const expected = listing(await listAudioFilesJs(library));
    const actual = listing(await native.listAudioFiles(library));
    assert.deepEqual(actual, expected);
    assert.deepEqual(actual.map(file => path.relative(library, file.path)).sort(), [
      '02.flac', path.join('Album [Live]', '01 — Песня.MP3'), 'alias.mp3', 'hardlink.mp3',
    ].sort());
    assert.equal(actual.find(file => file.path.endsWith('hardlink.mp3')).nlink, 2);
    assert.ok(actual.every(file => file.path.startsWith(`${library}${path.sep}`)));
  }
});

test('both listing backends reject malformed roots; Rust also rejects broken audio symlinks', { skip }, async t => {
  const directory = await temporaryDirectory(t);
  const native = client(t);
  const fileRoot = path.join(directory, 'file.mp3');
  await fs.writeFile(fileRoot, 'not a directory');
  for (const root of [path.join(directory, 'missing'), fileRoot]) {
    await assert.rejects(() => listAudioFilesJs(root));
    await assert.rejects(() => native.listAudioFiles(root));
  }
  const library = path.join(directory, 'broken-library');
  await fs.mkdir(library);
  await fs.symlink(path.join(directory, 'missing.mp3'), path.join(library, 'broken.mp3'));
  // Native traversal deliberately fails closed; the rollback backend retains
  // its earlier behavior of omitting a broken audio symlink.
  assert.deepEqual(await listAudioFilesJs(library), []);
  await assert.rejects(() => native.listAudioFiles(library));
});

test('Rust rejects unreadable directories instead of returning a partial listing', {
  skip: skip || (process.platform === 'win32' || process.getuid?.() === 0 ? 'Requires Unix permission checks as a non-root user' : false),
}, async t => {
  const directory = await temporaryDirectory(t);
  const blocked = path.join(directory, 'unreadable');
  await fs.mkdir(blocked);
  await fs.writeFile(path.join(blocked, 'track.mp3'), 'synthetic audio');
  await fs.chmod(blocked, 0);
  try {
    await assert.rejects(() => client(t).listAudioFiles(directory));
  } finally {
    await fs.chmod(blocked, 0o700);
  }
});
