import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLrc, activeLineIndex } from '../src/utils/lyrics.js';

test('LRC parses line times, strips word times, and derives line ends', () => {
  assert.deepEqual(parseLrc('[ti:Example]\n[0:01.2]<00:01.20>First <00:01.50>line\n[00:03.045]Second', 10), [
    { startMs: 1200, endMs: 3045, text: 'First line' },
    { startMs: 3045, endMs: 10000, text: 'Second' },
  ]);
});

test('LRC expands repeated timestamps, groups simultaneous vocals, and keeps pauses', () => {
  const lines = parseLrc('[00:01][00:05]Repeated\n[00:01]Backing\n[00:03]\n[00:60]Invalid', 8);
  assert.deepEqual(lines, [
    { startMs: 1000, endMs: 3000, text: 'Repeated\nBacking' },
    { startMs: 3000, endMs: 5000, text: '' },
    { startMs: 5000, endMs: 8000, text: 'Repeated' },
  ]);
  for (const [time, expected] of [[0, -1], [1, 0], [4, 1], [6, 2], [2, 0], [8, -1]]) {
    assert.equal(activeLineIndex(lines, time), expected);
  }
});

test('LRC supports positive and negative offset, BOM/CRLF, stable sorting and empty input', () => {
  assert.deepEqual(parseLrc('\uFEFF[offset:-1500]\r\n[00:03]Later\r\n[00:01]Early', 5), [
    { startMs: 0, endMs: 1500, text: 'Early' },
    { startMs: 1500, endMs: 5000, text: 'Later' },
  ]);
  assert.equal(parseLrc('[offset:+200]\n[00:01:50]Line')[0].startMs, 1700);
  assert.deepEqual(parseLrc(null), []);
  assert.deepEqual(parseLrc('[ar:Artist]\nUntimed text'), []);
  assert.equal(activeLineIndex([], 1), -1);
});
