import { getClient } from './db.js';

const SCAN_ADVISORY_LOCK_ID = 7491023;

let activeFullJob = null;
let activeTrackJobs = 0;
const trackQueues = new Map();

export function isFullJobActive() {
  return activeFullJob !== null;
}

/**
 * Reserve the single-process full scan / cover job slot when idle.
 */
export function tryStartFullJob(name) {
  if (activeFullJob !== null || activeTrackJobs > 0) {
    return false;
  }
  activeFullJob = name;
  return true;
}

export function endFullJob(name) {
  if (activeFullJob === name) {
    activeFullJob = null;
  }
}

/**
 * Acquire a PostgreSQL session advisory lock for full scans / cover jobs.
 */
export async function withLibraryAdvisoryLock(fn) {
  const client = await getClient();
  let locked = false;
  try {
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [SCAN_ADVISORY_LOCK_ID]);
    locked = Boolean(rows[0]?.locked);
    if (!locked) {
      throw Object.assign(new Error('Scan already in progress'), { statusCode: 409 });
    }
    return await fn();
  } finally {
    if (locked) {
      await client.query('SELECT pg_advisory_unlock($1)', [SCAN_ADVISORY_LOCK_ID]).catch(() => {});
    }
    client.release();
  }
}

/**
 * Serialize single-track scans / tag writes per key and block them while a full scan is active.
 */
export async function withTrackLock(key, fn) {
  if (activeFullJob !== null) {
    throw Object.assign(new Error('Cannot modify tracks while a library scan is in progress'), { statusCode: 409 });
  }
  activeTrackJobs += 1;
  const prev = trackQueues.get(key) || Promise.resolve();
  let releaseCurrent;
  const current = new Promise((resolve) => {
    releaseCurrent = resolve;
  });
  trackQueues.set(key, current);

  try {
    await prev;
    if (activeFullJob !== null) {
      throw Object.assign(new Error('Cannot modify tracks while a library scan is in progress'), { statusCode: 409 });
    }
    return await fn();
  } finally {
    activeTrackJobs -= 1;
    releaseCurrent();
    if (trackQueues.get(key) === current) {
      trackQueues.delete(key);
    }
  }
}
