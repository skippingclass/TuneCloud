import { query } from '../db.js';
import { requireAuth } from '../auth.js';
import fs from 'fs';
import path from 'path';

export default async function browseRoutes(fastify) {
  fastify.get('/api/browse/dirs', { preHandler: requireAuth }, async (req, reply) => {
    const { dir } = req.query;
    const musicDir = process.env.MUSIC_DIR;

    if (!musicDir) {
      return reply.status(500).send({ error: 'MUSIC_DIR is not configured' });
    }

    const resolvedMusicDir = path.resolve(musicDir);
    let targetDir = resolvedMusicDir;

    if (dir) {
      targetDir = path.resolve(resolvedMusicDir, dir);
      const rel = path.relative(resolvedMusicDir, targetDir);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        return reply.status(403).send({ error: 'Access denied' });
      }
    }

    // Resolve symlinks too; a lexical path check alone cannot contain the walk.
    try {
      const root = await fs.promises.realpath(resolvedMusicDir);
      const physical = await fs.promises.realpath(targetDir);
      const rel = path.relative(root, physical);
      if (rel.startsWith('..') || path.isAbsolute(rel)) return reply.status(403).send({ error: 'Access denied' });
    } catch { return reply.status(404).send({ error: 'Directory not found' }); }

    let entries;
    try {
      entries = await fs.promises.readdir(targetDir, { withFileTypes: true });
    } catch {
      return reply.status(404).send({ error: 'Directory not found' });
    }
    const audioExts = new Set(['.mp3', '.flac', '.ogg', '.wav', '.m4a', '.aac', '.wma', '.opus']);
    const audioPaths = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (audioExts.has(ext)) {
          audioPaths.push(path.join(targetDir, entry.name));
        }
      }
    }

    const trackMap = new Map();
    if (audioPaths.length > 0) {
      const { rows } = await query(
        `SELECT t.id, t.title, t.duration, t.file_size, t.format, t.track_number,
                t.file_path,
                (t.missing_since IS NULL) AS available,
                COALESCE(t.track_artist_credit, a.name) as artist,
                al.title as album, al.id as album_id,
                COALESCE(t.cover_path, al.cover_path) as cover_path
         FROM tracks t
         LEFT JOIN artists a ON t.artist_id = a.id
         LEFT JOIN albums al ON t.album_id = al.id
         WHERE t.file_path = ANY($1::text[])`,
        [audioPaths]
      );
      for (const r of rows) {
        trackMap.set(r.file_path, r);
      }
    }

    const result = [];

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(targetDir, entry.name);
      const relativePath = path.relative(musicDir, fullPath);

      if (entry.isDirectory()) {
        result.push({
          name: entry.name,
          path: relativePath,
          type: 'dir',
        });
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (audioExts.has(ext)) {
          const trackRow = trackMap.get(fullPath);
          let meta = null;
          if (trackRow) {
            const { file_path, ...metaFields } = trackRow;
            meta = metaFields;
          }
          result.push({
            name: entry.name,
            path: relativePath,
            type: 'file',
            meta,
          });
        }
      }
    }

    return result;
  });

  fastify.get('/api/browse/tree', { preHandler: requireAuth }, async (req, reply) => {
    const musicDir = process.env.MUSIC_DIR;
    const { rows } = await query(
      `SELECT t.id, t.file_path, t.file_name, t.duration, t.title, t.track_number,
              a.name as artist, al.title as album, al.id as album_id
       FROM tracks t
       LEFT JOIN artists a ON t.artist_id = a.id
       LEFT JOIN albums al ON t.album_id = al.id
       ORDER BY al.title, t.disc_number, COALESCE(t.track_number, 999), t.file_name`
    );

    const albums = Object.create(null);
    for (const track of rows) {
      const albumKey = String(track.album_id ?? 'unknown');
      if (!albums[albumKey]) {
        albums[albumKey] = {
          title: track.album || 'Unknown',
          artist: track.artist,
          tracks: [],
        };
      }
      albums[albumKey].tracks.push({
        id: track.id,
        title: track.title || track.file_name,
        fileName: track.file_name,
        filePath: track.file_path,
        duration: track.duration,
        trackNumber: track.track_number,
        artist: track.artist,
      });
    }

    return Object.values(albums);
  });
}
