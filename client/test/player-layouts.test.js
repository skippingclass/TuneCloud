import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { createTestDOM, render, click, changeInput, flushAsync } from './setup.js';
import { PlayerProvider, usePlayer } from '../src/context/PlayerContext.jsx';
import { FavoritesProvider } from '../src/context/FavoritesContext.jsx';
import { Player } from '../src/components/player/Player.jsx';
import { LyricsModal } from '../src/components/player/LyricsModal.jsx';
import { QueueDrawer } from '../src/components/player/QueueDrawer.jsx';
import { setAuthToken } from '../src/api.js';

const named = (root, label) => root.find(el => el.getAttribute('aria-label') === label);
const byClass = (root, name) => root.find(el => el.className?.split(' ').includes(name));
async function harness(width, id) {
  createTestDOM(); window.innerWidth = width; setAuthToken('test-layout');
  let player;
  let lyricRequests = 0;
  globalThis.fetch = async url => {
    if (url.startsWith('/api/lyrics')) {
      lyricRequests++;
      return { ok: true, json: async () => ({ synced: true, lyrics: '[00:01]First line\n[00:05]Second line', source: 'local' }) };
    }
    return { ok: true, json: async () => ({ track_ids: [], album_ids: [], artist_ids: [] }) };
  };
  function Probe() { player = usePlayer(); return null; }
  const view = await render(<FavoritesProvider><PlayerProvider><Probe /><Player /><QueueDrawer /><LyricsModal /></PlayerProvider></FavoritesProvider>);
  await React.act(async () => player.playTrack({ id, title: 'Layout song', artist: 'Artist', album: 'Album', duration: 120, format: 'flac' }));
  return { ...view, player: () => player, lyricRequests: () => lyricRequests };
}

test('desktop Now playing docks a panel; artwork/lyrics share one full player and cached lyrics', async () => {
  const view = await harness(1440, 7101);
  try {
    const audio = view.player().audioRef.current;
    const playCalls = audio.playCalls;
    await click(named(view.container, 'Now playing'));
    await flushAsync();
    const panel = named(view.container, 'Now playing');
    assert.equal(panel.tagName, 'ASIDE');
    assert.equal(panel.getAttribute('aria-modal'), null);
    assert.equal(view.player().isLyricsOpen, false);
    assert.ok(panel.textContent.includes('First line'));
    await React.act(async () => view.player().seek(6));
    await click(named(panel, 'Open lyrics'));
    await flushAsync();
    let full = byClass(view.container, 'full-player');
    assert.equal(full.getAttribute('role'), 'dialog');
    assert.equal(view.container.findAll(el => el.getAttribute('role') === 'dialog').length, 1);
    assert.equal(byClass(view.container, 'now-playing-panel'), null);
    assert.ok(full.textContent.includes('Second line'));
    const cover = byClass(full, 'full-player-cover');
    assert.ok(named(byClass(full, 'full-player-art'), 'Playback position'));
    assert.ok(byClass(cover, 'np-transport'));
    assert.ok(byClass(full, 'full-player-ambience'));
    assert.match(byClass(full, 'full-player-source').textContent, /synced via local/);
    assert.ok(named(cover, 'Like track'));
    assert.equal(named(cover, 'Volume').getAttribute('aria-orientation'), 'vertical');
    assert.equal(byClass(full, 'full-player-footer'), null);
    assert.equal(view.lyricRequests(), 1);
    assert.equal(view.player().currentTime, 6);
    assert.equal(audio.playCalls, playCalls);

    await click(full.find(el => el.tagName === 'BUTTON' && el.textContent === 'Artwork'));
    full = byClass(view.container, 'full-player');
    assert.ok(full.className.includes('show-artwork'));
    assert.equal(view.container.findAll(el => el.getAttribute('role') === 'dialog').length, 1);
    await changeInput(named(full, 'Playback position'), '20');
    assert.equal(audio.currentTime, 20);

    let exits = 0;
    document.exitFullscreen = async () => { exits++; document.fullscreenElement = null; document.dispatchEvent({ type: 'fullscreenchange' }); };
    full.requestFullscreen = async () => { document.fullscreenElement = full; document.dispatchEvent({ type: 'fullscreenchange' }); };
    await click(named(full, 'Enter fullscreen'));
    assert.equal(document.fullscreenElement, full);
    await click(named(full, 'Sleep timer'));
    assert.ok(named(full, 'Sleep timer settings'));
    await click(named(full, 'Close sleep timer'));
    await click(named(full, 'Close player view'));
    assert.equal(exits, 1);
    assert.equal(document.fullscreenElement, null);
    assert.equal(view.player().isLyricsOpen, false);
    assert.ok(byClass(view.container, 'now-playing-panel'));
    await click(named(view.container, 'Queue'));
    assert.equal(view.player().isQueueOpen, true);
    assert.equal(view.player().isNowPlayingOpen, false);
    assert.equal(byClass(view.container, 'now-playing-panel'), null);
    assert.equal(audio.playCalls, playCalls);
  } finally { await view.unmount(); }
});

test('mobile has a single full player with the favorite beside the title, and resizes to a desktop panel', async () => {
  const view = await harness(390, 7102);
  try {
    await click(named(view.container, 'Expand player: Layout song'));
    let mobile = byClass(document.body, 'np-mobile');
    assert.equal(mobile.getAttribute('role'), 'dialog');
    const heart = named(mobile, 'Like track');
    assert.ok(heart.parentNode.className.includes('np-title-row'));
    assert.equal(mobile.findAll(el => ['Like track', 'Unlike track'].includes(el.getAttribute('aria-label'))).length, 1);
    await click(named(mobile, 'Open lyrics'));
    await flushAsync();
    assert.equal(byClass(document.body, 'np-mobile'), null);
    assert.equal(document.body.findAll(el => el.getAttribute('role') === 'dialog').length, 1);
    const full = byClass(view.container, 'full-player');
    await click(full.find(el => el.tagName === 'BUTTON' && el.textContent === 'Artwork'));
    assert.equal(view.player().playerView, 'artwork');
    assert.ok(byClass(full, 'full-player-footer'));
    assert.equal(byClass(full, 'full-player-cover-controls'), null);
    const plays = view.player().audioRef.current.playCalls;
    await React.act(async () => { window.innerWidth = 1280; window.dispatchEvent({ type: 'resize' }); });
    assert.ok(named(byClass(full, 'full-player-art'), 'Playback position'));
    assert.equal(byClass(full, 'full-player-footer'), null);
    assert.equal(view.player().audioRef.current.playCalls, plays);
    await React.act(async () => { window.innerWidth = 390; window.dispatchEvent({ type: 'resize' }); });
    await click(named(view.container, 'Close player view'));
    mobile = byClass(document.body, 'np-mobile');
    assert.ok(mobile.className.includes('np-mobile'));

    await React.act(async () => { window.innerWidth = 1280; window.dispatchEvent({ type: 'resize' }); });
    assert.equal(byClass(document.body, 'np-mobile'), null);
    assert.ok(byClass(view.container, 'now-playing-panel'));
    assert.equal(view.container.findAll(el => el.getAttribute('role') === 'dialog').length, 0);
  } finally { await view.unmount(); }
});

test('Now playing previews the actual next queue entry, including repeats, shuffle and repeat-all', async () => {
  const view = await harness(1440, 7103);
  try {
    await click(named(view.container, 'Now playing'));
    let card = named(view.container, 'Next up');
    assert.ok(card.textContent.includes('No tracks up next.'));
    assert.ok(!view.container.textContent.includes('Track details'));
    const first = view.player().currentTrack;
    const entries = [first, { ...first, title: 'Repeated entry' }, { id: 7104, title: 'Another track', artist: 'Other artist', duration: 100 }];
    await React.act(async () => view.player().playTrack(first, entries));
    card = named(view.container, 'Next up');
    assert.ok(card.textContent.includes('Repeated entry'));
    await click(named(card, 'Play next: Repeated entry'));
    assert.equal(view.player().queueIndex, 1);
    assert.equal(view.player().currentTrack.title, 'Repeated entry');
    assert.ok(named(view.container, 'Next up').textContent.includes('Another track'));

    await React.act(async () => view.player().toggleShuffle());
    const nextIndex = view.player().queueOrder[1];
    const expected = view.player().queue[nextIndex];
    await click(named(named(view.container, 'Next up'), 'Play next: ' + expected.title));
    assert.equal(view.player().queueIndex, nextIndex);
    await React.act(async () => view.player().clearUpcoming());
    assert.ok(named(view.container, 'Next up').textContent.includes('No tracks up next.'));
    await React.act(async () => view.player().toggleRepeat());
    const wrappedIndex = view.player().queueOrder[0];
    const wrapped = view.player().queue[wrappedIndex];
    await click(named(named(view.container, 'Next up'), 'Play next: ' + wrapped.title));
    assert.equal(view.player().queueIndex, wrappedIndex);
    await click(named(view.container, 'Next up').find(el => el.tagName === 'BUTTON' && el.textContent === 'Open queue'));
    assert.equal(view.player().isQueueOpen, true);
    assert.equal(view.player().isNowPlayingOpen, false);
  } finally { await view.unmount(); }
});
