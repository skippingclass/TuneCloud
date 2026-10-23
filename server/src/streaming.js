import fs from 'fs';
import path from 'node:path';
import { streamOpened, streamClosed } from './metrics.js';

export const MIME_TYPES = {
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wma: 'audio/x-ms-wma',
  opus: 'audio/ogg',
};

export function contentTypeFor(format) {
  const f = (format || 'mp3').toLowerCase();
  return MIME_TYPES[f] || 'audio/mpeg';
}

export function pipeWithTracking(fileStream, res) {
  streamOpened();
  let bytes = 0;
  let done = false;
  fileStream.on('data', (chunk) => {
    bytes += chunk.length;
  });
  const finish = () => {
    if (done) return;
    done = true;
    streamClosed(bytes);
    if (!fileStream.destroyed) {
      fileStream.destroy();
    }
  };
  res.on('finish', finish);
  res.on('close', finish);
  fileStream.on('error', () => {
    finish();
    if (!res.writableEnded) {
      res.end();
    }
  });
  fileStream.pipe(res);
}

/**
 * Parses a Range header against a file size.
 * Returns null when no (usable) range was requested, { start, end } for a valid
 * range, or { invalid: true } when the range cannot be satisfied.
 * Only the first range of a multi-range request is honoured.
 */
export function parseRange(header, size) {
  if (!header || !header.startsWith('bytes=')) return null;
  const first = header.slice(6).split(',')[0].trim();
  const m = first.match(/^(\d*)-(\d*)$/);
  if (!m || (m[1] === '' && m[2] === '')) return null;

  let start;
  let end;
  if (m[1] === '') {
    const suffix = parseInt(m[2], 10);
    if (suffix === 0) return { invalid: true };
    start = Math.max(size - suffix, 0);
    end = size - 1;
  } else {
    start = parseInt(m[1], 10);
    end = m[2] === '' ? size - 1 : Math.min(parseInt(m[2], 10), size - 1);
  }
  if (start >= size || start > end) return { invalid: true };
  return { start, end };
}

/**
 * Streams an audio file with HTTP Range support. Assumes the file exists.
 */
export async function sendAudioFile(req, reply, filePath, format) {
  let stat;
  try {
    const physical = await fs.promises.realpath(filePath);
    const root = await fs.promises.realpath(process.env.MUSIC_DIR);
    const rel = path.relative(root, physical);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return reply.status(403).send({ error: 'File outside music library' });
    stat = await fs.promises.stat(physical);
    if (!stat.isFile()) return reply.status(404).send({ error: 'Audio file not found' });
    filePath = physical;
  } catch { return reply.status(404).send({ error: 'Audio file not found' }); }
  const fileSize = stat.size;
  const contentType = contentTypeFor(format);
  const range = parseRange(req.headers.range, fileSize);

  reply.hijack();

  if (range?.invalid) {
    reply.raw.writeHead(416, { 'Content-Range': `bytes */${fileSize}`, 'Accept-Ranges': 'bytes' });
    reply.raw.end();
    return;
  }

  if (range) {
    const { start, end } = range;
    reply.raw.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': contentType,
      'Cache-Control': 'private, no-store',
    });
    pipeWithTracking(fs.createReadStream(filePath, { start, end }), reply.raw);
    return;
  }

  reply.raw.writeHead(200, {
    'Content-Length': fileSize,
    'Content-Type': contentType,
    'Cache-Control': 'private, no-store',
    'Accept-Ranges': 'bytes',
  });
  pipeWithTracking(fs.createReadStream(filePath), reply.raw);
}
