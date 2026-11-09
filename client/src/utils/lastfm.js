import { api, getAuthToken } from '../api.js';
export const LASTFM_CHANGED = 'tunecloud:lastfm';
export function lastfmChanged() { window.dispatchEvent(new Event(LASTFM_CHANGED)); }
export function lastfmEligible(duration, seconds, settings) {
  return Number.isFinite(duration) && duration > settings.min_duration && seconds >= Math.min(duration * settings.percent / 100, settings.seconds);
}

// A small per-user durable buffer bridges a failed browser -> TuneCloud request.
// Server acceptance transfers responsibility to PostgreSQL, independent of playback.
export function createLastfmTracker(userId, { client = api, storage = localStorage, token = getAuthToken } = {}) {
  const key = `tunecloud-lastfm-pending:${userId}`;
  const initialToken = token();
  let status = null, stopped = false, busy = false, refreshing = null;
  let queue;
  try { queue = JSON.parse(storage.getItem(key)) || []; } catch { queue = []; }
  if (!Array.isArray(queue)) queue = [];
  queue = queue.filter(e => e && typeof e.eventId === 'string' && typeof e.connectionId === 'string' && Number.isInteger(e.trackId));
  const active = () => !stopped && token() === initialToken;
  const persist = () => { try { storage.setItem(key, JSON.stringify(queue)); } catch { /* Keep memory copy if storage is full. */ } };
  async function refresh() {
    if (!active() || refreshing) return refreshing;
    refreshing = client.lastfm().then(next => {
      if (!active()) return;
      status = next;
      queue = queue.filter(e => e.connectionId === next.connectionId); persist();
    }).catch(() => {}).finally(() => { refreshing = null; });
    return refreshing;
  }
  async function flush() {
    if (!active() || busy || !status?.configured || !status.connected || !status.settings.enabled || status.needsReauth) return;
    busy = true;
    try {
      for (const event of [...queue]) {
        if (!active()) break;
        if (event.retryAt > Date.now()) continue;
        try {
          const { retryAt, attempts, ...body } = event;
          await client.lastfmScrobble(body);
          queue = queue.filter(e => e.eventId !== event.eventId);
        } catch (error) {
          if (error.status === 401) break;
          if (error.status >= 400 && error.status < 500 && error.status !== 429) queue = queue.filter(e => e.eventId !== event.eventId);
          else { event.attempts = (event.attempts || 0) + 1; event.retryAt = Date.now() + Math.min(300000, 5000 * 2 ** Math.min(event.attempts, 6)); }
        }
        persist();
      }
    } finally { busy = false; }
  }
  const tick = async () => { await refresh(); await flush(); };
  const timer = setInterval(tick, 15000);
  const online = () => { for (const e of queue) e.retryAt = 0; tick(); };
  window.addEventListener('online', online);
  window.addEventListener(LASTFM_CHANGED, tick);
  tick();
  return {
    get status() { return status; },
    sample(listening, trackId, duration) {
      if (!active() || !listening.startedAt || !status) return;
      if (listening.lastfmConnection === undefined) listening.lastfmConnection = status.configured && status.settings.enabled ? status.connectionId : null;
      if (!listening.lastfmConnection || listening.lastfmConnection !== status.connectionId || !status.settings.enabled || status.needsReauth) return;
      const event = { trackId: Number(trackId), eventId: listening.eventId, connectionId: listening.lastfmConnection, startedAt: listening.startedAt };
      if (!listening.nowPlayingSent) {
        listening.nowPlayingSent = true;
        if (status.settings.now_playing) client.lastfmNowPlaying(event).catch(() => {});
      }
      if (!listening.lastfmQueued && lastfmEligible(duration, listening.seconds, status.settings)) {
        if (queue.some(e => e.eventId === event.eventId)) listening.lastfmQueued = true;
        else if (queue.length < 250) {
          queue.push({ ...event, listenedSeconds: listening.seconds }); persist(); listening.lastfmQueued = true; flush();
        }
      }
    },
    stop() { stopped = true; clearInterval(timer); window.removeEventListener('online', online); window.removeEventListener(LASTFM_CHANGED, tick); persist(); },
  };
}
