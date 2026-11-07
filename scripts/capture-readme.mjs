/**
 * Refresh README screenshots from a real TuneCloud instance.
 *
 * Setup: npm install --no-save --package-lock=false playwright-core
 * Provide TUNECLOUD_USERNAME and TUNECLOUD_PASSWORD through your environment.
 * Optional: TUNECLOUD_URL, CHROMIUM_PATH, PLAYWRIGHT_MODULE_PATH, SCREENSHOT_DIR,
 * TUNECLOUD_THEME (default: oled / Midnight), CAPTURE_LYRICS_QUERY (default: Выдох), CAPTURE_LYRICS_ARTIST,
 * CAPTURE_ALBUM_QUERY (default: Sqwore),
 * CAPTURE_DETAIL_QUERY (default: Draining Love Story), CAPTURE_SKIP_ALBUMS=1, CAPTURE_ONLY_ALBUMS=1.
 * CAPTURE_DEMOS=1 also refreshes GIF/MP4/WebM demos (requires ffmpeg).
 * CAPTURE_ONLY_DEMOS=1 refreshes only those demos, leaving screenshots unchanged.
 * CAPTURE_ONLY_LYRICS=1 refreshes only the lyrics GIF/MP4/WebM with natural animation.
 * CAPTURE_LYRICS_START selects the demo starting position in seconds (default: 16).
 * CAPTURE_CLEAR_LYRICS=1 omits the capture-only blur for user-supplied lyrics.
 * Run: node scripts/capture-readme.mjs
 *
 * No credentials, tokens, browser profiles, or storage-state files are persisted.
 * Desktop captures are 1920x1080 with no cover hover; mobile captures are 390x844.
 * Screenshots hide the account identity. Surrounding lyric text is blurred;
 * only a short active line is retained in the lyrics capture.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

if (process.argv.includes("--help")) {
  console.log(
    "Set TUNECLOUD_USERNAME and TUNECLOUD_PASSWORD, then run node scripts/capture-readme.mjs. See the script header for setup and optional variables.",
  );
  process.exit(0);
}
if (!process.env.TUNECLOUD_USERNAME || !process.env.TUNECLOUD_PASSWORD) {
  throw new Error("TUNECLOUD_USERNAME and TUNECLOUD_PASSWORD are required");
}
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE_PATH || "playwright-core"
);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(
  process.env.SCREENSHOT_DIR || path.join(root, "pictures"),
);
const base = new URL(process.env.TUNECLOUD_URL || "https://tune.realgeek.ru/");
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox"],
});
const identityStyle =
  ".tune-sidebar > div:last-child > div:last-child { visibility: hidden !important; }";

try {
  await fs.mkdir(output, { recursive: true });
  const page = await browser.newPage({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    reducedMotion: process.env.CAPTURE_ONLY_LYRICS === "1" ? "no-preference" : "reduce",
  });
  page.setDefaultTimeout(30000);
  await page.addInitScript((theme) => {
    localStorage.setItem("tunecloud-theme", theme);
    localStorage.setItem("tunecloud_albums_density", "standard");
  }, process.env.TUNECLOUD_THEME || "oled");
  await page.goto(base.href, { waitUntil: "domcontentloaded" });
  await page
    .getByPlaceholder("Enter your username")
    .fill(process.env.TUNECLOUD_USERNAME);
  await page
    .getByPlaceholder("Enter your password")
    .fill(process.env.TUNECLOUD_PASSWORD);
  await page.getByRole("button", { name: "Sign In", exact: true }).click();
  await page.getByRole("heading", { name: "On repeat", exact: true }).waitFor();

  async function api(route) {
    return page.evaluate(async (route) => {
      const response = await fetch(route, {
        headers: {
          Authorization: `Bearer ${localStorage.getItem("tunecloud-token")}`,
        },
      });
      if (!response.ok)
        throw new Error(`Capture API request failed (${response.status})`);
      return response.json();
    }, route);
  }
  const account = await api('/api/auth/me');
  if (account.user?.username !== process.env.TUNECLOUD_USERNAME) throw new Error('Capture account verification failed');
  console.log('Authenticated account verified');

  async function settle() {
    await page.evaluate(async () => {
      await document.fonts.ready;
      const visible = [...document.images].filter((image) => {
        const rect = image.getBoundingClientRect();
        return (
          rect.bottom > 0 &&
          rect.top < innerHeight &&
          rect.width > 0 &&
          rect.height > 0
        );
      });
      await Promise.race([
        Promise.all(visible.map((image) => image.decode().catch(() => {}))),
        new Promise((resolve) => setTimeout(resolve, 12000)),
      ]);
    });
    await page.locator('.fixed.top-5.right-5').waitFor({ state: 'hidden', timeout: 6000 });
    await page.evaluate(() => document.activeElement?.blur?.());
    await page.mouse.move(0, 0);
    await page.waitForTimeout(350);
  }
  async function shot(name, extraStyle = "") {
    if (process.env.CAPTURE_ONLY_DEMOS === "1") return;
    await settle();
    const mobile = /^(07_|10_)/.test(name);
    const expected = mobile ? { width: 390, height: 844 } : { width: 1920, height: 1080 };
    const actual = page.viewportSize();
    if (actual.width !== expected.width || actual.height !== expected.height) throw new Error(`Unexpected capture dimensions for ${name}`);
    const overlay = page.locator('.full-player-cover-controls');
    if (await overlay.count() && await overlay.evaluate(el => Number(getComputedStyle(el).opacity)) > 0.01) throw new Error('Artwork hover controls must be hidden in gallery captures');
    await page.screenshot({
      path: path.join(output, name),
      fullPage: false,
      style: identityStyle + extraStyle,
    });
    console.log(`Captured ${name}`);
  }
  async function go(route, ready) {
    await page.goto(new URL(route, base).href, {
      waitUntil: "domcontentloaded",
    });
    await page.locator(ready).first().waitFor();
  }

  async function demo(name, steps, extraStyle = "") {
    if (process.env.CAPTURE_DEMOS !== "1" && process.env.CAPTURE_ONLY_DEMOS !== "1" && process.env.CAPTURE_ONLY_LYRICS !== "1") return;
    await settle();
    const frames = await fs.mkdtemp(path.join(os.tmpdir(), "tunecloud-demo-"));
    const style = await page.addStyleTag({ content: identityStyle + extraStyle });
    const run = promisify(execFile);
    let frame = 0;
    const activeLines = new Set();
    try {
      for (const { action, seconds } of steps) {
        if (action) await action();
        for (let index = 0; index < seconds * 10; index++) {
          const started = Date.now();
          if (name === 'lyrics_demo' && index % 10 === 0) {
            const active = await page.locator('.full-player-lyrics .lyrics-line[aria-current="true"]').textContent();
            if (active) activeLines.add(active);
          }
          await page.screenshot({ path: path.join(frames, `${String(frame++).padStart(4, "0")}.png`) });
          await page.waitForTimeout(Math.max(0, 100 - (Date.now() - started)));
        }
      }
      if (name === 'lyrics_demo' && process.env.CAPTURE_ONLY_LYRICS === '1' && activeLines.size < 2) {
        throw new Error('The lyrics demo must show at least two active lines; playback did not advance');
      }
      if (name === 'lyrics_demo') console.log(`Captured ${activeLines.size} distinct active lyric lines`);
      const input = ["-y", "-framerate", "10", "-i", path.join(frames, "%04d.png")];
      await run("ffmpeg", [...input, "-vf", "split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=3", "-loop", "0", path.join(output, `${name}.gif`)]);
      await run("ffmpeg", [...input, "-c:v", "libx264", "-crf", "22", "-preset", "fast", "-pix_fmt", "yuv420p", "-movflags", "+faststart", path.join(output, `${name}.mp4`)]);
      await run("ffmpeg", [...input, "-c:v", "libvpx-vp9", "-crf", "35", "-b:v", "0", "-cpu-used", "6", path.join(output, `${name}.webm`)]);
      console.log(`Captured ${name} (1920x1080 GIF, MP4, WebM)`);
    } finally {
      await style.evaluate(element => element.remove());
      await fs.rm(frames, { recursive: true, force: true });
    }
  }

  async function captureAlbums() {
    await page
      .locator(".tune-sidebar button")
      .filter({ hasText: /^Albums$/ })
      .click();
    await page.getByTitle("Compact Grid", { exact: true }).waitFor();
    const albumQuery = process.env.CAPTURE_ALBUM_QUERY || "Sqwore";
    const input = page.getByPlaceholder(/Search albums|Filter albums/i).first();
    await input.fill(albumQuery);
    await page.waitForTimeout(700);
    await page.getByTitle("Standard Grid", { exact: true }).click();
    await shot("03_albums_toolbar.png");
    await page.getByTitle("Compact Grid", { exact: true }).click();
    await shot("04_compact_grid.png");
  }

  async function findLyricTrack() {
    const query = process.env.CAPTURE_LYRICS_QUERY || "Выдох";
    const trackResult = await api(
      `/api/tracks?q=${encodeURIComponent(query)}&limit=10`,
    );
    const candidates = trackResult.tracks?.filter(track => track.available !== false &&
      (!process.env.CAPTURE_LYRICS_ARTIST || track.artist?.toLowerCase().includes(process.env.CAPTURE_LYRICS_ARTIST.toLowerCase())));
    const track = candidates?.find(track => track.title.toLowerCase() === query.toLowerCase()) || candidates?.[0];
    if (!track?.album_id)
      throw new Error(
        "No available lyric capture track found; set CAPTURE_LYRICS_QUERY",
      );
    console.log(`Capture track: ${track.artist} — ${track.title}`);

    return track;
  }

  if (process.env.CAPTURE_ONLY_LYRICS === "1") {
    const track = await findLyricTrack();
    await go(`/album/${track.album_id}`, 'main table tbody tr');
    const row = page.locator('main table tbody tr').filter({ has: page.getByText(track.title, { exact: true }) }).first();
    await row.hover();
    await row.getByRole('button', { name: `Play ${track.title}`, exact: true }).click();
    await page.waitForFunction(() => document.querySelector('audio')?.readyState >= 1, null, { timeout: 60000 });
    await page.locator('audio').evaluate(audio => audio.pause());
    await page.getByRole('button', { name: 'Lyrics', exact: true }).click();
    await page.locator('.full-player-lyrics .lyrics-line').first().waitFor({ timeout: 90000 });
    const requestedStart = Number(process.env.CAPTURE_LYRICS_START ?? 16);
    if (!Number.isFinite(requestedStart) || requestedStart < 0) throw new Error('CAPTURE_LYRICS_START must be a nonnegative number');
    const timeline = page.locator('.full-player').getByRole('slider', { name: 'Playback position', exact: true });
    await timeline.evaluate((input, position) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, String(Math.min(position, Number(input.max))));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, requestedStart);
    await settle();
    const clear = process.env.CAPTURE_CLEAR_LYRICS === '1';
    await demo('lyrics_demo', [
      { seconds: 1 },
      { action: () => page.locator('audio').evaluate(audio => audio.play()), seconds: 10 },
      { action: () => page.locator('audio').evaluate(audio => audio.pause()), seconds: 1 },
    ], clear ? '' : '.full-player-lyrics .lyrics-line:not([aria-current="true"]) p { filter: blur(12px) !important; }');
  } else if (process.env.CAPTURE_ONLY_ALBUMS === "1") {
    await captureAlbums();
  } else {
    const track = await findLyricTrack();

    async function prepareHome() {
      const preferred = process.env.CAPTURE_DETAIL_QUERY || 'Draining Love Story';
      const candidates = await api('/api/albums?limit=100');
      const maximum = Math.min(candidates.albums?.length || 12, 100);
      for (let attempt = 0; attempt < maximum; attempt++) {
        const title = await page.locator('.spotlight-copy h1').textContent();
        if (title.trim().toLowerCase() === preferred.toLowerCase()) break;
        await page.getByRole('button', { name: 'Switch spotlight album', exact: true }).click();
      }
      await settle();
      await page.locator('.spotlight-art img').evaluate(image => {
        if (!image.complete || !image.naturalWidth) throw new Error('Spotlight artwork failed to load');
      });
    }
    await prepareHome();
    await shot("01_home_hub.png");

    const detailQuery =
      process.env.CAPTURE_DETAIL_QUERY || "Draining Love Story";
    const detailResult = await api(
      `/api/albums?q=${encodeURIComponent(detailQuery)}&limit=10`,
    );
    const detailAlbum =
      detailResult.albums?.find(
        (album) => album.title.toLowerCase() === detailQuery.toLowerCase(),
      ) || detailResult.albums?.[0];
    await go(
      `/album/${detailAlbum?.id || track.album_id}`,
      "main table tbody tr",
    );
    await shot("05_album_detail.png");

    await go(`/album/${track.album_id}`, "main table tbody tr");
    const row = page
      .locator("main table tbody tr")
      .filter({ has: page.getByText(track.title, { exact: true }) })
      .first();
    await row.hover();
    await row.getByRole('button', { name: `Play ${track.title}`, exact: true }).click();
    await page.locator(".playback-bar").waitFor();
    await page.locator("audio").evaluate((audio) => audio.pause());
    // Fill the local playback queue with real tracks using the application's selection controls.
    await go(`/album/${detailAlbum?.id || track.album_id}`, 'main table tbody tr');
    await page.getByRole('button', { name: 'Select tracks', exact: true }).click();
    const selections = page.locator('main table tbody input[type="checkbox"]');
    for (let index = 0; index < Math.min(await selections.count(), 6); index++) await selections.nth(index).check();
    await page.locator('main').getByRole('button', { name: 'Queue', exact: true }).click();

    // Navigate inside the app so that the player and its queue are retained.
    await page
      .locator(".tune-sidebar button")
      .filter({ hasText: /^Home$/ })
      .click();
    await page
      .getByRole("heading", { name: "On repeat", exact: true })
      .waitFor();
    await prepareHome();
    await shot("02_floating_player.png");

    await page.getByRole('button', { name: 'Now playing', exact: true }).click();
    await page.locator('.now-playing-panel').waitFor();
    await page.locator('.np-lyrics-card .lyrics-content[aria-busy="false"]').waitFor({ timeout: 90000 });
    await shot('08_now_playing.png', process.env.CAPTURE_CLEAR_LYRICS === '1' ? '' : '.np-lyrics-card .lyrics-line p, .np-lyrics-card .lyrics-plain { filter: blur(12px) !important; }');
    await page.getByRole('button', { name: 'Close now playing', exact: true }).click();
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.getByRole('button', { name: 'Queue', exact: true }).click();
    await page.locator('.queue-panel').waitFor();
    await shot('09_queue.png');
    await page.getByRole('button', { name: 'Close queue', exact: true }).click();

    await demo('home_demo', [
      { seconds: 2 },
      { action: () => page.getByRole('button', { name: 'Queue', exact: true }).click(), seconds: 3 },
      { action: () => page.locator('main').evaluate(el => el.scrollTo({ top: 340, behavior: 'smooth' })), seconds: 2 },
      { action: () => page.getByRole('button', { name: 'Close queue', exact: true }).click(), seconds: 2 },
      { action: () => page.locator('main').evaluate(el => el.scrollTo({ top: 0, behavior: 'smooth' })), seconds: 2 },
    ]);

    if (process.env.CAPTURE_SKIP_ALBUMS !== "1" && process.env.CAPTURE_ONLY_DEMOS !== "1") await captureAlbums();

    await page.getByRole('button', { name: 'Lyrics', exact: true }).click();
    await page
      .locator('.full-player-lyrics .lyrics-line')
      .first()
      .waitFor({ timeout: 90000 });
    const shortLine = page
      .locator('.full-player-lyrics .lyrics-line')
      .filter({ has: page.locator("p") });
    const index = await shortLine.evaluateAll((lines) =>
      lines.findIndex((line) => {
        const words = line.textContent.trim().split(/\s+/);
        return (
          words.length > 1 &&
          words.length <= 8 &&
          !line.textContent.includes("♪")
        );
      }),
    );
    if (index < 0)
      throw new Error("No short lyric line suitable for the README capture");
    await shortLine.nth(index).click();
    await page.locator("audio").evaluate((audio) => audio.pause());
    await page.locator('[aria-current="true"]').waitFor();
    await shot(
      "06_karaoke_lyrics.png",
      process.env.CAPTURE_CLEAR_LYRICS === '1' ? '' : ' .full-player-lyrics .lyrics-line:not([aria-current="true"]) p { filter: blur(12px) !important; }',
    );
    await demo('lyrics_demo', [
      { seconds: 2 },
      { action: () => page.locator('audio').evaluate(audio => audio.play()), seconds: 6 },
      { action: () => page.locator('audio').evaluate(audio => audio.pause()), seconds: 2 },
    ], process.env.CAPTURE_CLEAR_LYRICS === '1' ? '' : ` .full-player-lyrics .lyrics-line:not(:nth-child(${index + 1})) p { filter: blur(12px) !important; }`);
    await page.getByRole('button', { name: 'Close player view', exact: true }).click();

    await page
      .locator(".tune-sidebar button")
      .filter({ hasText: /^Home$/ })
      .click();
    await page
      .getByRole("heading", { name: "On repeat", exact: true })
      .waitFor();
    await prepareHome();
    await page.setViewportSize({ width: 390, height: 844 });
    await shot("07_mobile.png");
    await page.getByRole('button', { name: `Expand player: ${track.title}`, exact: true }).click();
    await page.locator('.np-mobile').waitFor();
    await shot('10_mobile_now_playing.png');
    console.log("Screenshots refreshed from the live application");
  }
} finally {
  await browser.close();
}
