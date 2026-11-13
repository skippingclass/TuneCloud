import { scanDirectory, scanSingleFile } from '../scanner.js';
import { extractAllMissingCovers } from '../cover.js';
import { requireAdmin, requireAuth } from '../auth.js';
import { recordScan } from '../metrics.js';
import { query } from '../db.js';
import { isWithinRoot } from '../paths.js';
import {
  isFullJobActive,
  tryStartFullJob,
  endFullJob,
  withLibraryAdvisoryLock,
  withTrackLock,
} from '../library-lock.js';
import fs from 'fs';

// Single-process guard (server runs with replicas: 1) plus PG advisory lock for DB safety.
let lastResult = null;
let lastScanAt = null;
const INITIAL_PROGRESS = {
  phase: 'idle', // 'idle' | 'listing' | 'processing' | 'cleaning' | 'covers' | 'complete' | 'error'
  total: 0,
  processed: 0,
  toProcess: 0,
  unchanged: 0,
  removed: 0,
  coversExtracted: 0,
  coversTotal: 0,
  durationSeconds: 0,
  error: null,
  full: false,
  startedAt: null,
};
let scanProgress = { ...INITIAL_PROGRESS };

function createListingProgress(full) {
  return {
    ...INITIAL_PROGRESS,
    phase: 'listing',
    full,
    startedAt: new Date().toISOString(),
  };
}

async function isReadableDirectory(dirPath) {
  if (!dirPath) return false;
  try {
    return (await fs.promises.stat(dirPath)).isDirectory();
  } catch {
    return false;
  }
}

async function executeScan({ musicDir, full, reextractCovers }) {
  const start = Date.now();
  const result = await withLibraryAdvisoryLock(() =>
    scanDirectory(musicDir, {
      full,
      reextractCovers,
      onProgress: (p) => {
        scanProgress = { ...scanProgress, ...p };
      },
    })
  );
  const durationSeconds = Math.round((Date.now() - start) / 1000);
  recordScan(result, durationSeconds);
  lastResult = result;
  lastScanAt = new Date().toISOString();
  scanProgress = {
    ...scanProgress,
    phase: 'complete',
    ...result,
    durationSeconds,
    error: null,
  };
  return result;
}

export function getScanState() {
  return { isScanning: isFullJobActive(), lastResult, lastScanAt, progress: scanProgress };
}

export function startScanInBackground({ full = false, reextractCovers = false } = {}) {
  const musicDir = process.env.MUSIC_DIR;
  if (!musicDir || !tryStartFullJob('scan')) return false;

  scanProgress = createListingProgress(full);
  const covers = reextractCovers || full;

  (async () => {
    try {
      if (!(await isReadableDirectory(musicDir))) {
        throw new Error(`Music directory not found: ${musicDir}`);
      }
      await executeScan({ musicDir, full, reextractCovers: covers });
    } catch (err) {
      console.error('[Scanner] Scan failed:', err);
      scanProgress = { ...scanProgress, phase: 'error', error: err.message };
    } finally {
      endFullJob('scan');
    }
  })();
  return true;
}

export default async function scanRoutes(fastify) {
  fastify.post('/api/scan', { preHandler: requireAdmin }, async (req, reply) => {
    const musicDir = process.env.MUSIC_DIR;

    if (!(await isReadableDirectory(musicDir))) {
      return reply.status(400).send({ error: `Music directory not found: ${musicDir}` });
    }
    if (isFullJobActive()) {
      return reply.status(409).send({
        error: 'Scan already in progress',
        isScanning: true,
        progress: scanProgress,
      });
    }

    const full = req.body?.full === true || req.query?.full === '1' || req.query?.full === 'true';
    const reextractCovers =
      req.body?.reextractCovers === true ||
      req.query?.reextractCovers === '1' ||
      req.query?.reextractCovers === 'true' ||
      (full && req.body?.reextractCovers !== false);

    // If synchronous mode is explicitly requested (e.g. CLI script or testing)
    if (req.query?.sync === 'true') {
      if (!tryStartFullJob('scan')) {
        return reply.status(409).send({
          error: 'Scan already in progress',
          isScanning: true,
          progress: scanProgress,
        });
      }
      scanProgress = createListingProgress(full);
      try {
        const result = await executeScan({ musicDir, full, reextractCovers });
        return { message: 'Scan completed', result };
      } catch (err) {
        req.log.error(err);
        scanProgress = { ...scanProgress, phase: 'error', error: err.message };
        return reply.status(err.statusCode === 409 ? 409 : 500).send({ error: err.message });
      } finally {
        endFullJob('scan');
      }
    }

    // Default: non-blocking asynchronous scan to prevent proxy & client timeouts
    const started = startScanInBackground({ full, reextractCovers });
    if (!started) {
      return reply.status(409).send({ error: 'Could not start scan: already in progress' });
    }

    return reply.status(202).send({
      message: 'Scan started in background',
      isScanning: true,
      full,
      reextractCovers,
    });
  });

  fastify.post('/api/scan/covers', { preHandler: requireAdmin }, async (req, reply) => {
    if (!tryStartFullJob('covers')) {
      return reply.status(409).send({ error: 'Scan already in progress' });
    }

    const rawAlbumId = req.body?.albumId ?? req.query?.albumId;
    const rawAlbumIds = req.body?.albumIds ?? req.query?.albumIds;
    let albumIds = null;
    if (rawAlbumIds) {
      albumIds = Array.isArray(rawAlbumIds)
        ? rawAlbumIds.map(Number).filter(Number.isFinite)
        : String(rawAlbumIds).split(',').map((s) => Number(s.trim())).filter(Number.isFinite);
    } else if (rawAlbumId != null) {
      const parsed = Number(rawAlbumId);
      if (Number.isFinite(parsed)) albumIds = [parsed];
    }

    const force = req.body?.force !== false && req.query?.force !== 'false';
    try {
      const start = Date.now();
      const result = await withLibraryAdvisoryLock(() => extractAllMissingCovers({ albumIds, force }));
      const durationSeconds = Math.round((Date.now() - start) / 1000);
      return { message: 'Cover extraction completed', result, durationSeconds };
    } catch (err) {
      req.log.error(err);
      return reply.status(err.statusCode === 409 ? 409 : 500).send({ error: err.message });
    } finally {
      endFullJob('covers');
    }
  });

  fastify.post('/api/scan/file', { preHandler: requireAdmin }, async (req, reply) => {
    const { filePath } = req.body || {};
    if (!filePath) {
      return reply.status(400).send({ error: 'filePath required' });
    }

    if (typeof filePath !== 'string' || !process.env.MUSIC_DIR) return reply.status(400).send({ error: 'Invalid music path' });
    let resolvedPath, musicDir;
    try {
      resolvedPath = await fs.promises.realpath(filePath);
      musicDir = await fs.promises.realpath(process.env.MUSIC_DIR);
    } catch { return reply.status(404).send({ error: 'File not found' }); }

    if (!isWithinRoot(musicDir, resolvedPath)) {
      return reply.status(403).send({ error: 'File must be within music directory' });
    }
    try {
      const st = await fs.promises.stat(resolvedPath);
      if (!st.isFile()) return reply.status(404).send({ error: 'File not found' });
    } catch {
      return reply.status(404).send({ error: 'File not found' });
    }

    try {
      const success = await withTrackLock(`path:${resolvedPath}`, () => scanSingleFile(resolvedPath));
      return { success };
    } catch (err) {
      if (err.statusCode === 409) {
        return reply.status(409).send({ error: err.message });
      }
      throw err;
    }
  });

  // Cheap: no filesystem walk. File totals come from the last completed scan.
  fastify.get('/api/scan/status', { preHandler: requireAuth }, async () => {
    const { rows } = await query('SELECT COUNT(*)::int AS count FROM tracks WHERE missing_since IS NULL');
    const indexed = rows[0].count;
    const totalFiles = lastResult ? lastResult.total : null;

    return {
      isScanning,
      lastScanAt,
      lastResult,
      progress: scanProgress,
      totalFiles,
      indexedTracks: indexed,
      remaining: totalFiles == null ? null : Math.max(totalFiles - indexed, 0),
    };
  });
}
