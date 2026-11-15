import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createNativeScannerClient } from '../src/native-scanner.js';

const execFileAsync = promisify(execFile);
const hashResult = { contentHash: 'a'.repeat(64), audioHash: 'b'.repeat(64), audioPayloadSize: 4096 };

async function assertProcessStopped(pid) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); }
    catch (error) { if (error.code === 'ESRCH') return; throw error; }
    if (process.platform === 'linux') {
      try {
        const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
        // A killed child can briefly remain a zombie until the parent's or
        // container init's reaper runs. It has no running code or open handles.
        if (/\) Z /.test(stat)) return;
      } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`Native worker ${pid} is still running after its parent exited`);
}

async function fixture(t, body, { ready = true, ...options } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tunecloud-native-bridge-'));
  const binaryPath = path.join(dir, 'scanner fixture ; literal.mjs');
  await fs.writeFile(binaryPath, `#!${process.execPath}
import fs from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
const send = message => process.stdout.write(JSON.stringify(message) + '\\n');
const hashResult = ${JSON.stringify(hashResult)};
${ready ? 'send({ ready: true, protocol: 1 });' : ''}
${body}
`, { mode: 0o755 });
  const client = createNativeScannerClient({ engine: 'rust', env: {}, binaryPath, ...options });
  t.after(async () => { await client.close(); await fs.rm(dir, { recursive: true, force: true }); });
  return { client, dir, binaryPath };
}

test('engine and worker configuration reject invalid values explicitly', () => {
  for (const engine of ['', 'native', 'Rust']) {
    assert.throws(() => createNativeScannerClient({ engine, env: {} }), /SCANNER_ENGINE/);
  }
  for (const workers of [0, 33, 1.5, 'four', '4junk', NaN]) {
    assert.throws(() => createNativeScannerClient({ engine: 'rust', workers, env: {} }), /RUST_SCANNER_WORKERS/);
  }
  assert.equal(createNativeScannerClient({ env: { SCANNER_ENGINE: 'js', RUST_SCANNER_WORKERS: '8' } }).getInfo().workers, 8);
});

test('only auto permits unavailable executables to select the JS fallback', async t => {
  const binaryPath = path.join(os.tmpdir(), `tunecloud-scanner-missing-${process.pid}-${Date.now()}`);
  const auto = createNativeScannerClient({ engine: 'auto', env: {}, binaryPath });
  const rust = createNativeScannerClient({ engine: 'rust', env: {}, binaryPath });
  const js = createNativeScannerClient({ engine: 'js', env: {}, binaryPath });
  t.after(async () => { await Promise.all([auto.close(), rust.close(), js.close()]); });
  assert.equal(await auto.computeFileHashes('/music/song.mp3'), null);
  assert.equal(await auto.listAudioFiles('/music'), null);
  assert.equal(auto.getInfo().state, 'unavailable');
  await assert.rejects(rust.listAudioFiles('/music'), { code: 'SCANNER_UNAVAILABLE' });
  assert.equal(await js.computeFileHashes('/music/song.mp3'), null);
  assert.equal(js.getInfo().binaryPath, null);
});

test('auto also falls back for an executable without execute permission', async t => {
  const { binaryPath, client } = await fixture(t, 'process.exit(90);', { engine: 'auto' });
  await fs.chmod(binaryPath, 0o644);
  assert.equal(await client.listAudioFiles('/music'), null);
  assert.equal(client.getInfo().state, 'unavailable');
});

test('long-lived worker correlates out-of-order responses, arguments, and absolute paths', async t => {
  const { client } = await fixture(t, `
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['--stdio', '--workers', '2'])) process.exit(20);
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (!path.isAbsolute(request.path)) process.exit(21);
  const first = request.path.endsWith('first.mp3');
  setTimeout(() => send({ id: request.id, result: { ...hashResult, audioPayloadSize: first ? 1 : 2 } }), first ? 35 : 0);
});`, { workers: 2 });
  const results = await Promise.all([client.computeFileHashes('first.mp3'), client.computeFileHashes('second.mp3')]);
  assert.deepEqual(results.map(result => result.audioPayloadSize), [1, 2]);
  assert.deepEqual(await client.computeFileHashes('/music/second.mp3'), { ...hashResult, audioPayloadSize: 2 });
  assert.equal(client.getInfo().state, 'ready');
  assert.equal(client.getInfo().pending, 0);
});

test('large chunked UTF-8 listing validates identity and restores Date values', async t => {
  const { client } = await fixture(t, `
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  const files = Array.from({ length: 1500 }, (_, i) => ({
    path: path.join(request.path, 'Исполнитель 🎵 ' + i + '.FLAC'), size: i,
    mtimeMs: 1700000000123.75, dev: '9007199254740993', ino: String(i + 1),
    nlink: 1, birthtimeMs: '1700000000000',
  }));
  const bytes = Buffer.from(JSON.stringify({ id: request.id, result: { files } }) + '\\n');
  for (let start = 0; start < bytes.length; start += 73) process.stdout.write(bytes.subarray(start, start + 73));
});`);
  const files = await client.listAudioFiles('/music');
  assert.equal(files.length, 1500);
  assert.equal(files[1499].path, '/music/Исполнитель 🎵 1499.FLAC');
  assert.equal(files[0].mtime.getTime(), 1700000000123);
  assert.equal(files[0].dev, '9007199254740993');
  assert.equal(files[0].birthtimeMs, '1700000000000');
});

test('worker operation errors abort the request without returning a partial list or falling back', async t => {
  const { client } = await fixture(t, `
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  send(request.op === 'list'
    ? { id: request.id, error: 'cannot read library subtree: permission denied' }
    : { id: request.id, result: hashResult });
});`, { engine: 'auto' });
  await assert.rejects(client.listAudioFiles('/music'), { code: 'SCANNER_REQUEST_FAILED' });
  assert.equal(client.getInfo().state, 'ready');
  assert.deepEqual(await client.computeFileHashes('/music/song.mp3'), hashResult);
});

test('a worker crash rejects active and queued requests and never falls back or restarts', async t => {
  const { client } = await fixture(t, `
readline.createInterface({ input: process.stdin }).once('line', () => process.exit(17));`, { engine: 'auto', workers: 1 });
  const results = await Promise.allSettled([client.listAudioFiles('/music'), client.computeFileHashes('/music/song.mp3')]);
  assert.equal(results.filter(result => result.status === 'rejected').length, 2);
  assert.equal(results[0].reason.code, 'SCANNER_FAILED');
  assert.equal(client.getInfo().state, 'failed');
  await assert.rejects(client.listAudioFiles('/music'), { code: 'SCANNER_FAILED' });
});

test('invalid readiness, response framing, and result shapes poison the worker', async t => {
  const bodies = [
    { ready: false, body: 'send({ ready: true, protocol: 2 });' },
    { body: "readline.createInterface({ input: process.stdin }).once('line', () => process.stdout.write('not json\\n'));" },
    { body: "readline.createInterface({ input: process.stdin }).once('line', () => send({ id: 999, result: hashResult }));" },
    { body: "readline.createInterface({ input: process.stdin }).once('line', line => send({ id: JSON.parse(line).id, result: { ...hashResult, contentHash: 'incorrect' } }));" },
    { body: "readline.createInterface({ input: process.stdin }).once('line', line => send({ id: JSON.parse(line).id, result: { ...hashResult, contentHash: null } }));" },
    { body: "readline.createInterface({ input: process.stdin }).once('line', line => send({ id: JSON.parse(line).id, result: { ...hashResult, audioHash: null } }));" },
    { body: "readline.createInterface({ input: process.stdin }).once('line', line => send({ id: JSON.parse(line).id, result: { ...hashResult, audioPayloadSize: 0 } }));" },
    { body: "readline.createInterface({ input: process.stdin }).once('line', line => send({ id: JSON.parse(line).id, error: 17 }));" },
    { body: "readline.createInterface({ input: process.stdin }).once('line', () => process.stdout.write(Buffer.from([255, 10])));" },
  ];
  for (const entry of bodies) {
    const { client } = await fixture(t, entry.body, { engine: 'auto', ready: entry.ready ?? true });
    await assert.rejects(client.computeFileHashes('/music/song.mp3'), { code: 'SCANNER_PROTOCOL' });
    assert.equal(client.getInfo().state, 'failed');
  }
});

test('list responses reject paths escaping the root, duplicates, and unsafe identity values', async t => {
  for (const mutation of [
    "files[0].path = '/elsewhere/song.mp3';",
    'files.push(files[0]);',
    'files[0].size = Number.MAX_SAFE_INTEGER + 1;',
    'files[0].mtimeMs = null;',
    "files[0].dev = 123;",
    "files[0].birthtimeMs = 'bad';",
  ]) {
    const { client } = await fixture(t, `
readline.createInterface({ input: process.stdin }).once('line', line => {
  const request = JSON.parse(line);
  const files = [{ path: path.join(request.path, 'song.mp3'), size: 123, mtimeMs: 1700000000000,
    dev: '1', ino: '2', nlink: 1, birthtimeMs: null }];
  ${mutation}
  send({ id: request.id, result: { files } });
});`);
    await assert.rejects(client.listAudioFiles('/music'), { code: 'SCANNER_PROTOCOL' });
  }
});

test('readiness and operation timeouts fail auto instead of selecting JS', async t => {
  const startup = await fixture(t, 'setInterval(() => {}, 1000);', { ready: false, engine: 'auto', startupTimeoutMs: 40 });
  await assert.rejects(startup.client.listAudioFiles('/music'), { code: 'SCANNER_TIMEOUT' });
  const operation = await fixture(t, 'setInterval(() => {}, 1000);', { engine: 'auto', timeoutMs: 40 });
  await assert.rejects(operation.client.listAudioFiles('/music'), { code: 'SCANNER_TIMEOUT' });
  assert.equal(operation.client.getInfo().state, 'failed');
});

test('response size limits abort the worker instead of returning a truncated result', async t => {
  const { client } = await fixture(t, `
readline.createInterface({ input: process.stdin }).once('line', line => send({ id: JSON.parse(line).id, result: hashResult }));`, { maxResponseBytes: 80 });
  await assert.rejects(client.computeFileHashes('/music/song.mp3'), { code: 'SCANNER_PROTOCOL' });
});

test('closing stdout without exiting aborts a request immediately', async t => {
  const { client } = await fixture(t, `
readline.createInterface({ input: process.stdin }).once('line', () => process.stdout.end());
setInterval(() => {}, 1000);`, { timeoutMs: 10000 });
  await assert.rejects(client.listAudioFiles('/music'), /output closed/);
  assert.equal(client.getInfo().state, 'failed');
});

test('bounded queue rejects excess work while allowing accepted requests to finish', async t => {
  const { client } = await fixture(t, `
let active = 0;
readline.createInterface({ input: process.stdin }).on('line', line => {
  if (++active > 1) process.exit(25);
  const request = JSON.parse(line);
  setTimeout(() => { active--; send({ id: request.id, result: hashResult }); }, 30);
});`, { workers: 1, maxQueue: 2 });
  const first = client.computeFileHashes('/music/first.mp3');
  const second = client.computeFileHashes('/music/second.mp3');
  await assert.rejects(client.computeFileHashes('/music/third.mp3'), { code: 'SCANNER_QUEUE_FULL' });
  assert.deepEqual(await Promise.all([first, second]), [hashResult, hashResult]);
  assert.deepEqual(await client.computeFileHashes('/music/fourth.mp3'), hashResult);
});

test('close kills a live worker, rejects pending work, and is idempotent', async t => {
  const { client, dir } = await fixture(t, `
fs.writeFileSync(path.join(path.dirname(process.argv[1]), 'pid'), String(process.pid));
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);`);
  const pending = client.listAudioFiles('/music');
  const rejected = assert.rejects(pending, { code: 'SCANNER_CLOSED' });
  const deadline = Date.now() + 3000;
  while (client.getInfo().state !== 'ready') {
    assert.notEqual(client.getInfo().state, 'failed');
    assert.ok(Date.now() < deadline, 'worker did not become ready');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  const pid = Number(await fs.readFile(path.join(dir, 'pid'), 'utf8'));
  await client.close();
  await rejected;
  await client.close();
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  await assert.rejects(client.listAudioFiles('/music'), { code: 'SCANNER_CLOSED' });
});

test('idle workers do not keep a parent process alive and are killed on parent exit', async t => {
  const { binaryPath, dir } = await fixture(t, `
fs.writeFileSync(path.join(path.dirname(process.argv[1]), 'pid'), String(process.pid));
readline.createInterface({ input: process.stdin }).on('line', line => send({ id: JSON.parse(line).id, result: hashResult }));
setInterval(() => {}, 1000);`);
  const moduleUrl = new URL('../src/native-scanner.js', import.meta.url).href;
  const source = `import { createNativeScannerClient } from ${JSON.stringify(moduleUrl)};
const client = createNativeScannerClient({ engine: 'rust', env: {}, binaryPath: ${JSON.stringify(binaryPath)} });
await client.computeFileHashes('/music/song.mp3');
console.log('finished');`;
  const result = await execFileAsync(process.execPath, ['--input-type=module', '-e', source], { timeout: 3000 });
  assert.match(result.stdout, /finished/);
  const pid = Number(await fs.readFile(path.join(dir, 'pid'), 'utf8'));
  t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch {} });
  await assertProcessStopped(pid);
});

test('a standalone process can await explicit worker cleanup before exiting', async t => {
  const { binaryPath } = await fixture(t, `
readline.createInterface({ input: process.stdin }).on('line', line => send({ id: JSON.parse(line).id, result: hashResult }));
setInterval(() => {}, 1000);`);
  const moduleUrl = new URL('../src/native-scanner.js', import.meta.url).href;
  const source = `import { createNativeScannerClient } from ${JSON.stringify(moduleUrl)};
const client = createNativeScannerClient({ engine: 'rust', env: {}, binaryPath: ${JSON.stringify(binaryPath)} });
await client.computeFileHashes('/music/song.mp3');
await client.close();
console.log(client.getInfo().state);`;
  const result = await execFileAsync(process.execPath, ['--input-type=module', '-e', source], { timeout: 3000 });
  assert.match(result.stdout, /closed/);
});

test('failed initial launches leave no handles that keep a fallback process alive', async () => {
  const moduleUrl = new URL('../src/native-scanner.js', import.meta.url).href;
  const source = `import { createNativeScannerClient } from ${JSON.stringify(moduleUrl)};
const client = createNativeScannerClient({ engine: 'auto', env: {}, binaryPath: '/missing/tunecloud-scanner' });
if (await client.listAudioFiles('/music') !== null) throw new Error('expected unavailable fallback');
console.log(client.getInfo().state);`;
  const result = await execFileAsync(process.execPath, ['--input-type=module', '-e', source], { timeout: 3000 });
  assert.match(result.stdout, /unavailable/);
});
