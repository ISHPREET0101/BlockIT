# BlockIT scanning performance analysis (1.9)

Read-only profiling and optimisation of the BlockIT storage scanner. This document
explains how the scanner works, where its time actually went, what changed, and
how to reproduce every number. It is the analysis companion to
`docs/BENCHMARKS.md` (raw results and methodology) and `docs/PR-fast-scan.md`
(review notes).

Measured on the benchmark machine described in `docs/BENCHMARKS.md`. All scans
are read-only metadata passes over local NTFS volumes; no file contents are read
and nothing is written inside the scanned tree.

## 1. Architecture before this branch (`main`, v1.5.0)

The scanner runs in a worker thread (`electron/scanner-worker.ts`) and writes into
a per-scan SQLite database that the query worker reads.

- **Frontier.** A disk-backed queue table (`pending_folders`) drives the traversal.
  Each folder is popped LIFO (`ORDER BY id DESC LIMIT 1`), opened with
  `fs.opendir`, and its entries are pushed back as new rows. One folder is
  processed at a time.
- **Metadata.** Entries are collected in groups of four and resolved with
  `Promise.all([fs.lstat, ...])`, i.e. at most four metadata syscalls in flight
  process-wide (libuv's default thread pool is four).
- **Rows.** Every entry performs one prepared `INSERT` inside a transaction that
  commits every 1,024 rows or 1 second.
- **Politeness.** Every 128 metadata operations the worker calls `breathe()`:
  commit, then `await new Promise(resolve => setTimeout(resolve, 12))`.
- **Progress.** Throttled to two updates per second.
- **Roll-up.** Folder totals are accumulated bottom-up through a phase column on
  the frontier table.

Version 1.5 was itself the result of an earlier pass (`docs/optimization-comparison.json`,
median 1,696 ms to 1,300 ms on 4,000 files) that reduced repeated database work.
It did not change the traversal model.

## 2. Where the time went (measured)

Three cost centres dominated, in this order.

1. **Fixed sleep.** `breathe()` adds a 12 ms sleep every 128 entries. A 4,000-entry
   tree therefore pays about 31 sleeps, roughly 370 ms of wall time doing nothing.
   On a 120,000-entry tree it is about 11 seconds of pure sleeping. This is the
   single largest controllable cost on warm-cache storage, and it is invisible in
   CPU time, which is why earlier CPU-based profiling did not flag it.
2. **Serial directory traversal with a shallow stat window.** One directory at a
   time, four `lstat` calls in flight. Every directory open is a separate round
   trip, and there is no overlap between the walk and the metadata phase.
3. **Per-entry and per-folder overhead in JavaScript.** `path.resolve` plus
   `toLowerCase` plus an exclusion `some()` scan per entry, one prepared statement
   execution per entry, and per-folder `fs.lstat` + `fs.realpath` safety checks.
   Individually small, but paid hundreds of thousands of times.

Recorded baselines: `docs/performance.json` (generated fixture, 4,000 files:
1,500 ms) and `docs/optimization-comparison.json` (1,696 ms to 1,300 ms). The
comparison harness `scripts/performance-check.cjs` keeps both engines side by side
and asserts folder totals recursively, so the numbers come with correctness checks
rather than timings alone.

## 3. What each version changed

The scan engine was rebuilt across 1.6, 1.7, 1.8 and 1.9. Each step is documented
in its own verification file; the summary below is what actually moves the number.

- **1.6 (`docs/verification-1.6.md`).** Introduced a small native helper
  (`native/DirectoryReader.cs`, compiled with the in-box .NET Framework compiler)
  that enumerates a directory subtree and streams compact JSON records, 256 per
  batch. 20,000 files: 4,480 ms to 1,772 ms.
- **1.7 (`docs/verification-1.7.md`).** Hand-encoded protocol writer, 1,024-entry
  demand-driven batches, several helper processes running in parallel lanes
  (budget scales with cores, collapses to one lane when measured open latency
  suggests a mechanical disk), directory write time and resolved path returned
  with each open so per-directory `lstat`/`realpath` disappeared, 32-row inserts,
  indexes built once after enumeration, roll-ups moved to an in-memory depth-first
  frontier with parent reference counts, 32,768-row commits behind a 64 MB WAL
  threshold. 20,000 files: 2,327 ms to 790 ms. 120,000 files: 12,904 ms to
  2,166 ms.
- **1.8 (`docs/verification-1.8.md`).** NTFS Master File Table mode for drive
  roots: one sequential read of `$MFT` builds the whole volume tree in memory and
  streams it over the same protocol, 4,096 entries per batch. The nodes table
  dropped its constant `scan_id` column and the live "top files/folders" lists
  moved to a small `scan_top` table so mid-scan refreshes stay cheap. Walk lanes
  grew to a 16-lane cap. A real 193,143-entry development tree went from 101.6 s
  (1.7 walk) to 3.3 s (1.8 walk), 31x, with node-for-node identical output.
- **1.9 (this branch).** Fixes the volume-mode dispatch bug described below,
  commits a multi-batch volume regression fixture, and upgrades the treemap. The
  scanner engine itself is the 1.8 engine plus that fix.

## 4. The bug this branch fixes

The 1.8 branch shipped one release-blocking defect, recorded as "fix pending" in
`docs/verification-1.8.md`: elevated whole-drive MFT scans stopped after the first
4,096-entry batch.

Root cause, on both sides of the helper protocol:

- `native/DirectoryReader.cs` kept a per-request flag: `volumeRequest = op == "volume"`.
  A volume walk streams through repeated `{"op":"next"}` requests, so on the first
  continuation the flag became `false` and the request was routed to the directory
  walk writer. That writer had empty walk state, so it answered `done: true`
  immediately. The scan therefore "completed" with 4,096 of ~2.9M entries and no
  warning.
- `electron/scanner-worker.ts` matched this by sending a bare `next` for volume
  continuations with no way to signal which engine it belonged to.

The fix makes engine routing sticky for the duration of a volume walk
(`startsVolume` plus `"next"` inheriting the active engine), passes `null` as the
directory on continuations so the already-loaded MFT state is reused rather than
reloaded, and adds an explicit `readVolumeNext()` on the worker client. See
`docs/PR-fast-scan.md` for the exact diff.

Why it survived the original test suite: the crafted-MFT fixture had about twenty
records, so its first batch always ended in `done: true` and a continuation was
never requested. The fixture also lived in the git-ignored `.bench/` directory, so
it was never part of the repository's checks. It is now committed as
`scripts/volume-fixture-check.cjs` with a 9,000-file volume image that forces
three batches, plus the original structural assertions.

## 5. Correctness method

Speed is only meaningful if the output is unchanged. The benchmark harness
(`scripts/bench-scan.cjs`) scans the same tree with both engines and compares:

- node, file, folder and link counts;
- total logical bytes;
- the root node's rolled-up size, file count and folder count;
- every category and extension aggregate row;
- a SHA-256 digest over every row's path, kind, size and parent *path* (structure
  is compared by path, not by internal row id, because traversal order may assign
  different ids to an identical tree).

A paired run only counts as valid when all of those match; the harness exits
non-zero otherwise. `scripts/native-scanner-check.cjs` independently compares the
native engine against the compatibility engine on generated fixtures, and
`scripts/performance-check.cjs` re-derives every folder total with a recursive
query. Edge cases (junctions and junction cycles, unreadable and disappearing
entries, empty folders, Unicode and >260-character paths, exclusions, pause,
resume, cancel) are covered by `scripts/regression-check.cjs`,
`scripts/native-scanner-check.cjs` and `electron/native-directory.test.ts`.

## 6. Reproducing

```powershell
npm install
npm run build                 # typecheck + native helper + worker + renderer
npm test                      # unit tests (vitest)
npm run lint                  # strict unused-code checks
npm run test:volume           # crafted-MFT fixture incl. multi-batch continuation
npm run test:native           # native engine vs compatibility engine
npm run test:regression
npm run test:performance
npm run test:ui               # Electron UI, treemap and action suites
npm run bench:scan suite      # before/after benchmarks -> docs/benchmark-1.9.json
```

`bench:scan suite` generates small (4,000 files), medium (30,000 files) and
large/deep (86,000 files, including an 80-level chain and a 6,000-file flat
folder) fixtures under `.bench/fixtures/`, then benchmarks each plus the real
tree at `%REAL_TREE%` (default `D:\Projects`) against the archived v1.5 worker in
`.bench/main15/worker/scanner-worker.js`. Override with `BEFORE_WORKER`,
`AFTER_WORKER`, `REAL_TREE`, `TRIALS` and `OUT`.
