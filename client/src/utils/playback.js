// An event identifier, including on HTTP LAN previews where randomUUID is absent.
export function playbackEventId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const isPlayableTrack = track => track && /^[1-9]\d*$/.test(String(track.id)) && Number(track.id) <= 2147483647 && track.available !== false;

// Fisher–Yates preserves every entry, including repeated tracks in a queue.
export function shuffled(items, random = Math.random) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export function shuffleOrder(length, currentIndex) {
  return [
    currentIndex,
    ...shuffled(Array.from({ length }, (_, i) => i).filter((i) => i !== currentIndex)),
  ].filter((i) => i >= 0 && i < length);
}

export function readPlaybackSession(key) {
  try {
    const saved = JSON.parse(localStorage.getItem(key));
    if (!saved || !Array.isArray(saved.queue) || !Number.isInteger(saved.queueIndex)) return null;
    if (saved.queueIndex < 0 || saved.queueIndex >= saved.queue.length) return null;
    if (
      !saved.queue.every(
        (track) => isPlayableTrack(track),
      )
    )
      return null;
    const order = saved.order;
    return {
      queue: saved.queue,
      queueIndex: saved.queueIndex,
      currentTime: Number.isFinite(saved.currentTime) ? Math.max(0, saved.currentTime) : 0,
      repeat: ['none', 'all', 'one'].includes(saved.repeat) ? saved.repeat : 'none',
      shuffle: saved.shuffle === true,
      order:
        Array.isArray(order) &&
        order.length === saved.queue.length &&
        new Set(order).size === order.length &&
        order.every((i) => Number.isInteger(i) && i >= 0 && i < order.length)
          ? order
          : shuffleOrder(saved.queue.length, saved.queueIndex),
      scrobbled: saved.scrobbled === true,
      startedAt: Number.isInteger(saved.startedAt) && saved.startedAt > 0 ? saved.startedAt : null,
      lastfmConnection: saved.lastfmConnection === null || typeof saved.lastfmConnection === 'string' ? saved.lastfmConnection : undefined,
      lastfmQueued: saved.lastfmQueued === true,
      listenedSeconds: Number.isFinite(saved.listenedSeconds) ? Math.max(0, saved.listenedSeconds) : 0,
      eventId: typeof saved.eventId === 'string' && /^[0-9a-f-]{36}$/i.test(saved.eventId) ? saved.eventId : undefined,
    };
  } catch {
    return null;
  }
}
