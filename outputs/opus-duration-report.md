# Bug Reproducer

## ✅ FIX_PROVEN — Bug reproduced and fix proven

> The same reproducer changed from failing to passing and broader checks passed.

**Project:** TuneCloud
**Bug:** Opus tracks indexed with zero duration
**Environment:** Linux x86_64, Node.js v26.13.0, music-metadata 12.2.3; disposable PostgreSQL cluster with isolated test schema.
**Generated:** 2026-11-13

## Original report

Длительность Opus-аудиофайлов массово стала 0:00.

| Contract | Expected | Actual |
|---|---|---|
| Observed behavior | Valid 30-second Ogg/Opus files retain their actual duration after import, single-file rescan and incremental repair. | Full and single-file scans stored 0; incremental scan skipped unchanged files with zero duration. |

## Minimal reproduction

A checked-in synthetic 30-second Opus file is copied to .opus and .ogg paths alongside a 0.15-second Opus control. The integration test calls the real scanDirectory and scanSingleFile against an isolated database. It then forces legacy zeros and checks that an incremental scan repairs them while preserving file contents, mtime, track/artist/album IDs, playlist membership, favorites and history.

**Confirming signal:** Before the fix, full and single-file scan assertions failed with 'expected 30 seconds, got 0'; incremental repair processed 0 files instead of 2. Direct parser diagnostic: default=undefined, explicit duration=true=30.

### Reproduction files approved at Gate 1

- [opus-duration.test.js](/home/pirkov/self/server/test/opus-duration.test.js:1) — Real scanner integration regression, four scenarios plus parent test.
- [duration-30s.opus](/home/pirkov/self/server/test/fixtures/tags/duration-30s.opus:1) — Synthetic 440 Hz, 30-second, 48 kHz Opus fixture; no third-party recordings.
- [reproduce-opus-duration.sh](/home/pirkov/self/server/scripts/reproduce-opus-duration.sh:1) — Disposable Unix-socket PostgreSQL cluster and exact targeted test command.

## Red to green evidence

| Evidence | Before fix | After fix |
|---|---:|---:|
| Exit code | 1 | 0 |
| Timed out | False | False |
| Duration | 1,717.479 ms | 1,317.568 ms |
| Same command | — | True |
| Broader suite | — | passed |

### Before — failing evidence

```text
waiting for server to start.... done
server started
TAP version 13
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
# [Migrations] Applying 013_lastfm.sql
# [Migrations] Applying 014_lastfm_web_auth.sql
# [Migrations] Applying 015_lastfm_defaults.sql
# Database migrations up to date
# Found 3 audio files (full scan)
# Unchanged: 0, to process: 3
# Processed 3/3
# Covers extracted: 1/2
# Scan complete in 0s. Processed 3 files.
# Subtest: Opus scan duration and repair of unchanged zero-duration tracks
    # Subtest: full scan stores actual duration for both Opus extensions and short files
    not ok 1 - full scan stores actual duration for both Opus extensions and short files
      ---
      duration_ms: 86.247978
      type: 'test'
      location: '/home/pirkov/self/server/test/opus-duration.test.js:42:13'
      failureType: 'testCodeFailure'
      error: 'expected 30 seconds, got 0'
      code: 'ERR_ASSERTION'
      name: 'AssertionError'
      expected: true
      actual: false
      operator: '=='
      stack: |-
        near (file:///home/pirkov/self/server/test/opus-duration.test.js:10:43)
        TestContext.<anonymous> (file:///home/pirkov/self/server/test/opus-duration.test.js:46:33)
        process.processTicksAndRejections (node:internal/process/task_queues:104:5)
        async Test.run (node:internal/test_runner/test:1409:7)
        async TestContext.<anonymous> (file:///home/pirkov/self/server/test/opus-duration.test.js:42:5)
        async Test.run (node:internal/test_runner/test:1409:7)
        async startSubtestAfterBootstrap (node:internal/test_runner/harness:387:3)
      ...
    # Subtest: single-file rescan stores actual duration
    not ok 2 - single-file rescan stores actual duration
      ---
      duration_ms: 33.574564
      type: 'test'
      location: '/home/pirkov/self/server/test/opus-duration.test.js:50:13'
      failureType: 'testCodeFailure'
      error: 'expected 30 seconds, got 0'
      code: 'ERR_ASSERTION'
      name: 'AssertionError'
      expected: true
      actual: false
      operator: '=='
      stack: |-
        near (file:///home/pirkov/self/server/test/opus-duration.test.js:10:43)
        TestContext.<anonymous> (file:///home/pirkov/self/server/test/opus-duration.test.js:52:7)
        process.processTicksAndRejections (node:internal/process/task_queues:104:5)
        async Test.run (node:internal/test_runner/test:1409:7)
        async TestContext.<anonymous> (file:///home/pirkov/self/server/test/opus-duration.test.js:50:5)
        async Test.run (node:internal/test_runner/test:1409:7)
        async startSubtestAfterBootstrap (node:internal/test_runner/harness:387:3)
      ...
# Found 3 audio files (incremental scan)
# Unchanged: 3, to process: 0
# Covers extracted: 0/2
# Scan complete in 0s. Processed 0 files.
    # Subtest: incremental scan repairs legacy zeros without changing files, IDs or user references
    not ok 3 - incremental scan repairs legacy zeros without changing files, IDs or user references
      ---
      duration_ms: 29.185287
      type: 'test'
      location: '/home/pirkov/self/server/test/opus-duration.test.js:55:13'
      failureType: 'testCodeFailure'
      error: |-
        repair both unchanged long files, skip healthy short Opus

        0 !== 2

      code: 'ERR_ASSERTION'
      name: 'AssertionError'
      expected: 2
      actual: 0
      operator: 'strictEqual'
      stack: |-
        TestContext.<anonymous> (file:///home/pirkov/self/server/test/opus-duration.test.js:66:14)
        process.processTicksAndRejections (node:internal/process/task_queues:104:5)
        async Test.run (node:internal/test_runner/test:1409:7)
        async TestContext.<anonymous> (file:///home/pirkov/self/server/test/opus-duration.test.js:55:5)
        async Test.run (node:internal/test_runner/test:1409:7)
        async startSubtestAfterBootstrap (node:internal/test_runner/harness:387:3)
      ...
# Found 3 audio files (incremental scan)
# Unchanged: 3, to process: 0
# Covers extracted: 0/2
# Scan complete in 0s. Processed 0 files.
    # Subtest: healthy files stay skipped by subsequent incremental scans
    ok 4 - healthy files stay skipped by subsequent incremental scans
      ---
      duration_ms: 23.551737
      type: 'test'
      ...
    1..4
not ok 1 - Opus scan duration and repair of unchanged zero-duration tracks
  ---
  duration_ms: 608.85308
  type: 'test'
  location: '/home/pirkov/self/server/test/opus-duration.test.js:15:1'
  failureType: 'subtestsFailed'
  error: '3 subtests failed'
  code: 'ERR_TEST_FAILURE'
  ...
# parser duration: default=undefined, explicit=30
1..1
# tests 5
# suites 0
# pass 1
# fail 4
# cancelled 0
# skipped 0
# todo 0
# duration_ms 840.640218
```

### After — fixed evidence

```text
waiting for server to start.... done
server started
TAP version 13
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
# [Migrations] Applying 013_lastfm.sql
# [Migrations] Applying 014_lastfm_web_auth.sql
# [Migrations] Applying 015_lastfm_defaults.sql
# Database migrations up to date
# Found 3 audio files (full scan)
# Unchanged: 0, to process: 3
# Processed 3/3
# Covers extracted: 1/2
# Scan complete in 0s. Processed 3 files.
# Subtest: Opus scan duration and repair of unchanged zero-duration tracks
    # Subtest: full scan stores actual duration for both Opus extensions and short files
    ok 1 - full scan stores actual duration for both Opus extensions and short files
      ---
      duration_ms: 70.561536
      type: 'test'
      ...
    # Subtest: single-file rescan stores actual duration
    ok 2 - single-file rescan stores actual duration
      ---
      duration_ms: 25.039325
      type: 'test'
      ...
# Found 3 audio files (incremental scan)
# Unchanged: 1, to process: 2
# Processed 2/2
# Covers extracted: 0/2
# Scan complete in 0s. Processed 2 files.
    # Subtest: incremental scan repairs legacy zeros without changing files, IDs or user references
    ok 3 - incremental scan repairs legacy zeros without changing files, IDs or user references
      ---
      duration_ms: 71.738199
      type: 'test'
      ...
# Found 3 audio files (incremental scan)
# Unchanged: 3, to process: 0
# Covers extracted: 0/2
# Scan complete in 0s. Processed 0 files.
    # Subtest: healthy files stay skipped by subsequent incremental scans
    ok 4 - healthy files stay skipped by subsequent incremental scans
      ---
      duration_ms: 24.082781
      type: 'test'
      ...
    1..4
ok 1 - Opus scan duration and repair of unchanged zero-duration tracks
  ---
  duration_ms: 404.316789
  type: 'test'
  ...
# parser duration: default=undefined, explicit=30
1..1
# tests 5
# suites 0
# pass 5
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 557.125359
```

## Root cause

The scanner omitted duration:true. The installed Ogg parser stops after page sequence 12 once metadata is complete unless duration is requested, while Opus duration is calculated from the final granule position minus pre-skip, at 48000 Hz. Missing format.duration became 0 with parseError=false, allowing existing durations to be overwritten. Incremental selection did not reconsider an unchanged zero-duration Ogg/Opus track. The dependency upgrade in 51d1c6a is the likely introduction point based on Git history; the older dependency was not executed.

## Approved fix

Only scanner.js production behavior changes: request duration:true from music-metadata, and include unchanged .ogg/.opus tracks with nonpositive or absent stored durations in incremental processing. Preserve the existing transactional upsert and identity logic.

**Why this is causal:** duration:true prevents the early Ogg parser exit and makes the final-page timing available. Incremental selection now revisits the exact records persisted with the old missing-duration fallback.

### Production files approved at Gate 2

- [scanner.js](/home/pirkov/self/server/src/scanner.js:532) — Duration calculation and incremental repair selection at line 1178.

## Verification

| Check | Status | Evidence |
|---|---|---|
| Focused Opus regression | ✅ passed | Same command before/after: exit 1 to 0; 5 tests pass, no skips. |
| Full server suite with PostgreSQL | ✅ passed | 160 tests passed, 0 failures, 0 skipped; disposable PostgreSQL cluster; exit 0. |
| Server syntax check | ✅ passed | npm run check --prefix server: exit 0. |
| Patch whitespace | ✅ passed | git diff --check: exit 0. |

## Reproduce

```bash
bash server/scripts/reproduce-opus-duration.sh
```
```bash
env -u TEST_DATABASE_URL bash server/scripts/test-postgres.sh
```
```bash
npm run check --prefix server
```

## Limitations

- No production deployment or production library scan was performed. Existing records recover when an ordinary scan runs with the updated server.
- The regression exercises Opus in .opus and .ogg files; it does not add a long Vorbis fixture.
- The regression proves the behavior of the current dependency; the prior version was not installed or compared.

## Residual risks

- Duration calculation may read more of files whose duration is not available in headers, increasing scan I/O.
- Ogg/Opus files that remain genuinely unreadable or have no positive duration will remain eligible for another incremental scan.

## Notes

- The user approved the named reproduction files, separately requested a fix, and subsequently granted full access and instructed continuation of the fix.
- An initial sandboxed PostgreSQL launch failed before any test assertions; that infrastructure failure is excluded from the red-to-green evidence.
- The 0.15-second existing fixture ended before the parser cutoff and therefore did not cover the reported failure.
- Existing reports for previous investigations are preserved; this task has its own opus-duration evidence/report paths.
- No dependencies, migrations, audio files in the user's library or public API formats were changed.

---

Generated by `$bug-reproducer`. A fix is proven only by the same red-to-green reproducer plus relevant broader checks.
