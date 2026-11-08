import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { createTestDOM, render, flushAsync, click } from './setup.js';
import { AlbumCard } from '../src/components/cards/AlbumCard.jsx';
import { MoreByArtist } from '../src/components/MoreByArtist.jsx';
import { AlbumDetailView } from '../src/views/AlbumDetailView.jsx';
import { PlayerProvider, usePlayer } from '../src/context/PlayerContext.jsx';
import { FavoritesProvider } from '../src/context/FavoritesContext.jsx';
import { api, setAuthToken } from '../src/api.js';

const wrap = children => <FavoritesProvider><PlayerProvider>{children}</PlayerProvider></FavoritesProvider>;
const response = data => ({ ok: true, json: async () => data });

test('More by artist filters requests, excludes current/duplicate releases and supports navigation and playback', async () => {
  createTestDOM(); setAuthToken(null);
  const requests = []; let selected; let artist; let player;
  function Probe() { player = usePlayer(); return null; }
  globalThis.fetch = async url => {
    requests.push(url);
    if (url.startsWith('/api/albums?')) return response({ albums: [
      { id: 10, title: 'Current', artist: 'Artist' }, { id: 20, title: 'Another release', artist: 'Artist', artist_id: 5, year: 2025 },
      { id: 20, title: 'Duplicate' }, { id: 30, title: 'Earlier single', artist: 'Artist', artist_id: 5, year: 2023 },
    ] });
    if (url === '/api/albums/20') return response([{ id: 201, album_id: 20, title: 'Song' }, { id: 202, available: false }]);
    return response({});
  };
  const view = await render(wrap(<><Probe /><MoreByArtist artist={{ id: 5, name: 'Artist' }} albumId={10} onGoToAlbum={a => selected = a} onGoToArtist={a => artist = a} /></>));
  try {
    await flushAsync();
    const params = new URL(requests.find(url => url.startsWith('/api/albums?')), 'http://localhost').searchParams;
    assert.equal(params.get('artist_id'), '5'); assert.equal(params.get('exclude_id'), '10'); assert.equal(params.get('limit'), '10');
    assert.equal(params.get('sort'), 'year_desc');
    const headings = view.container.findAll(el => el.tagName === 'H3').map(el => el.textContent);
    assert.deepEqual(headings, ['Another release', 'Earlier single']);
    await click(view.container.find(el => el.tagName === 'H3' && el.textContent === 'Another release').parentNode.parentNode);
    assert.equal(selected.id, 20);
    await click(view.container.find(el => el.tagName === 'BUTTON' && el.textContent === 'See discography'));
    assert.deepEqual(artist, { id: 5, name: 'Artist' });
    await click(view.container.find(el => el.tagName === 'BUTTON' && el.getAttribute('title') === 'Play Album'));
    await flushAsync(); assert.equal(player.currentTrack.id, 201); assert.equal(player.queue.length, 1);
  } finally { await view.unmount(); }
});

test('empty discographies are hidden; failures offer retry without replacing the album', async () => {
  createTestDOM(); setAuthToken(null);
  let fail = true;
  globalThis.fetch = async () => { if (fail) throw new Error('Offline'); return response({ albums: [] }); };
  const view = await render(wrap(<MoreByArtist artist={{ id: 5, name: 'Artist' }} albumId={10} />));
  try {
    await flushAsync(); assert.ok(view.container.textContent.includes('Could not load more releases.'));
    fail = false; await click(view.container.find(el => el.tagName === 'BUTTON' && el.textContent === 'Retry')); await flushAsync();
    assert.equal(view.container.find(el => el.tagName === 'SECTION'), null);
  } finally { await view.unmount(); }
});

test('album details use the album artist, preserve commas in names, and ignore requests completed after unmount', async () => {
  createTestDOM(); setAuthToken(null);
  let finish; let pendingSignal;
  const original = api.albums;
  api.albums = (params, options) => { assert.equal(params.artist_id, 9); pendingSignal = options.signal; return new Promise(resolve => { finish = resolve; }); };
  globalThis.fetch = async url => response(url === '/api/albums/10' ? [{ id: 101, title: 'Guest track', artist: 'Guest', artist_id: 2, album_artist: 'Earth, Wind & Fire', album_artist_id: 9 }] : {});
  const view = await render(wrap(<AlbumDetailView album={{ id: 10, title: 'Album', artist: 'Earth, Wind & Fire', artist_id: 9 }} />));
  try {
    await flushAsync(); assert.ok(view.container.textContent.includes('More by Earth, Wind & Fire'));
    await view.unmount(); assert.equal(pendingSignal.aborted, true);
    finish({ albums: [{ id: 77, title: 'Late release' }] }); await flushAsync();
  } finally { api.albums = original; }
});


test('albums sharing a title keep independent playback controls', async () => {
  createTestDOM(); setAuthToken(null); let player; let played;
  function Probe() { player = usePlayer(); return null; }
  globalThis.fetch = async () => response({});
  const view = await render(wrap(<><Probe /><AlbumCard album={{ id: 2, title: 'Same title', artist: 'Artist' }} onPlay={album => played = album.id} /></>));
  try {
    await React.act(async () => player.playTrack({ id: 101, album_id: 1, album: 'Same title', title: 'Song' }, [{ id: 101, album_id: 1, album: 'Same title', title: 'Song' }]));
    const play = view.container.find(el => el.tagName === 'BUTTON' && el.getAttribute('title') === 'Play Album');
    assert.ok(play); await click(play); assert.equal(played, 2);
  } finally { await view.unmount(); }
});
