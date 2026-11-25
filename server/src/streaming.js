import fs from 'fs';
import { Transform } from 'node:stream';
import { isWithinRoot } from './paths.js';
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

const FLAC_MAGIC = Buffer.from('fLaC', 'ascii');
const FLAC_BLOCK_PICTURE = 6;
const FLAC_BLOCK_PADDING = 1;
const MAX_FLAC_METADATA_BLOCKS = 128;

export function contentTypeFor(format) {
  const f = (format || 'mp3').toLowerCase();
  return MIME_TYPES[f] || 'audio/mpeg';
}

/**
 * Finds byte offsets of FLAC METADATA_BLOCK_PICTURE headers whose MIME length is 0.
 * Chromium/Electron/FFmpeg demuxers reject FLAC streams with empty PICTURE MIME types;
 * rewriting the block type byte (6 -> 1 PADDING, preserving the is-last bit) on the fly
 * keeps file size, Content-Length, and Range byte offsets identical to disk.
 */
export async function findEmptyMimeFlacPictureOffsets(filePath, fileSize) {
  if (fileSize < 12) return [];
  let handle;
  try {
    handle = await fs.promises.open(filePath, 'r');
    const magic = Buffer.allocUnsafe(4);
    const { bytesRead: mRead } = await handle.read(magic, 0, 4, 0);
    if (mRead !== 4 || !magic.equals(FLAC_MAGIC)) return [];

    const offsets = [];
    const header = Buffer.allocUnsafe(4);
    const picHeader = Buffer.allocUnsafe(8);
    let cursor = 4;

    for (let i = 0; i < MAX_FLAC_METADATA_BLOCKS && cursor + 4 <= fileSize; i++) {
      const { bytesRead: hRead } = await handle.read(header, 0, 4, cursor);
      if (hRead !== 4) break;

      const isLast = (header[0] & 0x80) !== 0;
      const blockType = header[0] & 0x7f;
      const blockLen = (header[1] << 16) | (header[2] << 8) | header[3];
      if (blockType === 127 || (i === 0 && (blockType !== 0 || blockLen !== 34)) || cursor + 4 + blockLen > fileSize) {
        break;
      }

      if (blockType === FLAC_BLOCK_PICTURE && blockLen >= 8) {
        const { bytesRead: pRead } = await handle.read(picHeader, 0, 8, cursor + 4);
        if (pRead === 8 && picHeader.readUInt32BE(4) === 0) {
          offsets.push(cursor);
        }
      }

      cursor += 4 + blockLen;
      if (isLast) break;
    }
    return offsets;
  } catch {
    return [];
  } finally {
    await handle?.close().catch(() => {});
  }
}

function createAudioReadStream(filePath, { start, end }, patchOffsets) {
  const streamOpts = start !== undefined ? { start, end } : undefined;
  const fileStream = fs.createReadStream(filePath, streamOpts);
  const streamStart = start ?? 0;
  const streamEnd = end ?? Infinity;
  const relevant = patchOffsets.filter(off => off >= streamStart && off <= streamEnd);
  if (relevant.length === 0) return fileStream;

  let pos = streamStart;
  const patcher = new Transform({
    transform(chunk, _encoding, callback) {
      const chunkStart = pos;
      const chunkEnd = pos + chunk.length;
      pos = chunkEnd;
      let out = chunk;
      for (const off of relevant) {
        if (off >= chunkStart && off < chunkEnd) {
          if (out === chunk) out = Buffer.from(chunk);
          const idx = off - chunkStart;
          out[idx] = (out[idx] & 0x80) | FLAC_BLOCK_PADDING;
        }
      }
      callback(null, out);
    },
  });

  fileStream.on('error', err => patcher.destroy(err));
  patcher.on('close', () => {
    if (!fileStream.destroyed) fileStream.destroy();
  });
  return fileStream.pipe(patcher);
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
  res.on('error', finish);
  fileStream.on('error', () => {
    finish();
    if (!res.destroyed) {
      res.destroy();
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
    if (!isWithinRoot(root, physical)) return reply.status(403).send({ error: 'File outside music library' });
    stat = await fs.promises.stat(physical);
    if (!stat.isFile()) return reply.status(404).send({ error: 'Audio file not found' });
    filePath = physical;
  } catch { return reply.status(404).send({ error: 'Audio file not found' }); }
  const fileSize = stat.size;
  const contentType = contentTypeFor(format);
  const range = parseRange(req.headers.range, fileSize);
  const isHead = req.method === 'HEAD';

  const patchOffsets = !isHead && (format || '').toLowerCase() === 'flac' && (!range || !range.invalid)
    ? await findEmptyMimeFlacPictureOffsets(filePath, fileSize)
    : [];

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
    if (isHead) {
      reply.raw.end();
      return;
    }
    pipeWithTracking(createAudioReadStream(filePath, { start, end }, patchOffsets), reply.raw);
    return;
  }

  reply.raw.writeHead(200, {
    'Content-Length': fileSize,
    'Content-Type': contentType,
    'Cache-Control': 'private, no-store',
    'Accept-Ranges': 'bytes',
  });
  if (isHead) {
    reply.raw.end();
    return;
  }
  pipeWithTracking(createAudioReadStream(filePath, {}, patchOffsets), reply.raw);
}
