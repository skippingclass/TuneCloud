import './setup.js';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { createTestDOM, render, flushAsync, click } from './setup.js';
import { PlayerProvider, usePlayer } from '../src/context/PlayerContext.jsx';
import { FavoritesProvider } from '../src/context/FavoritesContext.jsx';
import { PlaylistDetailView } from '../src/views/PlaylistDetailView.jsx';
import { useTrackLyrics } from '../src/hooks/useTrackLyrics.js';
import { parseArtistTokens } from '../src/components/common/ArtistLinks.jsx';
import { api, setAuthToken } from '../src/api.js';

beforeEach(() => {
  createTestDOM();
  globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });
});
const tracks = [
  { id: 1, playlist_track_id: 11, title: 'Repeated', duration: 120 },
  { id: 2, playlist_track_id: 12, title: 'Middle', duration: 120 },
  { id: 1, playlist_track_id: 13, title: 'Repeated', duration: 120 },
];
async function harness() {
  let player;
  function Probe() { player = usePlayer(); return null; }
  const view = await render(<PlayerProvider><Probe /></PlayerProvider>);
  return { ...view, player: () => player };
}

test('playlist occurrences have separate playback identity and invalid browse files never enter the queue', async () => {
  const view = await harness();
  try {
    await React.act(async () => view.player().playTrack(tracks[2], [...tracks, { id: null, title: 'Not indexed' }]));
    assert.equal(view.player().queueIndex, 2);
    assert.equal(view.player().currentTrack.playlist_track_id, 13);
    assert.equal(view.player().queue.length, 3);
    await React.act(async () => view.player().playTrack(tracks[0], tracks));
    assert.equal(view.player().queueIndex, 0);
    await React.act(async () => { view.player().addToQueue({ id: null }); view.player().addManyToQueue([{ id: null }, { id: 0 }]); });
    assert.equal(view.player().queue.length, 3);
  } finally { await view.unmount(); }
});

test('only the active occurrence is highlighted in a playlist', async () => {
  const original = api.playlist; api.playlist = async () => ({ id: 1, name: 'Playlist', tracks });
  let player;
  function Probe() { player = usePlayer(); return null; }
  const view = await render(<FavoritesProvider><PlayerProvider><Probe /><PlaylistDetailView playlist={{ id: 1 }} /></PlayerProvider></FavoritesProvider>);
  try {
    await flushAsync();
    await React.act(async () => player.playTrack(tracks[2], tracks));
    const highlighted = view.container.findAll(el => el.tagName === 'TR' && el.className.includes('bg-accent/10'));
    assert.equal(highlighted.length, 1);
    assert.equal(view.container.findAll(el => el.tagName === 'TR' && el.className.includes('track-row')).indexOf(highlighted[0]), 2);
  } finally { await view.unmount(); api.playlist = original; }
});

test('a late response cannot replace the current playlist or expose controls for the previous one', async () => {
  const original = api.playlist; const pending = new Map();
  api.playlist = id => new Promise(resolve => pending.set(id, resolve));
  const content = id => <FavoritesProvider><PlayerProvider><PlaylistDetailView playlist={{ id }} /></PlayerProvider></FavoritesProvider>;
  const view = await render(content(1));
  try {
    await view.rerender(content(2));
    await React.act(async () => pending.get(2)({ id: 2, name: 'Second playlist', tracks: [], is_owner: false }));
    await React.act(async () => pending.get(1)({ id: 1, name: 'First playlist', tracks: [], is_owner: true }));
    assert.match(view.container.textContent, /Second playlist/);
    assert.doesNotMatch(view.container.textContent, /First playlist|Edit Details/);
  } finally { await view.unmount(); api.playlist = original; }
});

test('seeks do not scrobble; actual listening retries a failed request with the same event ID', async () => {
  let clock = 0, wall = 0; const originalNow = performance.now, originalDate = Date.now, originalScrobble = api.scrobble;
  performance.now = () => clock; Date.now = () => wall;
  const calls = []; api.scrobble = async (id, eventId) => { calls.push({ id, eventId }); if (calls.length === 1) throw new Error('Offline'); };
  const view = await harness();
  try {
    await React.act(async () => view.player().playTrack(tracks[0], tracks));
    const audio = view.player().audioRef.current; audio.duration = 120;
    await React.act(async () => { view.player().seek(45); audio.dispatchEvent({ type: 'timeupdate' }); });
    assert.equal(calls.length, 0);
    await React.act(async () => { clock += 29000; wall += 29000; audio.currentTime = 74; audio.dispatchEvent({ type: 'timeupdate' }); });
    assert.equal(calls.length, 0);
    await React.act(async () => { clock += 1000; wall += 1000; audio.currentTime = 75; audio.dispatchEvent({ type: 'timeupdate' }); });
    assert.equal(calls.length, 1);
    await React.act(async () => { clock += 5000; wall += 5000; audio.currentTime = 80; audio.dispatchEvent({ type: 'timeupdate' }); });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].eventId, calls[1].eventId);
    await React.act(async () => { clock += 5000; audio.currentTime = 85; audio.dispatchEvent({ type: 'timeupdate' }); });
    assert.equal(calls.length, 2);
  } finally { await view.unmount(); performance.now = originalNow; Date.now = originalDate; api.scrobble = originalScrobble; }
});

test('successful tag edits invalidate visible and cached lyrics for the track', async () => {
  const original = api.lyrics; let lyricCalls = 0, result;
  api.lyrics = async () => ({ synced: false, lyrics: ++lyricCalls === 1 ? 'Old text' : 'Updated text' });
  function Probe() { result = useTrackLyrics({ id: 98901, title: 'Track' }, true); return null; }
  const view = await render(<Probe />);
  try {
    await flushAsync(); assert.equal(result.data.text, 'Old text');
    await React.act(async () => api.updateTags(98901, { title: 'Corrected title' }));
    await flushAsync(); assert.equal(result.data.text, 'Updated text'); assert.equal(lyricCalls, 2);
  } finally { await view.unmount(); api.lyrics = original; }
  assert.deepEqual(parseArtistTokens('Simon & Garfunkel'), ['Simon & Garfunkel']);
  assert.deepEqual(parseArtistTokens('dvsn'), ['dvsn']);
});
