import { useLibraryScan } from '../src/hooks/useLibraryScan.js';
import { CreatePlaylistModal } from '../src/components/modals/CreatePlaylistModal.jsx';
import { submitForm } from './setup.js';
import './setup.js';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { createTestDOM, render, flushAsync, click, changeInput } from './setup.js';
import { PlayerProvider, usePlayer } from '../src/context/PlayerContext.jsx';
import { FavoritesProvider } from '../src/context/FavoritesContext.jsx';
import { SearchView } from '../src/views/SearchView.jsx';
import { HistoryView } from '../src/views/HistoryView.jsx';
import { readPlaybackSession } from '../src/utils/playback.js';
import { api } from '../src/api.js';

beforeEach(() => {
  createTestDOM();
  globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });
});
const tracks = [1, 2, 3, 4].map((id) => ({
  id,
  title: `Song ${id}`,
  duration: 120,
  available: true,
}));
async function harness(userId = 'alice', strict = false) {
  let player;
  function Probe() {
    player = usePlayer();
    return null;
  }
  const content = (
    <PlayerProvider userId={userId}>
      <Probe />
    </PlayerProvider>
  );
  const view = await render(strict ? <React.StrictMode>{content}</React.StrictMode> : content);
  return { ...view, player: () => player };
}

test('shuffle plays each entry once and previous/forward retrace the same order', async () => {
  const view = await harness();
  try {
    await React.act(async () => view.player().playTrack(tracks[0], tracks));
    await React.act(async () => view.player().toggleShuffle());
    const visited = [view.player().currentTrack.id];
    for (let i = 1; i < tracks.length; i++) {
      await React.act(async () => view.player().next());
      visited.push(view.player().currentTrack.id);
    }
    assert.equal(new Set(visited).size, tracks.length);
    assert.equal(view.player().hasNext, false);
    await React.act(async () => view.player().prev());
    assert.equal(view.player().currentTrack.id, visited.at(-2));
    await React.act(async () => view.player().next());
    assert.equal(view.player().currentTrack.id, visited.at(-1));
    await React.act(async () => view.player().toggleRepeat());
    await React.act(async () => view.player().next());
    assert.equal(view.player().currentTrack.id, visited[0]);
  } finally {
    await view.unmount();
  }
});

test('play next handles duplicate entries in shuffle and moving active entry does not restart audio', async () => {
  const view = await harness();
  try {
    await React.act(async () => view.player().playTrack(tracks[0], tracks));
    await React.act(async () => view.player().toggleShuffle());
    const audio = view.player().audioRef.current;
    const calls = audio.playCalls;
    await React.act(async () => view.player().moveInQueue(0, 3));
    assert.equal(view.player().currentTrack.id, 1);
    assert.equal(audio.playCalls, calls);
    await React.act(async () => view.player().playNext(tracks[0]));
    await React.act(async () => view.player().next());
    assert.equal(view.player().currentTrack.id, 1);
    // The base queue is preserved while shuffled; the new duplicate follows index 0.
    assert.equal(view.player().queueIndex, 1);
    assert.equal(view.player().queue.length, 5);
    assert.equal(audio.playCalls, calls + 1);
  } finally {
    await view.unmount();
  }
});

test('reload restores exact position paused in StrictMode; sessions are isolated per user', async () => {
  let view = await harness();
  await React.act(async () => view.player().playTrack(tracks[1], tracks));
  await React.act(async () => {
    const audio = view.player().audioRef.current;
    audio.duration = 120;
    audio.currentTime = 43.25;
    audio.dispatchEvent({ type: 'timeupdate' });
    view.player().toggleShuffle();
    view.player().toggleRepeat();
  });
  await view.unmount();
  view = await harness('alice', true);
  try {
    assert.equal(view.player().currentTrack.id, 2);
    assert.equal(view.player().currentTime, 43.25);
    assert.equal(view.player().shuffle, true);
    assert.equal(view.player().repeat, 'all');
    assert.equal(view.player().audioRef.current.playCalls, 0);
    await React.act(async () => {
      const audio = view.player().audioRef.current;
      audio.duration = 120;
      audio.dispatchEvent({ type: 'loadedmetadata' });
    });
    assert.equal(view.player().audioRef.current.currentTime, 43.25);
    await React.act(async () => view.player().togglePlay());
    await React.act(async () => view.player().audioRef.current.dispatchEvent({ type: 'ended' }));
    assert.equal(view.player().isPlaying, true);
    assert.equal(view.player().audioRef.current.playCalls, 2);
  } finally {
    await view.unmount();
  }
  const other = await harness('bob');
  assert.equal(other.player().currentTrack, null);
  await other.unmount();
});

test('bulk append keeps order; clear removes persisted queue; corrupt storage is ignored', async () => {
  localStorage.setItem('broken', JSON.stringify({ queue: [null], queueIndex: 0 }));
  assert.equal(readPlaybackSession('broken'), null);
  const view = await harness();
  try {
    await React.act(async () => view.player().addManyToQueue(tracks));
    assert.deepEqual(
      view.player().queue.map((t) => t.id),
      [1, 2, 3, 4],
    );
    await React.act(async () => view.player().clearQueue());
    assert.equal(localStorage.getItem('tunecloud-playback:alice'), null);
  } finally {
    await view.unmount();
  }
});

test('sleep after track stops with repeat one without advancing', async () => {
  const view = await harness();
  try {
    await React.act(async () => view.player().playTrack(tracks[0], tracks));
    await React.act(async () => {
      view.player().toggleRepeat();
      view.player().toggleRepeat();
      view.player().setSleepTimer('track');
    });
    await React.act(async () => view.player().audioRef.current.dispatchEvent({ type: 'ended' }));
    assert.equal(view.player().currentTrack.id, 1);
    assert.equal(view.player().isPlaying, false);
    assert.equal(view.player().sleepUntil, null);
  } finally {
    await view.unmount();
  }
});

test('search distinguishes connection failure from empty results and retry recovers', async () => {
  const original = api.search;
  let mode = 'error';
  api.search = async () => {
    if (mode === 'error') throw new Error('Offline');
    return { tracks: mode === 'empty' ? [] : tracks, albums: [], artists: [] };
  };
  const view = await render(
    <FavoritesProvider>
      <PlayerProvider>
        <SearchView initialQuery="song" />
      </PlayerProvider>
    </FavoritesProvider>,
  );
  try {
    await flushAsync(300);
    assert.match(view.container.textContent, /Search unavailable/);
    assert.doesNotMatch(view.container.textContent, /No matching results/);
    mode = 'success';
    await click(view.container.find((el) => el.getAttribute('aria-label') === 'Retry search'));
    await flushAsync(300);
    assert.match(view.container.textContent, /Song 1/);
    mode = 'empty';
    await changeInput(
      view.container.find((el) => el.tagName === 'INPUT'),
      'nothing',
    );
    await flushAsync(300);
    assert.match(view.container.textContent, /No matching results/);
  } finally {
    api.search = original;
    await view.unmount();
  }
});

test('history displays repeated events and aborts requests on unmount', async () => {
  const original = api.history;
  let signal;
  api.history = async (_params, opts) => {
    signal = opts.signal;
    return {
      total: 2,
      tracks: [11, 12].map((history_id) => ({
        ...tracks[0],
        history_id,
        played_at: '2026-11-02T10:00:00Z',
      })),
    };
  };
  const view = await render(
    <FavoritesProvider>
      <PlayerProvider>
        <HistoryView />
      </PlayerProvider>
    </FavoritesProvider>,
  );
  try {
    await flushAsync();
    assert.equal(view.container.findAll((el) => el.tagName === 'TR').length, 3);
    assert.equal(signal.aborted, false);
  } finally {
    api.history = original;
    await view.unmount();
  }
  assert.equal(signal.aborted, true);
});

test('leaving settings cancels the scheduled scan poll and its request', async () => {
  const originalScan = api.scan;
  const originalStatus = api.scanStatus;
  let calls = 0;
  let signal;
  let scan;
  api.scan = async () => ({});
  api.scanStatus = async (options) => {
    calls += 1;
    signal = options.signal;
    return { isScanning: false };
  };
  function Probe() {
    scan = useLibraryScan();
    return null;
  }
  const view = await render(<Probe />);
  try {
    await flushAsync();
    await React.act(async () => scan.startScan());
    assert.equal(calls, 1);
  } finally {
    await view.unmount();
    api.scan = originalScan;
    api.scanStatus = originalStatus;
  }
  await flushAsync(850);
  assert.equal(calls, 1);
  assert.equal(signal.aborted, true);
});

test('saving a queue creates a playlist with duplicate track IDs in the original order', async () => {
  const original = api.createPlaylist;
  let payload;
  let closed = false;
  api.createPlaylist = async (data) => {
    payload = data;
    return { id: 91, ...data };
  };
  const view = await render(
    <CreatePlaylistModal
      initialTrackIds={[1, 2, 1]}
      onClose={() => {
        closed = true;
      }}
    />,
  );
  try {
    await changeInput(
      view.container.find((element) => element.tagName === 'INPUT'),
      'My queue',
    );
    await submitForm(view.container.find((element) => element.tagName === 'FORM'));
    assert.deepEqual(payload.trackIds, [1, 2, 1]);
    assert.equal(payload.name, 'My queue');
    assert.equal(closed, true);
  } finally {
    api.createPlaylist = original;
    await view.unmount();
  }
});

test('removing the active track follows the displayed shuffle queue', async () => {
  const view = await harness();
  try {
    await React.act(async () => view.player().playTrack(tracks[0], tracks));
    await React.act(async () => view.player().toggleShuffle());
    const expected = view.player().queue[view.player().queueOrder[1]].id;
    await React.act(async () => view.player().removeFromQueue(view.player().queueIndex));
    assert.equal(view.player().currentTrack.id, expected);
    assert.equal(view.player().queue.length, 3);
    assert.equal(view.player().isPlaying, true);
  } finally {
    await view.unmount();
  }
});


test('seeking before audio metadata is ready keeps the requested position', async () => {
  const view = await harness();
  try {
    await React.act(async () => view.player().playTrack(tracks[0]));
    const audio = view.player().audioRef.current;
    audio.readyState = 0;
    await React.act(async () => {
      view.player().seek(42);
      audio.dispatchEvent({ type: 'timeupdate' });
    });
    assert.equal(view.player().currentTime, 42);
    await React.act(async () => {
      audio.duration = 120;
      audio.readyState = 1;
      audio.dispatchEvent({ type: 'loadedmetadata' });
    });
    assert.equal(audio.currentTime, 42);
  } finally { await view.unmount(); }
});
