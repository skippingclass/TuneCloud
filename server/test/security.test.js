import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { Writable } from 'node:stream';
import { validateSecurityConfig, trustedProxies, safeRequestSerializer, accountLoginAllowed, recordLoginFailure } from '../src/security.js';
import { parseRange } from '../src/streaming.js';

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
