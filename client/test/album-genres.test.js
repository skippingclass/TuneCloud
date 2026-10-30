import "./setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import {
  DOMNode,
  createTestDOM,
  render,
  changeInput,
  flushAsync,
} from "./setup.js";
import { setAuthToken } from "../src/api.js";
import { PlayerProvider } from "../src/context/PlayerContext.jsx";
import { AlbumsView } from "../src/views/AlbumsView.jsx";

// React's native select implementation reads the DOM options collection.
Object.defineProperty(DOMNode.prototype, "options", {
  get() {
    return this.findAll((node) => node.tagName === "OPTION");
  },
});

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
    const select = view.container.find(
      (el) => el.tagName === "SELECT" && el.textContent.includes("All Genres"),
    );
    const options = select.findAll((el) => el.tagName === "OPTION");
    assert.deepEqual(
      options.map((el) => el.textContent),
      ["All Genres", "Electronic", "Rock", "Legacy genre"],
    );
    assert.deepEqual(
      options.map((el) => el.getAttribute("value")),
      ["all", "Electronic", "Rock", "Legacy genre"],
    );
    await changeInput(select, "Electronic");
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
