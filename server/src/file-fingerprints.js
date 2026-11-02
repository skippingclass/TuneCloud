import fs from 'node:fs/promises';
import crypto from 'node:crypto';

const empty = () => ({ contentHash: null, audioHash: null, audioPayloadSize: 0 });

// Hash actual bytes, not an embedded checksum or tag similarity. Keep memory
// bounded even when multiple multi-gigabyte lossless files are scanned together.
export async function computeFileHashes(filePath) {
  let file;
  try {
    file = await fs.open(filePath, 'r');
    const before = await file.stat({ bigint: true });
    const size = Number(before.size);
    if (!before.isFile() || !Number.isSafeInteger(size) || size <= 0) return empty();
    const read = async (position, length) => {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await file.read(buffer, 0, length, position);
      if (bytesRead !== length) throw new Error('File changed while fingerprinting');
      return buffer;
    };
    let start = 0;
    let end = size;
    let hasId3 = false;
    // ID3v2 uses syncsafe sizes; offsets are validated before every read.
    for (let i = 0; i < 32 && start + 10 <= end; i++) {
      const header = await read(start, 10);
      if (header.toString('ascii', 0, 3) !== 'ID3' || header[3] < 2 || header[3] > 4 || header.subarray(6, 10).some(value => value >= 128)) break;
      const length = (header[6] << 21) | (header[7] << 14) | (header[8] << 7) | header[9];
      const next = start + 10 + length + (header[3] === 4 && (header[5] & 16) ? 10 : 0);
      if (next > end || next <= start) break;
      start = next;
      hasId3 = true;
    }
    // FLAC metadata (including changed titles/artwork) precedes the frame bytes.
    // A STREAMINFO block and a valid last-block marker are required before
    // treating any prefix as metadata; malformed files fall back to whole bytes.
    let flac = false;
    if (start + 8 <= end && (await read(start, 4)).toString('ascii') === 'fLaC') {
      const originalStart = start;
      let cursor = start + 4;
      for (let block = 0; block < 1024 && cursor + 4 <= end; block++) {
        const header = await read(cursor, 4);
        const type = header[0] & 127;
        const length = header.readUIntBE(1, 3);
        if (type === 127 || (block === 0 && (type !== 0 || length !== 34)) || cursor + 4 + length > end) break;
        cursor += 4 + length;
        if (header[0] & 128) { start = cursor; flac = true; break; }
      }
      if (!flac) start = originalStart;
    }
    if (!flac && end - start >= 128) {
      const head = end - start >= 2 ? await read(start, 2) : Buffer.alloc(0);
      const mp3 = head.length === 2 && head[0] === 255 && (head[1] & 224) === 224 && (head[1] & 6) !== 0;
      if ((hasId3 || mp3) && (await read(end - 128, 3)).toString('ascii') === 'TAG') end -= 128;
    }
    const content = crypto.createHash('sha256');
    const audio = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(256 * 1024);
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
      if (!bytesRead) throw new Error('File changed while fingerprinting');
      content.update(buffer.subarray(0, bytesRead));
      const from = Math.max(start, offset);
      const to = Math.min(end, offset + bytesRead);
      if (to > from) audio.update(buffer.subarray(from - offset, to - offset));
      offset += bytesRead;
    }
    const after = await file.stat({ bigint: true });
    const current = await fs.stat(filePath, { bigint: true });
    if (before.dev !== current.dev || before.ino !== current.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || before.mtimeNs !== current.mtimeNs || before.ctimeNs !== current.ctimeNs) return empty();
    const contentHash = content.digest('hex');
    const audioPayloadSize = Math.max(0, end - start);
    return { contentHash, audioHash: audioPayloadSize ? audio.digest('hex') : contentHash, audioPayloadSize };
  } catch {
    return empty();
  } finally {
    await file?.close().catch(() => {});
  }
}
