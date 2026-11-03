import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { createTestDOM, render } from './setup.js';
import { ThemeProvider, useTheme } from '../src/context/ThemeContext.jsx';

test('Midnight is the default and replaces removed themes while supported preferences persist', async () => {
  for (const saved of [null, 'violet', 'cyberpunk', 'unknown', 'oled', 'peach', 'cyan']) {
    createTestDOM();
    if (saved) localStorage.setItem('tunecloud-theme', saved);
    let theme;
    function Probe() { theme = useTheme(); return <span>{theme.themes.find(t => t.id === theme.theme)?.name}</span>; }
    const view = await render(<ThemeProvider><Probe /></ThemeProvider>);
    try {
      const expected = ['peach', 'cyan'].includes(saved) ? saved : 'oled';
      assert.equal(theme.theme, expected);
      assert.equal(localStorage.getItem('tunecloud-theme'), expected);
      assert.ok(!theme.themes.some(t => ['violet', 'cyberpunk'].includes(t.id)));
      assert.equal(theme.themes.find(t => t.id === 'oled').name, 'Midnight');
      if (expected === 'oled') assert.equal(view.container.textContent, 'Midnight');
    } finally { await view.unmount(); }
  }
});
