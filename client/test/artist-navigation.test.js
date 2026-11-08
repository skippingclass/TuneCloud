import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { createTestDOM, render, flushAsync, click } from './setup.js';
import { ArtistLinks, parseArtistTokens } from '../src/components/common/ArtistLinks.jsx';
import { ArtistDetailView } from '../src/views/ArtistDetailView.jsx';
import { PlayerProvider, usePlayer } from '../src/context/PlayerContext.jsx';
import { FavoritesProvider } from '../src/context/FavoritesContext.jsx';
import { api, setAuthToken } from '../src/api.js';
import { buildUrl, parseLocation } from '../src/App.jsx';

const wrap = node => <FavoritesProvider><PlayerProvider>{node}</PlayerProvider></FavoritesProvider>;
const reply = value => ({ ok: true, json: async () => value });

test('feature links use the selected performer ID, preserve bands, and support names starting with digits', async () => {
  createTestDOM(); setAuthToken(null); let target;
  const view = await render(<ArtistLinks artist="Scally Milano, 163ONMYNECK, FEARMUCH" primaryArtistId={1} primaryArtistName="Scally Milano"
    artists={[{ id: '1', name: 'Scally Milano' }, { id: '2', name: '163ONMYNECK' }, { id: '3', name: 'FEARMUCH' }]} onGoToArtist={a => target = a} />);
  try {
    await click(view.container.find(el => el.getAttribute('title') === 'Go to artist: 163ONMYNECK'));
    assert.deepEqual(target, { id: '2', name: '163ONMYNECK' });
    assert.equal(buildUrl('artist', target), '/artist/2');
    assert.deepEqual(parseLocation('/artist/163ONMYNECK', ''), { view: 'artist', param: { name: '163ONMYNECK' } });
    assert.deepEqual(parseArtistTokens('Earth, Wind & Fire feat. Guest', [{ name: 'Earth, Wind & Fire' }, { name: 'Guest' }]), ['Earth, Wind & Fire', ' feat. ', 'Guest']);
  } finally { await view.unmount(); }
});

test('Appears On is separate from own discography, respects explicit ownership and plays full guest albums', async () => {
  createTestDOM(); setAuthToken(null); let player;
  function Probe() { player = usePlayer(); return null; }
  const own = { id: 10, title: 'Own album', artist: 'Alternate credit', artist_id: 99, is_primary_album: true, track_count: 8 };
  const feature = { id: 20, title: 'Really Rich', artist: 'Scally Milano', artist_id: 1, is_primary_album: false, track_count: 12 };
  globalThis.fetch = async url => reply(url === '/api/artists/2' ? {
    artist: { id: 2, name: '163ONMYNECK' }, albums: [own, feature], tracks: [{ id: 21, title: 'Два', artist: 'Scally Milano, 163ONMYNECK', album_id: 20, album: 'Really Rich' }],
  } : url === '/api/albums/20' ? [{ id: 21, title: 'Два', album_id: 20 }, { id: 22, title: 'Another album track', album_id: 20 }] : {});
  const view = await render(wrap(<><Probe /><ArtistDetailView artist={{ id: 2, name: '163ONMYNECK' }} /></>));
  try {
    await flushAsync();
    const appears = view.container.find(el => el.tagName === 'SECTION' && el.getAttribute('aria-label') === 'Appears On');
    assert.ok(appears.textContent.includes('Really Rich')); assert.ok(!appears.textContent.includes('Own album'));
    assert.ok(view.container.textContent.includes('All (1)'));
    const ownGrid = view.container.findAll(el => el.className.includes('album-grid')).find(el => el !== appears.find(n => n.className.includes('album-grid')));
    assert.ok(ownGrid.textContent.includes('Own album')); assert.ok(!ownGrid.textContent.includes('Really Rich'));
    await click(appears.find(el => el.tagName === 'BUTTON' && el.getAttribute('title') === 'Play Album')); await flushAsync();
    assert.deepEqual(player.queue.map(track => track.id), [21, 22]);
  } finally { await view.unmount(); }
});

test('artist navigation clears old data and ignores late requests and portraits', async () => {
  createTestDOM(); setAuthToken(null); let latePortrait;
  globalThis.fetch = async url => {
    if (url === '/api/artists/1') return reply({ artist: { id: 1, name: 'Scally Milano' }, albums: [], tracks: [{ id: 11, title: 'Scally solo' }] });
    if (url.startsWith('/api/spotify/artist?name=Scally')) return new Promise(resolve => { latePortrait = () => resolve(reply({ found: true, artist: { image: '/old-photo.jpg' } })); });
    if (url.includes('/api/artists/by-name?')) return reply({ artist: { id: 2, name: '163ONMYNECK' }, albums: [{ id: 20, title: 'Really Rich', artist_id: 1, artist: 'Scally Milano', is_primary_album: false, track_count: 12 }], tracks: [{ id: 22, title: 'Guest song', album_id: 20 }] });
    return reply({});
  };
  let navigate;
  function Harness() { const [artist, setArtist] = React.useState({ id: 1, name: 'Scally Milano' }); navigate = setArtist; return <ArtistDetailView artist={artist} />; }
  const view = await render(wrap(<Harness />));
  try {
    await flushAsync(); assert.ok(view.container.textContent.includes('Scally solo'));
    await React.act(async () => navigate({ name: '163ONMYNECK' })); await flushAsync();
    await React.act(async () => latePortrait()); await flushAsync();
    assert.equal(view.container.find(el => el.tagName === 'H1').textContent, '163ONMYNECK');
    assert.ok(view.container.textContent.includes('Guest song')); assert.ok(!view.container.textContent.includes('Scally solo'));
    assert.equal(view.container.find(el => el.tagName === 'IMG' && el.getAttribute('src') === '/old-photo.jpg'), null);
  } finally { await view.unmount(); }
});
