# Bug Reproducer

## ✅ FIX_PROVEN — Bug reproduced and fix proven

> The same reproducer changed from failing to passing and broader checks passed.

**Project:** TuneCloud
**Bug:** First-artist scrobbling falls back to the library primary artist
**Environment:** v26.13.0 on Linux; focused unit regression, disposable PostgreSQL, React test harness and headless Chromium.
**Generated:** 2026-11-09T19:32:09.894314+00:00

## Original report

The user reports that First credited artist only does not work, alongside a request to redesign Settings and use Pano-style sliders.

| Contract | Expected | Actual |
|---|---|---|
| Observed behavior | When first_artist is enabled and structured credits are absent, use the canonical primary artist already stored in the library. | Before: OG Buda, 163ONMYNECK, Yanix was emitted even though the primary artist was OG Buda. After: the same regression emits OG Buda, preserves full credits when the option is off, and preserves band names containing commas. |

## Minimal reproduction

Call the real metadataPayload with artist=OG Buda, track_artist_credit=OG Buda, 163ONMYNECK, Yanix, metadata={} and first_artist=true.

**Confirming signal:** AssertionError: expected OG Buda, received OG Buda, 163ONMYNECK, Yanix.

### Reproduction files approved at Gate 1

- [lastfm.test.js](/home/pirkov/self/server/test/lastfm.test.js:40) — Unchanged red-to-green test covers missing structured credits, disabled option and a band name containing commas.

## Red to green evidence

| Evidence | Before fix | After fix |
|---|---:|---:|
| Exit code | 1 | 0 |
| Timed out | False | False |
| Duration | 242.258 ms | 227.786 ms |
| Same command | — | True |
| Broader suite | — | passed |

### Before — failing evidence

```text
✔ Last.fm signatures use ASCII ordering, UTF-8 and exclude response parameters (1.632275ms)
✔ sessions are authenticated encrypted and independent of JWT secret (101.197513ms)
✔ Last.fm thresholds exclude short tracks and can only be raised by settings (0.291349ms)
✔ metadata corrections take precedence; first artist requires structured credits (0.276633ms)
✖ first-artist scrobbling uses the library primary artist when structured credits are missing (1.052042ms)
✔ requests are signed form POSTs; errors never expose Last.fm response secrets (2.153084ms)
✔ configuration requires stable encryption and an explicit safe public URL (0.294558ms)
ℹ tests 7
ℹ suites 0
ℹ pass 6
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 198.270905

✖ failing tests:

test at server/test/lastfm.test.js:40:1
✖ first-artist scrobbling uses the library primary artist when structured credits are missing (1.052042ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  + actual - expected

  + 'OG Buda, 163ONMYNECK, Yanix'
  - 'OG Buda'
            ^

      at TestContext.<anonymous> (file:///home/pirkov/self/server/test/lastfm.test.js:42:10)
      at Test.runInAsyncScope (node:async_hooks:226:14)
      at Test.run (node:internal/test_runner/test:1402:25)
      at Test.processPendingSubtests (node:internal/test_runner/test:974:18)
      at Test.postRun (node:internal/test_runner/test:1542:19)
      at Test.run (node:internal/test_runner/test:1467:12)
      at async Test.processPendingSubtests (node:internal/test_runner/test:974:7) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: 'OG Buda, 163ONMYNECK, Yanix',
    expected: 'OG Buda',
    operator: 'strictEqual',
    diff: 'simple'
  }
```

### After — fixed evidence

```text
✔ Last.fm signatures use ASCII ordering, UTF-8 and exclude response parameters (1.637938ms)
✔ sessions are authenticated encrypted and independent of JWT secret (102.039794ms)
✔ Last.fm thresholds exclude short tracks and can only be raised by settings (0.279592ms)
✔ metadata corrections take precedence and structured credits identify the first artist (0.272967ms)
✔ first-artist scrobbling uses the library primary artist when structured credits are missing (0.184268ms)
✔ requests are signed form POSTs; errors never expose Last.fm response secrets (2.150126ms)
✔ configuration requires stable encryption and an explicit safe public URL (0.297432ms)
ℹ tests 7
ℹ suites 0
ℹ pass 7
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 187.18467
```

## Root cause

The first-artist branch read only metadata.artists[0]. If the array was absent it fell through to the full credit string before considering track.artist, even though the database join already supplied the primary artist.

## Approved fix

Fall back to track.artist within the first-artist branch. Keep structured credits first and explicit per-track overrides last.

**Why this is causal:** The canonical primary artist is selected before the full credit fallback, so legacy tracks without structured metadata now honor the option without guessing where to split artist names.

### Production files approved at Gate 2

- [lastfm.js](/home/pirkov/self/server/src/services/lastfm.js:68) — Primary-artist fallback in metadataPayload.

## Verification

| Check | Status | Evidence |
|---|---|---|
| Focused regression / unchanged command | ✅ passed | node --test server/test/lastfm.test.js: exit 1 before, exit 0 after; 7 passed. |
| Server suite | ✅ passed | 155 passed, 0 failed, 0 skipped on disposable PostgreSQL, including migration 015 and new-connection defaults. |
| Client suite | ✅ passed | 91 passed, including percentage slider changes/reset/save and OAuth callback handling. |
| Server syntax and frontend production build | ✅ passed | npm run check --prefix server; npm run build. |
| Chromium visual and native control verification | ✅ passed | No runtime errors or horizontal overflow at 390, 1024, 1440 and 1920 px. Native ArrowRight increments and reset verified for all three sliders; accent theme checked. |

## Reproduce

```bash
node --test server/test/lastfm.test.js
```
```bash
bash server/scripts/test-postgres.sh
```
```bash
npm test --prefix client
```
```bash
npm run check --prefix server
```
```bash
npm run build
```

## Limitations

- Already delivered Last.fm scrobbles are not rewritten. Explicit personal artist corrections continue to override automatic first-artist selection.

## Residual risks

- When neither structured credits nor a primary library artist are present, only the full credit remains available.

## Notes

- Gate 1: user explicitly approved editing server/test/lastfm.test.js and running node --test server/test/lastfm.test.js through the question tool. Gate 2: user separately approved the exact metadataPayload fallback, verification, evidence/report updates and deployment through the question tool.
- Independent authorized UI work: responsive Settings columns, Pano-style sliders with reset and time formatting, new connection defaults (Now Playing off, first artist on), quieter delivery history, and replacement of the hard-coded System & Protocol cards with project links.
- Migration 015 changes only defaults for new connections; existing saved preferences are preserved.
- Previous bug evidence and reports are retained in these artifacts.

---

Generated by `$bug-reproducer`. A fix is proven only by the same red-to-green reproducer plus relevant broader checks.


---

<details>
<summary>Previous verified reports</summary>

# Bug Reproducer

## ✅ FIX_PROVEN — Bug reproduced and fix proven

> The same reproducer changed from failing to passing and broader checks passed.

**Project:** TuneCloud
**Bug:** Last.fm authorization returns to TuneCloud
**Environment:** v26.13.0 on Linux; disposable PostgreSQL and mocked Last.fm boundary; React callback exercised under StrictMode.
**Generated:** 2026-11-09T19:05:37.440080+00:00

## Original report

User grants access on Last.fm but is not redirected back to TuneCloud and the integration stays disconnected.

| Contract | Expected | Actual |
|---|---|---|
| Observed behavior | Last.fm redirects the user to PUBLIC_URL/settings with a token; TuneCloud exchanges that callback token once and shows the connected account. | Before: /connect pre-issued a desktop token, selecting a manual-return flow; production logs contained /connect but no /complete. After: the URL carries only api_key and cb, and callback exchange and credential cleanup pass regression tests. |

## Minimal reproduction

Call the real authenticated /api/lastfm/connect route and inspect its authorization URL. The regression asserts no initial token and no auth.getToken request.

**Confirming signal:** AssertionError: A pre-issued token selects desktop authorization, which does not redirect back to the web callback; actual true, expected false.

### Reproduction files approved at Gate 1

- [lastfm-integration.test.js](/home/pirkov/self/server/test/lastfm-integration.test.js:51) — Unchanged red-to-green assertion checks that web authorization never sends a pre-issued token.

## Red to green evidence

| Evidence | Before fix | After fix |
|---|---:|---:|
| Exit code | 1 | 0 |
| Timed out | False | False |
| Duration | — ms | 36,120.367 ms |
| Same command | — | True |
| Broader suite | — | passed |

### Before — failing evidence

```text
waiting for server to start.... done
server started
npm notice run tunecloud-server@0.1.0 test
npm notice run node --test --test-concurrency=1 test/*.test.js
✔ embedded lyrics retain text and millisecond SYLT timestamps (36.92578ms)
✔ upstream timeout includes a body stalled after successful headers (106.284061ms)
[Migrations] Applying 001_initial.sql
[Migrations] Applying 002_track_mtime.sql
[Migrations] Applying 003_metadata_credits_and_genres.sql
[Migrations] Applying 004_album_dedup_and_subsonic_features.sql
[Migrations] Applying 005_gonic_parity_features.sql
[Migrations] Applying 006_track_lyrics.sql
[Migrations] Applying 007_session_revocation_and_missing_tracks.sql
[Migrations] Applying 008_album_metadata_and_availability.sql
[Migrations] Applying 009_case_insensitive_dedup_and_cleanup.sql
[Migrations] Applying 010_track_identity_and_rename_reconciliation.sql
[Migrations] Applying 011_playback_event_id.sql
[Migrations] Applying 012_release_metadata.sql
[Migrations] Applying 013_lastfm.sql
Database migrations up to date
Found 2 audio files (full scan)
Unchanged: 0, to process: 2
Processed 2/2
Covers extracted: 0/2
Scan complete in 0s. Processed 2 files.
▶ library identity, tag consistency, exact artist matching, playback retries and personal Subsonic lists
  ✔ same directory never supplies identity for an unrelated new album (70.241106ms)
Found 2 audio files (incremental scan)
Unchanged: 2, to process: 0
Covers extracted: 0/4
Scan complete in 0s. Processed 0 files.
  ✔ tag edit refreshes album year/genre, invalidates lyrics, and remains correct after an incremental scan (63.720836ms)
  ✔ a late lookup for old metadata cannot poison the corrected lyrics cache (21.468151ms)
  ✔ a failure during album refresh rolls back both tags on disk and metadata in PostgreSQL (11.709048ms)
  ✔ artist names preserve band punctuation and only whole participant credits match (65.257315ms)
  ✔ retrying an acknowledged or lost playback event cannot double-count it (6.491925ms)
  ✔ Subsonic frequent and recent use personal listening history rather than import dates (107.720263ms)
✔ library identity, tag consistency, exact artist matching, playback retries and personal Subsonic lists (763.776174ms)
[Migrations] Applying 001_initial.sql
[Migrations] Applying 002_track_mtime.sql
[Migrations] Applying 003_metadata_credits_and_genres.sql
[Migrations] Applying 004_album_dedup_and_subsonic_features.sql
[Migrations] Applying 005_gonic_parity_features.sql
[Migrations] Applying 006_track_lyrics.sql
[Migrations] Applying 007_session_revocation_and_missing_tracks.sql
[Migrations] Applying 008_album_metadata_and_availability.sql
[Migrations] Applying 009_case_insensitive_dedup_and_cleanup.sql
[Migrations] Applying 010_track_identity_and_rename_reconciliation.sql
[Migrations] Applying 011_playback_event_id.sql
[Migrations] Applying 012_release_metadata.sql
[Migrations] Applying 013_lastfm.sql
Database migrations up to date
▶ web discovery lists individual participants and hides legacy composite artist cards
  ✔ /api/artists (596.656199ms)
  ✔ /api/artists?q=Scally%20Milano (542.404108ms)
  ✔ /api/artists?q=uglystephan (524.714283ms)
  ✔ /api/search?q=Scally%20Milano (363.79912ms)
  ✔ /api/search?q=uglystephan (343.235617ms)
✔ web discovery lists individual participants and hides legacy composite artist cards (2657.836491ms)
[Migrations] Applying 009_case_insensitive_dedup_and_cleanup.sql
[Migrations] Applying 010_track_identity_and_rename_reconciliation.sql
[Migrations] Applying 011_playback_event_id.sql
[Migrations] Applying 012_release_metadata.sql
[Migrations] Applying 013_lastfm.sql
✔ upgrade from populated pre-009 DB preserves recordings and per-user stars, ratings, credits and track references (120.201353ms)
[Migrations] Applying 001_initial.sql
[Migrations] Applying 002_track_mtime.sql
[Migrations] Applying 003_metadata_credits_and_genres.sql
[Migrations] Applying 004_album_dedup_and_subsonic_features.sql
[Migrations] Applying 005_gonic_parity_features.sql
[Migrations] Applying 006_track_lyrics.sql
[Migrations] Applying 007_session_revocation_and_missing_tracks.sql
[Migrations] Applying 008_album_metadata_and_availability.sql
[Migrations] Applying 009_case_insensitive_dedup_and_cleanup.sql
[Migrations] Applying 010_track_identity_and_rename_reconciliation.sql
[Migrations] Applying 011_playback_event_id.sql
[Migrations] Applying 012_release_metadata.sql
[Migrations] Applying 013_lastfm.sql
▶ audit regressions: tag APIs, atomic album merge, and safe artwork fallback
  ✔ case-only edits reuse artist/album IDs, including albums without artists (91.815236ms)
  ✔ mp3 tag endpoint updates DB/file atomically, enforces admin and rolls back failures (51.165522ms)
  ✔ flac tag endpoint updates DB/file atomically, enforces admin and rolls back failures (41.763497ms)
  ✔ opus tag endpoint updates DB/file atomically, enforces admin and rolls back failures (53.070494ms)
  ✔ ogg tag endpoint updates DB/file atomically, enforces admin and rolls back failures (33.894347ms)
  ✔ m4a tag endpoint updates DB/file atomically, enforces admin and rolls back failures (67.051856ms)
  ✔ unsupported and corrupt files leave source and database intact (4.543737ms)
  ✔ album merge preserves conflicting user links and rolls back on mid-merge failure (10.459024ms)
  ✔ folder artwork rejects outside symlinks, falls back, and cached/embedded artwork still works (208.666049ms)
✔ audit regressions: tag APIs, atomic album merge, and safe artwork fallback (940.889303ms)
▶ comma-separated track and album credits identify individual participants
  ✔ no album artist (1.446461ms)
  ✔ explicit album artist (0.200151ms)
  ✔ participant arrays (0.191905ms)
✔ comma-separated track and album credits identify individual participants (3.133373ms)
[Migrations] Applying 001_initial.sql
[Migrations] Applying 002_track_mtime.sql
[Migrations] Applying 003_metadata_credits_and_genres.sql
[Migrations] Applying 004_album_dedup_and_subsonic_features.sql
[Migrations] A
```

### After — fixed evidence

```text
npm notice run tunecloud-server@0.1.0 test
npm notice run node --test --test-concurrency=1 test/*.test.js
```

## Root cause

A pre-issued token combines the desktop authorization path with an expected web callback. Last.fm desktop authorization asks users to return manually.

## Approved fix

Use Last.fm web authorization, bind callback to the one-time state and current TuneCloud user/login version, and exchange the token only after it returns from Last.fm. Migration 014 permits an initially unknown token hash while retaining validation of older attempts.

**Why this is causal:** Removing the initial token selects the documented web authorization flow that honors cb and supplies a token on return.

### Production files approved at Gate 2

- [lastfm.js](/home/pirkov/self/server/src/routes/lastfm.js:33) — Use web authorization and validate callback state, user, login version and upstream token.
- [014_lastfm_web_auth.sql](/home/pirkov/self/server/src/migrations/014_lastfm_web_auth.sql:1) — Allow initially unknown token hash without invalidating existing attempts.
- [schema.sql](/home/pirkov/self/server/src/schema.sql:198) — Keep canonical schema in sync.
- [lastfm.test.js](/home/pirkov/self/client/test/lastfm.test.js:99) — Verify token exchange exactly once under StrictMode and credential removal from URL.

## Verification

| Check | Status | Evidence |
|---|---|---|
| Server suite / identical reproducer command | ✅ passed | 154 passed, 0 failed, 0 skipped on disposable PostgreSQL. Before: exit 1 on token URL assertion; after: exit 0. |
| Client suite | ✅ passed | 91 passed, including callback token exchange and URL cleanup. |
| Server syntax | ✅ passed | npm run check --prefix server |
| Frontend production build | ✅ passed | npm run build |

## Reproduce

```bash
bash server/scripts/test-postgres.sh
```
```bash
npm test --prefix client
```
```bash
npm run check --prefix server
```
```bash
npm run build
```

## Limitations

- Automated tests mock the Last.fm grant; they do not perform a real user consent flow. Production URL and applied migration will be checked after deployment.

## Residual risks

- A user stuck on the old Last.fm authorization screen must restart Connect Last.fm.

## Notes

- Gate 1: user approved creating and running the reproduction test with “делай”. Gate 2: user separately approved the exact production fix, tests, report artifacts, push and deployment check with “да”.
- Official protocol reference: https://www.last.fm/api/webauth and https://www.last.fm/api/authspec
- Previous evidence and report are retained in these artifacts.

---

Generated by `$bug-reproducer`. A fix is proven only by the same red-to-green reproducer plus relevant broader checks.


---

<details>
<summary>Previous verified report: artist identities and navigation</summary>

# Bug Reproducer

## ✅ FIX_PROVEN — Bug reproduced and fix proven

> The same reproducer changed from failing to passing and broader checks passed.

**Project:** TuneCloud
**Bug:** Separate comma feature artists; retain playlist indexing and folder navigation fixes
**Environment:** Linux, Node v26.13.0, disposable local PostgreSQL over Unix socket, isolated schema; checked-in synthetic MP3 fixture copied into /tmp.
**Generated:** 2026-11-09T18:16:34.568768+00:00

## Discovery scope

- Metadata parsing and scanner import/album refresh/orphan cleanup.
- Artist list, search, participant counts and by-ID/by-name details; Subsonic artist identities.
- Git history of comma splitting and the previous artist-filter change. Existing playlist and folder regressions retained.

## Ranked and tested candidates

| # | Candidate | Contract evidence | Trigger | Location | Confidence | Outcome |
|---:|---|---|---|---|---|---|
| 1 | Comma credits import as a composite artist without ALBUMARTIST | User explicitly requires Scally Milano and uglystephan as separate participants, including artist arrays. | Import an MP3 with ARTIST=Scally Milano, uglystephan and no ALBUMARTIST. | /home/pirkov/self/server/src/metadata.js:2 | high | FIX_PROVEN |
| 2 | Guest-only artist missing from the web list/search/counts | Both credited performers must be discoverable and open the shared track. | Import the same credit with ALBUMARTIST=Scally Milano; uglystephan has no solo track. | /home/pirkov/self/server/src/routes/tracks.js:13 | high | FIX_PROVEN |
| 3 | Full rescan fails to repair a legacy composite identity | Rescan must create the two identities without replacing the track or losing its playlist/favorite/history references. | Seed a legacy composite artist linked to track and album; full-scan the original tagged MP3. | /home/pirkov/self/server/src/scanner.js:1456 | high | FIX_PROVEN |

## Original report

User reported that Scally Milano, uglystephan must be two distinct artists rather than a composite artist card. They approved reproduction and the exact patch, then requested amend and push of the previous commit.

| Contract | Expected | Actual |
|---|---|---|
| Observed behavior | Two separate artist records and cards; each list/search/detail returns the shared track; full rescan removes the obsolete composite and preserves track ID, playlist, favorite, history and MP3 bytes. | Before: parser/import/rescan retained the composite; list count was 1 rather than 2; the guest disappeared even with explicit ALBUMARTIST. After: all 23 unchanged test/subtest records pass. |

## Minimal reproduction

The unchanged test covers scalar artist credits with/without ALBUMARTIST, participant arrays, real MP3 imports, authenticated REST/Subsonic requests, paginated list totals, per-participant track counts, both by-ID/by-name detail pages, and a full rescan seeded with a legacy composite artist. Legacy rescan assertions also check playlist, track favorite, history and original MP3 bytes.

**Confirming signal:** Before: exit 1, 19 failing and 4 passing test/subtest records. Examples: expected [Scally Milano, uglystephan] as two names but received a single combined name; expected artist total 2, got 1. After: exit 0, 23 passed, 0 failed, 0 skipped.

### Reproduction files approved at Gate 1

- [comma-feature-artists.test.js](/home/pirkov/self/server/test/comma-feature-artists.test.js:16) — Unchanged red-to-green integration/metadata reproducer, 23 test/subtest records.
- [reproduce-comma-feature-artists.sh](/home/pirkov/self/server/scripts/reproduce-comma-feature-artists.sh:1) — Disposable PostgreSQL runner; no development or production DB.
- [artist-comma-regression.test.js](/home/pirkov/self/server/test/artist-comma-regression.test.js:9) — Approved replacement of the prior comma-band contract with separate credited participants and hidden legacy composite cards.
- [opensubsonic-compatibility.test.js](/home/pirkov/self/server/test/opensubsonic-compatibility.test.js:114) — Approved fixture update to Simon & Garfunkel; preserves single-identity ampersand punctuation and all artwork/guest compatibility assertions.

## Red to green evidence

| Evidence | Before fix | After fix |
|---|---:|---:|
| Exit code | 1 | 0 |
| Timed out | False | False |
| Duration | 1,275.341 ms | 9,863.601 ms |
| Same command | — | True |
| Broader suite | — | passed |

### Before — failing evidence

```text
waiting for server to start.... done
server started
TAP version 13
# Subtest: comma-separated track and album credits identify individual participants
    # Subtest: no album artist
    not ok 1 - no album artist
      ---
      duration_ms: 2.653512
      type: 'test'
      location: '/home/pirkov/self/server/test/comma-feature-artists.test.js:22:13'
      failureType: 'testCodeFailure'
      error: |-
        Expected values to be strictly deep-equal:
        + actual - expected

          [
        +   'Scally Milano, uglystephan'
        -   'Scally Milano',
        -   'uglystephan'
          ]

      code: 'ERR_ASSERTION'
      name: 'AssertionError'
      expected:
        0: 'Scally Milano'
        1: 'uglystephan'
      actual:
        0: 'Scally Milano, uglystephan'
      operator: 'deepStrictEqual'
      stack: |-
        TestContext.<anonymous> (file:///home/pirkov/self/server/test/comma-feature-artists.test.js:25:14)
        Test.runInAsyncScope (node:async_hooks:226:14)
        Test.run (node:internal/test_runner/test:1402:25)
        Test.start (node:internal/test_runner/test:1262:17)
        TestContext.test (node:internal/test_runner/test:400:20)
        TestContext.<anonymous> (file:///home/pirkov/self/server/test/comma-feature-artists.test.js:22:13)
        Test.runInAsyncScope (node:async_hooks:226:14)
        Test.run (node:internal/test_runner/test:1402:25)
        Test.start (node:internal/test_runner/test:1262:17)
        startSubtestAfterBootstrap (node:internal/test_runner/harness:387:17)
      ...
    # Subtest: explicit album artist
    ok 2 - explicit album artist
      ---
      duration_ms: 0.377406
      type: 'test'
      ...
    # Subtest: participant arrays
    not ok 3 - participant arrays
      ---
      duration_ms: 0.348304
      type: 'test'
      location: '/home/pirkov/self/server/test/comma-feature-artists.test.js:22:13'
      failureType: 'testCodeFailure'
      error: |-
        Expected values to be strictly deep-equal:
        + actual - expected

          [
        +   'Scally Milano, uglystephan',
        -   'Scally Milano',
        -   'uglystephan',
            'Guest'
          ]

      code: 'ERR_ASSERTION'
      name: 'AssertionError'
      expected:
        0: 'Scally Milano'
        1: 'uglystephan'
        2: 'Guest'
      actual:
        0: 'Scally Milano, uglystephan'
        1: 'Guest'
      operator: 'deepStrictEqual'
      stack: |-
        TestContext.<anonymous> (file:///home/pirkov/self/server/test/comma-feature-artists.test.js:25:14)
        Test.runInAsyncScope (node:async_hooks:226:14)
        Test.run (node:internal/test_runner/test:1402:25)
        Test.start (node:internal/test_runner/test:1262:17)
        TestContext.test (node:internal/test_runner/test:400:20)
        TestContext.<anonymous> (file:///home/pirkov/self/server/test/comma-feature-artists.test.js:22:13)
        async Test.run (node:internal/test_runner/test:1409:7)
        async startSubtestAfterBootstrap (node:internal/test_runner/harness:387:3)
      ...
    1..3
not ok 1 - comma-separated track and album credits identify individual participants
  ---
  duration_ms: 4.651218
  type: 'test'
  location: '/home/pirkov/self/server/test/comma-feature-artists.test.js:16:1'
  failureType: 'subtestsFailed'
  error: '2 subtests failed'
  code: 'ERR_TEST_FAILURE'
  ...
# [Migrations] Applying 001_initial.sql
# [Migrations] Applying 002_track_mtime.sql
# [Migrations] Applying 003_metadata_credits_and_genres.sql
# [Migrations] Applying 004_album_dedup_and_subsonic_features.sql
# [Migrations] Applying 005_gonic_parity_features.sql
# [Migrations] Applying 006_track_lyrics.sql
# [Migrations] Applying 007_session_revocation_and_missing_tracks.sql
# [Migrations] Applying 008_album_metadata_and_availability.sql
# [Migrations] Applying 009_case_insensitive_dedup_and_cleanup.sql
# [Migrations] Applying 010_track_identity_and_rename_reconciliation.sql
# [Migrations] Applying 011_playback_event_id.sql
# [Migrations] Applying 012_release_metadata.sql
# Database migrations up to date
# Subtest: import, web discovery, Subsonic and legacy rescan keep comma feature artists separate
    # Subtest: import without ALBUMARTIST
        # Subtest: stored identities and credits
        not ok 1 - stored identities and credits
          ---
          duration_ms: 1.31445
          type: 'test'
          location: '/home/pirkov/self/server/test/comma-feature-artists.test.js:82:21'
          failureType: 'testCodeFailure'
          error: |-
            Expected values to be strictly deep-equal:
            + actual - expected

              [
            +   'Scally Milano, uglystephan'
            -   'Scally Milano',
            -   'uglystephan'
              ]

          code: 'ERR_ASSERTION'
          name: 'AssertionError'
          expected:
            0: 'Scally Milano'
            1: 'uglystephan'
          actual:
            0: 'Scally Milano, uglystephan'
          operator: 'deepStrictEqual'
          stack: |-
            TestContext.<anonymous> (file:///home/pirkov/self/server/test/comma-feature-artists.test.js:84:16)
            process.processTicksAndRejections (node:internal/process/task_queues:104:5)
            async Test.run (node:internal/test_runner/test:1409:7)
            async verify (file:///home/pirkov/self/server/test/comma-feature-artists.test.js:82:7)
            async TestContext.<anonymous> (file:///home/pirkov/self/server/test/comma-feature-artists.test.js:125:11)
            async Test.run (node:internal/test_runner/test:1409:7)
            async TestContext.<anonymous> (file:///home/pirkov/self/server/test/comma-feature-artists.test.js:120:7)
            async Test.run (node:internal/test_runner/test:1409:7)
            async Test.processPendingSubtests (node:internal/test_runner/test:974:7)
          ...
        # Subtest: web list, guest counts and pagination
        not ok 2 - web list, gues
```

### After — fixed evidence

```text
waiting for server to start.... done
server started
TAP version 13
# Subtest: comma-separated track and album credits identify individual participants
    # Subtest: no album artist
    ok 1 - no album artist
      ---
      duration_ms: 1.41851
      type: 'test'
      ...
    # Subtest: explicit album artist
    ok 2 - explicit album artist
      ---
      duration_ms: 0.17797
      type: 'test'
      ...
    # Subtest: participant arrays
    ok 3 - participant arrays
      ---
      duration_ms: 0.262728
      type: 'test'
      ...
    1..3
ok 1 - comma-separated track and album credits identify individual participants
  ---
  duration_ms: 3.116337
  type: 'test'
  ...
# [Migrations] Applying 001_initial.sql
# [Migrations] Applying 002_track_mtime.sql
# [Migrations] Applying 003_metadata_credits_and_genres.sql
# [Migrations] Applying 004_album_dedup_and_subsonic_features.sql
# [Migrations] Applying 005_gonic_parity_features.sql
# [Migrations] Applying 006_track_lyrics.sql
# [Migrations] Applying 007_session_revocation_and_missing_tracks.sql
# [Migrations] Applying 008_album_metadata_and_availability.sql
# [Migrations] Applying 009_case_insensitive_dedup_and_cleanup.sql
# [Migrations] Applying 010_track_identity_and_rename_reconciliation.sql
# [Migrations] Applying 011_playback_event_id.sql
# [Migrations] Applying 012_release_metadata.sql
# Database migrations up to date
# Subtest: import, web discovery, Subsonic and legacy rescan keep comma feature artists separate
    # Subtest: import without ALBUMARTIST
        # Subtest: stored identities and credits
        ok 1 - stored identities and credits
          ---
          duration_ms: 1.405895
          type: 'test'
          ...
        # Subtest: web list, guest counts and pagination
        ok 2 - web list, guest counts and pagination
          ---
          duration_ms: 1146.096089
          type: 'test'
          ...
        # Subtest: web search and detail: Scally Milano
        ok 3 - web search and detail: Scally Milano
          ---
          duration_ms: 863.207905
          type: 'test'
          ...
        # Subtest: web search and detail: uglystephan
        ok 4 - web search and detail: uglystephan
          ---
          duration_ms: 910.226122
          type: 'test'
          ...
        # Subtest: Subsonic artist identities
        ok 5 - Subsonic artist identities
          ---
          duration_ms: 7.629524
          type: 'test'
          ...
        1..5
    ok 1 - import without ALBUMARTIST
      ---
      duration_ms: 2974.629972
      type: 'test'
      ...
    # Subtest: import with ALBUMARTIST
        # Subtest: stored identities and credits
        ok 1 - stored identities and credits
          ---
          duration_ms: 0.798253
          type: 'test'
          ...
        # Subtest: web list, guest counts and pagination
        ok 2 - web list, guest counts and pagination
          ---
          duration_ms: 1058.561403
          type: 'test'
          ...
        # Subtest: web search and detail: Scally Milano
        ok 3 - web search and detail: Scally Milano
          ---
          duration_ms: 854.262348
          type: 'test'
          ...
        # Subtest: web search and detail: uglystephan
        ok 4 - web search and detail: uglystephan
          ---
          duration_ms: 953.738479
          type: 'test'
          ...
        # Subtest: Subsonic artist identities
        ok 5 - Subsonic artist identities
          ---
          duration_ms: 4.09545
          type: 'test'
          ...
        1..5
    ok 2 - import with ALBUMARTIST
      ---
      duration_ms: 2886.493815
      type: 'test'
      ...
# Found 1 audio files (full scan)
# Unchanged: 0, to process: 1
# Processed 1/1
# Covers extracted: 0/1
# Scan complete in 0s. Processed 1 files.
    # Subtest: full rescan repairs legacy identity and retains track references
        # Subtest: stored identities and credits
        ok 1 - stored identities and credits
          ---
          duration_ms: 0.718146
          type: 'test'
          ...
        # Subtest: web list, guest counts and pagination
        ok 2 - web list, guest counts and pagination
          ---
          duration_ms: 1079.187018
          type: 'test'
          ...
        # Subtest: web search and detail: Scally Milano
        ok 3 - web search and detail: Scally Milano
          ---
          duration_ms: 846.657982
          type: 'test'
          ...
        # Subtest: web search and detail: uglystephan
        ok 4 - web search and detail: uglystephan
          ---
          duration_ms: 914.212478
          type: 'test'
          ...
        # Subtest: Subsonic artist identities
        ok 5 - Subsonic artist identities
          ---
          duration_ms: 4.395211
          type: 'test'
          ...
        1..5
    ok 3 - full rescan repairs legacy identity and retains track references
      ---
      duration_ms: 2874.613872
      type: 'test'
      ...
    1..3
ok 2 - import, web discovery, Subsonic and legacy rescan keep comma feature artists separate
  ---
  duration_ms: 9068.920122
  type: 'test'
  ...
1..2
# tests 23
# suites 0
# pass 23
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 9198.358061
```

## Root cause

Comma splitting was removed in 7c265df, replacing the prior extractLeadingArtist comma behavior. The artist-list SQL still hid comma names until the previous patch removed that protection. Participant-only artists were excluded because list/search/counts checked only the primary track/album owner. Orphan cleanup ran before album-artist refresh, leaving a released composite artist after one rescan.

## Approved fix

Restore comma splitting in scalar and array metadata. Reuse a role-limited participant match in artist-list/search discovery and track counts, and hide comma-composite cards. Run orphan cleanup after album refresh. Replace prior comma-band expectations with the user-selected participant contract; preserve ampersand-name and exact-name tests. Keep the previous playlist-index and stale-folder fixes.

**Why this is causal:** The new reproduction file was not changed after its failing baseline. The patch repairs the parser, query visibility/count and cleanup order exercised by those exact assertions. No audio-tag rewrites, migrations, dependency changes or relaxed assertions.

### Production files approved at Gate 2

- [metadata.js](/home/pirkov/self/server/src/metadata.js:2) — Comma separation for artist and album-artist credits, including arrays; shared helper also serves scanner/tag editing.
- [tracks.js](/home/pirkov/self/server/src/routes/tracks.js:13) — Participant visibility and counts in artist list/search, with composite-card exclusion.
- [scanner.js](/home/pirkov/self/server/src/scanner.js:1456) — Refresh album metadata before deleting newly orphaned artist records.

## Verification

| Check | Status | Evidence |
|---|---|---|
| New unchanged reproducer | ✅ passed | bash server/scripts/reproduce-comma-feature-artists.sh: exit 1 to 0; 23 records pass after fix. |
| Complete PostgreSQL suite | ✅ passed | bash server/scripts/test-postgres.sh: 139 passed, 0 failed, 0 skipped; includes retained playlist-index regression. |
| Complete client suite | ✅ passed | npm test --prefix client: 81 passed, 0 failed, 0 skipped; includes retained three-run stale-folder regression. |
| Server syntax | ✅ passed | npm run check --prefix server, exit 0. |
| Production build | ✅ passed | npm run build, exit 0. |
| Whitespace | ✅ passed | git diff --check, exit 0. |

## Reproduce

```bash
bash server/scripts/reproduce-comma-feature-artists.sh
```
```bash
bash server/scripts/test-postgres.sh
```
```bash
npm test --prefix client
```
```bash
npm run check --prefix server
```
```bash
npm run build
```

## Limitations

- Existing deployed libraries need one full metadata rescan after updating; ordinary incremental scans may skip unchanged files.
- Real user music and production databases were not accessed or scanned.
- No manual browser verification was performed; the client suite uses the repository DOM harness.

## Residual risks

- Comma is intentionally always a participant separator under the user-selected rule; genuine comma-containing names are also split.
- The rescan proves preservation of track favorites, playlists and history. A favorite on an obsolete composite artist card is not mapped to one or both replacement artists.

## Notes

- This report supersedes the previous comma-band report and its claimed artist behavior; that expectation was rejected by the user.
- All new reproducer assertions remained identical between red and green. Updating two older test contracts was explicitly approved.
- User approved the complete three-production-file patch, including scanner cleanup order, and requested amend/push.
- Track display credits remain intact: Scally Milano, uglystephan is still shown as the song credit, while artist identities and cards are separate.
- The playlist-index and stale-folder fixes from the previous commit remain unchanged and pass the current full suites.

---

Generated by `$bug-reproducer`. A fix is proven only by the same red-to-green reproducer plus relevant broader checks.

</details>

</details>
