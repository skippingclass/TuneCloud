import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchLrcRedLyrics, normalizeLineLrc } from '../src/lrc-red.js';

const target = { title: 'Test Song', artist: 'Test Artist', album: 'Test Album', duration: 120 };
const hit = { ...target, isrc: 'USAAA2600001' };
const json = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });

test('lrc.red selects matching version and duration, identifies app, and returns line-only LRC', async () => {
  const requests = [];
  const result = await fetchLrcRedLyrics(target, { fetchImpl: async (url, options) => {
    requests.push(url);
    assert.match(options.headers['User-Agent'], /TuneCloud.*https:\/\/github.com\/skippingclass\/TuneCloud.*contact: [^\s]+@/);
    if (url.includes('/search.json')) return json({ hits: [
      { ...hit, isrc: 'USAAA2600002', title: 'Test Song (Acoustic)' },
      { ...hit, isrc: 'USAAA2600003', duration: 180 },
      { ...hit, isrc: 'USAAA2600004', artist: 'Cover Artist' },
      hit,
    ] });
    return new Response('[ti:Test Song]\n[00:01.00]<00:01.00>First <00:01.50>line\n[00:03.00]Second line');
  } });
  assert.deepEqual(result, { synced: true, type: 'line',
    lyrics: '[ti:Test Song]\n[00:01.00]First line\n[00:03.00]Second line', source: 'lrc.red' });
  assert.equal(requests.length, 2);
  assert.match(requests[1], /USAAA2600001\.lrc$/);
});

test('lrc.red rejects unrelated tracks, missing artist, invalid ISRC and version mismatches', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return json({ hits: [
    { ...hit, title: 'Different Song' }, { ...hit, isrc: '../../outside' },
    { ...hit, title: 'Test Song (Live)' }, { ...hit, title: 'Test Song (Remix)' },
    { ...hit, duration: null },
  ] }); };
  assert.equal(await fetchLrcRedLyrics(target, { fetchImpl }), null);
  assert.equal(calls, 1);
  assert.equal(await fetchLrcRedLyrics({ title: 'Test Song' }, { fetchImpl }), null);
  assert.equal(calls, 1);
});

test('lrc.red prefers closest duration and album, tolerates remastered labels', async () => {
  const requests = [];
  const result = await fetchLrcRedLyrics(target, { fetchImpl: async url => {
    requests.push(url);
    return url.includes('/search.json') ? json({ hits: [
      { ...hit, isrc: 'USAAA2600002', album: 'Other Album', duration: 123 },
      { ...hit, title: 'Test Song (Remastered 2020)' },
    ] }) : new Response('[00:01.00]Matched line');
  } });
  assert.equal(result.source, 'lrc.red');
  assert.match(requests[1], /USAAA2600001\.lrc$/);
});

test('lrc.red handles HTTP failures, malformed payloads, untimed LRC and response limits', async () => {
  for (const status of [404, 429, 503]) {
    assert.equal(await fetchLrcRedLyrics(target, { fetchImpl: async () => new Response('', { status }) }), null);
  }
  for (const body of ['<html>Error</html>', '{}', '{broken', '{"hits":null}']) {
    assert.equal(await fetchLrcRedLyrics(target, { fetchImpl: async () => new Response(body) }), null);
  }
  for (const body of ['plain text', '[ti:No timing]', '[00:01.00]', '[00:01][00:02]', '[00:99]Invalid', '[00:01]'+ 'x'.repeat(512 * 1024 + 1)]) {
    assert.equal(await fetchLrcRedLyrics(target, { fetchImpl: async url =>
      url.includes('/search.json') ? json({ hits: [hit] }) : new Response(body) }), null);
  }
  assert.equal(await fetchLrcRedLyrics(target, { fetchImpl: async url => url.includes('/search.json')
    ? json({ hits: [hit] }) : new Response('[00:01]Declared oversized', {
      headers: { 'content-length': String(512 * 1024 + 1) },
    }) }), null);
  assert.equal(normalizeLineLrc(null), null);
});

test('lrc.red timeout aborts requests, including body reads, and failures can be retried', async () => {
  let aborted = false;
  assert.equal(await fetchLrcRedLyrics(target, { timeoutMs: 10, fetchImpl: async (url, { signal }) =>
    new Promise((resolve, reject) => signal.addEventListener('abort', () => {
      aborted = true; reject(new Error('aborted'));
    }, { once: true })) }), null);
  assert.equal(aborted, true);
  assert.equal(await fetchLrcRedLyrics(target, { timeoutMs: 10, fetchImpl: async (url, { signal }) =>
    new Response(new ReadableStream({ start(controller) {
      signal.addEventListener('abort', () => controller.error(new Error('body aborted')), { once: true });
    } })) }), null);
  assert.equal(await fetchLrcRedLyrics(target, { fetchImpl: async url => url.includes('/search.json')
    ? json({ hits: [hit] }) : new Response('[00:01.00]Recovered') }).then(r => r.source), 'lrc.red');
});

test('lrc.red shares concurrent identical requests without caching failures', async () => {
  let count = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const options = { fetchImpl: async () => { count++; await gate; return new Response('', { status: 429 }); } };
  const first = fetchLrcRedLyrics(target, options);
  const second = fetchLrcRedLyrics(target, options);
  release();
  assert.deepEqual(await Promise.all([first, second]), [null, null]);
  assert.equal(count, 1);
  await fetchLrcRedLyrics(target, options);
  assert.equal(count, 2);
});
