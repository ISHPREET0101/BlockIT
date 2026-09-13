# BlockIT 1.7 verification

Verified locally on Windows x64, September 13, 2026. Only generated fixtures were scanned; no real drive scans or real user-file deletion tests were performed.

## Speed

Alternating paired full scans against the packaged 1.6 worker build, same fixtures, helper startup included:

| Fixture | 1.6 median | 1.7 median | Change |
|---|---:|---:|---|
| 20,000 files, 80 folders | 2,327 ms | 790 ms | 2.9× |
| 120,000 files, 2,400 folders | 12,904 ms | 2,166 ms | 6.0× |

Against the original unpaired 1.6 baseline run on a 120,000-file flat fixture (21.6 s), the 1.7 worker completes in roughly 2.2–2.6 s. Small scans are dominated by fixed process startup, so relative gains grow with tree size. Raw results: `scanner-comparison-1.7.json`. These were warm-cache local tests, not whole-drive, HDD, network, or cold-cache measurements.

## What changed

- The native helper writes protocol responses with a hand-encoder instead of reflection-based serialization, and returns up to 1,024 entries per demand-driven batch (previously 256).
- Several helper processes enumerate different directories in parallel. The lane budget scales with CPU count (two to four) and collapses to one lane after ~96 directories if average open latency exceeds 25 ms on a local path, which suggests a mechanical disk where parallel seeks would hurt. UNC roots keep parallelism.
- Each open response carries the directory's fresh write time and resolved final path, so the worker no longer performs per-directory lstat/realpath. The probe opens the final component without following its reparse point: swapped junctions are caught by the reparse flag, swapped files by the directory flag, and ancestor junction swaps by the resolved path, matching the previous safety checks.
- File rows queue into multi-row inserts (32 per statement) and the five result indexes are built once after enumeration instead of maintained per insert. Because each database holds exactly one scan, index keys omit the constant scan id. Rows land append-only during the scan; mid-scan queries stay correct through bounded table scans.
- Folder roll-ups moved from a SQLite queue table (about seven statements per folder) to an in-memory depth-first frontier with parent reference counts. Children always hold higher row ids than their parents, so cancellation drains partial totals in one descending pass.
- Commits batch 32,768 rows (or one second) behind a 64 MB WAL checkpoint threshold with a 64 MB page cache and 16 KB pages.
- Compatibility (portable) scanning is unchanged in behavior and serialized across lanes so its bounded four-at-a-time metadata concurrency never multiplies.

## Checks

- Strict type checking and unused-code linting.
- 18 unit tests, including native transport backpressure, cancellation, startup failure, malformed output and timeout handling.
- Native versus compatibility metadata: exact file/folder totals (1,702 files including a 1,100-file wide folder), allocation estimates, extensions, timestamps, empty files/folders, Unicode and >260-character paths, junctions and exclusions. Unavailable-helper fallback records one warning and retains exact results.
- Actual native protocol: 1,024-entry maximum batches, no unsolicited read-ahead, self metadata on open and null on continuation, missing-folder errors and EOF shutdown.
- SQLite/query regression: inaccessible/disappearing entries (injected into compatibility scanning), 100,005 generated rows, stable pagination, validation, cache invalidation and complete CSV export; metadata concurrency stayed at or below 4.
- Pause/resume/Stop with partial file results: 2,048 indexed files retained in the recorded run, cancellation-to-worker-exit 115 ms. Partial and completed folder totals reconciled exactly, including parallel interleaving.
- 200,000-row query checks: 181 treemap rows, 50 file rows per page, correct totals and a responsive host event loop.
- Isolated Electron UI suites: scan/navigation/search, treemap interactions and PNG export in both themes, settings persistence, IPC validation and mocked Recycle Bin actions.
- Installer and portable x64 builds remain reproducible via `npm run package:win`; the packaged check asserts the 1.7.0 archive and shipped helper.

## Remaining manual verification

Whole-drive throughput and laptop-wide responsiveness under real workloads, cold-cache HDD/removable/network scans, UAC relaunch, antivirus/SmartScreen prompts, installer use and launch on a clean Windows machine remain unverified. The parallel helper processes each stay below normal priority; total memory use is modestly higher than 1.6 (one small .NET process per lane, bounded batches, 64 MB scan cache).

## Reproduce

```powershell
npm run build
npm test
npm run lint
npm run test:native
npm run test:regression
npm run test:performance
npm run test:ui
npm run package:win
npm run test:packaged
```

The paired benchmark `scripts/compare-scanner-17.cjs` alternates the current build against an archived 1.6 worker copy via `OLD_WORKER=<path>` and writes `docs/scanner-comparison-1.7.json`. `scripts/bench-large.cjs` measures a single build against a 120,000-file generated fixture. `npm run test:packaged` requires a packaged 1.7.0 build in `release/win-unpacked`.
