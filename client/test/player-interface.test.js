import './setup.js';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { createTestDOM, render, click, changeInput, submitForm, flushAsync, getReactProps } from './setup.js';
import { PlayerProvider, usePlayer } from '../src/context/PlayerContext.jsx';
import { SleepTimer, timerRemaining } from '../src/components/player/SleepTimer.jsx';
import { RangeControl } from '../src/components/player/RangeControl.jsx';
import { QueueDrawer, queueSections } from '../src/components/player/QueueDrawer.jsx';

beforeEach(() => {
  createTestDOM();
  globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });
});
const tracks = [1, 2, 3, 4].map(id => ({ id, title: `Interface Song ${id}`, artist: 'Artist', duration: 120 }));
async function harness(content) {
  let player;
  function Probe() { player = usePlayer(); return null; }
  const view = await render(<PlayerProvider><Probe />{content}</PlayerProvider>);
  return { ...view, player: () => player };
}
const named = (root, name) => root.find(el => el.getAttribute('aria-label') === name);

test('range clamps invalid position and keeps accessible native controls with normalized fill', async () => {
  let changed;
  const view = await render(<RangeControl label="Seek" max={100} value={250} onChange={value => changed = value} />);
  try {
    const input = named(view.container, 'Seek');
    assert.equal(input.value, '100');
    assert.equal(input.style['--range-progress'], '100%');
    await changeInput(input, '25');
    assert.equal(changed, 25);
    await view.rerender(<RangeControl label="Seek" max={0} value={20} onChange={() => {}} />);
    assert.equal(named(view.container, 'Seek').disabled, true);
  } finally { await view.unmount(); }
});

test('sleep timer uses a custom dialog with presets, custom duration and cancellation', async () => {
  const view = await harness(<SleepTimer compact />);
  try {
    assert.equal(view.container.find(el => el.tagName === 'SELECT'), null);
    await click(named(view.container, 'Sleep timer'));
    let dialog = named(document.body, 'Sleep timer settings');
    assert.ok(dialog);
    await click(named(dialog, 'Sleep in 30 minutes'));
    assert.ok(Math.abs(view.player().sleepUntil - Date.now() - 30 * 60000) < 1000);
    assert.equal(named(document.body, 'Sleep timer settings'), null);
    await click(named(view.container, 'Sleep timer'));
    dialog = named(document.body, 'Sleep timer settings');
    await changeInput(named(dialog, 'Custom sleep minutes'), '12');
    await submitForm(dialog.find(el => el.tagName === 'FORM'));
    assert.ok(Math.abs(view.player().sleepUntil - Date.now() - 12 * 60000) < 1000);
    await click(named(view.container, 'Sleep timer'));
    dialog = named(document.body, 'Sleep timer settings');
    await click(dialog.find(el => el.tagName === 'BUTTON' && el.textContent === 'End of this track'));
    assert.equal(view.player().sleepUntil, 'track');
    await click(named(view.container, 'Sleep timer'));
    dialog = named(document.body, 'Sleep timer settings');
    await click(dialog.find(el => el.tagName === 'BUTTON' && el.textContent === 'Turn off timer'));
    assert.equal(view.player().sleepUntil, null);
    assert.equal(timerRemaining(61000, 1000), '1:00');
    assert.equal(timerRemaining(500, 1000), '0:00');
  } finally { await view.unmount(); }
});

test('elapsed sleep timer pauses playback without removing the queue and rejects unbounded timers', async () => {
  const view = await harness();
  try {
    await React.act(async () => view.player().playTrack(tracks[0], tracks));
    await React.act(async () => view.player().setSleepTimer(0.0001));
    await flushAsync(25);
    assert.equal(view.player().isPlaying, false);
    assert.equal(view.player().sleepUntil, null);
    assert.equal(view.player().queue.length, 4);
    await React.act(async () => view.player().setSleepTimer(Infinity));
    assert.equal(view.player().sleepUntil, null);
  } finally { await view.unmount(); }
});

test('queue separates now playing/upcoming/history and clears only future entries without restarting audio', async () => {
  const view = await harness(<QueueDrawer />);
  try {
    await React.act(async () => {
      view.player().playTrack(tracks[1], tracks);
      view.player().setIsQueueOpen(true);
    });
    assert.ok(view.container.textContent.includes('Now playing'));
    assert.ok(view.container.textContent.includes('Interface Song 2'));
    assert.ok(view.container.textContent.includes('Interface Song 3'));
    assert.equal(view.container.textContent.includes('Interface Song 1'), false);
    const audio = view.player().audioRef.current;
    const calls = audio.playCalls;
    await React.act(async () => view.player().seek(30));
    await click(named(view.container, 'Clear upcoming tracks'));
    assert.deepEqual(view.player().queue.map(track => track.id), [1, 2]);
    assert.equal(view.player().currentTrack.id, 2);
    assert.equal(view.player().currentTime, 30);
    assert.equal(audio.playCalls, calls);
    assert.equal(view.player().hasNext, false);
    assert.ok(view.container.textContent.includes('All caught up'));
  } finally { await view.unmount(); }
});

test('queue keyboard reorder follows displayed order and clear-upcoming works in shuffle', async () => {
  const view = await harness(<QueueDrawer />);
  try {
    await React.act(async () => { view.player().playTrack(tracks[0], tracks); view.player().setIsQueueOpen(true); });
    const row = view.container.find(el => String(el.className).split(' ').includes('queue-track') && el.textContent.includes('Interface Song 3'));
    await React.act(async () => getReactProps(row).onKeyDown({ altKey: true, key: 'ArrowUp', preventDefault() {} }));
    assert.deepEqual(view.player().queue.map(track => track.id), [1, 3, 2, 4]);
    await React.act(async () => view.player().toggleShuffle());
    await React.act(async () => view.player().next());
    const active = view.player().currentTrack.id;
    const audio = view.player().audioRef.current;
    const calls = audio.playCalls;
    await React.act(async () => view.player().clearUpcoming());
    assert.equal(view.player().queue.length, 2);
    assert.equal(view.player().currentTrack.id, active);
    assert.equal(audio.playCalls, calls);
    assert.equal(view.player().hasNext, false);
    assert.deepEqual(queueSections([3, 1, 0, 2], 1), { previous: [3], upcoming: [0, 2] });
  } finally { await view.unmount(); }
});

test('long queues render bounded batches without truncating playback order', async () => {
  const view = await harness(<QueueDrawer />);
  try {
    const library = Array.from({ length: 151 }, (_, index) => ({ id: index + 1, title: `Long queue ${index + 1}`, duration: 60 }));
    await React.act(async () => { view.player().playTrack(library[0], library); view.player().setIsQueueOpen(true); });
    const countRows = () => view.container.findAll(el => String(el.className).split(' ').includes('queue-track')).length;
    assert.equal(countRows(), 60);
    const more = () => view.container.find(el => el.tagName === 'BUTTON' && el.textContent.startsWith('Show more'));
    await click(more());
    assert.equal(countRows(), 120);
    await click(more());
    assert.equal(countRows(), 150);
    assert.equal(view.player().queue.length, 151);
  } finally { await view.unmount(); }
});

test('queue action menu moves the selected entry next without interrupting current audio', async () => {
  const view = await harness(<QueueDrawer />);
  try {
    await React.act(async () => { view.player().playTrack(tracks[0], tracks); view.player().setIsQueueOpen(true); });
    const calls = view.player().audioRef.current.playCalls;
    await click(named(view.container, 'Actions for Interface Song 3'));
    const actions = named(view.container, 'Queue actions for Interface Song 3');
    await click(actions.find(el => el.tagName === 'BUTTON' && el.textContent === 'Play next'));
    assert.deepEqual(view.player().queue.map(track => track.id), [1, 3, 2, 4]);
    assert.equal(view.player().audioRef.current.playCalls, calls);
    assert.equal(named(view.container, 'Queue actions for Interface Song 3'), null);
  } finally { await view.unmount(); }
});

test('Escape dismisses the playlist modal without closing the docked queue', async () => {
  const view = await harness(<QueueDrawer />);
  try {
    await React.act(async () => { view.player().playTrack(tracks[0], tracks); view.player().setIsQueueOpen(true); });
    await click(named(view.container, 'Save queue as playlist'));
    assert.ok(document.body.textContent.includes('Create playlist') || document.body.textContent.includes('Create Playlist'));
    await React.act(async () => window.dispatchEvent({ type: 'keydown', key: 'Escape', preventDefault() { this.defaultPrevented = true; } }));
    assert.equal(view.player().isQueueOpen, true);
    assert.equal(view.container.find(el => el.getAttribute('role') === 'dialog'), null);
  } finally { await view.unmount(); }
});

test('mobile Escape closes track actions before dismissing the entire queue', async () => {
  window.innerWidth = 390;
  const view = await harness(<QueueDrawer />);
  try {
    await React.act(async () => { view.player().playTrack(tracks[0], tracks); view.player().setIsQueueOpen(true); });
    await click(named(view.container, 'Actions for Interface Song 2'));
    await React.act(async () => window.dispatchEvent({ type: 'keydown', key: 'Escape', preventDefault() { this.defaultPrevented = true; } }));
    assert.equal(view.player().isQueueOpen, true);
    assert.equal(named(view.container, 'Queue actions for Interface Song 2'), null);
    await React.act(async () => window.dispatchEvent({ type: 'keydown', key: 'Escape', preventDefault() { this.defaultPrevented = true; } }));
    assert.equal(view.player().isQueueOpen, false);
  } finally { await view.unmount(); }
});

test('reordering shuffled entries preserves the source album order when shuffle is disabled', async () => {
  const view = await harness();
  try {
    await React.act(async () => view.player().playTrack(tracks[0], tracks));
    await React.act(async () => view.player().toggleShuffle());
    const order = view.player().queueOrder;
    const from = order[3];
    await React.act(async () => view.player().moveInQueue(from, order[1]));
    assert.equal(view.player().queueOrder[1], from);
    assert.deepEqual(view.player().queue.map(track => track.id), [1, 2, 3, 4]);
    await React.act(async () => view.player().toggleShuffle());
    assert.deepEqual(view.player().queueOrder, [0, 1, 2, 3]);
  } finally { await view.unmount(); }
});
