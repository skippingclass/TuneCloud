import './setup.js';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';

import {
  createTestDOM,
  render,
  click,
  changeInput,
  focusInput,
  submitForm,
  flushAsync,
  getReactProps,
} from './setup.js';
import {
  api,
  ApiError,
  setAuthToken,
  getAuthToken,
  onAuthExpired,
  AUTH_EXPIRED_EVENT,
} from '../src/api.js';
import App from '../src/App.jsx';
import { AdminView } from '../src/views/AdminView.jsx';
import { PlayerProvider, usePlayer } from '../src/context/PlayerContext.jsx';
import { FavoritesProvider } from '../src/context/FavoritesContext.jsx';
import { SearchView } from '../src/views/SearchView.jsx';
import { Header } from '../src/components/layout/Header.jsx';
import { TracksView } from '../src/views/TracksView.jsx';

describe('API client, stream URL, typed errors, and central 401 handling', () => {
  beforeEach(() => {
    createTestDOM();
    setAuthToken(null);
  });

  it('streamUrl(id) returns /api/stream/:id without JWT query parameter even when token is set', () => {
    setAuthToken('secret-jwt-token');
    assert.equal(api.streamUrl(42), '/api/stream/42');
    assert.equal(api.streamUrl('abc').includes('token='), false);
  });

  it('throws typed ApiError with HTTP status and emits central 401 event except for login', async () => {
    setAuthToken('expired-jwt');
    let expiredEvents = 0;
    let windowEvents = 0;
    const unsub = onAuthExpired(() => {
      expiredEvents += 1;
    });
    window.addEventListener(AUTH_EXPIRED_EVENT, () => {
      windowEvents += 1;
    });

    // 1. 401 on login should throw ApiError(401) but NOT fire central expiration event
    globalThis.fetch = async () => ({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      json: async () => ({ error: 'Invalid credentials' }),
    });

    await assert.rejects(
      () => api.login('alice', 'wrong'),
      (err) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 401);
        assert.equal(err.message, 'Invalid credentials');
        return true;
      }
    );
    assert.equal(expiredEvents, 0);
    assert.equal(windowEvents, 0);
    assert.equal(getAuthToken(), 'expired-jwt');

    // 2. 401 on a regular endpoint fires central expiration event and clears token
    await assert.rejects(
      () => api.albums(),
      (err) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 401);
        return true;
      }
    );
    assert.equal(expiredEvents, 1);
    assert.equal(windowEvents, 1);
    assert.equal(getAuthToken(), null);

    unsub();
  });
});

describe('App auth lifecycle: startup 503/network retry, 401 expiration, and logout', () => {
  beforeEach(() => {
    createTestDOM();
    setAuthToken(null);
  });

  it('preserves token and shows Retry on startup 503/network failure, then succeeds on retry', async () => {
    setAuthToken('persisted-jwt');
    let meAttempts = 0;

    globalThis.fetch = async (url) => {
      if (url === '/api/auth/me') {
        meAttempts += 1;
        if (meAttempts === 1) {
          return {
            ok: false,
            status: 503,
            statusText: 'Service Unavailable',
            json: async () => ({ error: 'Database temporarily unavailable' }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            authenticated: true,
            user: { id: 1, username: 'alice', is_admin: false },
          }),
        };
      }
      if (url === '/api/albums' || url === '/api/genres') {
        return { ok: true, status: 200, json: async () => [] };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ tracks: [], albums: [], artists: [] }),
      };
    };

    const view = await render(<App />);
    await flushAsync();

    // Token must NOT be deleted on 503 error
    assert.equal(getAuthToken(), 'persisted-jwt');
    assert.equal(localStorage.getItem('tunecloud-token'), 'persisted-jwt');
    assert.ok(view.container.textContent.includes('Database temporarily unavailable'));

    const retryBtn = view.container.find(
      (el) => el.tagName === 'BUTTON' && el.textContent.includes('Retry')
    );
    assert.ok(retryBtn, 'Retry button should be rendered');

    await click(retryBtn);
    await flushAsync();

    assert.equal(meAttempts, 2);
    assert.ok(view.container.textContent.includes('alice'));
    await view.unmount();
  });

  it('clears user on central 401 expiration and calls POST /api/auth/logout before local clear on logout', async () => {
    setAuthToken('active-jwt');
    const callOrder = [];

    globalThis.fetch = async (url, opts = {}) => {
      if (url === '/api/auth/me') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            authenticated: true,
            user: { id: 1, username: 'alice', is_admin: false },
          }),
        };
      }
      if (url === '/api/auth/logout') {
        callOrder.push({
          endpoint: url,
          method: opts.method,
          tokenAtCallTime: getAuthToken(),
          authHeader: opts.headers?.Authorization,
        });
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true }),
        };
      }
      if (url === '/api/albums' || url === '/api/genres') {
        return { ok: true, status: 200, json: async () => [] };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ tracks: [], albums: [], artists: [] }),
      };
    };

    const view = await render(<App />);
    await flushAsync();
    assert.ok(view.container.textContent.includes('alice'));

    const logoutBtn = view.container.find(
      (el) => el.tagName === 'BUTTON' && el.getAttribute('title') === 'Logout'
    );
    assert.ok(logoutBtn, 'Logout button should be rendered');

    await click(logoutBtn);
    await flushAsync();

    assert.equal(callOrder.length, 1);
    assert.equal(callOrder[0].endpoint, '/api/auth/logout');
    assert.equal(callOrder[0].method, 'POST');
    assert.equal(callOrder[0].tokenAtCallTime, 'active-jwt');
    assert.equal(callOrder[0].authHeader, 'Bearer active-jwt');
    assert.equal(getAuthToken(), null);
    assert.ok(view.container.textContent.includes('Sign in to stream'));

    await view.unmount();
  });

  it('clears user and returns to LoginView when any API call returns 401 while logged in', async () => {
    setAuthToken('session-jwt');
    let expireNextPlaylistsCall = false;

    globalThis.fetch = async (url) => {
      if (url === '/api/auth/me') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            authenticated: true,
            user: { id: 2, username: 'bob', is_admin: false },
          }),
        };
      }
      if (url === '/api/playlists' && expireNextPlaylistsCall) {
        return {
          ok: false,
          status: 401,
          statusText: 'Unauthorized',
          json: async () => ({ error: 'Token expired' }),
        };
      }
      if (url === '/api/albums' || url === '/api/genres') {
        return { ok: true, status: 200, json: async () => [] };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ tracks: [], albums: [], artists: [] }),
      };
    };

    const view = await render(<App />);
    await flushAsync();
    assert.ok(view.container.textContent.includes('bob'));

    expireNextPlaylistsCall = true;
    await React.act(async () => {
      await api.playlists().catch(() => {});
    });
    await flushAsync();

    assert.equal(getAuthToken(), null);
    assert.ok(view.container.textContent.includes('Sign in to stream'));

    await view.unmount();
  });
});

describe('AdminView security: no plaintext password display/copy while retaining create/reset', () => {
  beforeEach(() => {
    createTestDOM();
    setAuthToken('admin-jwt');
  });

  it('does not render plaintext passwords or copy buttons, and retains password reset and user creation', async () => {
    const apiCalls = [];
    globalThis.fetch = async (url, opts = {}) => {
      apiCalls.push({ url, method: opts.method || 'GET', body: opts.body });
      if (url === '/api/auth/users') {
        return {
          ok: true,
          status: 200,
          json: async () => [
            {
              id: 1,
              username: 'admin',
              is_admin: true,
              password: 'leaked-plaintext-secret-123',
              created_at: '2026-01-01T00:00:00Z',
            },
          ],
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      };
    };

    const view = await render(<AdminView user={{ id: 1, username: 'admin', is_admin: true }} />);
    await flushAsync();

    const text = view.container.textContent;
    assert.equal(text.includes('leaked-plaintext-secret-123'), false);
    assert.equal(text.includes('••••••••••••'), false);

    const copyBtn = view.container.find(
      (el) =>
        el.tagName === 'BUTTON' &&
        (el.getAttribute('title') || '').toLowerCase().includes('copy password')
    );
    assert.equal(copyBtn, null);

    // Verify Change Password modal and submission still work
    const changePwBtn = view.container.find(
      (el) => el.tagName === 'BUTTON' && el.textContent.includes('Change Password')
    );
    assert.ok(changePwBtn, 'Change Password button should remain available');
    await click(changePwBtn);

    const pwInput = view.container.find(
      (el) => el.tagName === 'INPUT' && el.getAttribute('placeholder') === 'Min 8 characters'
    );
    assert.ok(pwInput, 'Password reset input should open');
    await changeInput(pwInput, 'newstrongpass99');

    const form = view.container.find((el) => el.tagName === 'FORM');
    await submitForm(form);
    await flushAsync();

    const putCall = apiCalls.find((c) => c.url === '/api/auth/users/1/password' && c.method === 'PUT');
    assert.ok(putCall, 'Should call PUT /api/auth/users/1/password');
    assert.deepEqual(JSON.parse(putCall.body), { password: 'newstrongpass99' });

    await view.unmount();
  });
});

describe('PlayerContext: scrobble reset on next/repeat, resume paused track, and promise/error handling', () => {
  beforeEach(() => {
    createTestDOM();
    setAuthToken('user-jwt');
  });

  it('resets scrobbled flag on automatic next and repeat-one, resumes same paused track with audio.play(), and handles play() rejection and audio errors', async () => {
    const scrobbledIds = [];
    globalThis.fetch = async (url) => {
      if (url.startsWith('/api/scrobble/')) {
        scrobbledIds.push(Number(url.split('/').pop()));
      }
      return { ok: true, status: 200, json: async () => ({}) };
    };

    let playerApi = null;
    function Harness() {
      playerApi = usePlayer();
      return null;
    }

    const view = await render(
      <PlayerProvider>
        <Harness />
      </PlayerProvider>
    );

    const tracks = [
      { id: 10, title: 'Song One', artist: 'Artist A', duration: 100 },
      { id: 20, title: 'Song Two', artist: 'Artist B', duration: 100 },
    ];

    // Start playing track 10
    await React.act(async () => {
      playerApi.playTrack(tracks[0], tracks);
    });
    await flushAsync();

    const audioEl = playerApi.audioRef.current;
    assert.ok(audioEl, 'Audio element should be mounted');
    assert.equal(audioEl.getAttribute('src'), '/api/stream/10');
    assert.equal(audioEl.playCalls, 1);

    // Advance time to 35s -> should scrobble track 10
    await React.act(async () => {
      audioEl.duration = 100;
      audioEl.currentTime = 35;
      audioEl.dispatchEvent({ type: 'loadedmetadata' });
      audioEl.dispatchEvent({ type: 'timeupdate' });
    });
    assert.deepEqual(scrobbledIds, [10]);

    // Pause track 10 at 35s, then call playTrack on the SAME track 10 -> should call audio.play() without resetting currentTime
    await React.act(async () => {
      playerApi.togglePlay();
    });
    assert.equal(playerApi.isPlaying, false);
    assert.equal(audioEl.paused, true);

    const playCallsBeforeResume = audioEl.playCalls;
    await React.act(async () => {
      playerApi.playTrack(tracks[0], tracks);
    });
    await flushAsync();
    assert.equal(audioEl.playCalls, playCallsBeforeResume + 1);
    assert.equal(playerApi.currentTime, 35);
    assert.equal(playerApi.isPlaying, true);

    // Automatic next on 'ended' -> should advance to track 20 and reset scrobbledRef so track 20 scrobbles
    await React.act(async () => {
      audioEl.dispatchEvent({ type: 'ended' });
    });
    await flushAsync();
    assert.equal(playerApi.currentTrack.id, 20);

    await React.act(async () => {
      audioEl.duration = 100;
      audioEl.currentTime = 35;
      audioEl.dispatchEvent({ type: 'timeupdate' });
    });
    assert.deepEqual(scrobbledIds, [10, 20]);

    // Enable repeat === 'one' (none -> all -> one)
    await React.act(async () => {
      playerApi.toggleRepeat();
      playerApi.toggleRepeat();
    });
    assert.equal(playerApi.repeat, 'one');

    // Trigger 'ended' on track 20 in repeat-one mode -> should reset scrobbledRef and scrobble track 20 again
    await React.act(async () => {
      audioEl.dispatchEvent({ type: 'ended' });
    });
    await flushAsync();
    assert.equal(playerApi.currentTime, 0);

    await React.act(async () => {
      audioEl.currentTime = 35;
      audioEl.dispatchEvent({ type: 'timeupdate' });
    });
    assert.deepEqual(scrobbledIds, [10, 20, 20]);

    // Verify rejected play() promise is caught and sets isPlaying to false
    audioEl._playImpl = () => Promise.reject(new Error('NotAllowedError'));
    await React.act(async () => {
      audioEl.paused = true;
      playerApi.togglePlay();
    });
    await flushAsync();
    assert.equal(playerApi.isPlaying, false);

    // Verify audio error event sets isPlaying to false
    audioEl._playImpl = null;
    await React.act(async () => {
      playerApi.togglePlay();
    });
    await flushAsync();
    assert.equal(playerApi.isPlaying, true);

    await React.act(async () => {
      audioEl.dispatchEvent({ type: 'error' });
    });
    assert.equal(playerApi.isPlaying, false);

    await view.unmount();
  });
});

describe('SearchView and Header: AbortSignal and stale response guards on input change/clear', () => {
  beforeEach(() => {
    createTestDOM();
    setAuthToken('user-jwt');
  });

  it('SearchView aborts in-flight search and ignores stale results when input is cleared', async () => {
    let pendingResolve = null;
    let capturedSignal = null;

    globalThis.fetch = (url, opts = {}) => {
      if (url.startsWith('/api/search')) {
        capturedSignal = opts.signal;
        return new Promise((resolve) => {
          pendingResolve = () =>
            resolve({
              ok: true,
              status: 200,
              json: async () => ({
                tracks: [{ id: 1, title: 'Stale Search Track', artist: 'Old Artist', duration: 120 }],
                albums: [],
                artists: [],
              }),
            });
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
    };

    const view = await render(
      <FavoritesProvider>
        <PlayerProvider>
          <SearchView initialQuery="" />
        </PlayerProvider>
      </FavoritesProvider>
    );

    const input = view.container.find((el) => el.tagName === 'INPUT');
    await changeInput(input, 'stale');
    await flushAsync(320);

    assert.ok(capturedSignal, 'AbortSignal should be passed to search fetch');
    assert.equal(capturedSignal.aborted, false);

    // Clear input while search request is still in-flight
    await changeInput(input, '');
    assert.equal(capturedSignal.aborted, true, 'Clearing input should abort in-flight request');

    // Now resolve the stale promise and verify it does NOT populate results
    pendingResolve();
    await flushAsync(20);

    assert.equal(view.container.textContent.includes('Stale Search Track'), false);
    await view.unmount();
  });

  it('Header aborts in-flight search and does not reopen dropdown when input is cleared', async () => {
    let pendingResolve = null;
    let capturedSignal = null;

    globalThis.fetch = (url, opts = {}) => {
      if (url.startsWith('/api/search')) {
        capturedSignal = opts.signal;
        return new Promise((resolve) => {
          pendingResolve = () =>
            resolve({
              ok: true,
              status: 200,
              json: async () => ({
                tracks: [{ id: 9, title: 'Ghost Dropdown Track', artist: 'Ghost' }],
                albums: [],
                artists: [],
              }),
            });
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
    };

    function HeaderHost() {
      const [q, setQ] = React.useState('');
      return (
        <Header
          searchQuery={q}
          onSearchChange={setQ}
          currentView="home"
          currentViewTitle="Home Hub"
        />
      );
    }

    const view = await render(<HeaderHost />);
    const input = view.container.find((el) => el.tagName === 'INPUT');
    await focusInput(input);
    await changeInput(input, 'ghost');
    await flushAsync(220);

    assert.ok(capturedSignal, 'Header should pass AbortSignal to search');
    assert.equal(capturedSignal.aborted, false);

    // Click Clear button while request is in-flight
    const clearBtn = view.container.find(
      (el) => el.tagName === 'BUTTON' && el.getAttribute('title') === 'Clear search'
    );
    assert.ok(clearBtn);
    await click(clearBtn);

    assert.equal(capturedSignal.aborted, true);

    // Resolve stale response and verify dropdown stays closed and empty
    pendingResolve();
    await flushAsync(20);

    assert.equal(view.container.textContent.includes('Ghost Dropdown Track'), false);
    await view.unmount();
  });
});

describe('TracksView: server pagination/search (limit<=200, offset, q) and multi-page Play All / Shuffle', () => {
  beforeEach(() => {
    createTestDOM();
    setAuthToken('user-jwt');
  });

  it('paginates with limit<=200 & offset, queries server with q, and fetches all matching pages on Play All / Shuffle', async () => {
    const allTracksData = [
      { id: 1, title: 'Alpha', artist: 'Artist 1', duration: 180 },
      { id: 2, title: 'Beta', artist: 'Artist 2', duration: 190 },
      { id: 3, title: 'Gamma', artist: 'Artist 3', duration: 200 },
      { id: 4, title: 'Delta', artist: 'Artist 4', duration: 210 },
      { id: 5, title: 'Epsilon', artist: 'Artist 5', duration: 220 },
    ];

    const trackRequests = [];
    globalThis.fetch = async (url) => {
      if (url.startsWith('/api/tracks')) {
        const u = new URL(url, 'http://localhost');
        const limit = Number(u.searchParams.get('limit'));
        const offset = Number(u.searchParams.get('offset') || 0);
        const q = (u.searchParams.get('q') || '').toLowerCase();
        trackRequests.push({ limit, offset, q });

        assert.ok(limit <= 200, `Expected limit <= 200, got ${limit}`);

        const filtered = q
          ? allTracksData.filter((t) => t.title.toLowerCase().includes(q))
          : allTracksData;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            tracks: filtered.slice(offset, offset + limit),
            total: filtered.length,
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    };

    let playerApi = null;
    function PlayerProbe() {
      playerApi = usePlayer();
      return null;
    }

    const view = await render(
      <FavoritesProvider>
        <PlayerProvider>
          <PlayerProbe />
          <TracksView pageSize={2} />
        </PlayerProvider>
      </FavoritesProvider>
    );
    await flushAsync();

    // Initial load: page 1 (offset 0, limit 2) -> renders only 2 bounded rows out of 5 total
    assert.equal(trackRequests[0].limit, 2);
    assert.equal(trackRequests[0].offset, 0);
    assert.ok(view.container.textContent.includes('Showing 1–2 of 5'));
    assert.ok(view.container.textContent.includes('Alpha'));
    assert.ok(view.container.textContent.includes('Beta'));
    assert.equal(view.container.textContent.includes('Gamma'), false);

    // Navigate to Next page (page 2: offset 2, limit 2)
    const nextBtn = view.container.find(
      (el) => el.tagName === 'BUTTON' && el.getAttribute('aria-label') === 'Next page'
    );
    await click(nextBtn);
    await flushAsync();

    assert.ok(view.container.textContent.includes('Showing 3–4 of 5'));
    assert.ok(view.container.textContent.includes('Gamma'));
    assert.ok(view.container.textContent.includes('Delta'));

    // Click Play All while on page 2 -> must fetch all matching pages (all 5 tracks, not just current page)
    const playAllBtn = view.container.find(
      (el) => el.tagName === 'BUTTON' && el.textContent.includes('Play All')
    );
    await click(playAllBtn);
    await flushAsync();

    assert.equal(playerApi.queue.length, 5);
    assert.deepEqual(
      playerApi.queue.map((t) => t.id),
      [1, 2, 3, 4, 5]
    );
    assert.equal(playerApi.currentTrack.id, 1);

    // Click Shuffle -> must also fetch/use all 5 matching tracks across pages
    const shuffleBtn = view.container.find(
      (el) => el.tagName === 'BUTTON' && el.textContent.includes('Shuffle')
    );
    await click(shuffleBtn);
    await flushAsync();
    assert.equal(playerApi.queue.length, 5);
    assert.deepEqual(
      [...playerApi.queue.map((t) => t.id)].sort((a, b) => a - b),
      [1, 2, 3, 4, 5]
    );

    // Server-side search filter with q parameter
    const filterInput = view.container.find(
      (el) => el.tagName === 'INPUT' && el.getAttribute('placeholder') === 'Filter tracks...'
    );
    await changeInput(filterInput, 'del');
    await flushAsync(200);

    const lastReq = trackRequests[trackRequests.length - 1];
    assert.equal(lastReq.q, 'del');
    assert.equal(lastReq.offset, 0);
    assert.ok(view.container.textContent.includes('Delta'));
    assert.ok(view.container.textContent.includes('(1 songs)'));

    await view.unmount();
  });
});

it('a late 401 from an old session cannot log out a newly signed-in session', async () => {
  createTestDOM();
  setAuthToken('old-session');
  let resolve;
  globalThis.fetch = () => new Promise(r => { resolve = r; });
  const oldRequest = api.me();
  setAuthToken('new-session');
  resolve({ ok: false, status: 401, json: async () => ({ error: 'Expired' }) });
  await assert.rejects(oldRequest, ApiError);
  assert.equal(getAuthToken(), 'new-session');
});

it('clearing a filter before its debounce expires restarts a cancelled initial load', async () => {
  createTestDOM();
  setAuthToken('user-jwt');
  let requests = 0;
  globalThis.fetch = async url => {
    if (url.startsWith('/api/tracks')) {
      if (++requests === 1) return new Promise(() => {});
      return { ok: true, json: async () => ({ total: 1, tracks: [{ id: 55, title: 'Recovered Library' }] }) };
    }
    return { ok: true, json: async () => ({}) };
  };
  const view = await render(<FavoritesProvider><PlayerProvider><TracksView /></PlayerProvider></FavoritesProvider>);
  const input = view.container.find(el => el.tagName === 'INPUT');
  await changeInput(input, 'a');
  await changeInput(input, '');
  await flushAsync();
  assert.equal(requests, 2);
  assert.ok(view.container.textContent.includes('Recovered Library'));
  await view.unmount();
});
