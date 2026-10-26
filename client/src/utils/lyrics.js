const TIMESTAMP = /\[(\d+):(\d{2})(?:[.:](\d{1,3}))?\]/g;

export function parseLrc(text, duration = 0) {
  if (typeof text !== 'string') return [];
  const offset = Number(text.match(/\[offset:\s*([+-]?\d+)\s*\]/i)?.[1] || 0);
  const entries = [];
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    const prefix = line.match(/^(?:\[\d+:\d{2}(?:[.:]\d{1,3})?\])+/)?.[0];
    if (!prefix) continue;
    const content = line.slice(prefix.length).replace(/<\d+:\d{2}(?:[.:]\d{1,3})?>/g, '').trim();
    for (const match of prefix.matchAll(TIMESTAMP)) {
      if (Number(match[2]) >= 60) continue;
      const startMs = Math.max(0, Number(match[1]) * 60000 + Number(match[2]) * 1000 + Number((match[3] || '').padEnd(3, '0')) + offset);
      entries.push({ startMs, text: content });
    }
  }
  entries.sort((a, b) => a.startMs - b.startMs);
  const groups = [];
  for (const entry of entries) {
    const previous = groups.at(-1);
    if (previous?.startMs === entry.startMs) {
      if (entry.text && !previous.text.split('\n').includes(entry.text)) {
        previous.text = [previous.text, entry.text].filter(Boolean).join('\n');
      }
    } else groups.push({ ...entry });
  }
  return groups.map((entry, index) => ({
    ...entry,
    endMs: groups[index + 1]?.startMs ?? (duration * 1000 > entry.startMs ? duration * 1000 : Infinity),
  }));
}

export function activeLineIndex(lines, currentTime) {
  const timeMs = currentTime * 1000;
  let low = 0, high = lines.length - 1, result = -1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    if (lines[middle].startMs <= timeMs) { result = middle; low = middle + 1; }
    else high = middle - 1;
  }
  return result >= 0 && timeMs < lines[result].endMs ? result : -1;
}
