import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readLocalLyrics, MAX_LYRICS_FILE_SIZE, isSafeFilename, isWithinDirectory } from '../src/lyrics.js';
import { parseSubsonicFormData, mergeSubsonicParams } from '../src/routes/subsonic.js';
import {
  BoundedTtlCache,
  artistCache,
  inFlight,
  searchArtist,
  getArtistImage,
  fetchWithTimeout,
  REQUEST_TIMEOUT_MS,
  MAX_IMAGE_SIZE,
} from '../src/spotify.js';

test('Lyrics security: safe filename and directory containment', () => {
  assert.equal(isSafeFilename('song'), true);
  assert.equal(isSafeFilename('track-title (feat. artist)'), true);
  assert.equal(isSafeFilename('../passwd'), false);
  assert.equal(isSafeFilename('../../etc/passwd'), false);
  assert.equal(isSafeFilename('/etc/passwd'), false);
  assert.equal(isSafeFilename('foo/bar'), false);
  assert.equal(isSafeFilename('foo\\bar'), false);
  assert.equal(isSafeFilename('.'), false);
  assert.equal(isSafeFilename('..'), false);
  assert.equal(isSafeFilename(''), false);
  assert.equal(isSafeFilename(null), false);

  assert.equal(isWithinDirectory('/music', '/music/album/song.lrc'), true);
  assert.equal(isWithinDirectory('/music', '/etc/passwd'), false);
  assert.equal(isWithinDirectory('/music', '/music/../etc/passwd'), false);
});

test('Lyrics security: traversal via title, symlink outside MUSIC_DIR, and size limit', () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'tunecloud-lyrics-test-'));
  const musicDir = path.join(tmpBase, 'music');
  const outsideDir = path.join(tmpBase, 'outside');
  const albumDir = path.join(musicDir, 'RockArtist', 'BestAlbum');
  fs.mkdirSync(albumDir, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });

  const prevMusicDir = process.env.MUSIC_DIR;
  process.env.MUSIC_DIR = musicDir;

  try {
    const audioPath = path.join(albumDir, 'track1.mp3');
    fs.writeFileSync(audioPath, Buffer.alloc(64));

    const secretFile = path.join(outsideDir, 'secret.txt');
    fs.writeFileSync(secretFile, 'SUPER_SECRET_DATA');

    // 1. Traversal via title parameter must not read outside files
    const traversalResult = readLocalLyrics(audioPath, '../../../../outside/secret');
    assert.equal(traversalResult, null);

    const traversalAbsolute = readLocalLyrics(audioPath, secretFile);
    assert.equal(traversalAbsolute, null);

    // 2. Symlink inside music library pointing OUTSIDE MUSIC_DIR must be rejected
    const symlinkPath = path.join(albumDir, 'track1.lrc');
    fs.symlinkSync(secretFile, symlinkPath);
    const symlinkResult = readLocalLyrics(audioPath, 'track1');
    assert.equal(symlinkResult, null, 'Symlink escaping MUSIC_DIR must be rejected');
    fs.unlinkSync(symlinkPath);

    // 3. Oversized lyrics file (> 128 KB) must be rejected
    const oversizedContent = 'A'.repeat(MAX_LYRICS_FILE_SIZE + 1024);
    fs.writeFileSync(symlinkPath, oversizedContent);
    const oversizedResult = readLocalLyrics(audioPath, 'track1');
    assert.equal(oversizedResult, null, 'Oversized lyrics must be rejected');
    fs.unlinkSync(symlinkPath);

    // 4. Legitimate local .lrc file inside MUSIC_DIR works
    const validLyrics = '[00:12.00] Line one\n[00:15.50] Line two';
    fs.writeFileSync(symlinkPath, validLyrics);
    const validResult = readLocalLyrics(audioPath, 'track1');
    assert.notEqual(validResult, null);
    assert.equal(validResult.synced, true);
    assert.equal(validResult.lyrics, validLyrics);
    assert.equal(validResult.source, 'local');

    // 5. Legitimate symlink pointing INSIDE MUSIC_DIR works
    const targetInside = path.join(albumDir, 'target.txt');
    fs.writeFileSync(targetInside, 'Plain lyrics text');
    const symlinkInside = path.join(albumDir, 'track2.txt');
    fs.symlinkSync(targetInside, symlinkInside);
    const track2Path = path.join(albumDir, 'track2.mp3');
    fs.writeFileSync(track2Path, Buffer.alloc(64));
    const insideResult = readLocalLyrics(track2Path, 'track2');
    assert.notEqual(insideResult, null);
    assert.equal(insideResult.lyrics, 'Plain lyrics text');
  } finally {
    process.env.MUSIC_DIR = prevMusicDir;
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test('Subsonic Form POST: repeating parameters preserved as arrays and aligned with GET', () => {
  // Empty or missing body
  assert.deepEqual(parseSubsonicFormData(''), {});
  assert.deepEqual(parseSubsonicFormData(null), {});

  // Single parameters
  const single = parseSubsonicFormData('u=admin&p=secret&name=MyPlaylist');
  assert.deepEqual(single, { u: 'admin', p: 'secret', name: 'MyPlaylist' });

  // Repeating parameters: preserves order and duplicates
  const formBody = 'name=SummerMix&songId=101&songId=202&songId=101';
  const parsed = parseSubsonicFormData(formBody);
  assert.deepEqual(parsed, {
    name: 'SummerMix',
    songId: ['101', '202', '101'],
  });

  // Multiple repeating parameter keys
  const updateBody = 'playlistId=5&songIdToAdd=10&songIdToAdd=20&songIdToAdd=10&songIndexToRemove=0&songIndexToRemove=2';
  const updateParsed = parseSubsonicFormData(updateBody);
  assert.deepEqual(updateParsed, {
    playlistId: '5',
    songIdToAdd: ['10', '20', '10'],
    songIndexToRemove: ['0', '2'],
  });

  // Query and body merging: query auth params + body payload with repeated keys
  const query = { u: 'admin', t: 'md5token', s: 'salt', v: '1.16.1', c: 'substreamer', f: 'json' };
  const merged = mergeSubsonicParams(query, parsed);
  assert.equal(merged.u, 'admin');
  assert.equal(merged.f, 'json');
  assert.equal(merged.name, 'SummerMix');
  assert.deepEqual(merged.songId, ['101', '202', '101']);

  // If a list parameter is present in both query and body, they combine preserving order
  const combined = mergeSubsonicParams({ songId: '50' }, { songId: ['100', '200'] });
  assert.deepEqual(combined.songId, ['50', '100', '200']);
});

test('Spotify/Deezer bounded cache: maxSize eviction and TTL expiration', async () => {
  const cache = new BoundedTtlCache({ maxSize: 3, defaultTtlMs: 50 });

  cache.set('a', { id: 1 });
  cache.set('b', { id: 2 });
  cache.set('c', { id: 3 });
  assert.equal(cache.size, 3);

  // Access 'a' so 'b' becomes the oldest unaccessed
  assert.deepEqual(cache.get('a'), { id: 1 });

  // Adding 'd' should evict 'b'
  cache.set('d', { id: 4 });
  assert.equal(cache.size, 3);
  assert.equal(cache.has('b'), false);
  assert.equal(cache.has('a'), true);
  assert.equal(cache.has('c'), true);
  assert.equal(cache.has('d'), true);

  // TTL expiration
  cache.set('expire-me', { id: 99 }, 10);
  assert.deepEqual(cache.get('expire-me'), { id: 99 });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(cache.get('expire-me'), undefined);
  cache.pruneExpired();
  assert.equal(cache.has('expire-me'), false);
});

test('Spotify/Deezer request coalescing: concurrent calls share single upstream promise', async () => {
  artistCache.clear();
  inFlight.clear();

  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    fetchCalls++;
    await new Promise((r) => setTimeout(r, 25));
    if (String(url).includes('deezer.com')) {
      return {
        ok: true,
        json: async () => ({
          data: [
            {
              id: 12345,
              name: 'Coalesced Artist',
              picture_xl: 'https://cdn.example.com/artist.jpg',
            },
          ],
        }),
      };
    }
    return { ok: false, status: 404 };
  };

  const oldId = process.env.SPOTIFY_CLIENT_ID;
  const oldSecret = process.env.SPOTIFY_CLIENT_SECRET;
  delete process.env.SPOTIFY_CLIENT_ID;
  delete process.env.SPOTIFY_CLIENT_SECRET;

  try {
    const p1 = searchArtist('Coalesced Artist');
    const p2 = searchArtist('Coalesced Artist');
    const p3 = searchArtist('Coalesced Artist');

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

    assert.equal(fetchCalls, 1, 'Only 1 upstream fetch should be dispatched for concurrent identical keys');
    assert.deepEqual(r1, r2);
    assert.deepEqual(r2, r3);
    assert.equal(r1.name, 'Coalesced Artist');
    assert.equal(inFlight.size, 0, 'inFlight map should be cleared after resolution');
  } finally {
    if (oldId !== undefined) process.env.SPOTIFY_CLIENT_ID = oldId;
    if (oldSecret !== undefined) process.env.SPOTIFY_CLIENT_SECRET = oldSecret;
    globalThis.fetch = originalFetch;
    artistCache.clear();
  }
});

test('Spotify/Deezer error handling: transient errors are not cached for 24h; not-found has short TTL', async () => {
  artistCache.clear();
  inFlight.clear();

  let shouldFail = true;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    if (shouldFail) {
      throw new Error('Transient network glitch ECONNRESET');
    }
    return {
      ok: true,
      json: async () => ({
        data: [
          {
            id: 999,
            name: 'Recovered Artist',
            picture_xl: 'https://cdn.example.com/recovered.jpg',
          },
        ],
      }),
    };
  };

  try {
    // 1. Transient failure
    const failRes = await searchArtist('Recovered Artist');
    assert.equal(failRes, null);
    assert.equal(artistCache.has('recovered artist'), false, 'Transient error must not be cached');

    // 2. Recovery succeeds immediately because it was not negatively cached for 24h
    shouldFail = false;
    const successRes = await searchArtist('Recovered Artist');
    assert.notEqual(successRes, null);
    assert.equal(successRes.name, 'Recovered Artist');
    assert.equal(artistCache.has('recovered artist'), true, 'Successful result is cached');
  } finally {
    globalThis.fetch = originalFetch;
    artistCache.clear();
  }
});

test('Spotify/Deezer image download size limit: rejects images exceeding MAX_IMAGE_SIZE', async () => {
  artistCache.clear();
  inFlight.clear();

  const originalFetch = globalThis.fetch;
  try {
    // 1. Search returns artist metadata
    artistCache.set('huge artist', {
      id: '1',
      name: 'Huge Artist',
      image: 'https://cdn.example.com/huge.jpg',
    });

    // 2. Fetch image with Content-Length exceeding limit
    globalThis.fetch = async (url) => {
      return {
        ok: true,
        headers: new Map([['content-length', String(MAX_IMAGE_SIZE + 1024)]]),
        body: (async function* () {
          yield Buffer.alloc(1024);
        })(),
      };
    };

    const res1 = await getArtistImage('Huge Artist', 1001);
    assert.equal(res1, null, 'Oversized Content-Length must be rejected');

    // 3. Fetch image where streamed chunks exceed limit (even if content-length omitted)
    globalThis.fetch = async (url) => {
      return {
        ok: true,
        headers: new Map(),
        body: (async function* () {
          yield Buffer.alloc(MAX_IMAGE_SIZE / 2);
          yield Buffer.alloc(MAX_IMAGE_SIZE / 2 + 1024);
        })(),
      };
    };

    const res2 = await getArtistImage('Huge Artist', 1002);
    assert.equal(res2, null, 'Oversized streamed image must be aborted and rejected');
  } finally {
    globalThis.fetch = originalFetch;
    artistCache.clear();
  }
});

test('Spotify/Deezer request timeouts: fetchWithTimeout aborts hung requests', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    return new Promise((resolve, reject) => {
      if (options?.signal) {
        options.signal.addEventListener('abort', () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      }
    });
  };

  try {
    await assert.rejects(
      () => fetchWithTimeout('https://api.example.com/hang', {}, 25),
      { name: 'AbortError' }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('OpenSubsonic extensions list: does not declare transcodeOffset', async () => {
  const Fastify = (await import('fastify')).default;
  const app = Fastify();
  const { default: pool } = await import('../src/db.js');
  try {
    const subsonicRoutes = (await import('../src/routes/subsonic.js')).default;
    await subsonicRoutes(app);
    const res = await app.inject({
      method: 'GET',
      url: '/rest/getOpenSubsonicExtensions?u=test&p=test&f=json',
    });
    const json = res.json();
    const extensions = json?.['subsonic-response']?.openSubsonicExtensions || [];
    const hasTranscodeOffset = extensions.some((e) => e.name === 'transcodeOffset');
    assert.equal(hasTranscodeOffset, false, 'transcodeOffset must not be advertised in openSubsonicExtensions');
  } finally {
    await app.close();
    await pool.end();
  }
});
