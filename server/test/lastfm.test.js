import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { signature, encryptSession, decryptSession, eligible, DEFAULT_SETTINGS, metadataPayload, lastfmRequest, LastfmError, batchParams, configured } from '../src/services/lastfm.js';

test('Last.fm signatures use ASCII ordering, UTF-8 and exclude response parameters', () => {
  const params = { 'artist[1]': 'Б', 'artist[10]': '曲', 'artist[0]': 'A', format: 'json', callback: 'x', api_sig: 'old' };
  const expected = crypto.createHash('md5').update('artist[0]Aartist[10]曲artist[1]Бsecret').digest('hex');
  assert.equal(signature(params, 'secret'), expected);
});
test('sessions are authenticated encrypted and independent of JWT secret', () => {
  process.env.LASTFM_ENCRYPTION_KEY = 'a'.repeat(64);
  const encrypted = encryptSession('session-token');
  assert.ok(!encrypted.includes('session-token'));
  process.env.JWT_SECRET = 'new-jwt';
  assert.equal(decryptSession(encrypted), 'session-token');
  process.env.LASTFM_ENCRYPTION_KEY = 'b'.repeat(64);
  assert.throws(() => decryptSession(encrypted));
});
test('Last.fm thresholds exclude short tracks and can only be raised by settings', () => {
  for (const duration of [0, 29, 30, NaN]) assert.equal(eligible(duration, 999, DEFAULT_SETTINGS), false);
  assert.equal(eligible(31, 15.49, DEFAULT_SETTINGS), false);
  assert.equal(eligible(31, 15.5, DEFAULT_SETTINGS), true);
  assert.equal(eligible(300, 149.99, DEFAULT_SETTINGS), false);
  assert.equal(eligible(300, 150, DEFAULT_SETTINGS), true);
  assert.equal(eligible(1000, 239, DEFAULT_SETTINGS), false);
  assert.equal(eligible(1000, 240, DEFAULT_SETTINGS), true);
  assert.equal(eligible(300, 299, { ...DEFAULT_SETTINGS, percent: 100, seconds: 600 }), false);
  assert.equal(eligible(300, 300, { ...DEFAULT_SETTINGS, percent: 100, seconds: 600 }), true);
});
test('metadata corrections take precedence and structured credits identify the first artist', () => {
  const track = { title: 'Song', artist: 'Earth, Wind & Fire', album: 'Album', duration: 123.5 };
  assert.equal(metadataPayload(track, { first_artist: true }).artist, 'Earth, Wind & Fire');
  track.metadata = { artists: [{ name: 'A' }, { name: 'B' }] };
  assert.equal(metadataPayload(track, { first_artist: true }).artist, 'A');
  const payload = metadataPayload(track, DEFAULT_SETTINGS, { artist: ' Correct ', album: '' });
  assert.equal(payload.artist, 'Correct'); assert.equal(payload.album, ''); assert.equal(payload.duration, '123');
  assert.equal(metadataPayload({ file_name: 'Artist - Song.mp3' }, DEFAULT_SETTINGS).track, '');
});
test('first-artist scrobbling uses the library primary artist when structured credits are missing', () => {
  const track = { title: 'Song', artist: 'OG Buda', track_artist_credit: 'OG Buda, 163ONMYNECK, Yanix', album_artist: 'OG Buda', album_artist_credit: 'OG Buda, MAYOT', metadata: { albumArtists: [{ name: 'OG Buda' }, { name: 'MAYOT' }] }, duration: 180 };
  assert.equal(metadataPayload(track, { ...DEFAULT_SETTINGS, first_artist: true }).artist, 'OG Buda');
  assert.equal(metadataPayload(track, { ...DEFAULT_SETTINGS, first_artist: true }).albumArtist, 'OG Buda');
  assert.equal(metadataPayload(track, { ...DEFAULT_SETTINGS, first_artist: false }).artist, 'OG Buda, 163ONMYNECK, Yanix');
  assert.equal(metadataPayload(track, { ...DEFAULT_SETTINGS, first_artist: false }).albumArtist, 'OG Buda, MAYOT');
  assert.equal(metadataPayload({ ...track, artist: 'Earth, Wind & Fire', track_artist_credit: 'Earth, Wind & Fire' }, { ...DEFAULT_SETTINGS, first_artist: true }).artist, 'Earth, Wind & Fire');
});
test('requests are signed form POSTs; errors never expose Last.fm response secrets', async () => {
  process.env.LASTFM_API_KEY = 'key'; process.env.LASTFM_API_SECRET = 'secret';
  await lastfmRequest('track.scrobble', { artist: '曲', timestamp: '123' }, 'session', async (url, opts) => {
    assert.equal(url, 'https://ws.audioscrobbler.com/2.0/'); assert.equal(opts.method, 'POST');
    const params = Object.fromEntries(opts.body); assert.equal(params.sk, 'session');
    assert.equal(params.api_sig, signature(params, 'secret'));
    return { ok: true, status: 200, json: async () => ({ scrobbles: {} }) };
  });
  for (const [code, retryable] of [[8, true], [9, false], [11, true], [16, true], [29, true], [6, false]]) {
    await assert.rejects(lastfmRequest('x', {}, null, async () => ({ ok: true, status: 200, json: async () => ({ error: code, message: 'SECRET' }) })), e => e instanceof LastfmError && e.retryable === retryable && !e.message.includes('SECRET'));
  }
  await assert.rejects(lastfmRequest('x', {}, null, async () => { throw new Error('SECRET'); }), e => e.retryable && !e.message.includes('SECRET'));
  const batch = batchParams([{ payload: { track: 'A', album: '', timestamp: '100' } }]);
  assert.deepEqual(batch, { 'track[0]': 'A', 'timestamp[0]': '100' });
});
test('configuration requires stable encryption and an explicit safe public URL', () => {
  process.env.LASTFM_ENCRYPTION_KEY = 'a'.repeat(64);
  for (const url of ['', 'http://music.example.com', 'javascript:alert(1)', 'https://user:pass@example.com']) {
    process.env.PUBLIC_URL = url; assert.equal(configured(), false);
  }
  for (const url of ['https://music.example.com', 'http://localhost:5173']) { process.env.PUBLIC_URL = url; assert.equal(configured(), true); }
});
