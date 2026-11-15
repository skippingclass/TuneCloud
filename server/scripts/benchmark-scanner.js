#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { listAudioFilesJs } from '../src/scanner.js';
import { computeFileHashesJs } from '../src/file-fingerprints.js';
import { createNativeScannerClient } from '../src/native-scanner.js';

const usage = `Usage: npm run benchmark:scanner -- [--path /music] [--files 128] [--size-mib 1] [--rounds 3] [--workers 4] [--json]
Without --path, generates temporary synthetic files and removes them afterwards.
An existing --path is only read. Results use warm filesystem caches and cover
directory listing plus fingerprinting, excluding metadata and database work.`;

function options(args) {
  const result = { files: 128, sizeMiB: 1, rounds: 3, workers: 4, json: false };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') return { help: true };
    if (argument === '--json') { result.json = true; continue; }
    const key = { '--path': 'path', '--files': 'files', '--size-mib': 'sizeMiB', '--rounds': 'rounds', '--workers': 'workers' }[argument];
    if (!key || index + 1 >= args.length) throw new Error(`Invalid argument: ${argument}\n${usage}`);
    const value = args[++index];
    result[key] = key === 'path' ? path.resolve(value) : Number(value);
  }
  for (const [key, maximum] of [['files', 100000], ['rounds', 100], ['workers', 32]]) {
    if (!Number.isInteger(result[key]) || result[key] < 1 || result[key] > maximum) {
      throw new Error(`${key} must be an integer from 1 to ${maximum}`);
    }
  }
  if (!Number.isFinite(result.sizeMiB) || result.sizeMiB <= 0 || result.sizeMiB > 1024) {
    throw new Error('size-mib must be greater than zero and at most 1024');
  }
  return result;
}

async function mapLimit(items, limit, operation) {
  let next = 0;
  const results = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(items.length, limit) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await operation(items[index]);
    }
  }));
  return results;
}

function normalizeListing(files) {
  return files.map(file => ({
    path: file.path, size: file.size, mtimeMs: file.mtime.getTime(),
    dev: file.dev, ino: file.ino, nlink: file.nlink, birthtimeMs: file.birthtimeMs,
  })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

async function scan(backend, root, workers) {
  const start = performance.now();
  const files = await backend.list(root);
  const listed = performance.now();
  const fingerprints = await mapLimit(files, workers, async file => ({ path: file.path, ...await backend.hash(file.path) }));
  const finished = performance.now();
  fingerprints.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const sizes = new Map(files.map(file => [file.path, file.size]));
  if (fingerprints.some(file => !file.contentHash && sizes.get(file.path) > 0)) {
    throw new Error(`${backend.name} could not fingerprint a nonempty file; the library may have changed`);
  }
  return {
    listing: normalizeListing(files), fingerprints,
    listingMs: listed - start, hashingMs: finished - listed, wallMs: finished - start,
  };
}

function sameResults(actual, expected) {
  assert.deepEqual(actual.listing, expected.listing, 'Directory listings differ or the library changed during the benchmark');
  assert.deepEqual(actual.fingerprints, expected.fingerprints, 'Fingerprints differ or the library changed during the benchmark');
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

async function generate(root, count, sizeMiB) {
  const size = Math.max(16, Math.round(sizeMiB * 1024 * 1024));
  const buffer = Buffer.alloc(size, 87);
  buffer[0] = 255; buffer[1] = 251;
  for (let index = 0; index < count; index++) {
    const folder = path.join(root, `album-${String(Math.floor(index / 16)).padStart(4, '0')}`);
    await fs.mkdir(folder, { recursive: true });
    buffer.writeUInt32BE(index, 4);
    await fs.writeFile(path.join(folder, `track-${String(index).padStart(6, '0')}.mp3`), buffer);
  }
}

async function main() {
  const settings = options(process.argv.slice(2));
  if (settings.help) { console.log(usage); return; }
  let temporaryRoot;
  const native = createNativeScannerClient({ engine: 'rust', workers: settings.workers });
  try {
    const root = settings.path || (temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tunecloud-scanner-benchmark-')));
    if (temporaryRoot) await generate(root, settings.files, settings.sizeMiB);
    // These functions are the original JS implementation and never dispatch to
    // native code, regardless of SCANNER_ENGINE in the caller's environment.
    const backends = [
      { name: 'js', list: listAudioFilesJs, hash: computeFileHashesJs },
      { name: 'rust', list: rootPath => native.listAudioFiles(rootPath), hash: file => native.computeFileHashes(file) },
    ];
    const baseline = await scan(backends[0], root, settings.workers);
    sameResults(await scan(backends[1], root, settings.workers), baseline);
    assert.equal(native.getInfo().engine, 'rust', 'The Rust benchmark must use the actual native backend');
    assert.equal(native.getInfo().state, 'ready');
    const runs = { js: [], rust: [] };
    for (let round = 0; round < settings.rounds; round++) {
      // Alternate order to reduce a consistent ordering advantage.
      for (const backend of round % 2 ? [...backends].reverse() : backends) {
        const run = await scan(backend, root, settings.workers);
        sameResults(run, baseline);
        runs[backend.name].push(run);
      }
    }
    const bytes = baseline.listing.reduce((sum, file) => sum + file.size, 0);
    const results = backends.map(backend => {
      const samples = runs[backend.name];
      const wallMs = median(samples.map(run => run.wallMs));
      return {
        backend: backend.name, files: baseline.listing.length, MiB: +(bytes / 1024 ** 2).toFixed(2),
        rounds: settings.rounds, listingMs: +median(samples.map(run => run.listingMs)).toFixed(2),
        hashingMs: +median(samples.map(run => run.hashingMs)).toFixed(2), wallMs: +wallMs.toFixed(2),
        MiBPerSecond: +(bytes / 1024 ** 2 / (wallMs / 1000)).toFixed(2),
      };
    });
    const report = {
      source: temporaryRoot ? 'synthetic temporary files' : root,
      parity: 'passed', cache: 'warm', workers: settings.workers,
      timing: 'median per backend; listing plus fingerprints; excludes helper startup, metadata and database work',
      results,
    };
    if (settings.json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`Parity passed; warm filesystem caches; ${settings.workers} concurrent fingerprints per backend.`);
      console.log(report.timing);
      console.table(results);
      console.log('These measurements do not predict a full library scan speedup.');
    }
  } finally {
    await native.close();
    if (temporaryRoot) await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
