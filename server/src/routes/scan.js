import { scanDirectory, scanSingleFile } from '../scanner.js';
import { requireAdmin } from '../auth.js';
import { recordScan } from '../metrics.js';
import { query } from '../db.js';
import fs from 'fs';
import path from 'path';

// Single-process guard (server runs with replicas: 1).
let isScanning = false;
let lastResult = null;
let lastScanAt = null;

export default async function scanRoutes(fastify) {
  fastify.post('/api/scan', { preHandler: requireAdmin }, async (req, reply) => {
    const musicDir = process.env.MUSIC_DIR;

    if (!musicDir || !fs.existsSync(musicDir)) {
      return reply.status(400).send({ error: `Music directory not found: ${musicDir}` });
    }
    if (isScanning) {
      return reply.status(409).send({ error: 'Scan already in progress' });
    }

    const full = req.body?.full === true || req.query?.full === '1' || req.query?.full === 'true';
    isScanning = true;
    try {
      const start = Date.now();
      const result = await scanDirectory(musicDir, { full });
      recordScan(result, Math.round((Date.now() - start) / 1000));
      lastResult = result;
      lastScanAt = new Date().toISOString();
      return { message: 'Scan completed', result };
    } catch (err) {
      req.log.error(err);
      return reply.status(500).send({ error: err.message });
    } finally {
      isScanning = false;
    }
  });

  fastify.post('/api/scan/file', { preHandler: requireAdmin }, async (req, reply) => {
    const { filePath } = req.body || {};
    if (!filePath) {
      return reply.status(400).send({ error: 'filePath required' });
    }

    const resolvedPath = path.resolve(filePath);
    const musicDir = path.resolve(process.env.MUSIC_DIR);

    if (resolvedPath !== musicDir && !resolvedPath.startsWith(musicDir + path.sep)) {
      return reply.status(403).send({ error: 'File must be within music directory' });
    }
    if (!fs.existsSync(resolvedPath)) {
      return reply.status(404).send({ error: 'File not found' });
    }

    const success = await scanSingleFile(resolvedPath);
    return { success };
  });

  // Cheap: no filesystem walk. File totals come from the last completed scan.
  fastify.get('/api/scan/status', async () => {
    const { rows } = await query('SELECT COUNT(*)::int AS count FROM tracks');
    const indexed = rows[0].count;
    const totalFiles = lastResult ? lastResult.total : null;

    return {
      isScanning,
      lastScanAt,
      lastResult,
      totalFiles,
      indexedTracks: indexed,
      remaining: totalFiles == null ? null : Math.max(totalFiles - indexed, 0),
    };
  });
}
