# BlockIT 1.8 verification

Verified locally on Windows x64 (16 logical cores, NVMe SSDs), September 13, 2026. Real-drive benchmarking and MFT-mode checks ran elevated; correctness fixtures were scanned as a normal user. No real user-file deletion tests were performed.

## Speed

Paired alternating full scans of the real `C:\` drive (elevated, warm cache, helper startup, index build and checkpoint included), archived packaged 1.7 worker versus the 1.8 worker:

| Engine | Median wall time | Entries |
|---|---:|---:|
| 1.7 (directory walk, single reader) | {{C_OLD}} | {{C_OLD_ENTRIES}} |
| 1.8 (MFT volume scan) | {{C_NEW}} | {{C_NEW_ENTRIES}} |

{{C_NOTE}}

The non-elevated fallback path was measured the same way on a real 193,143-entry development tree (`D:\Projects`): 1.7 walk **101.6 s** → 1.8 walk **3.3 s** median (**31×**), with node-for-node identical results in both engines (193,143 nodes, 172,753 files, 9,120,080,293 bytes). Raw results: `scanner-comparison-1.8.json` (drive), `scanner-comparison-1.8-fallback.json` (tree).

> **Known issue (fix pending):** the elevated `C:\` 1.8 MFT runs currently recorded in `scanner-comparison-1.8.json` are **invalid** — they truncate after the first 4,096-entry batch (4,436 entries instead of ~2.9M) because the helper dispatches volume-mode `next` requests to the walk writer instead of continuing the volume walk. Diagnostics (`BLOCKIT_VOLUME_DEBUG=1`) confirm the MFT parse itself is complete and correct: all 14 `$MFT` extents read, all 2,816,768 records accounted for (2,779,042 parsed, drops fully explained), 2,736,711 linked into the tree. The 1.7 baseline medians (1,779.5 s / 1,567.3 s) are valid. The dispatch fix, a re-measured full-drive MFT run, and the final table above remain to be completed on this branch.

## What changed

- On a drive root (`C:\`), the native helper reads the NTFS Master File Table directly: one sequential pass builds the whole volume tree in memory and streams it over the same demand-driven wire protocol the directory walk uses (≤4,096 entries per batch), so the worker needed only a thin dispatch change. Opening `\\.\C:` requires administrator rights; access denial is reported distinctly and the worker falls back to the walk lanes with a warning. `metadataEngine: 'portable'` still forces the compatibility engine everywhere.
- MFT parsing: boot sector → `$MFT` → FILE records with update-sequence fixups; `$FILE_NAME` supplies parent and name, `$STANDARD_INFORMATION` the mtime, `$DATA` the logical size. Deleted records, NTFS metafiles and extension records are skipped; reparse points are reported as links and never descended; hardlinks are counted per link, matching the walk engine. Unknown or malformed records are skipped with a warning rather than failing the scan. Subtree scans resolve the requested root's FRN, so non-drive-root scans use the same engine when elevated.
- The app probes the volume handle through the helper (`admin` op — the exact capability the MFT scan needs, so no PowerShell detour). When a scan targets a drive root without elevation, a dialog offers "Restart as administrator" (UAC relaunch with the scan root handed over) or continuing with the standard scan; cancelling UAC simply continues.
- Walk-engine improvements for the fallback and non-admin path: batches grew from 1,024 to 4,096 entries, the per-directory `pathById` SQL lookup became an in-memory map, the lane budget caps at 16 (default `min(8, cpus/2)`, `SCAN_LANES`-style override honored), and the nodes table dropped the constant `scan_id` column (one database holds one scan), removing it from row payloads and every query on `C:\`-scale scans.
- A real-drive reconciliation caught a subtle protocol-split bug before release: directories beyond the helper's 2,048-dir walk cap were announced both as lane-local `dirs` and as caller-scheduled `pending`, and the worker processed `doneDirs` first — deleting the parent lookups `pending` needed, so those subtrees were silently dropped (a `D:\Projects` scan lost 92% of its entries with status "completed" and no warning). Fixed on both sides: beyond-cap directories are announced only as `pending`, and the worker schedules `pending` before `doneDirs`. Regression coverage now includes a 2,200-directory fixture that straddles the cap.
- The first elevated whole-drive probe caught a second release-blocking bug: the MFT run-list parser had the datarun header nibbles swapped (NTFS sizes the length field in the low nibble, the offset field in the high nibble). Symmetric headers decoded correctly — which is why the crafted fixture passed — while real asymmetric headers produced a 69 GB phantom extent and reads past the partition end. The parser now reads the nibbles correctly and refuses any run list whose lengths do not sum to the `$DATA` allocated size; the fixture was re-encoded to real NTFS semantics so the class stays covered.

## Checks

- Strict type checking and unused-code linting; 20 unit tests including volume/probe request shapes, single-flight native reads, a volume-load timeout longer than directory requests, backpressure, cancellation, startup failure and malformed output handling.
- Crafted-MFT-byte fixture (`BLOCKIT_VOLUME_IMAGE` seam, `.bench/volume-fixture-check.cjs`): synthetic volume image with sparse-gap runlists, resident and non-resident data, DOS aliases, deleted records, extension records, a reparse directory, Unicode names and attribute strings; exact file/dir sets, exclusion of a subtree, subtree-root FRN resolution, admin probe answers and repeatability.
- Native versus compatibility scan of a generated fixture: exact file/folder totals (4,905 files including a 1,100-file wide folder and a 2,200-directory folder straddling the walk cap, with markers proving beyond-cap subtrees are walked), timestamps, junctions, exclusions, fallback-with-warning, 4,096-entry demand batches, no unsolicited read-ahead, self metadata, empty/missing folders and EOF shutdown. Folder-mtime comparison tolerates NTFS parent-index lag on freshly created directories.
- Real-tree reconciliation: 1.7 and 1.8 walk engines produced identical node counts, file counts and byte totals on a live 193,143-entry development tree across paired trials.
- SQLite/query regression: inaccessible/disappearing entries, 100,005 generated rows, stable pagination, validation, cache invalidation, complete CSV export; metadata concurrency stayed ≤ 4.
- Performance regression: 200,000-row query checks (181 treemap rows, 50 search rows per page), cancel-to-exit 115 ms, results in `docs/performance.json`.
- Isolated Electron UI suites: scan/navigation/search, treemap interactions and PNG export in both themes, settings persistence, IPC validation and mocked Recycle Bin actions.

## Remaining manual verification

The in-app elevation dialog was verified by code review and mocked UI only — a real end-to-end UAC relaunch inside the packaged app, cold-cache/HDD/network/removable scans, antivirus/SmartScreen prompts, installer use on a clean machine and laptop-wide responsiveness remain unverified. Whole-drive MFT scanning was measured on one NVMe machine; other volumes (ReFS/exFAT, dynamic disks, BitLocker-locked) fall back to the walk engine or compatibility scanning.

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
node .bench/volume-fixture-check.cjs
node .bench/walk-probe.cjs C:\some\real\tree
```

`scripts/compare-scanner-18.cjs` alternates the current build against an archived 1.7 worker (`OLD_WORKER=<path>`, default `.bench/old17/scanner-worker.js`, with the helper that shipped beside it via `OLD_HELPER`) over `SCAN_ROOT` (default `C:\`) and writes `docs/scanner-comparison-1.8.json`. MFT mode requires running the benchmark elevated. The archived worker can be extracted from a packaged 1.7 build: `npx asar extract-file release/win-unpacked/resources/app.asar dist-electron/scanner-worker.js`. `npm run test:packaged` requires a packaged 1.8.0 build in `release/win-unpacked`.
