import './setup.js';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';

import {
  createTestDOM,
  render,
  flushAsync,
} from './setup.js';
import { setAuthToken, api } from '../src/api.js';
import { ToastContainer } from '../src/components/layout/Toast.jsx';
import { PlayerProvider, usePlayer } from '../src/context/PlayerContext.jsx';
import { FavoritesProvider, useFavorites } from '../src/context/FavoritesContext.jsx';
import { AddToPlaylistModal } from '../src/components/modals/AddToPlaylistModal.jsx';

describe('Audit frontend hardening regressions', () => {
  beforeEach(() => {
    createTestDOM();
    setAuthToken('user-jwt');
  });

  it('PlayerContext suppresses MEDIA_ERR_ABORTED, retries via el.load() after network error, and aborts in-flight tag refreshes on unmount', async () => {
    const updatedSignals = [];
    let resolveTrackFetch = null;

    globalThis.fetch = (url, opts = {}) => {
      if (url === '/api/tags/10') {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ id: 10 }) });
      }
      if (url === '/api/tracks/10') {
        updatedSignals.push(opts.signal);
        return new Promise((resolve) => {
          resolveTrackFetch = () =>
            resolve({
              ok: true,
              status: 200,
              json: async () => ({ id: 10, title: 'Updated Song', duration: 100 }),
            });
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
    };

    let playerApi = null;
    function Harness() {
      playerApi = usePlayer();
      return null;
    }

    const view = await render(
      <>
        <ToastContainer />
        <PlayerProvider userId="1">
          <Harness />
        </PlayerProvider>
      </>
    );

    const track = { id: 10, title: 'Song One', artist: 'Artist A', duration: 100 };
    await React.act(async () => {
      playerApi.playTrack(track, [track]);
    });
    await flushAsync();

    const audioEl = playerApi.audioRef.current;
    assert.ok(audioEl);
    assert.equal(playerApi.isPlaying, true);

    // 1. MEDIA_ERR_ABORTED (code === 1) must NOT show an error toast or pause playback
    await React.act(async () => {
      audioEl.error = { code: 1 };
      audioEl.dispatchEvent({ type: 'error' });
    });
    await flushAsync();
    assert.equal(playerApi.isPlaying, true);
    assert.equal(view.container.textContent.includes('Playback error'), false);

    // 2. Real media error (code === 2) pauses playback and surfaces toast, and retrying invokes load()
    let loadCalls = 0;
    audioEl.load = () => {
      loadCalls += 1;
      audioEl.error = null;
    };
    await React.act(async () => {
      audioEl.error = { code: 2 };
      audioEl.dispatchEvent({ type: 'error' });
    });
    await flushAsync();
    assert.equal(playerApi.isPlaying, false);
    assert.equal(view.container.textContent.includes('Playback error: unable to play "Song One"'), true);

    await React.act(async () => {
      audioEl.paused = true;
      playerApi.playTrack(track, [track]);
    });
    await flushAsync();
    assert.equal(loadCalls, 1);
    assert.equal(playerApi.isPlaying, true);

    // 3. Tag update triggers track refresh, which is aborted if PlayerProvider unmounts mid-flight
    await React.act(async () => {
      await api.updateTags(10, { title: 'Updated Song' });
    });
    assert.equal(updatedSignals.length, 1);
    assert.equal(updatedSignals[0].aborted, false);

    await view.unmount();
    assert.equal(updatedSignals[0].aborted, true);
    resolveTrackFetch?.();
    await flushAsync();
  });

  it('FavoritesContext keeps rapid toggles deterministic, rolls back with error toast on failure, and isolates user switches via key', async () => {
    const pendingToggles = [];
    let currentIds = [10];

    globalThis.fetch = (url, opts = {}) => {
      if (url === '/api/favorites/ids') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ track_ids: currentIds, album_ids: [], artist_ids: [] }),
        });
      }
      if (url === '/api/favorites/track/10' && opts.method === 'POST') {
        return new Promise((resolve, reject) => {
          pendingToggles.push({ resolve, reject });
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
    };

    let favApi = null;
    function Harness() {
      favApi = useFavorites();
      return null;
    }

    const view = await render(
      <>
        <ToastContainer />
        <FavoritesProvider key="user-1">
          <Harness />
        </FavoritesProvider>
      </>
    );
    await flushAsync();
    assert.equal(favApi.isTrackStarred(10), true);

    // Rapid double toggle: true -> false -> true before responses return
    await React.act(async () => {
      favApi.toggleFavoriteTrack(10);
      favApi.toggleFavoriteTrack(10);
    });
    assert.equal(pendingToggles.length, 2);
    assert.equal(favApi.isTrackStarred(10), true);

    // Stale first response settles with { starred: false } -> MUST NOT clobber newer optimistic state
    await React.act(async () => {
      pendingToggles[0].resolve({
        ok: true,
        status: 200,
        json: async () => ({ starred: false }),
      });
    });
    await flushAsync();
    assert.equal(favApi.isTrackStarred(10), true);

    // Second response confirms { starred: true }
    await React.act(async () => {
      pendingToggles[1].resolve({
        ok: true,
        status: 200,
        json: async () => ({ starred: true }),
      });
    });
    await flushAsync();
    assert.equal(favApi.isTrackStarred(10), true);

    // Single toggle failure rolls back and displays an error toast
    await React.act(async () => {
      favApi.toggleFavoriteTrack(10);
    });
    assert.equal(pendingToggles.length, 3);
    assert.equal(favApi.isTrackStarred(10), false);
    await React.act(async () => {
      pendingToggles[2].resolve({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: async () => ({ error: 'Database unavailable' }),
      });
    });
    await flushAsync();
    assert.equal(favApi.isTrackStarred(10), true);
    assert.equal(view.container.textContent.includes('Failed to update favorite: Database unavailable'), true);

    // Keyed remount on user switch resets starred state cleanly
    currentIds = [20];
    await view.rerender(
      <>
        <ToastContainer />
        <FavoritesProvider key="user-2">
          <Harness />
        </FavoritesProvider>
      </>
    );
    await flushAsync();
    assert.equal(favApi.isTrackStarred(10), false);
    assert.equal(favApi.isTrackStarred(20), true);

    await view.unmount();
  });

  it('AddToPlaylistModal does not refetch when onClose identity changes and aborts pending load on unmount', async () => {
    let fetchCount = 0;
    let capturedSignal = null;
    let resolvePlaylists = null;

    globalThis.fetch = (url, opts = {}) => {
      if (url === '/api/playlists') {
        fetchCount += 1;
        capturedSignal = opts.signal;
        return new Promise((resolve) => {
          resolvePlaylists = () =>
            resolve({
              ok: false,
              status: 500,
              statusText: 'Error',
              json: async () => ({ error: 'Late error' }),
            });
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
    };

    const track = { id: 10, title: 'Song One' };
    const view = await render(
      <>
        <ToastContainer />
        <AddToPlaylistModal track={track} onClose={() => {}} />
      </>
    );
    assert.equal(fetchCount, 1);

    // New onClose lambda prop must NOT restart /api/playlists fetch
    await view.rerender(
      <>
        <ToastContainer />
        <AddToPlaylistModal track={track} onClose={() => {}} />
      </>
    );
    assert.equal(fetchCount, 1);
    assert.equal(capturedSignal.aborted, false);

    await view.unmount();
    assert.equal(capturedSignal.aborted, true);
    resolvePlaylists?.();
    await flushAsync();
  });
});
