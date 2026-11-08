import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { createTestDOM, render, click, getReactProps } from './setup.js';
import { Select } from '../src/components/common/Select.jsx';
import { useConfirmation } from '../src/hooks/useConfirmation.jsx';

const key = async (node, value) => React.act(async () => getReactProps(node).onKeyDown({ key: value, preventDefault() {}, stopPropagation() {} }));
const options = [{ value: 'all', label: 'All Years' }, { value: '2026', label: '2026' }, { value: '2025', label: '2025' }];

test('themed select supports pointer selection, arrow keys, typeahead, Escape and outside dismissal', async () => {
  createTestDOM(); let value = 'all';
  function Harness() { const [selected, setSelected] = React.useState('all'); return <Select label="Year" options={options} value={selected} onChange={v => { value = v; setSelected(v); }} />; }
  const view = await render(<Harness />);
  try {
    const trigger = view.container.find(el => el.getAttribute('role') === 'combobox');
    assert.equal(document.body.find(el => el.tagName === 'SELECT'), null);
    await click(trigger);
    assert.ok(document.body.find(el => el.getAttribute('role') === 'listbox'));
    await click(document.body.find(el => el.getAttribute('role') === 'option' && el.textContent === '2025'));
    assert.equal(value, '2025'); assert.equal(trigger.getAttribute('aria-expanded'), 'false'); assert.equal(document.activeElement, trigger);
    await key(trigger, 'ArrowDown'); await key(trigger, 'Home'); await key(trigger, 'ArrowDown'); await key(trigger, 'Enter');
    assert.equal(value, '2026');
    await key(trigger, '2'); await key(trigger, '0'); await key(trigger, '2'); await key(trigger, '5'); await key(trigger, 'Enter');
    assert.equal(value, '2025');
    await click(trigger); await key(trigger, 'Escape'); assert.equal(trigger.getAttribute('aria-expanded'), 'false');
    await click(trigger);
    await React.act(async () => document.dispatchEvent({ type: 'pointerdown', target: document.body }));
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
    await click(trigger); await key(trigger, 'Tab'); assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  } finally { await view.unmount(); }
});

test('TuneCloud confirmation requires an explicit choice and cancellation never runs the action', async () => {
  createTestDOM(); let completed = 0;
  function Harness() { const { confirm, confirmation } = useConfirmation(); return <><button onClick={() => { confirm({ title: 'Delete playlist?', description: 'Playlist example' }).then(ok => { if (ok) completed++; }); }}>Delete playlist</button>{confirmation}</>; }
  const view = await render(<Harness />);
  try {
    const start = view.container.find(el => el.tagName === 'BUTTON');
    await click(start); assert.equal(completed, 0); assert.ok(document.body.find(el => el.getAttribute('role') === 'alertdialog'));
    await click(document.body.find(el => el.tagName === 'BUTTON' && el.textContent === 'Cancel')); assert.equal(completed, 0);
    await click(start); await React.act(async () => window.dispatchEvent({ type: 'keydown', key: 'Escape', preventDefault() {} }));
    assert.equal(completed, 0); assert.equal(document.body.find(el => el.getAttribute('role') === 'alertdialog'), null);
    await click(start); await click(document.body.find(el => el.tagName === 'BUTTON' && el.textContent === 'Delete')); assert.equal(completed, 1);
  } finally { await view.unmount(); }
});
