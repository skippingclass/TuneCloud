import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { Writable } from 'node:stream';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateSecurityConfig, trustedProxies, safeRequestSerializer, accountLoginAllowed, recordLoginFailure } from '../src/security.js';
import { parseRange, sendAudioFile, findEmptyMimeFlacPictureOffsets } from '../src/streaming.js';

test('production rejects shipped secrets and default administrator passwords', () => {
  for (const secret of ['', 'change-me-in-production', 'tunecloud-default-secret-replace-me',
    'replace_with_a_secure_random_string_at_least_32_chars', 'your-random-secret']) {
    assert.throws(() => validateSecurityConfig({ NODE_ENV: 'production', JWT_SECRET: secret }));
  }
  assert.throws(() => validateSecurityConfig({ NODE_ENV: 'production', JWT_SECRET: 'a'.repeat(64), ADMIN_PASSWORD: 'admin' }));
  assert.doesNotThrow(() => validateSecurityConfig({ NODE_ENV: 'production', JWT_SECRET: 'a'.repeat(64), ADMIN_PASSWORD: 'unique-admin-password' }));
});

test('untrusted forwarded IP cannot evade rate limiting; credentials never reach request logs', async () => {
  const lines = [];
  const app = Fastify({ trustProxy: trustedProxies({}), logger: { serializers: { req: safeRequestSerializer },
    stream: new Writable({ write(c, enc, done) { lines.push(c.toString()); done(); } }) } });
  await app.register(rateLimit, { max: 1, timeWindow: '1 minute' });
  app.get('/rest/ping', async () => ({ ok: true }));
  const one = await app.inject({ url: '/rest/ping?p=secret-password&t=secret-token', headers: { 'x-forwarded-for': '203.0.113.1' } });
  const two = await app.inject({ url: '/rest/ping?p=secret-password', headers: { 'x-forwarded-for': '203.0.113.2' } });
  assert.equal(one.statusCode, 200);
  assert.equal(two.statusCode, 429);
  await app.close();
  assert.ok(lines.some(s => s.includes('/rest/ping')));
  assert.ok(lines.every(s => !s.includes('secret-password') && !s.includes('secret-token')));
});

test('failed authentication is bounded across source IPs, expires, and does not block successful Subsonic streams', () => {
  const now = 1000;
  assert.equal(accountLoginAllowed('audit-user', now), true);
  for (let i = 0; i < 100; i++) assert.equal(accountLoginAllowed('audit-user', now), true);
  for (let i = 0; i < 10; i++) recordLoginFailure('audit-user', now);
  assert.equal(accountLoginAllowed('audit-user', now), false);
  assert.equal(accountLoginAllowed('audit-user', now + 60_001), true);
});

test('range streaming handles suffixes, clipping and unsatisfiable requests', () => {
  assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=50-500', 100), { start: 50, end: 99 });
  assert.deepEqual(parseRange('bytes=100-', 100), { invalid: true });
});

test('a full failure cache cannot globally lock out legitimate accounts', () => {
  const now = Date.now();
  for (let i = 0; i < 10001; i++) recordLoginFailure(`unknown-${i}`, now);
  assert.equal(accountLoginAllowed('legitimate-unseen-user', now), true);
});

test('FLAC streaming patches empty-MIME PICTURE blocks to PADDING on the fly while preserving Range offsets', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tunecloud-flac-patch-'));
  const prevMusicDir = process.env.MUSIC_DIR;
  process.env.MUSIC_DIR = dir;
  t.after(async () => {
    if (prevMusicDir === undefined) delete process.env.MUSIC_DIR;
    else process.env.MUSIC_DIR = prevMusicDir;
    await fs.rm(dir, { recursive: true, force: true });
  });

  // Build minimal FLAC: fLaC + STREAMINFO (34 bytes) + last PICTURE block (type 6 | 0x80 = 0x86) with mimeLen = 0 + fake audio frames
  const picPayload = Buffer.alloc(36, 0xaa);
  picPayload.writeUInt32BE(3, 0); // Cover (front)
  picPayload.writeUInt32BE(0, 4); // empty MIME length
  const picHdr = Buffer.from([0x86, 0x00, 0x00, picPayload.length]);
  const flacBytes = Buffer.concat([
    Buffer.from('fLaC', 'ascii'),
    Buffer.from([0x00, 0x00, 0x00, 34]),
    Buffer.alloc(34),
    picHdr,
    picPayload,
    Buffer.from('FRAMES'),
  ]);
  const filePath = path.join(dir, 'empty-mime.flac');
  await fs.writeFile(filePath, flacBytes);

  const picOffset = 4 + 4 + 34;
  assert.deepEqual(await findEmptyMimeFlacPictureOffsets(filePath, flacBytes.length), [picOffset]);

  const app = Fastify();
  app.get('/stream', (req, reply) => sendAudioFile(req, reply, filePath, 'flac'));
  t.after(() => app.close());

  const fullRes = await app.inject({ method: 'GET', url: '/stream' });
  assert.equal(fullRes.statusCode, 200);
  assert.equal(fullRes.rawPayload.length, flacBytes.length);
  // Block type 6 (0x86 with is_last) becomes PADDING 1 (0x81 with is_last preserved)
  assert.equal(fullRes.rawPayload[picOffset], 0x81);
  assert.equal(fullRes.rawPayload.subarray(picOffset + 1).equals(flacBytes.subarray(picOffset + 1)), true);

  const rangeRes = await app.inject({ method: 'GET', url: '/stream', headers: { range: `bytes=${picOffset}-${picOffset + 5}` } });
  assert.equal(rangeRes.statusCode, 206);
  assert.equal(rangeRes.rawPayload.length, 6);
  assert.equal(rangeRes.rawPayload[0], 0x81);

  // Disk file remains untouched
  assert.equal((await fs.readFile(filePath))[picOffset], 0x86);
});
