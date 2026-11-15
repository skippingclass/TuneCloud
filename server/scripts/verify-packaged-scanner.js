import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { computeFileHashes, computeFileHashesJs } from '../src/file-fingerprints.js';
import { listAudioFiles, listAudioFilesJs } from '../src/scanner.js';
import { getNativeScanner, closeNativeScanner } from '../src/native-scanner.js';

const ordered = files => files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

async function verify() {
  assert.equal(process.getuid(), 1000, 'The packaged scanner must run as the node user');
  if (process.argv[2] === 'rollback') {
    assert.equal(process.env.SCANNER_ENGINE, 'js');
    assert.deepEqual(await computeFileHashes('/fixtures/sample.mp3'), await computeFileHashesJs('/fixtures/sample.mp3'));
    assert.equal(getNativeScanner().getInfo().state, 'js');
    console.log('Packaged JavaScript rollback passed with an unavailable native helper');
    return;
  }
  if (process.argv[2] === 'missing') {
    assert.equal(process.env.SCANNER_ENGINE, 'rust');
    await assert.rejects(() => computeFileHashes('/fixtures/sample.mp3'), { code: 'SCANNER_UNAVAILABLE' });
    console.log('Packaged required Rust mode rejected an unavailable helper');
    return;
  }

  assert.equal(process.env.SCANNER_ENGINE, 'rust', 'The image must require Rust by default');
  const files = ordered(await listAudioFiles('/fixtures'));
  assert.deepEqual(files, ordered(await listAudioFilesJs('/fixtures')));
  for (const extension of ['mp3', 'flac', 'ogg', 'wav', 'm4a', 'aac', 'wma', 'opus']) {
    assert.ok(files.some(file => file.path === `/fixtures/sample.${extension}`), `Missing ${extension} fixture`);
  }
  for (const file of files) {
    assert.deepEqual(await computeFileHashes(file.path), await computeFileHashesJs(file.path));
  }
  const temporary = await fs.mkdtemp('/tmp/tunecloud-packaged-scanner-');
  try {
    const alias = path.join(temporary, 'library alias [FLAC]');
    await fs.symlink('/fixtures', alias);
    const aliases = ordered(await listAudioFiles(alias));
    assert.deepEqual(aliases, ordered(await listAudioFilesJs(alias)));
    assert.equal(aliases.length, files.length);
    assert.ok(aliases.every(file => file.path.startsWith(`${alias}/`)), 'Listing must preserve lexical paths');
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
  assert.equal(getNativeScanner().getInfo().state, 'ready');
  // Awaited shutdown must keep the event loop alive until the helper exits.
  await closeNativeScanner();
  console.log('Packaged Rust hashes, timestamps, identities, lexical aliases and shutdown passed on Alpine');
  for (const [mode, engine] of [['rollback', 'js'], ['missing', 'rust']]) {
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), mode], {
      env: { ...process.env, SCANNER_ENGINE: engine, RUST_SCANNER_BIN: '/unavailable/tunecloud-scanner' },
      stdio: 'inherit',
    });
    assert.equal(result.status, 0, `${mode} validation failed: ${result.error?.message || result.signal || result.status}`);
  }
}

try {
  await verify();
} finally {
  await closeNativeScanner();
}
