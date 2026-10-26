import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { DOMNode, createTestDOM, render, click, flushAsync } from './setup.js';
import { PlayerProvider, usePlayer } from '../src/context/PlayerContext.jsx';
import { FavoritesProvider } from '../src/context/FavoritesContext.jsx';
import { LyricsModal } from '../src/components/player/LyricsModal.jsx';
import { setAuthToken } from '../src/api.js';

DOMNode.prototype.scrollIntoView = function () { this.scrollCalls = (this.scrollCalls || 0) + 1; };

async function harness() {
  createTestDOM();
  setAuthToken('test-user');
  let player;
  function Probe() { player = usePlayer(); return null; }
  const view = await render(<FavoritesProvider><PlayerProvider><Probe /><LyricsModal /></PlayerProvider></FavoritesProvider>);
  return { ...view, player: () => player };
}
const track = id => ({ id, title: `Test ${id}`, artist: 'Artist', duration: 10 });
const response = (lyrics, source = 'lrc.red', synced = true) => ({ ok: true, status: 200, json: async () => ({ lyrics, source, synced }) });

test('lyrics modal highlights whole lines, credits lrc.red, seeks and scrolls only on line changes', async () => {
  globalThis.fetch = async url => url.startsWith('/api/lyrics')
    ? response('[00:01]<00:01>First <00:01.50>line\n[00:03]Second line') : response('');
  const view = await harness();
  try {
    await React.act(async () => { view.player().playTrack(track(6101)); view.player().setIsLyricsOpen(true); });
    await flushAsync();
    const credit = view.container.find(el => el.tagName === 'A' && el.textContent === 'Lyrics via lrc.red');
    assert.equal(credit.getAttribute('href'), 'https://lrc.red');
    assert.equal(view.container.textContent.includes('<00:'), false);
    const line = text => view.container.find(el => el.getAttribute('role') === 'button' && el.textContent === text);
    const audio = view.player().audioRef.current;
    await React.act(async () => { audio.currentTime = 1.5; audio.dispatchEvent({ type: 'timeupdate' }); });
    assert.equal(line('First line').getAttribute('aria-current'), 'true');
    const scrolls = line('First line').scrollCalls;
    await React.act(async () => { audio.currentTime = 2; audio.dispatchEvent({ type: 'timeupdate' }); });
    assert.equal(line('First line').scrollCalls, scrolls);
    await click(line('Second line'));
    assert.equal(audio.currentTime, 3);
    assert.equal(line('Second line').getAttribute('aria-current'), 'true');
    await React.act(async () => view.player().seek(1));
    assert.equal(line('First line').getAttribute('aria-current'), 'true');
  } finally { await view.unmount(); }
});

test('lyrics modal aborts stale loads on track change/close, including a switch to a cached track', async () => {
  const pending = new Map();
  globalThis.fetch = (url, options = {}) => {
    if (!url.startsWith('/api/lyrics')) return Promise.resolve(response(''));
    const id = new URL(url, 'http://localhost').searchParams.get('id');
    if (id === '6201') return Promise.resolve(response('[00:01]Cached line'));
    return new Promise(resolve => pending.set(id, { resolve, signal: options.signal }));
  };
  const view = await harness();
  try {
    await React.act(async () => { view.player().playTrack(track(6201)); view.player().setIsLyricsOpen(true); });
    await flushAsync();
    await React.act(async () => view.player().playTrack(track(6202)));
    assert.equal(pending.get('6202').signal.aborted, false);
    await React.act(async () => view.player().playTrack(track(6201)));
    assert.equal(pending.get('6202').signal.aborted, true);
    await React.act(async () => pending.get('6202').resolve(response('[00:01]Stale line')));
    assert.ok(view.container.textContent.includes('Cached line'));
    assert.equal(view.container.textContent.includes('Stale line'), false);
    await React.act(async () => view.player().playTrack(track(6203)));
    await React.act(async () => view.player().setIsLyricsOpen(false));
    assert.equal(pending.get('6203').signal.aborted, true);
    await React.act(async () => pending.get('6203').resolve(response('[00:01]Closed line')));
  } finally { await view.unmount(); }
});

test('lyrics modal retries failed lookups on reopening and preserves plain text display', async () => {
  let attempts = 0;
  globalThis.fetch = async url => {
    if (!url.startsWith('/api/lyrics')) return response('');
    if (++attempts === 1) return { ok: false, status: 503, json: async () => ({ error: 'Temporary failure' }) };
    return response('Plain first line\nPlain second line', 'local', false);
  };
  const view = await harness();
  try {
    await React.act(async () => { view.player().playTrack(track(6301)); view.player().setIsLyricsOpen(true); });
    await flushAsync();
    await React.act(async () => view.player().setIsLyricsOpen(false));
    await React.act(async () => view.player().setIsLyricsOpen(true));
    await flushAsync();
    assert.equal(attempts, 2);
    assert.ok(view.container.textContent.includes('Plain first line\nPlain second line'));
    assert.equal(view.container.find(el => el.getAttribute('aria-current') === 'true'), null);
  } finally { await view.unmount(); }
});
