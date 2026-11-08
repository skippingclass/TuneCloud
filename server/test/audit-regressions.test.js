import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import pg from 'pg';
import Fastify from 'fastify';
import NodeID3 from 'node-id3';
import { runMigrations } from '../src/migrations/runner.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationsDir = new URL('../src/migrations/', import.meta.url);
async function isolatedDatabase(prefix) {
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const schema = prefix + crypto.randomBytes(8).toString('hex');
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(databaseUrl);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const pool = new pg.Pool({ connectionString: url.toString() });
  return { pool, url: url.toString(), close: async () => {
    await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
  } };
}

test('upgrade from populated pre-009 DB preserves recordings and per-user stars, ratings, credits and track references', { skip: !databaseUrl }, async () => {
  const db = await isolatedDatabase('audit_upgrade_');
  try {
    await db.pool.query('CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW())');
    const files = (await fs.readdir(migrationsDir)).filter(f => f.endsWith('.sql') && Number(f.slice(0, 3)) < 9).sort();
    for (const file of files) {
      await db.pool.query(await fs.readFile(new URL(file, migrationsDir), 'utf8'));
      await db.pool.query('INSERT INTO schema_migrations(version) VALUES($1)', [file]);
    }
    await db.pool.query(`
      INSERT INTO users(username,password_hash) VALUES('alice','unused'),('bob','unused');
      INSERT INTO artists(name) VALUES('Artist'),('artist'),('Guest');
      INSERT INTO albums(title,artist_id) VALUES('Album',1),('Album',2),('album',1),('Untitled',NULL),('untitled',NULL);
      INSERT INTO tracks(file_path,file_name,title,artist_id,album_id)
        VALUES('/clean.flac','track.flac','Same title',1,1),('/explicit.flac','track.flac','Same title',2,2),
              ('/live.flac','live.flac','Same title',1,3),('/unknown-a.flac','a.flac','A',NULL,4),('/unknown-b.flac','b.flac','B',NULL,5);
      INSERT INTO user_starred_artists(user_id,artist_id) VALUES(1,1),(1,2),(2,2);
      INSERT INTO user_starred_albums(user_id,album_id) VALUES(1,1),(1,2),(2,2),(2,3);
      INSERT INTO user_starred_tracks(user_id,track_id) VALUES(1,1),(2,2),(2,3);
      INSERT INTO user_ratings(user_id,entity_type,entity_id,rating)
        VALUES(1,'artist',1,5),(1,'artist',2,2),(2,'artist',2,4),(1,'album',1,5),(1,'album',2,2),(2,'album',2,4),(2,'track',2,3);
      INSERT INTO album_credits(album_id,artist_id,role,credited_as)
        VALUES(1,1,'albumartist','Artist'),(1,2,'albumartist','artist'),(2,3,'composer','Guest'),(3,3,'producer','Guest');
      INSERT INTO track_credits(track_id,artist_id,role,credited_as)
        VALUES(1,1,'artist','Artist'),(1,2,'artist','artist'),(2,2,'artist','artist'),(3,2,'composer','artist');
      INSERT INTO playlists(name,owner_id) VALUES('Versions',1);
      INSERT INTO playlist_tracks(playlist_id,track_id,track_order) VALUES(1,1,1),(1,2,2),(1,3,3);
      INSERT INTO play_history(user_id,track_id) VALUES(1,1),(2,2),(2,3);
      INSERT INTO bookmarks(user_id,track_id,position_ms) VALUES(2,2,500);
      INSERT INTO play_queues(user_id,current_track_id,track_ids) VALUES(2,2,ARRAY[1,2,3]);
      INSERT INTO track_lyrics(track_id,synced,type,lyrics,source) VALUES(2,false,'plain','Original lyrics','local');
    `);
    await runMigrations(db.pool);
    assert.deepEqual((await db.pool.query('SELECT id FROM tracks ORDER BY id')).rows.map(r => r.id), [1,2,3,4,5]);
    assert.deepEqual((await db.pool.query('SELECT id FROM artists ORDER BY id')).rows.map(r => r.id), [1,3]);
    assert.equal((await db.pool.query('SELECT * FROM albums')).rowCount, 2);
    for (const table of ['user_starred_artists', 'user_starred_albums']) {
      assert.deepEqual((await db.pool.query(`SELECT user_id FROM ${table} ORDER BY user_id`)).rows.map(r => r.user_id), [1,2]);
    }
    assert.deepEqual((await db.pool.query('SELECT track_id FROM user_starred_tracks ORDER BY track_id')).rows.map(r => r.track_id), [1,2,3]);
    assert.equal((await db.pool.query('SELECT * FROM album_credits')).rowCount, 3);
    assert.equal((await db.pool.query('SELECT * FROM track_credits')).rowCount, 3);
    assert.deepEqual((await db.pool.query("SELECT user_id,rating FROM user_ratings WHERE entity_type='artist' ORDER BY user_id")).rows, [{user_id:1,rating:5},{user_id:2,rating:4}]);
    assert.deepEqual((await db.pool.query("SELECT user_id,rating FROM user_ratings WHERE entity_type='album' ORDER BY user_id")).rows, [{user_id:1,rating:5},{user_id:2,rating:4}]);
    assert.deepEqual((await db.pool.query('SELECT track_id FROM playlist_tracks ORDER BY track_order')).rows.map(r => r.track_id), [1,2,3]);
    assert.equal((await db.pool.query('SELECT * FROM play_history')).rowCount, 3);
    assert.equal((await db.pool.query('SELECT track_id FROM bookmarks')).rows[0].track_id, 2);
    assert.deepEqual((await db.pool.query('SELECT track_ids FROM play_queues')).rows[0].track_ids, [1,2,3]);
    assert.equal((await db.pool.query('SELECT lyrics FROM track_lyrics')).rows[0].lyrics, 'Original lyrics');
    const after = (await db.pool.query('SELECT * FROM schema_migrations ORDER BY version')).rows;
    await runMigrations(db.pool);
    assert.deepEqual((await db.pool.query('SELECT * FROM schema_migrations ORDER BY version')).rows, after);
    await assert.rejects(db.pool.query("INSERT INTO artists(name) VALUES('ARTIST')"), { code: '23505' });
    await assert.rejects(db.pool.query("INSERT INTO albums(title,artist_id) VALUES('ALBUM',1)"), { code: '23505' });
    await assert.rejects(db.pool.query("INSERT INTO albums(title,artist_id) VALUES('UNTITLED',NULL)"), { code: '23505' });
  } finally { await db.close(); }
});

test('audit regressions: tag APIs, atomic album merge, and safe artwork fallback', { skip: !databaseUrl }, async t => {
  const db = await isolatedDatabase('audit_routes_');
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tunecloud-audit-regressions-'));
  process.env.DATABASE_URL = db.url;
  process.env.DOTENV_CONFIG_PATH = '/dev/null';
  process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
  process.env.TAG_EDITING_ENABLED = 'true';
  process.env.MUSIC_DIR = path.join(tmp, 'music');
  process.env.COVERS_DIR = path.join(tmp, 'covers');
  await fs.mkdir(process.env.MUSIC_DIR); await fs.mkdir(process.env.COVERS_DIR);
  const { default: pool, query } = await import('../src/db.js');
  const auth = await import('../src/auth.js');
  const { refreshAlbumsMetadata } = await import('../src/scanner.js');
  const { extractCoversForAlbum } = await import('../src/cover.js');
  const app = Fastify();
  try {
    await runMigrations(pool);
    for (const route of ['tags', 'cover', 'subsonic']) await (await import(`../src/routes/${route}.js`)).default(app);
    const password = 'audit-test-password';
    const admin = (await query("INSERT INTO users(username,password_hash,is_admin,subsonic_secret) VALUES('admin',$1,true,$2) RETURNING *",
      [await auth.hashPassword(password), auth.encryptSubsonicSecret(password)])).rows[0];
    const user = (await query("INSERT INTO users(username,password_hash) VALUES('listener','unused') RETURNING *")).rows[0];
    const call = (id, payload, asUser = admin) => app.inject({ method:'PUT', url:`/api/tags/${id}`, headers:{ authorization: 'Bearer ' + auth.signToken(asUser) }, payload });
    const artist = (await query("INSERT INTO artists(name) VALUES('Artist') RETURNING id")).rows[0].id;
    const album = (await query("INSERT INTO albums(title,artist_id) VALUES('Album',$1) RETURNING id", [artist])).rows[0].id;

    await t.test('case-only edits reuse artist/album IDs, including albums without artists', async () => {
      const file = path.join(process.env.MUSIC_DIR, 'case.mp3');
      await fs.writeFile(file, Buffer.from([0xff,0xfb,0x90,0x64,...new Array(414).fill(0)]));
      NodeID3.write({artist:'Artist',album:'Album',title:'Case'}, file);
      const track = (await query("INSERT INTO tracks(file_path,file_name,artist_id,album_id) VALUES($1,'case.mp3',$2,$3) RETURNING id", [file,artist,album])).rows[0].id;
      const response = await call(track, {artist:'artist',album:'album'});
      assert.equal(response.statusCode, 200, response.body);
      const row = (await query('SELECT artist_id,album_id,track_artist_credit FROM tracks WHERE id=$1',[track])).rows[0];
      assert.deepEqual(row, {artist_id:artist,album_id:album,track_artist_credit:'artist'});
      assert.equal(NodeID3.read(file).artist,'artist');
      const untitled = (await query("INSERT INTO albums(title) VALUES('Untitled') RETURNING id")).rows[0].id;
      assert.equal((await call(track,{artist:'',album:'untitled'})).statusCode,200);
      assert.equal((await query('SELECT album_id FROM tracks WHERE id=$1',[track])).rows[0].album_id,untitled);
    });

    for (const format of ['mp3','flac','opus','ogg','m4a']) await t.test(`${format} tag endpoint updates DB/file atomically, enforces admin and rolls back failures`, async () => {
      const file = path.join(process.env.MUSIC_DIR, 'sample.' + format);
      await fs.copyFile(new URL(`./fixtures/tags/sample.${format}`, import.meta.url), file);
      const track = (await query("INSERT INTO tracks(file_path,file_name,title,format) VALUES($1,$2,'Original title',$3) RETURNING id", [file,path.basename(file),format])).rows[0].id;
      assert.equal((await call(track,{title:'Forbidden'},user)).statusCode,403);
      const edited = await call(track,{title:'Edited 曲名',artist:'ARTIST',album:'ALBUM',year:2025,trackNumber:7});
      assert.equal(edited.statusCode,200,edited.body);
      const {parseFile} = await import('music-metadata');
      const meta = await parseFile(file);
      assert.equal(meta.common.title,'Edited 曲名');
      const row = (await query('SELECT title,artist_id,album_id,mtime,file_size,content_hash,dev,ino FROM tracks WHERE id=$1',[track])).rows[0];
      assert.equal(row.title,meta.common.title);assert.equal(row.artist_id,artist);
      const actualAlbum = (await query('SELECT al.title,a.name AS artist FROM albums al LEFT JOIN artists a ON a.id=al.artist_id WHERE al.id=$1',[row.album_id])).rows[0];
      assert.equal(actualAlbum.title.toLowerCase(),'album');
      assert.equal(actualAlbum.artist.toLowerCase(),(meta.common.albumartist || meta.common.artist).toLowerCase());
      const stat = await fs.stat(file);
      assert.equal(row.mtime.getTime(),stat.mtime.getTime());assert.equal(Number(row.file_size),stat.size);
      const bytes = await fs.readFile(file);
      assert.equal(row.content_hash,crypto.createHash('sha256').update(bytes).digest('hex'));
      await query(`CREATE OR REPLACE FUNCTION reject_tag_test() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.title='reject-test' THEN RAISE EXCEPTION 'test failure'; END IF; RETURN NEW; END $$`);
      await query('CREATE TRIGGER reject_tag_test BEFORE UPDATE ON tracks FOR EACH ROW EXECUTE FUNCTION reject_tag_test()');
      try {
        assert.equal((await call(track,{title:'reject-test'})).statusCode,500);
        assert.deepEqual(await fs.readFile(file),bytes);
        assert.equal((await query('SELECT title FROM tracks WHERE id=$1',[track])).rows[0].title,'Edited 曲名');
      } finally { await query('DROP TRIGGER reject_tag_test ON tracks'); }
      assert.equal((await call(track,{artist:'',album:'',year:null,trackNumber:null})).statusCode,200);
      const cleared = await parseFile(file);
      assert.ok(!cleared.common.artist);assert.ok(!cleared.common.album);assert.ok(!cleared.common.year);
      assert.ok(!(await fs.readdir(process.env.MUSIC_DIR)).some(n=>n.endsWith('.tmp')||n.endsWith('.bak')));
    });

    await t.test('unsupported and corrupt files leave source and database intact', async () => {
      for (const format of ['xyz','flac']) {
        const file=path.join(process.env.MUSIC_DIR,'bad.'+format),bytes=Buffer.from('invalid test data');
        await fs.writeFile(file,bytes);
        const id=(await query("INSERT INTO tracks(file_path,file_name,title) VALUES($1,$2,'Intact') RETURNING id",[file,path.basename(file)])).rows[0].id;
        const response=await call(id,{title:'No'});
        assert.equal(response.statusCode,format==='xyz'?400:500);
        assert.deepEqual(await fs.readFile(file),bytes);
        assert.equal((await query('SELECT title FROM tracks WHERE id=$1',[id])).rows[0].title,'Intact');
      }
    });

    await t.test('album merge preserves conflicting user links and rolls back on mid-merge failure', async () => {
      const otherArtist=(await query("INSERT INTO artists(name) VALUES('Other') RETURNING id")).rows[0].id;
      const source=(await query("INSERT INTO albums(title,artist_id) VALUES('Album',$1) RETURNING id",[otherArtist])).rows[0].id;
      const track=(await query("INSERT INTO tracks(file_path,file_name,title,artist_id,album_id,album_artist_credit) VALUES('/merge.mp3','merge.mp3','Merge',$1,$2,'Artist') RETURNING id",[otherArtist,source])).rows[0].id;
      await query('INSERT INTO user_starred_albums(user_id,album_id) VALUES($1,$3),($1,$4),($2,$4)',[admin.id,user.id,album,source]);
      await query("INSERT INTO user_ratings(user_id,entity_type,entity_id,rating) VALUES($1,'album',$3,5),($1,'album',$4,2),($2,'album',$4,4)",[admin.id,user.id,album,source]);
      await query("INSERT INTO album_credits(album_id,artist_id,role,credited_as) VALUES($1,$2,'composer','Other')",[source,otherArtist]);
      await query(`CREATE FUNCTION reject_album_merge() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'test delete failure'; END $$`);
      await query(`CREATE TRIGGER reject_album_merge BEFORE DELETE ON albums FOR EACH ROW WHEN (OLD.id=${source}) EXECUTE FUNCTION reject_album_merge()`);
      const client=await pool.connect();
      try {
        await assert.rejects(refreshAlbumsMetadata(client,new Set([source])),/test delete failure/);
        assert.equal((await query('SELECT album_id FROM tracks WHERE id=$1',[track])).rows[0].album_id,source);
        assert.equal((await query('SELECT * FROM user_starred_albums WHERE album_id=$1',[source])).rowCount,2);
        await query('DROP TRIGGER reject_album_merge ON albums');
        await refreshAlbumsMetadata(client,new Set([source]));
      } finally {client.release();}
      assert.equal((await query('SELECT album_id FROM tracks WHERE id=$1',[track])).rows[0].album_id,album);
      assert.equal((await query('SELECT * FROM albums WHERE id=$1',[source])).rowCount,0);
      assert.equal((await query('SELECT * FROM user_starred_albums WHERE album_id=$1',[album])).rowCount,2);
      assert.deepEqual((await query("SELECT user_id,rating FROM user_ratings WHERE entity_type='album' AND entity_id=$1 ORDER BY user_id",[album])).rows,[{user_id:admin.id,rating:5},{user_id:user.id,rating:4}]);
      assert.equal((await query("SELECT * FROM album_credits WHERE album_id=$1 AND role='composer'",[album])).rowCount,1);
      assert.equal((await query("SELECT * FROM user_ratings WHERE entity_type='album' AND entity_id=$1",[source])).rowCount,0);
    });

    await t.test('folder artwork rejects outside symlinks, falls back, and cached/embedded artwork still works', async () => {
      const dir=path.join(process.env.MUSIC_DIR,'artwork');await fs.mkdir(dir);
      const outside=path.join(tmp,'secret.txt');await fs.writeFile(outside,'private test data');
      const cover=path.join(dir,'cover.jpg');await fs.symlink(outside,cover);
      const dirId='dir:'+Buffer.from('artwork').toString('base64url');
      const get=()=>app.inject('/rest/getCoverArt?'+new URLSearchParams({u:admin.username,p:password,id:dirId}));
      assert.equal((await get()).statusCode,404);
      const good=Buffer.from('safe folder artwork');
      await fs.writeFile(path.join(dir,'folder.png'),good);
      assert.deepEqual((await get()).rawPayload,good);
      await fs.unlink(path.join(dir,'folder.png'));
      await fs.unlink(cover);
      await fs.writeFile(path.join(dir,'real.jpg'),good);await fs.symlink(path.join(dir,'real.jpg'),cover);
      assert.deepEqual((await get()).rawPayload,good);
      await fs.unlink(cover);await fs.symlink(outside,cover);
      const song=path.join(dir,'embedded.flac');
      await fs.copyFile(new URL('./fixtures/tags/sample.flac',import.meta.url),song);
      const artAlbum=(await query("INSERT INTO albums(title,artist_id,folder_path) VALUES('Artwork',$1,$2) RETURNING id",[artist,dir])).rows[0].id;
      await query("INSERT INTO tracks(file_path,file_name,album_id) VALUES($1,'embedded.flac',$2)",[song,artAlbum]);
      await extractCoversForAlbum(artAlbum);
      const {parseFile}=await import('music-metadata');const meta=await parseFile(song);
      assert.deepEqual((await get()).rawPayload,Buffer.from(meta.common.picture[0].data));
      const cached=await app.inject('/api/cover/album/'+artAlbum);
      assert.deepEqual(cached.rawPayload,Buffer.from(meta.common.picture[0].data));
      const unsafeCache=path.join(process.env.COVERS_DIR,'unsafe.jpg');await fs.symlink(outside,unsafeCache);
      assert.equal((await app.inject('/api/cover/unsafe.jpg')).statusCode,404);
    });
  } finally {
    await app.close();await pool.end();await db.close();await fs.rm(tmp,{recursive:true,force:true});
  }
});
