import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AUDIO_EXTENSIONS = new Set(['.mp3', '.flac', '.ogg', '.wav', '.m4a', '.aac', '.wma', '.opus']);
const DEFAULT_BINARIES = [
  '/app/bin/tunecloud-scanner',
  fileURLToPath(new URL('../native/scanner/target/release/tunecloud-scanner', import.meta.url)),
];
const UNAVAILABLE_CODES = new Set(['ENOENT', 'EACCES', 'ENOEXEC', 'ENOTDIR']);
const MAX_BATCH_PAYLOAD_BYTES = 48 * 1024;
const liveChildren = new Set();

// Idle workers do not keep Node alive. Kill them synchronously when Node exits;
// closing stdin also lets the worker exit when its parent terminates by signal.
process.once('exit', () => {
  for (const child of liveChildren) child.kill('SIGKILL');
});

function failure(message, code = 'SCANNER_FAILED', cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function positiveInteger(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > maximum) {
    throw new Error(`${name} must be an integer from 1 to ${maximum}`);
  }
  return Number(value);
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateHashObject(result) {
  if (!object(result)) throw new Error('result must be an object');
  const validHash = value => value === null || (typeof value === 'string' && /^[a-f0-9]{64}$/.test(value));
  if (!validHash(result.contentHash) || !validHash(result.audioHash) ||
      !Number.isSafeInteger(result.audioPayloadSize) || result.audioPayloadSize < 0 ||
      (result.contentHash === null ? result.audioHash !== null || result.audioPayloadSize !== 0 :
        result.audioHash === null || (result.audioPayloadSize === 0 && result.audioHash !== result.contentHash))) {
    throw new Error('invalid hash result');
  }
  return { contentHash: result.contentHash, audioHash: result.audioHash, audioPayloadSize: result.audioPayloadSize };
}

function validateResult(op, result, root, expectedBatchLength = 0) {
  if (!object(result)) throw new Error('result must be an object');
  if (op === 'hash') return validateHashObject(result);
  if (op === 'hash_batch') {
    if (!Array.isArray(result.items) || result.items.length !== expectedBatchLength) {
      throw new Error('invalid hash_batch result');
    }
    return result.items.map(validateHashObject);
  }
  if (!Array.isArray(result.files)) throw new Error('list result must contain files');
  const seen = new Set();
  return result.files.map(file => {
    if (!object(file) || typeof file.path !== 'string' || !path.isAbsolute(file.path) || file.path.includes('\0')) {
      throw new Error('invalid file path');
    }
    const relative = path.relative(root, file.path);
    const decimalOrNull = value => value === null || (typeof value === 'string' && /^\d+$/.test(value));
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ||
        !AUDIO_EXTENSIONS.has(path.extname(file.path).toLowerCase()) || seen.has(file.path) ||
        !Number.isSafeInteger(file.size) || file.size < 0 ||
        typeof file.mtimeMs !== 'number' || !Number.isFinite(file.mtimeMs) || Math.abs(file.mtimeMs) > 8.64e15 ||
        !decimalOrNull(file.dev) || !decimalOrNull(file.ino) ||
        !Number.isSafeInteger(file.nlink) || file.nlink < 0 ||
        !decimalOrNull(file.birthtimeMs) || (file.birthtimeMs !== null &&
          (!Number.isSafeInteger(Number(file.birthtimeMs)) || Number(file.birthtimeMs) <= 0))) {
      throw new Error('invalid file identity or file outside scan root');
    }
    seen.add(file.path);
    return {
      path: file.path, size: file.size, mtime: new Date(file.mtimeMs),
      dev: file.dev, ino: file.ino, nlink: file.nlink, birthtimeMs: file.birthtimeMs,
    };
  });
}

/** A bounded, lazy, long-lived protocol-1 worker. Null means JS was selected or unavailable at launch. */
export function createNativeScannerClient(options = {}) {
  return new NativeScannerClient(options);
}

class NativeScannerClient {
  constructor(options) {
    const env = options.env ?? process.env;
    this.engine = options.engine ?? env.SCANNER_ENGINE ?? 'auto';
    if (!['auto', 'rust', 'js'].includes(this.engine)) throw new Error('SCANNER_ENGINE must be auto, rust, or js');
    this.workers = positiveInteger(options.workers ?? env.RUST_SCANNER_WORKERS ?? 4, 'RUST_SCANNER_WORKERS', 32);
    this.timeoutMs = positiveInteger(options.timeoutMs ?? 300000, 'scanner timeoutMs');
    this.startupTimeoutMs = positiveInteger(options.startupTimeoutMs ?? 10000, 'scanner startupTimeoutMs');
    this.maxQueue = positiveInteger(options.maxQueue ?? 1024, 'scanner maxQueue');
    this.maxResponseBytes = positiveInteger(options.maxResponseBytes ?? 256 * 1024 * 1024, 'scanner maxResponseBytes');
    const binary = options.binaryPath ?? env.RUST_SCANNER_BIN;
    this.binaries = binary ? [path.resolve(binary)] : DEFAULT_BINARIES;
    this.state = this.engine === 'js' ? 'js' : 'new';
    this.pending = new Map();
    this.queue = [];
    this.nextId = 1;
    this.active = 0;
    this.frame = [];
    this.frameBytes = 0;
    this.stderr = '';
  }

  getInfo() {
    return { engine: this.engine, state: this.state, binaryPath: this.binaryPath ?? null, workers: this.workers, pending: this.pending.size };
  }

  computeFileHashes(filePath) { return this.request('hash', filePath); }
  listAudioFiles(root) { return this.request('list', root); }

  async computeFileHashesBatch(files) {
    if (!Array.isArray(files)) throw new Error('files must be an array');
    if (files.length === 0) return [];
    if (this.state === 'js' || this.state === 'unavailable') return null;

    const normalized = files.map(item => {
      const rawPath = typeof item === 'string' ? item : item?.path;
      if (typeof rawPath !== 'string' || !rawPath || rawPath.includes('\0')) {
        throw new Error('Scanner requires nonempty file paths');
      }
      return {
        path: path.resolve(rawPath),
        dev: typeof item === 'object' && item?.dev != null ? String(item.dev) : null,
        ino: typeof item === 'object' && item?.ino != null ? String(item.ino) : null,
      };
    });

    const out = [];
    let chunk = [];
    let chunkBytes = 64;
    for (const entry of normalized) {
      const itemBytes = Buffer.byteLength(JSON.stringify(entry), 'utf8') + 2;
      if (chunk.length > 0 && (chunkBytes + itemBytes > MAX_BATCH_PAYLOAD_BYTES || chunk.length >= 256)) {
        const res = await this._requestBatch(chunk);
        if (res === null) return null;
        out.push(...res);
        chunk = [];
        chunkBytes = 64;
      }
      chunk.push(entry);
      chunkBytes += itemBytes;
    }
    if (chunk.length > 0) {
      const res = await this._requestBatch(chunk);
      if (res === null) return null;
      out.push(...res);
    }
    return out;
  }

  _requestBatch(files) {
    if (this.state === 'js' || this.state === 'unavailable') return Promise.resolve(null);
    if (this.state === 'closed' || this.state === 'failed') return Promise.reject(this.error ?? failure('Native scanner is closed', 'SCANNER_CLOSED'));
    if (this.pending.size >= this.maxQueue) return Promise.reject(failure('Native scanner request queue is full', 'SCANNER_QUEUE_FULL'));
    const id = this.nextId++;
    const promise = new Promise((resolve, reject) => {
      const entry = { id, op: 'hash_batch', files, resolve, reject, sent: false };
      this.pending.set(id, entry);
      this.queue.push(entry);
    });
    this._reference(true);
    this.startPromise ??= this._start().catch(error => this._fail(error));
    this._drain();
    return promise;
  }

  request(op, filePath) {
    if (!['hash', 'list'].includes(op) || typeof filePath !== 'string' || !filePath || filePath.includes('\0')) {
      return Promise.reject(new Error('Scanner requires hash/list and a nonempty file path'));
    }
    if (this.state === 'js' || this.state === 'unavailable') return Promise.resolve(null);
    if (this.state === 'closed' || this.state === 'failed') return Promise.reject(this.error ?? failure('Native scanner is closed', 'SCANNER_CLOSED'));
    if (this.pending.size >= this.maxQueue) return Promise.reject(failure('Native scanner request queue is full', 'SCANNER_QUEUE_FULL'));
    const id = this.nextId++;
    const promise = new Promise((resolve, reject) => {
      const entry = { id, op, path: path.resolve(filePath), resolve, reject, sent: false };
      this.pending.set(id, entry);
      this.queue.push(entry);
    });
    this._reference(true);
    this.startPromise ??= this._start().catch(error => this._fail(error));
    this._drain();
    return promise;
  }

  async _start() {
    this.state = 'starting';
    let lastError;
    for (const binary of this.binaries) {
      const launched = await this._launch(binary);
      if (this.state === 'closed' || this.state === 'failed') return;
      if (launched) return;
      lastError = this.launchError;
    }
    if (this.engine === 'rust') throw failure(`Native scanner executable unavailable: ${lastError?.message ?? this.binaries.join(', ')}`, 'SCANNER_UNAVAILABLE', lastError);
    this.state = 'unavailable';
    for (const entry of this.pending.values()) entry.resolve(null);
    this.pending.clear();
    this.queue = [];
  }

  _launch(binary) {
    return new Promise((resolve, reject) => {
      let spawned = false;
      const child = spawn(binary, ['--stdio', '--workers', String(this.workers)], { stdio: ['pipe', 'pipe', 'pipe'], shell: false });
      this.child = child;
      this.binaryPath = binary;
      this.exitPromise = new Promise(done => child.once('close', done));
      child.once('spawn', () => {
        spawned = true;
        liveChildren.add(child);
        if (this.state === 'closed' || this.state === 'failed') { child.kill('SIGKILL'); resolve(true); return; }
        this.startupTimer = setTimeout(() => this._fail(failure('Native scanner readiness timed out', 'SCANNER_TIMEOUT')), this.startupTimeoutMs);
        resolve(true);
      });
      child.once('error', error => {
        if (!spawned && UNAVAILABLE_CODES.has(error.code)) {
          this.launchError = error;
          resolve(false);
        } else {
          const wrapped = failure(`Native scanner failed to launch: ${error.message}`, 'SCANNER_FAILED', error);
          this._fail(wrapped);
          reject(wrapped);
        }
      });
      child.once('exit', (code, signal) => {
        liveChildren.delete(child);
        if (child === this.child && spawned && this.state !== 'closed' && this.state !== 'failed') {
          this._fail(failure(`Native scanner exited (${signal ?? code})${this.stderr ? `: ${this.stderr.trim()}` : ''}`));
        }
      });
      child.stdin.on('error', error => {
        if (spawned && child === this.child) this._fail(failure(`Native scanner input failed: ${error.message}`, 'SCANNER_FAILED', error));
      });
      child.stdin.on('drain', () => { this.writeBlocked = false; this._drain(); });
      child.stdout.on('data', chunk => { if (child === this.child) this._read(chunk); });
      child.stdout.on('end', () => {
        if (spawned && child === this.child) this._fail(failure('Native scanner output closed unexpectedly'));
      });
      child.stdout.on('error', error => {
        if (spawned && child === this.child) this._fail(failure(`Native scanner output failed: ${error.message}`, 'SCANNER_FAILED', error));
      });
      child.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk.toString('utf8')).slice(-4096); });
      child.stderr.on('error', () => {});
    });
  }

  _read(chunk) {
    if (this.state === 'failed' || this.state === 'closed') return;
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start);
      const end = newline === -1 ? chunk.length : newline;
      const part = chunk.subarray(start, end);
      this.frameBytes += part.length;
      if (this.frameBytes > this.maxResponseBytes) { this._fail(failure('Native scanner response exceeds size limit', 'SCANNER_PROTOCOL')); return; }
      this.frame.push(part);
      if (newline === -1) return;
      const bytes = Buffer.concat(this.frame, this.frameBytes);
      this.frame = [];
      this.frameBytes = 0;
      try {
        const line = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        if (line.trim()) this._message(JSON.parse(line));
      } catch (error) { this._fail(failure(`Invalid native scanner protocol: ${error.message}`, 'SCANNER_PROTOCOL', error)); return; }
      if (this.state === 'failed' || this.state === 'closed') return;
      start = newline + 1;
    }
  }

  _message(message) {
    if (!object(message)) throw new Error('message must be an object');
    if (this.state === 'starting') {
      if (message.ready !== true || message.protocol !== 1) throw new Error('expected protocol-1 ready message');
      clearTimeout(this.startupTimer);
      this.state = 'ready';
      this._drain();
      return;
    }
    const entry = this.pending.get(message.id);
    const hasError = Object.hasOwn(message, 'error');
    if (!Number.isSafeInteger(message.id) || !entry?.sent || hasError === Object.hasOwn(message, 'result') ||
        (hasError && typeof message.error !== 'string')) throw new Error('invalid response or unknown request id');
    if (hasError) {
      this._finish(entry, failure(`Native scanner ${entry.op} failed: ${message.error}`, 'SCANNER_REQUEST_FAILED'));
    } else {
      this._finish(entry, null, validateResult(entry.op, message.result, entry.path, entry.files?.length ?? 0));
    }
  }

  _drain() {
    if (this.state !== 'ready' || this.writeBlocked) return;
    while (this.active < this.workers && this.queue.length) {
      const entry = this.queue.shift();
      entry.sent = true;
      this.active++;
      entry.timer = setTimeout(() => this._fail(failure(`Native scanner ${entry.op} timed out`, 'SCANNER_TIMEOUT')), this.timeoutMs);
      const payload = entry.op === 'hash_batch'
        ? { id: entry.id, op: 'hash_batch', files: entry.files }
        : { id: entry.id, op: entry.op, path: entry.path };
      try {
        if (!this.child.stdin.write(`${JSON.stringify(payload)}\n`)) {
          this.writeBlocked = true;
          return;
        }
      } catch (error) {
        this._fail(failure(`Native scanner input failed: ${error.message}`, 'SCANNER_FAILED', error));
        return;
      }
    }
  }

  _finish(entry, error, result) {
    clearTimeout(entry.timer);
    this.pending.delete(entry.id);
    this.active--;
    if (error) entry.reject(error); else entry.resolve(result);
    this._drain();
    if (!this.pending.size) this._reference(false);
  }

  _reference(referenced) {
    const method = referenced ? 'ref' : 'unref';
    this.child?.[method]?.();
    for (const stream of [this.child?.stdin, this.child?.stdout, this.child?.stderr]) stream?.[method]?.();
  }

  _fail(error) {
    if (this.state === 'closed' || this.state === 'failed') return;
    this.error = error;
    this.state = 'failed';
    clearTimeout(this.startupTimer);
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    this.pending.clear();
    this.queue = [];
    this.frame = [];
    this.frameBytes = 0;
    this.active = 0;
    this.child?.kill('SIGKILL');
    this._reference(false);
  }

  close() {
    this.closePromise ??= this._close();
    return this.closePromise;
  }

  async _close() {
    this._fail(failure('Native scanner closed', 'SCANNER_CLOSED'));
    this.state = 'closed';
    if (this.child) {
      this._reference(true);
      this.child.kill('SIGKILL');
      await this.exitPromise;
      this._reference(false);
    }
  }
}

let defaultClient;
export function getNativeScanner() { return defaultClient ??= createNativeScannerClient(); }
export async function closeNativeScanner() {
  const client = defaultClient;
  if (client) {
    await client.close();
    if (defaultClient === client) defaultClient = undefined;
  }
}
