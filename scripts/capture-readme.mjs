/**
 * Refresh README screenshots from a real TuneCloud instance.
 *
 * Setup: npm install --no-save --package-lock=false playwright-core
 * Provide TUNECLOUD_USERNAME and TUNECLOUD_PASSWORD through your environment.
 * Optional: TUNECLOUD_URL, CHROMIUM_PATH, PLAYWRIGHT_MODULE_PATH, SCREENSHOT_DIR,
 * TUNECLOUD_THEME (default: oled / Midnight), CAPTURE_LYRICS_QUERY (default: Barry Dylan), CAPTURE_ALBUM_QUERY (default: Sqwore),
 * CAPTURE_DETAIL_QUERY (default: Draining Love Story), CAPTURE_SKIP_ALBUMS=1, CAPTURE_ONLY_ALBUMS=1.
 * Run: node scripts/capture-readme.mjs
 *
 * No credentials, tokens, browser profiles, or storage-state files are persisted.
 * Screenshots hide the account identity. Surrounding lyric text is blurred;
 * only a short active line is retained in the lyrics capture.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
    reducedMotion: "reduce",
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
    const viewport = page.viewportSize();
    await page.mouse.move(viewport.width - 10, viewport.height - 10);
    await page.waitForTimeout(350);
  }
  async function shot(name, extraStyle = "", hoverCover = false) {
    await settle();
    if (hoverCover) { await page.locator(".full-player-cover").hover(); await page.waitForTimeout(350); }
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

  if (process.env.CAPTURE_ONLY_ALBUMS === "1") {
    await captureAlbums();
  } else {
    // Find a real vocal track for the player, album, and lyric views.
    const query = process.env.CAPTURE_LYRICS_QUERY || "Barry Dylan";
    const trackResult = await api(
      `/api/tracks?q=${encodeURIComponent(query)}&limit=10`,
    );
    const track = trackResult.tracks?.find(
      (track) => track.available !== false,
    );
    if (!track?.album_id)
      throw new Error(
        "No available lyric capture track found; set CAPTURE_LYRICS_QUERY",
      );

    // Keep the home screen's real selection, switching only if its artwork is missing.
    await settle();
    for (let attempt = 0; attempt < 12; attempt++) {
      const ready = await page
        .locator(".spotlight-art img")
        .evaluateAll((images) =>
          images.some((image) => image.complete && image.naturalWidth > 0),
        );
      if (ready) break;
      await page
        .getByRole("button", { name: "Switch spotlight album" })
        .click();
      await settle();
    }
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
    await row.dblclick();
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
    await shot("02_floating_player.png");

    await page.getByRole('button', { name: 'Now playing', exact: true }).click();
    await page.locator('.now-playing-panel').waitFor();
    await page.locator('.np-lyrics-card .lyrics-content[aria-busy="false"]').waitFor({ timeout: 90000 });
    await page.setViewportSize({ width: 1920, height: 1280 });
    await shot('08_now_playing.png', '.np-lyrics-card .lyrics-line p, .np-lyrics-card .lyrics-plain { filter: blur(12px) !important; }');
    await page.getByRole('button', { name: 'Close now playing', exact: true }).click();
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.getByRole('button', { name: 'Queue', exact: true }).click();
    await page.locator('.queue-panel').waitFor();
    await shot('09_queue.png');
    await page.getByRole('button', { name: 'Close queue', exact: true }).click();

    if (process.env.CAPTURE_SKIP_ALBUMS !== "1") await captureAlbums();

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
      ' .full-player-lyrics .lyrics-line:not([aria-current="true"]) p { filter: blur(12px) !important; }',
      true,
    );
    await page.getByRole('button', { name: 'Close player view', exact: true }).click();

    await page
      .locator(".tune-sidebar button")
      .filter({ hasText: /^Home$/ })
      .click();
    await page
      .getByRole("heading", { name: "On repeat", exact: true })
      .waitFor();
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
