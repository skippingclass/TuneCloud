import "./setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import {
  createTestDOM,
  render,
  changeInput,
  click,
  flushAsync,
} from "./setup.js";
import { setAuthToken } from "../src/api.js";
import { PlayerProvider } from "../src/context/PlayerContext.jsx";
import { AlbumsView } from "../src/views/AlbumsView.jsx";

test("Albums renders genre objects from the API and sends the selected name as its filter", async () => {
  createTestDOM();
  setAuthToken("test-session");
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(url);
    return {
      ok: true,
      status: 200,
      json: async () =>
        url === "/api/genres"
          ? [
              { name: "Electronic", track_count: 12 },
              { name: "Rock", track_count: 4 },
              "Legacy genre",
              { name: "Electronic", track_count: 1 },
              {},
              null,
            ]
          : { albums: [], total: 0 },
    };
  };
  const view = await render(
    <PlayerProvider>
      <AlbumsView />
    </PlayerProvider>,
  );
  try {
    await flushAsync();
    const select = view.container.find(el => el.getAttribute('role') === 'combobox' && el.getAttribute('aria-label') === 'Filter by genre');
    await click(select);
    const options = document.body.findAll(el => el.getAttribute('role') === 'option');
    assert.deepEqual(options.map(el => el.textContent), ['All Genres', 'Electronic', 'Rock', 'Legacy genre']);
    assert.equal(document.body.find(el => el.tagName === 'SELECT'), null);
    await click(options.find(el => el.textContent === 'Electronic'));
    await flushAsync();
    assert.ok(
      requests.some(
        (url) =>
          url.startsWith("/api/albums?") &&
          new URL(url, "http://localhost").searchParams.get("genre") ===
            "Electronic",
      ),
    );
  } finally {
    await view.unmount();
  }
});
