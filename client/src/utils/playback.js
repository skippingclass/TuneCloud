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
        (track) => track && (typeof track.id === 'number' || typeof track.id === 'string'),
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
    };
  } catch {
    return null;
  }
}
