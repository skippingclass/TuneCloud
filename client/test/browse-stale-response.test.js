import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { createTestDOM, render, flushAsync } from './setup.js';
import { PlayerProvider } from '../src/context/PlayerContext.jsx';
import { BrowseView } from '../src/views/BrowseView.jsx';
import { api } from '../src/api.js';

test('folder browsing keeps B visible when the older A response arrives last', async t => {
  for (let attempt = 1; attempt <= 3; attempt++) {
    await t.test(`controlled response order, run ${attempt}`, async () => {
      createTestDOM();
      const original = api.browse;
      const pending = new Map();
      api.browse = dir => new Promise(resolve => pending.set(dir, resolve));
      const content = path => <PlayerProvider><BrowseView browsePath={path} onBrowsePathChange={() => {}} /></PlayerProvider>;
      const view = await render(content('A'));
      try {
        assert.ok(pending.has('A'));
        await view.rerender(content('B'));
        assert.ok(pending.has('B'));
        await React.act(async () => pending.get('B')([{ name: 'B child', path: 'B/child', type: 'dir' }]));
        await flushAsync();
        assert.ok(view.container.textContent.includes('B child'), 'B loads before the delayed A response');
        await React.act(async () => pending.get('A')([{ name: 'A child', path: 'A/child', type: 'dir' }]));
        await flushAsync();
        assert.ok(view.container.textContent.includes('B child'), 'the current folder B must retain its contents after A finishes');
        assert.ok(!view.container.textContent.includes('A child'), 'contents of the old folder must not replace B');
      } finally {
        await view.unmount();
        api.browse = original;
      }
    });
  }
});
