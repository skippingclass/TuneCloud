import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { createTestDOM, render, flushAsync, click, changeInput } from './setup.js';
import { createLastfmTracker, lastfmEligible, lastfmChanged } from '../src/utils/lastfm.js';
import { api } from '../src/api.js';
import { PlayerProvider, usePlayer } from '../src/context/PlayerContext.jsx';
import { LastfmSettings } from '../src/components/common/LastfmSettings.jsx';
import { LastfmTrackModal } from '../src/components/modals/LastfmTrackModal.jsx';

const settings = { enabled: true, now_playing: true, first_artist: false, percent: 50, seconds: 240, min_duration: 30 };
const connected = { configured: true, connected: true, connectionId: 'connection-a', username: 'listener', settings, counts: {} };
beforeEach(() => { createTestDOM(); globalThis.fetch = async () => ({ ok: true, json: async () => ({}) }); });
function fakeClient() {
  const sent = [], now = [];
  return { sent, now, lastfm: async () => structuredClone(connected), lastfmScrobble: async body => { sent.push(body); return { accepted: true }; }, lastfmNowPlaying: async body => { now.push(body); return {}; } };
}
const listening = (extra = {}) => ({ startedAt: 100, seconds: 149, eventId: 'event-a', ...extra });
test('browser threshold respects short tracks and standard rules', () => {
  assert.equal(lastfmEligible(30, 30, settings), false);
  assert.equal(lastfmEligible(300, 149, settings), false);
  assert.equal(lastfmEligible(300, 150, settings), true);
  assert.equal(lastfmEligible(1000, 240, settings), true);
});
test('Now Playing and scrobble use separate once-per-play states', async () => {
  const client = fakeClient(); const tracker = createLastfmTracker('alice', { client });
  try {
    await flushAsync(); const play = listening();
    tracker.sample(play, 1, 300); tracker.sample(play, 1, 300);
    assert.equal(client.now.length, 1); assert.equal(client.sent.length, 0);
    play.seconds = 150; tracker.sample(play, 1, 300); await flushAsync();
    tracker.sample(play, 1, 300); await flushAsync(); assert.equal(client.sent.length, 1);
    assert.equal(client.sent[0].startedAt, 100);
    tracker.sample(listening({ eventId: 'event-b', seconds: 150 }), 1, 300); await flushAsync();
    assert.equal(client.sent.length, 2);
  } finally { tracker.stop(); }
});
test('unacknowledged events survive tracker restart, stay user scoped and never transfer accounts', async () => {
  const client = fakeClient(); client.lastfmScrobble = async () => { throw new Error('offline'); };
  let tracker = createLastfmTracker('alice', { client }); await flushAsync();
  const play = listening({ seconds: 150 }); tracker.sample(play, 1, 300); await flushAsync(); tracker.stop();
  const key = 'tunecloud-lastfm-pending:alice';
  const pending = JSON.parse(localStorage.getItem(key)); assert.equal(pending.length, 1);
  pending[0].retryAt = 0; localStorage.setItem(key, JSON.stringify(pending));
  const next = fakeClient(); tracker = createLastfmTracker('bob', { client: next }); await flushAsync(); tracker.stop(); assert.equal(next.sent.length, 0);
  tracker = createLastfmTracker('alice', { client: next }); await flushAsync(); tracker.stop(); assert.equal(next.sent.length, 1);
  localStorage.setItem(key, JSON.stringify(pending));
  const other = fakeClient(); other.lastfm = async () => ({ ...connected, connectionId: 'connection-b' });
  tracker = createLastfmTracker('alice', { client: other }); await flushAsync(); tracker.stop();
  assert.equal(other.sent.length, 0); assert.deepEqual(JSON.parse(localStorage.getItem(key)), []);
});
test('pause preserves browser queue; switching access token stops all delivery', async () => {
  const client = fakeClient(); let access = 'alice-token'; let enabled = false;
  client.lastfm = async () => ({ ...connected, settings: { ...settings, enabled } });
  localStorage.setItem('tunecloud-lastfm-pending:alice', JSON.stringify([{ trackId: 1, eventId: 'event-a', connectionId: 'connection-a', startedAt: 100, listenedSeconds: 150 }]));
  const tracker = createLastfmTracker('alice', { client, token: () => access });
  try {
    await flushAsync(); assert.equal(client.sent.length, 0);
    enabled = true; lastfmChanged(); await flushAsync(); assert.equal(client.sent.length, 1);
    access = 'bob-token'; tracker.sample(listening({ seconds: 150 }), 1, 300); await flushAsync(); assert.equal(client.now.length, 0);
  } finally { tracker.stop(); }
});
test('player excludes seeks and pauses, persists start time, and separates local history from Last.fm', async () => {
  const originals = { lastfm: api.lastfm, lastfmNowPlaying: api.lastfmNowPlaying, lastfmScrobble: api.lastfmScrobble, scrobble: api.scrobble };
  const client = fakeClient(); Object.assign(api, client);
  let local = 0, player, clock = 0;
  api.scrobble = async () => { local++; return {}; };
  const originalPerformance = globalThis.performance;
  Object.defineProperty(globalThis, 'performance', { configurable: true, value: { now: () => clock } });
  function Probe() { player = usePlayer(); return null; }
  const view = await render(<PlayerProvider userId="alice"><Probe /></PlayerProvider>);
  try {
    await flushAsync();
    await React.act(async () => player.playTrack({ id: 1, title: 'Song', artist: 'Artist', duration: 300 }));
    const audio = player.audioRef.current; audio.duration = 300; audio.readyState = 4;
    await React.act(async () => audio.dispatchEvent({ type: 'playing' }));
    for (let i = 1; i <= 30; i++) await React.act(async () => { clock += 1000; audio.currentTime = i; audio.dispatchEvent({ type: 'timeupdate' }); });
    await flushAsync(); assert.equal(local, 1); assert.equal(client.sent.length, 0);
    await React.act(async () => { audio.dispatchEvent({ type: 'seeking' }); audio.currentTime = 100; audio.dispatchEvent({ type: 'timeupdate' }); audio.dispatchEvent({ type: 'seeked' }); });
    await React.act(async () => { audio.pause(); clock += 100000; audio.dispatchEvent({ type: 'timeupdate' }); });
    assert.equal(client.sent.length, 0);
    await React.act(async () => { audio.play(); audio.dispatchEvent({ type: 'playing' }); });
    for (let i = 1; i <= 120; i++) await React.act(async () => { clock += 1000; audio.currentTime = 100 + i; audio.dispatchEvent({ type: 'timeupdate' }); });
    await flushAsync(); assert.equal(client.sent.length, 1); assert.equal(local, 1);
    const saved = JSON.parse(localStorage.getItem('tunecloud-playback:alice'));
    assert.ok(saved.startedAt > 0); assert.equal(saved.lastfmQueued, true);
  } finally { await view.unmount(); Object.assign(api, originals); Object.defineProperty(globalThis, 'performance', { configurable: true, value: originalPerformance }); }
});
test('settings render connection, diagnostics and editable thresholds', async () => {
  const originals = { lastfm: api.lastfm, lastfmQueue: api.lastfmQueue, lastfmRules: api.lastfmRules, lastfmSettings: api.lastfmSettings };
  Object.assign(api, { lastfm: async () => connected, lastfmQueue: async () => ({ items: [] }), lastfmRules: async () => ({ tracks: [], artists: [] }) });
  let update; api.lastfmSettings = async body => { update = body; return body; };
  const view = await render(<LastfmSettings />);
  try {
    await flushAsync(); assert.ok(view.container.textContent.includes('listener')); assert.ok(view.container.textContent.includes('Pending: 0'));
    const percent = view.container.findAll(n => n.tagName === 'INPUT' && n.type === 'number')[0];
    await changeInput(percent, '75');
    const { submitForm } = await import('./setup.js'); await submitForm(view.container.find(n => n.tagName === 'FORM'));
    assert.equal(update.percent, 75);
  } finally { await view.unmount(); Object.assign(api, originals); }
});
test('web callback exchanges the returned token once and removes credentials from the URL', async () => {
  const originals = { lastfm: api.lastfm, lastfmQueue: api.lastfmQueue, lastfmRules: api.lastfmRules, lastfmComplete: api.lastfmComplete };
  const originalHistory = window.history;
  const state = 'a'.repeat(64), token = 'lastfm-authorized-callback-token';
  const callback = new URL(`http://localhost:5173/settings?lastfm_state=${state}&token=${token}&keep=value`);
  window.location = { href: callback.href, search: callback.search, pathname: callback.pathname };
  let cleanedUrl, exchanges = 0;
  window.history = { state: { idx: 1 }, replaceState: (historyState, title, url) => { cleanedUrl = url; } };
  api.lastfmComplete = async body => {
    assert.equal(cleanedUrl, '/settings?keep=value', 'Clean the URL before exchanging callback credentials');
    assert.deepEqual(body, { state, token });
    exchanges++;
    return { success: true };
  };
  api.lastfm = async () => ({ ...connected, connected: exchanges === 1 });
  api.lastfmQueue = async () => ({ items: [] });
  api.lastfmRules = async () => ({ tracks: [], artists: [] });
  let view;
  try {
    view = await render(<React.StrictMode><LastfmSettings /></React.StrictMode>);
    await flushAsync();
    assert.equal(exchanges, 1);
    assert.ok(view.container.textContent.includes('Connected as listener'));
    assert.equal(cleanedUrl.includes(token), false);
    assert.equal(cleanedUrl.includes(state), false);
  } finally {
    if (view) await view.unmount();
    Object.assign(api, originals);
    if (originalHistory === undefined) delete window.history;
    else window.history = originalHistory;
  }
});
test('correction dialog previews changes and saves personal overrides', async () => {
  const originals = { lastfmTrack: api.lastfmTrack, lastfmSaveTrack: api.lastfmSaveTrack };
  const original = { artist: 'Artist', track: 'Song', album: 'Album', albumArtist: '' };
  api.lastfmTrack = async () => ({ original, preview: original, blocked: false });
  let saved; api.lastfmSaveTrack = async (id, data) => { saved = data; };
  const view = await render(<LastfmTrackModal track={{ id: 1 }} onClose={() => {}} />);
  try {
    await flushAsync(); const dialog = document.body.find(n => n.getAttribute('role') === 'dialog');
    await changeInput(dialog.find(n => n.tagName === 'INPUT'), 'Correct');
    assert.ok(dialog.textContent.includes('Preview: Correct'));
    const { submitForm } = await import('./setup.js'); await submitForm(dialog.find(n => n.tagName === 'FORM'));
    assert.deepEqual(saved.overrides, { artist: 'Correct' });
  } finally { await view.unmount(); Object.assign(api, originals); }
});

test('restored playback preserves the start timestamp and acknowledged state', async () => {
  const originals = { lastfm: api.lastfm, lastfmNowPlaying: api.lastfmNowPlaying, lastfmScrobble: api.lastfmScrobble };
  const client = fakeClient(); Object.assign(api, client);
  const key = 'tunecloud-playback:alice';
  localStorage.setItem(key, JSON.stringify({ queue: [{ id: 1, title: 'Song', duration: 300 }], queueIndex: 0, currentTime: 160, startedAt: 100,
    listenedSeconds: 150, eventId: '12345678-1234-1234-1234-123456789abc', lastfmConnection: 'connection-a' }));
  let player;
  function Probe() { player = usePlayer(); return null; }
  let view;
  try {
    view = await render(<PlayerProvider userId="alice"><Probe /></PlayerProvider>); await flushAsync();
    assert.equal(player.isPlaying, false);
    await React.act(async () => { player.togglePlay(); player.audioRef.current.dispatchEvent({ type: 'playing' }); });
    await flushAsync(); assert.equal(client.sent.length, 1); assert.equal(client.sent[0].startedAt, 100);
    await view.unmount(); view = null;
    view = await render(<PlayerProvider userId="alice"><Probe /></PlayerProvider>); await flushAsync();
    await React.act(async () => { player.togglePlay(); player.audioRef.current.dispatchEvent({ type: 'playing' }); });
    await flushAsync(); assert.equal(client.sent.length, 1);
  } finally { if (view) await view.unmount(); Object.assign(api, originals); }
});
test('100 percent threshold includes the final ended progress with clock precision tolerance', async () => {
  const originals = { lastfm: api.lastfm, lastfmNowPlaying: api.lastfmNowPlaying, lastfmScrobble: api.lastfmScrobble, scrobble: api.scrobble };
  const client = fakeClient(); client.lastfm = async () => ({ ...connected, settings: { ...settings, percent: 100, seconds: 600 } }); Object.assign(api, client);
  api.scrobble = async () => ({});
  const key = 'tunecloud-playback:alice';
  localStorage.setItem(key, JSON.stringify({ queue: [{ id: 1, duration: 300 }], queueIndex: 0, currentTime: 299, startedAt: 100,
    listenedSeconds: 298.99, scrobbled: true, eventId: '12345678-1234-1234-1234-123456789abc', lastfmConnection: 'connection-a' }));
  let player, clock = 0;
  const originalPerformance = globalThis.performance;
  Object.defineProperty(globalThis, 'performance', { configurable: true, value: { now: () => clock } });
  function Probe() { player = usePlayer(); return null; }
  const view = await render(<PlayerProvider userId="alice"><Probe /></PlayerProvider>);
  try {
    await flushAsync(); const audio = player.audioRef.current; audio.duration = 300; audio.readyState = 4;
    await React.act(async () => { player.togglePlay(); audio.dispatchEvent({ type: 'playing' }); });
    assert.equal(client.sent.length, 0);
    await React.act(async () => { clock = 1000; audio.currentTime = 300; audio.ended = true; audio.paused = true; audio.dispatchEvent({ type: 'ended' }); });
    await flushAsync(); assert.equal(client.sent.length, 1); assert.equal(client.sent[0].listenedSeconds, 300);
  } finally { await view.unmount(); Object.assign(api, originals); Object.defineProperty(globalThis, 'performance', { configurable: true, value: originalPerformance }); }
});
