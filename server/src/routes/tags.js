import path from 'path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { parseFile } from 'music-metadata';
import { query, getClient } from '../db.js';
import { requireAuth, requireAdmin } from '../auth.js';
import { extractLeadingArtist, computeFileHashes } from '../scanner.js';
import { EDITABLE_TAG_FORMATS, writeAudioTags } from '../tag-writer.js';

const TAG_EXTS = ['.mp3', '.flac', '.ogg', '.opus', '.m4a', '.aac', '.wma', '.wav'];

async function ensureArtist(client, name) {
  if (!name || name.trim() === '') return null;
  name = (extractLeadingArtist(name) || name).trim();
  const { rows } = await client.query(
    `INSERT INTO artists (name) VALUES ($1) ON CONFLICT (LOWER(name)) DO UPDATE SET name = artists.name RETURNING id`,
    [name]
  );
  return rows[0].id;
}

async function ensureAlbum(client, title, artistId, year, genre) {
  if (!title || title.trim() === '') return null;
  title = title.trim();
  const conflict = artistId == null ? '(LOWER(title)) WHERE artist_id IS NULL' : '(LOWER(title), artist_id)';
  const { rows } = await client.query(
    `INSERT INTO albums (title, artist_id, year, genre)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT ${conflict} DO UPDATE SET year = COALESCE(EXCLUDED.year, albums.year), genre = COALESCE(EXCLUDED.genre, albums.genre)
     RETURNING id`,
    [title, artistId, year || null, genre || null]
  );
  return rows[0].id;
}

async function readTags(filePath) {
  const metadata = await parseFile(filePath, { skipCovers: true });
  const c = metadata.common || {};
  return {
    title: c.title || '',
    artist: c.artist || '',
    album: c.album || '',
    track: c.track?.no || '',
    year: c.year || '',
    genre: c.genre?.[0] || '',
  };
}

export default async function tagRoutes(fastify) {
  fastify.put('/api/tags/:id', { preHandler: requireAdmin }, async (req, reply) => {
    if (process.env.TAG_EDITING_ENABLED !== 'true') {
      return reply.status(403).send({ error: 'Tag editing is disabled for this library' });
    }
    const updates = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? { ...req.body } : req.body;
    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
      return reply.status(400).send({ error: 'Tag updates must be an object' });
    }
    for (const field of ['year', 'trackNumber']) {
      if (updates[field] === '') updates[field] = null;
      else if (typeof updates[field] === 'string' && /^\d{1,4}$/.test(updates[field])) updates[field] = Number(updates[field]);
    }
    const textFields = ['title', 'artist', 'album', 'genre'];
    const numericFields = ['year', 'trackNumber'];
    if (Object.keys(updates).some(k => ![...textFields, ...numericFields].includes(k)) ||
        textFields.some(k => updates[k] !== undefined && (typeof updates[k] !== 'string' || updates[k].length > 1000)) ||
        numericFields.some(k => updates[k] !== undefined && updates[k] !== null &&
          (!Number.isInteger(updates[k]) || updates[k] < 0 || updates[k] > 9999))) {
      return reply.status(400).send({ error: 'Invalid tag fields' });
    }
    if (!Object.keys(updates).length) return { success: true };
    const client = await getClient();
    let staged, backup, filePath, replaced = false, committed = false;
    try {
      await client.query('BEGIN');
      const { rows } = await client.query('SELECT file_path, artist_id, album_id FROM tracks WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!rows.length) throw Object.assign(new Error('Track not found'), { statusCode: 404 });
      filePath = await fs.realpath(rows[0].file_path);
      const root = await fs.realpath(process.env.MUSIC_DIR);
      const rel = path.relative(root, filePath);
      if (rel.startsWith('..') || path.isAbsolute(rel)) throw Object.assign(new Error('File outside music library'), { statusCode: 403 });
      const format = path.extname(filePath).slice(1).toLowerCase();
      if (!EDITABLE_TAG_FORMATS.includes(format)) {
        throw Object.assign(new Error('Tag editing is supported for MP3, FLAC, Ogg, Opus and M4A files'), { statusCode: 400 });
      }
      const suffix = crypto.randomUUID();
      staged = `${filePath}.${suffix}.tmp`;
      backup = `${filePath}.${suffix}.bak`;
      // Stage writes on the same filesystem; a failed write never touches the original.
      await fs.copyFile(filePath, staged);
      writeAudioTags(staged, format, updates);

      let artistId = rows[0].artist_id;
      if (updates.artist !== undefined) artistId = await ensureArtist(client, updates.artist);
      const fields = [], params = [];
      const add = (name, value) => { params.push(value); fields.push(`${name} = $${params.length}`); };
      if (updates.title !== undefined) add('title', updates.title || path.basename(filePath, path.extname(filePath)));
      if (updates.genre !== undefined) add('genre', updates.genre || null);
      if (updates.year !== undefined) add('year', updates.year || null);
      if (updates.trackNumber !== undefined) add('track_number', updates.trackNumber || null);
      if (updates.artist !== undefined) {
        add('artist_id', artistId);
        add('track_artist_credit', updates.artist.trim() || null);
      }
      if (updates.album !== undefined) {
        const albumId = await ensureAlbum(client, updates.album, artistId, updates.year, updates.genre);
        add('album_id', albumId);
      }
      const { mtime, size } = await fs.stat(staged);
      const { contentHash, audioHash } = await computeFileHashes(staged);
      add('mtime', mtime);
      add('file_size', size);
      add('content_hash', contentHash);
      add('audio_hash', audioHash);
      params.push(req.params.id);
      await client.query(`UPDATE tracks SET ${fields.join(', ')}, updated_at = NOW() WHERE id = $${params.length}`, params);
      await fs.copyFile(filePath, backup);
      await fs.rename(staged, filePath);
      replaced = true;
      const finalStat = await fs.stat(filePath);
      await client.query(
        `UPDATE tracks
         SET dev = $1,
             ino = $2,
             birthtime_ms = $3,
             mtime = $4
         WHERE id = $5`,
        [
          Number.isSafeInteger(finalStat.dev) ? String(Math.trunc(finalStat.dev)) : null,
          Number.isSafeInteger(finalStat.ino) ? String(Math.trunc(finalStat.ino)) : null,
          Number.isFinite(finalStat.birthtimeMs) && finalStat.birthtimeMs > 0 ? String(Math.round(finalStat.birthtimeMs)) : null,
          finalStat.mtime,
          req.params.id,
        ]
      );
      await client.query('COMMIT');
      committed = true;
      return { success: true };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (replaced) {
        // Compensate filesystem changes when the database transaction fails.
        await fs.rename(backup, filePath);
        replaced = false;
      }
      req.log.error({ code: err.code }, 'Tag update failed');
      const status = err.statusCode || (err.code === 'ENOENT' ? 404 : ['EROFS', 'EACCES', 'EPERM'].includes(err.code) ? 403 : 500);
      return reply.status(status).send({ error: status === 403 ? 'Music library is read-only or tag editing is not permitted' :
        status === 404 ? 'Audio file not found' : err.statusCode ? err.message : 'Failed to update tags; no changes saved' });
    } finally {
      client.release();
      // Keep the backup if recovery itself failed.
      if (staged) await fs.unlink(staged).catch(() => {});
      if (backup && !replaced) await fs.unlink(backup).catch(() => {});
      if (backup && committed) await fs.unlink(backup).catch(() => {});
    }
  });

  fastify.get('/api/tags/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params;
    const { rows } = await query('SELECT file_path FROM tracks WHERE id = $1', [id]);

    if (rows.length === 0) {
      return reply.status(404).send({ error: 'Track not found' });
    }

    const filePath = rows[0].file_path;
    const ext = path.extname(filePath).toLowerCase();

    if (!TAG_EXTS.includes(ext)) {
      return reply.status(400).send({ error: `Tag reading not supported for ${ext} files` });
    }

    try {
      const physical = await fs.realpath(filePath);
      const root = await fs.realpath(process.env.MUSIC_DIR);
      const rel = path.relative(root, physical);
      if (rel.startsWith('..') || path.isAbsolute(rel)) return reply.status(403).send({ error: 'File outside music library' });
      const tags = await readTags(physical);
      return tags;
    } catch (err) {
      return reply.status(err.code === 'ENOENT' ? 404 : 500).send({ error: err.code === 'ENOENT' ? 'Audio file not found' : 'Failed to read tags' });
    }
  });
}
