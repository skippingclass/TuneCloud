import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import pg from 'pg';
import NodeID3 from 'node-id3';
import { File, Picture, PictureType, ByteVector } from 'node-taglib-sharp';
import { parseFile } from 'music-metadata';
import sharp from 'sharp';
import { writeAudioTags } from '../src/tag-writer.js';

function audioFrames(data, format) {
  if (format === 'wav') {
    for (let offset = 12; offset + 8 <= data.length;) {
      const size = data.readUInt32LE(offset + 4);
      if (data.toString('ascii', offset, offset + 4) === 'data') return data.subarray(offset + 8, offset + 8 + size);
      offset += 8 + size + (size % 2);
    }
  } else if (format === 'wma') {
    const offset = data.indexOf(Buffer.from('3626b2758e66cf11a6d900aa0062ce6c', 'hex'));
    assert.ok(offset >= 0);
    return data.subarray(offset + 50, offset + Number(data.readBigUInt64LE(offset + 16)));
  } else {
    let start = 0;
    if (data.toString('ascii', 0, 3) === 'ID3') start = 10 + ((data[6] << 21) | (data[7] << 14) | (data[8] << 7) | data[9]);
    const end = data.toString('ascii', data.length - 128, data.length - 125) === 'TAG' ? data.length - 128 : data.length;
    return data.subarray(start, end);
  }
  throw new Error('Audio payload not found');
}

for (const format of ['wav', 'wma', 'aac']) test(`${format}: edits round-trip without changing encoded audio`, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tunecloud-format-'));
  try {
    const file = path.join(dir, `song.${format}`);
    await fs.copyFile(new URL(`./fixtures/tags/sample.${format}`, import.meta.url), file);
    const before = await parseFile(file);
    const frames = audioFrames(await fs.readFile(file), format);
    assert.ok(frames.length > 0);
    writeAudioTags(file, format, { title: 'Edited 曲名', artist: 'Artist', album: 'Album', genre: 'Rock', trackNumber: 7, year: 2026 });
    const after = await parseFile(file);
    assert.equal(after.common.title, 'Edited 曲名'); assert.equal(after.common.artist, 'Artist');
    assert.equal(after.common.album, 'Album'); assert.equal(after.common.track.no, 7); assert.equal(after.common.year, 2026);
    assert.equal(after.format.numberOfSamples, before.format.numberOfSamples);
    assert.equal(after.format.sampleRate, before.format.sampleRate);
    assert.deepEqual(audioFrames(await fs.readFile(file), format), frames);
    writeAudioTags(file, format, { artist: '', album: '', genre: '', trackNumber: null, year: null });
    const cleared = await parseFile(file);
    assert.ok(!cleared.common.artist); assert.ok(!cleared.common.album); assert.ok(!cleared.common.genre?.length);
    assert.deepEqual(audioFrames(await fs.readFile(file), format), frames);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

const databaseUrl = process.env.TEST_DATABASE_URL;
test('OpenSubsonic sync, artwork, edition identity and complete tag metadata', { skip: !databaseUrl }, async t => {
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const schema = 'compat_' + crypto.randomBytes(8).toString('hex');
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(databaseUrl); url.searchParams.set('options', `-c search_path=${schema}`);
  process.env.DATABASE_URL = url.toString(); process.env.DOTENV_CONFIG_PATH = '/dev/null';
  process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex'); process.env.TAG_EDITING_ENABLED = 'true';
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tunecloud-compat-'));
  process.env.MUSIC_DIR = dir; process.env.COVERS_DIR = path.join(dir, 'covers'); await fs.mkdir(process.env.COVERS_DIR);
  const { default: pool, initDb, query } = await import('../src/db.js');
  const { scanSingleFile, scanDirectory } = await import('../src/scanner.js');
  const cover = await import('../src/cover.js');
  const auth = await import('../src/auth.js');
  let app;
  try {
    await initDb(); app = await (await import('../src/index.js')).buildApp(); app.log.level = 'silent';
    const password = 'compat-password';
    const user = (await query("INSERT INTO users(username,password_hash,is_admin,subsonic_secret) VALUES('audit',$1,true,$2) RETURNING *", [await auth.hashPassword(password), auth.encryptSubsonicSecret(password)])).rows[0];
    const headers = { authorization: 'Bearer ' + auth.signToken(user) };
    const salt = 'compat'; const credentials = { u: 'audit', s: salt, t: crypto.createHash('md5').update(password + salt).digest('hex'), f: 'json', c: 'Symfonium', v: '1.16.1' };
    const request = (endpoint, params = {}) => app.inject('/rest/' + endpoint + '?' + new URLSearchParams({ ...credentials, ...params }));
    const sub = async (endpoint, params) => { const response = await request(endpoint, params); assert.equal(response.statusCode, 200, response.body); return response.json()['subsonic-response']; };
    const edit = (id, payload) => app.inject({ method: 'PUT', url: `/api/tags/${id}`, headers, payload });
    const front = await sharp({ create: { width: 120, height: 80, channels: 3, background: '#ff0000' } }).png().toBuffer();
    const back = await sharp({ create: { width: 120, height: 80, channels: 3, background: '#0000ff' } }).png().toBuffer();
    const make = async (name, tags, pictures = [front]) => {
      const file = path.join(dir, name + '.mp3'); await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.copyFile(new URL('./fixtures/tags/sample.mp3', import.meta.url), file);
      NodeID3.removeTags(file); NodeID3.write(tags, file);
      const audio = File.createFromPath(file);
      audio.tag.pictures = pictures.map((bytes, index) => Picture.fromFullData(ByteVector.fromByteArray(bytes), index === pictures.length - 1 ? PictureType.FrontCover : PictureType.BackCover, 'image/png', String(index)));
      audio.save(); audio.dispose(); assert.equal(await scanSingleFile(file), true);
      return (await query('SELECT * FROM tracks WHERE file_path=$1', [file])).rows[0];
    };
    await t.test('empty queries enumerate, counts of zero stay zero, requested pages exceed 100 and ties are stable', async () => {
      await query(`INSERT INTO tracks(file_path,file_name,title) SELECT '/virtual/'||n, n||'.mp3','Same' FROM generate_series(1,253) n`);
      const ids = (await query('SELECT id FROM tracks ORDER BY id')).rows.map(r => String(r.id));
      for (const query of [undefined, '', '""']) {
        const params = { songCount: '125', artistCount: '0', albumCount: '0', ...(query === undefined ? {} : { query }) };
        const first = (await sub('search3.view', params)).searchResult3;
        assert.deepEqual(first.song.map(s => s.id), ids.slice(0, 125)); assert.deepEqual(first.artist, []); assert.deepEqual(first.album, []);
        const second = (await sub('search3', { ...params, songOffset: '125' })).searchResult3;
        assert.deepEqual(second.song.map(s => s.id), ids.slice(125, 250));
        const last = (await sub('search3', { ...params, songOffset: '250' })).searchResult3;
        assert.deepEqual(last.song.map(s => s.id), ids.slice(250));
      }
      const form = await app.inject({ method: 'POST', url: '/rest/search3', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams({ ...credentials, songCount: '0', artistCount: '0', albumCount: '0' }).toString() });
      assert.deepEqual(form.json()['subsonic-response'].searchResult3, { artist: [], album: [], song: [] });
      assert.equal((await sub('search3', { songCount: '10001' })).status, 'failed');
      await query('DELETE FROM tracks');
    });
    await t.test('authenticated sync remains available beyond the web rate limit', async () => {
      for (let n = 0; n < 305; n++) assert.equal((await request('ping')).statusCode, 200);
      assert.equal((await app.inject('/rest/ping?u=audit&p=bad&f=json')).json()['subsonic-response'].status, 'failed');
    });
    let rich, richAlbum;
    await t.test('front cover wins; artist URLs are directly usable; requested cover size is honored', async () => {
      rich = await make('Rich/song', { title: 'Rich', artist: 'Earth, Wind & Fire', album: 'Rich', performerInfo: 'Earth, Wind & Fire' }, [back, front]);
      richAlbum = (await query('SELECT * FROM albums WHERE id=$1', [rich.album_id])).rows[0];
      assert.deepEqual(await fs.readFile(cover.coverUrl(richAlbum.cover_path)), front);
      const artist = (await sub('getArtist', { id: String(rich.artist_id) })).artist;
      assert.equal(artist.name, 'Earth, Wind & Fire');
      const image = await app.inject(new URL(artist.artistImageUrl).pathname);
      assert.equal(image.statusCode, 200); assert.deepEqual(image.rawPayload, front);
      const info = (await sub('getArtistInfo2', { id: String(rich.artist_id) })).artistInfo2;
      assert.ok(info.smallImageUrl.startsWith('http'));
      process.env.PUBLIC_URL = 'https://music.example.test';
      assert.ok((await sub('getArtistInfo2', { id: String(rich.artist_id) })).artistInfo2.smallImageUrl.startsWith('https://music.example.test/api/cover/'));
      delete process.env.PUBLIC_URL;
      for (let n = 0; n < 305; n++) assert.equal((await app.inject(new URL(artist.artistImageUrl).pathname)).statusCode, 200);
      const small = await request('getCoverArt', { id: `al-${rich.album_id}`, size: '32' });
      const dimensions = await sharp(small.rawPayload).metadata(); assert.equal(dimensions.width, 32);
      const listed = (await sub('getArtists')).artists.index.flatMap(i => i.artist); assert.ok(listed.some(a => a.name === 'Earth, Wind & Fire'));
    });
    await t.test('feature credits have distinct real artist IDs and rich tags survive import and editing', async () => {
      const file = rich.file_path; const tagged = File.createFromPath(file);
      tagged.tag.performers = ['Alice feat. Bob']; tagged.tag.genres = ['Rock', 'Pop']; tagged.tag.composers = ['Composer'];
      tagged.tag.disc = 2; tagged.tag.discCount = 4; tagged.tag.isCompilation = true;
      tagged.tag.musicBrainzArtistId = '6d7d6c55-bd3e-4382-8c21-0a665022f114'; tagged.save(); tagged.dispose();
      await scanSingleFile(file);
      const song = (await sub('getSong', { id: String(rich.id) })).song;
      assert.deepEqual(song.artists.map(a => a.name), ['Alice', 'Bob']); assert.notEqual(song.artists[0].id, song.artists[1].id);
      for (const artist of song.artists) assert.equal((await query('SELECT name FROM artists WHERE id=$1', [artist.id])).rows[0].name, artist.name);
      assert.equal((await sub('getArtist', { id: song.artists[0].id })).artist.musicBrainzId, '6d7d6c55-bd3e-4382-8c21-0a665022f114');
      const indexed = (await sub('getArtists')).artists.index.flatMap(i => i.artist);
      const guest = indexed.find(a => a.id === song.artists[1].id);
      assert.ok(guest.albumCount > 0);
      assert.equal((await app.inject(new URL(guest.artistImageUrl).pathname)).statusCode, 200);
      assert.deepEqual(song.genres, [{ name: 'Rock' }, { name: 'Pop' }]);
      assert.ok((await sub('getSongsByGenre', { genre: 'Rock' })).songsByGenre.song.some(s => s.id === String(rich.id)));
      const genres = (await sub('getGenres')).genres.genre.map(g => g.value); assert.ok(genres.includes('Rock')); assert.ok(genres.includes('Pop')); assert.ok(!genres.includes('Rock, Pop'));
      const row = (await query('SELECT composer FROM tracks WHERE id=$1', [rich.id])).rows[0]; assert.equal(row.composer, 'Composer');
      assert.equal(song.contributors[0].artist.name, 'Composer');
      assert.equal((await query('SELECT name FROM artists WHERE id=$1', [song.contributors[0].artist.id])).rows[0].name, 'Composer');
      const album = (await query('SELECT compilation,disc_count FROM albums WHERE id=$1', [rich.album_id])).rows[0]; assert.deepEqual(album, { compilation: true, disc_count: 4 });
      assert.equal((await edit(rich.id, { title: 'Edited', genres: ['Jazz', 'Soul'], discTotal: 5 })).statusCode, 200);
      assert.deepEqual((await parseFile(file)).common.genre, ['Jazz', 'Soul']);
      assert.equal((await query('SELECT disc_count FROM albums WHERE id=$1', [rich.album_id])).rows[0].disc_count, 5);
    });
    await t.test('moving tracks between albums refreshes their unique artwork immediately', async () => {
      const other = await make('Rich/other', { title: 'Other', artist: 'Earth, Wind & Fire', album: 'Other', performerInfo: 'Earth, Wind & Fire' }, [back]);
      const response = await edit(rich.id, { album: 'Other' }); assert.equal(response.statusCode, 200, response.body);
      const moved = (await query('SELECT album_id FROM tracks WHERE id=$1', [rich.id])).rows[0]; assert.equal(moved.album_id, other.album_id);
      const song = (await sub('getSong', { id: String(rich.id) })).song;
      assert.deepEqual((await request('getCoverArt', { id: song.coverArt })).rawPayload, front);
      await scanDirectory(dir); assert.deepEqual((await request('getCoverArt', { id: song.coverArt })).rawPayload, front);
    });
    await t.test('editions in different folders keep separate IDs and artwork after rescans', async () => {
      const original = await make('Original/song', { title: 'Original', artist: 'Same', album: 'Same Album', year: '2001' }, [front]);
      const remaster = await make('Remaster/song', { title: 'Remaster', artist: 'Same', album: 'Same Album', year: '2020' }, [back]);
      assert.notEqual(original.album_id, remaster.album_id);
      await scanDirectory(dir, { full: true });
      const rows = (await query('SELECT id,album_id FROM tracks WHERE id=ANY($1::int[]) ORDER BY id', [[original.id, remaster.id]])).rows;
      assert.deepEqual(rows.map(r => r.album_id), [original.album_id, remaster.album_id]);
    });
    await t.test('embedded lyrics reach OpenSubsonic; orphan artwork is removed; empty playlists omit broken cover IDs', async () => {
      NodeID3.update({ unsynchronisedLyrics: { language: 'eng', text: 'Embedded lyric' } }, rich.file_path);
      const lyrics = (await sub('getLyricsBySongId', { id: String(rich.id) })).lyricsList.structuredLyrics;
      assert.equal(lyrics[0].line[0].value, 'Embedded lyric');
      assert.equal((await edit(rich.id, { album: '' })).statusCode, 200);
      assert.ok((await query('SELECT cover_path FROM tracks WHERE id=$1', [rich.id])).rows[0].cover_path);
      const file = File.createFromPath(rich.file_path); file.tag.pictures = []; file.save(); file.dispose();
      await cover.extractAllMissingCovers({ force: true });
      assert.equal((await query('SELECT cover_path FROM tracks WHERE id=$1', [rich.id])).rows[0].cover_path, null);
      const playlist = (await sub('createPlaylist', { name: 'No cover', songId: String(rich.id) })).playlist;
      assert.equal(playlist.coverArt, undefined);
    });
    await t.test('WAV, WMA and AAC edits work through the staged HTTP writer', async () => {
      for (const format of ['wav', 'wma', 'aac']) {
        const file = path.join(dir, 'http.' + format);
        await fs.copyFile(new URL(`./fixtures/tags/sample.${format}`, import.meta.url), file);
        const before = audioFrames(await fs.readFile(file), format);
        const track = (await query('INSERT INTO tracks(file_path,file_name,format) VALUES($1,$2,$3) RETURNING id', [file, path.basename(file), format])).rows[0];
        const response = await edit(track.id, { title: 'HTTP edited', artist: 'HTTP Artist', album: 'HTTP Album' });
        assert.equal(response.statusCode, 200, response.body);
        assert.equal((await parseFile(file)).common.title, 'HTTP edited');
        assert.deepEqual(audioFrames(await fs.readFile(file), format), before);
      }
    });
    await t.test('GIF content types, radio response names and editing capabilities are accurate', async () => {
      const gif = await sharp(front).gif().toBuffer(); await fs.writeFile(path.join(process.env.COVERS_DIR, 'test.gif'), gif);
      const response = await app.inject('/api/cover/test.gif'); assert.equal(response.headers['content-type'], 'image/gif');
      const caps = (await app.inject({ url: '/api/tags/capabilities', headers })).json(); assert.equal(caps.enabled, true);
      for (const format of ['flac', 'mp3', 'ogg', 'opus', 'm4a', 'aac', 'wma', 'wav']) assert.ok(caps.formats.includes(format));
      process.env.TAG_EDITING_ENABLED = 'false';
      assert.equal((await app.inject({ url: '/api/tags/capabilities', headers })).json().enabled, false);
      assert.equal((await edit(rich.id, { title: 'Forbidden' })).statusCode, 403); process.env.TAG_EDITING_ENABLED = 'true';
      const radio = (await sub('getInternetRadioStations')).internetRadioStations; assert.deepEqual(radio.internetRadioStation, []); assert.equal(radio.station, undefined);
    });
  } finally {
    if (app) await app.close(); await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); await fs.rm(dir, { recursive: true, force: true });
  }
});
