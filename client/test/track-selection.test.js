import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { createTestDOM, render, click, changeInput, flushAsync, getReactProps } from './setup.js';
import { PlayerProvider, usePlayer } from '../src/context/PlayerContext.jsx';
import { FavoritesProvider } from '../src/context/FavoritesContext.jsx';
import { TrackRow } from '../src/components/cards/TrackRow.jsx';
import { TracksView } from '../src/views/TracksView.jsx';
import { useTrackSelection } from '../src/hooks/useTrackSelection.jsx';
import { api, setAuthToken } from '../src/api.js';

const tracks = Array.from({ length: 5 }, (_, i) => ({ id: i + 1, title: `Song ${i + 1}`, duration: (i + 1) * 10, available: i !== 2 }));
const event = async (node, handler, extra = {}) => React.act(async () => getReactProps(node)[handler]({
  target: node, currentTarget: node, preventDefault() {}, stopPropagation() {}, ...extra,
}));
const rows = view => view.container.findAll(el => el.tagName === 'TR' && el.className.includes('track-row'));
const selected = view => rows(view).filter(el => el.getAttribute('aria-selected') === 'true').map(el => rows(view).indexOf(el));

async function harness(initialTracks = tracks) {
  createTestDOM();
  setAuthToken('test-session');
  globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });
  let player;
  const playlistCalls = [];
  const onPlaylist = value => playlistCalls.push(value);
  function Selection({ list }) {
    const selection = useTrackSelection(list, onPlaylist);
    player = usePlayer();
    return <>{selection.toolbar}<table><tbody>{list.map((track, i) => <TrackRow key={track.playlist_track_id || track.id}
      track={track} index={i} {...selection.rowProps(track)} onAddToPlaylist={onPlaylist}
      onPlay={value => player.playTrack(value, list)} />)}</tbody></table></>;
  }
  const content = list => <FavoritesProvider><PlayerProvider><Selection list={list} /></PlayerProvider></FavoritesProvider>;
  const view = await render(content(initialTracks));
  return { ...view, player: () => player, playlistCalls, list: list => view.rerender(content(list)) };
}

test('track selection supports plain, Ctrl/Command and anchored Shift ranges without starting playback', async () => {
  const view = await harness();
  try {
    await click(rows(view)[0]);
    assert.deepEqual(selected(view), [0]);
    assert.equal(view.player().currentTrack, null);
    await event(rows(view)[2], 'onClick', { shiftKey: true });
    assert.deepEqual(selected(view), [0, 1, 2]);
    await event(rows(view)[1], 'onClick', { ctrlKey: true });
    assert.deepEqual(selected(view), [0, 2]);
    await event(rows(view)[4], 'onClick', { metaKey: true });
    assert.deepEqual(selected(view), [0, 2, 4]);
    await event(rows(view)[3], 'onClick', { shiftKey: true });
    assert.deepEqual(selected(view), [3, 4]);
    await event(rows(view)[1], 'onClick', { ctrlKey: true, shiftKey: true });
    assert.deepEqual(selected(view), [1, 2, 3, 4]);
    await click(rows(view)[0]);
    assert.deepEqual(selected(view), [0]);
    await event(rows(view)[0], 'onDoubleClick');
    assert.equal(view.player().currentTrack.id, 1);
    await event(rows(view)[0], 'onClick', { ctrlKey: true });
    assert.deepEqual(selected(view), []);
    await event(rows(view)[2], 'onKeyDown', { key: ' ', shiftKey: true });
    assert.deepEqual(selected(view), [0, 1, 2]);
    await event(rows(view)[0], 'onKeyDown', { key: 'a', ctrlKey: true });
    assert.equal(selected(view).length, 5);
    await event(rows(view)[0], 'onKeyDown', { key: 'Escape' });
    assert.deepEqual(selected(view), []);
    await click(rows(view)[1]);
    await view.list([...tracks].reverse());
    assert.deepEqual(selected(view), [], 'changing the list clears stale selections and anchors');
  } finally { await view.unmount(); }
});

test('right-click preserves a group, applies bulk actions, and replaces it when targeting another track', async () => {
  const view = await harness();
  try {
    await click(rows(view)[0]);
    await event(rows(view)[2], 'onClick', { ctrlKey: true });
    await event(rows(view)[2], 'onContextMenu', { clientX: 450, clientY: 200 });
    assert.deepEqual(selected(view), [0, 2]);
    let menu = document.body.find(el => el.getAttribute('role') === 'menu');
    assert.equal(menu.getAttribute('aria-label'), 'Actions for 2 selected tracks');
    await click(menu.find(el => el.tagName === 'BUTTON' && el.textContent.trim() === 'Add to Playlist'));
    assert.deepEqual(view.playlistCalls[0].map(t => t.id), [1, 3]);
    await event(rows(view)[2], 'onContextMenu', { clientX: 450, clientY: 200 });
    menu = document.body.find(el => el.getAttribute('role') === 'menu');
    await click(menu.find(el => el.tagName === 'BUTTON' && el.textContent.trim() === 'Add to Queue'));
    assert.deepEqual(view.player().queue.map(t => t.id), [1], 'unavailable members do not enter the queue');
    await event(rows(view)[1], 'onContextMenu', { clientX: 450, clientY: 200 });
    assert.deepEqual(selected(view), [1]);
    menu = document.body.find(el => el.getAttribute('role') === 'menu');
    assert.equal(menu.getAttribute('aria-label'), 'Actions for Song 2');
    await click(menu.find(el => el.tagName === 'BUTTON' && el.textContent.trim() === 'Add to Playlist'));
    assert.equal(view.playlistCalls[1].id, 2);
  } finally { await view.unmount(); }
});

test('repeated playlist occurrences can be selected independently', async () => {
  const repeated = [{ ...tracks[0], playlist_track_id: 11 }, { ...tracks[0], playlist_track_id: 12 }];
  const view = await harness(repeated);
  try {
    await click(rows(view)[1]);
    assert.deepEqual(selected(view), [1]);
    await event(rows(view)[0], 'onClick', { ctrlKey: true });
    assert.deepEqual(selected(view), [0, 1]);
    await click(view.container.find(el => el.getAttribute('aria-label') === 'Add selection to playlist'));
    assert.deepEqual(view.playlistCalls[0].map(t => t.playlist_track_id), [11, 12]);
  } finally { await view.unmount(); }
});

test('Tracks sorting resets pagination, persists, and uses the same ordering for every Play All page and search', async () => {
  createTestDOM();
  setAuthToken('test-session');
  globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });
  const original = api.tracks;
  const requests = [];
  api.tracks = async params => {
    requests.push({ ...params });
    const sorted = [...tracks].sort((a, b) => params.order === 'desc' ? b.duration - a.duration : a.duration - b.duration);
    return { tracks: sorted.slice(params.offset, params.offset + params.limit), total: sorted.length };
  };
  let player;
  function Probe() { player = usePlayer(); return null; }
  const content = <FavoritesProvider><PlayerProvider><Probe /><TracksView pageSize={2} /></PlayerProvider></FavoritesProvider>;
  let view;
  try {
    view = await render(content);
    await click(view.container.find(el => el.getAttribute('aria-label') === 'Next page'));
    assert.equal(requests.at(-1).offset, 2);
    await click(view.container.find(el => el.getAttribute('role') === 'combobox' && el.getAttribute('aria-label') === 'Sort tracks'));
    await click(document.body.find(el => el.getAttribute('role') === 'option' && el.textContent === 'Duration'));
    assert.equal(requests.at(-1).offset, 0);
    assert.equal(requests.at(-1).sort, 'duration');
    assert.equal(requests.at(-1).order, 'asc');
    await click(view.container.find(el => el.getAttribute('aria-label') === 'Sort descending'));
    assert.equal(requests.at(-1).order, 'desc');
    await click(view.container.find(el => el.tagName === 'BUTTON' && el.textContent === 'Play All'));
    assert.deepEqual(player.queue.map(t => t.id), [5, 4, 2, 1]);
    assert.ok(requests.slice(-2).every(params => params.sort === 'duration' && params.order === 'desc'));
    await changeInput(view.container.find(el => el.placeholder === 'Filter tracks...'), 'Song');
    await flushAsync(180);
    assert.equal(requests.at(-1).q, 'Song');
    assert.equal(requests.at(-1).sort, 'duration');
    await view.unmount(); view = null;
    view = await render(content);
    assert.equal(requests.at(-1).sort, 'duration');
    assert.equal(requests.at(-1).order, 'desc');
  } finally { await view?.unmount(); api.tracks = original; }
});

test('bulk toolbar is absent initially and for plain clicks; modifiers reveal actions and Deselect hides them', async () => {
  const view = await harness();
  try {
    const bar = () => view.container.find(el => el.className.includes('track-selection-bar'));
    assert.equal(bar(), null);
    assert.equal(view.container.find(el => el.getAttribute('aria-label') === 'Select tracks'), null);
    await click(rows(view)[0]); assert.equal(bar(), null);
    await event(rows(view)[1], 'onClick', { ctrlKey: true });
    assert.ok(bar()); assert.ok(bar().textContent.includes('2 tracks'));
    assert.ok(view.container.find(el => el.getAttribute('aria-label') === 'Add selection to queue'));
    assert.equal(rows(view).some(row => row.find(el => el.className === 'track-selection-checkbox')), false);
    await click(view.container.find(el => el.getAttribute('aria-label') === 'Deselect tracks'));
    assert.equal(bar(), null); assert.deepEqual(selected(view), []);
    await event(rows(view)[2], 'onClick', { metaKey: true });
    assert.ok(bar(), 'a modifier selection of one track shows the actions too');
    await click(view.container.find(el => el.getAttribute('aria-label') === 'Select page'));
    assert.equal(selected(view).length, tracks.length);
    await click(view.container.find(el => el.getAttribute('aria-label') === 'Deselect page'));
    assert.equal(bar(), null); assert.deepEqual(selected(view), []);
    await click(rows(view)[0]);
    await event(rows(view)[2], 'onClick', { shiftKey: true }); assert.ok(bar());
    await click(rows(view)[4]); assert.equal(bar(), null);
    await event(rows(view)[0], 'onKeyDown', { key: 'a', ctrlKey: true }); assert.ok(bar());
    await event(rows(view)[0], 'onKeyDown', { key: 'Escape' }); assert.equal(bar(), null);
  } finally { await view.unmount(); }
});
