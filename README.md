# BlockIT

BlockIT is a private, local-first Windows storage explorer. It scans a drive or folder in the background, visualizes usage as a treemap, and provides virtual categories, large-file and old-file views without moving user data.

## Development

```powershell
npm install
npm run dev
```

## Verification and packaging

```powershell
npm test
npm run build
npm run package:win
```

The Windows installer and portable executable are written to `release/`.

## Whole-drive MFT scanning (1.8)

- On a drive root, the native helper reads the NTFS Master File Table directly — one sequential pass over `$MFT` builds the whole volume tree, replacing hundreds of thousands of directory round trips. It streams results over the same demand-driven protocol as directory walks (≤4,096 entries per batch), so pause and cancel stay immediate and the worker needed only a thin dispatch change. Administrator rights are required to open the volume; without them the scan falls back to the directory walk with a warning.
- MFT parsing skips deleted records, NTFS metafiles and extension records, reports reparse points as links without descending into them, and counts hardlinks per link — matching the walk engine. Subtree scans resolve the requested root through the MFT too, so an elevated scan of any folder on the drive can use the same engine. Unknown records are skipped with a warning, never fatal.
- When a scan targets a drive root without elevation, the app probes the volume through the helper and offers **Restart as administrator** up front (UAC relaunch); cancelling simply continues with the standard scan.
- Walk-engine improvements for the fallback path: 4,096-entry batches, an in-memory directory map replacing per-directory SQL lookups, a lane budget capped at 16, and a leaner nodes table (no constant scan id column). A real-drive reconciliation during verification caught and fixed a subtle bug that could silently drop subtrees beyond the helper's 2,048-directory prefetch cap; a 2,200-directory fixture now guards the split.

Paired alternating full scans of a real `C:\` drive (elevated, warm cache, same machine) measured **1,779.5 s (v1.7 directory walk) → 79.8 s (this engine, MFT mode)** median wall time including index build and checkpoint — the whole ~2.8-million-entry drive in under 80 seconds. The non-elevated walk engine measured **101.6 s → 3.3 s** (31×) on a 193,143-entry development tree with node-for-node identical results. See `docs/scanner-comparison-1.8.json` and `docs/scanner-comparison-1.8-fallback.json`. Warm-cache same-machine measurements; cold-cache, HDD and network results will vary.

Run `npm run test:volume` after building to drive the MFT parser against crafted synthetic volume images, including a 9,000-entry image that forces multi-batch continuation (sparse runlists, resident and non-resident data, DOS aliases, deleted/extension records, reparse points, exclusions, subtree roots). `scripts/compare-scanner-18.cjs` pairs the current build against an archived 1.7 worker on a real drive root; MFT mode needs elevation.

## Faster Windows scanning (1.7)

- A native Windows metadata reader gets file names, sizes, dates and attributes together using [FindFirstFileExW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-findfirstfileexw) with a larger enumeration buffer. This avoids a separate metadata request for every file; no file contents are read.
- Several helper processes enumerate different directories in parallel (adaptive: a lane budget of two to four, collapsing to one when directory opens average slower than 25 ms, which suggests a mechanical or otherwise latency-bound disk). Requests stay demand-driven with at most 1,024 entries per batch and one directory open per reader; pause and cancel remain immediate.
- Each open response carries the folder's fresh write time and its resolved final path, so the worker no longer issues per-directory lstat/realpath calls. Junctions and directory reparse points are still never traversed, folders swapped for junctions or files are still rejected, and a changed ancestor is still detected through the resolved path. Compatibility scanning keeps the previous checks.
- The helper serializes responses with a hand-written encoder (the reflection-based serializer was the single largest helper cost), and index building moved out of the insert path: rows land in an append-only table during the scan and the five result indexes are built once at the end. Each database holds one scan, so index keys omit the constant scan id. Folder roll-ups run through parent reference counts in memory instead of a queue table, and file rows use multi-row inserts.
- If the native helper cannot start, scanning continues with the bounded compatibility engine and a warning. A failed reader never replays a partially indexed folder. Native enumeration requests time out; cancellation stops outstanding native requests. A timed-out folder is skipped rather than immediately retried through the compatibility API.

Alternating paired scans against the packaged 1.6 worker measured **2,327 ms → 790 ms** median for **20,000 generated files** (2.9×) and **12,904 ms → 2,166 ms** for **120,000 files across 2,400 folders** (6.0×). Against the original unpaired 1.6 baseline on a 120,000-file flat fixture (21.6 s), the 1.7 worker completes in about 2.2–2.6 s. Small scans are dominated by fixed process startup, so relative gains grow with tree size. See `docs/scanner-comparison-1.7.json`. These warm-cache local tests include helper startup; whole-drive, HDD and network performance will vary. This is standard directory enumeration, not NTFS MFT scanning.

`npm run build:main` compiles the small x64 helper using the Windows .NET Framework C# compiler, then builds Electron code. Windows builds require .NET Framework 4.x and `System.Web.Extensions` (included on supported Windows 10/11 installations). Packaging places the helper beside `app.asar`, outside the archive. Other development platforms use compatibility scanning.

Run `npm run test:native` after building to compare native and compatibility totals, timestamps, Unicode/long paths, junctions, exclusions, fallback, empty/missing folders, bounded batches and helper shutdown. `scripts/compare-v15.cjs` requires the original 1.5.0 `app.asar` in `release/win-unpacked/resources/`; run before packaging replaces that baseline.

## Fast scanning and the advanced treemap (1.9)

- Scanning a drive root walks the NTFS Master File Table directly (one sequential pass; administrator rights required) and falls back to the parallel directory walk automatically when the volume cannot be opened. Folder scans use the same walk engine with several helper lanes in parallel.
- Two correctness defects in the 1.8 engine are fixed: elevated MFT scans stopped after the first 4,096 entries (volume-mode continuation requests were routed to the walk writer), and the last queued file rows of a volume scan were counted into the run totals but never written. See `docs/PERFORMANCE-ANALYSIS.md`.
- Measured on one machine, archived v1.5.0 worker versus this branch, alternating paired runs with output parity asserted node-for-node (method and raw results in `docs/BENCHMARKS.md` and `docs/benchmark-1.9.json`):

| Profile | 1.5 | 1.9 | Speedup |
|---|---:|---:|---:|
| small | 1,683 ms | 588 ms | 2.86x |
| medium | 9,806 ms | 1,076 ms | 9.11x |
| large | 24.3 s | 2,030 ms | 11.95x |
| D:\Projects | 206.9 s | 6,633 ms | 31.19x |

  A full elevated `C:\` MFT scan now completes instead of stopping after 4,096 entries; the previous directory-walk baseline for that volume is recorded in `docs/verification-1.8.md`.
- The treemap is now a nested map: depth control (1-3 levels), five colour modes (Distinct, Types, Size, Age, Levels) each with a legend, a floating pointer tooltip, and a minimum-share filter that dims tiny blocks. Search, keyboard navigation, free space and PNG export are unchanged, and the palette is a cartographic ochre and sage set.

Re-run the benchmarks and the new checks:

```powershell
npm run bench:scan suite    # small, medium and large fixtures plus a real tree
npm run test:volume         # crafted MFT images incl. multi-batch continuation
npm run test:drive          # elevated whole-drive check (needs an admin shell)
```

## Performance and reliability update (1.5)

- Four-at-a-time metadata lookups overlap disk latency without an unbounded queue. Existing low-priority scanning, small database caches, and periodic yields remain enabled.
- Completed subfolders are rolled up during traversal. Stopping a scan finalizes only its open ancestor chain instead of revisiting every folder on the drive.
- A single reusable query connection and a bounded, change-aware count cache eliminate repeated database opens and repeated pagination counts. Index-compatible tie sorting avoids large temporary sorts for equal-size items.
- CSV exports stream through the query worker in bounded chunks, preserve filters and sorting, and no longer silently stop at 100,000 rows. Stop or finish a scan before exporting.
- Recycle-index updates run off the UI thread. Overlapping folder/child selections are deduplicated, partial-scan folder recycling is blocked, and changed junctions or out-of-root paths are rejected. Native confirmation remains mandatory.
- Preference writes are serialized and validated. Fixed stale navigation rows, search-result breadcrumbs, empty-page pagination, zero-size totals after recycling, and ignored zero-value filters.
- Startup preferences no longer wait for drive discovery. Treemap rendering is memoized, and file-type colour mode survives folder navigation.
- Administrator relaunch waits for the UAC outcome instead of closing the app on a timer. Interactive UAC acceptance/cancellation still requires manual Windows validation.

The paired generated-data comparison in `docs/optimization-comparison.json` measured median scan times of **1,696 ms → 1,300 ms** (4,000 files, three trials). Twenty pages of queries over 200,000 equal-size-heavy metadata rows measured **6,868 ms → 21 ms**. These are specific local fixtures with cached filesystem data, not a promise of whole-drive speed or laptop-wide memory usage.

After `npm run build`, run:

```powershell
npm run lint
npm test
npm run test:regression
npm run test:performance
npm run test:ui
```

`lint` uses TypeScript's strict unused-code checks. Regression tests cover warning continuation, Unicode/long paths, junction exclusion, query validation, stable pagination, cache invalidation, complete CSV exports, settings races, path changes, and mocked file actions. The paired benchmark script `scripts/compare-v14.cjs` requires the original 1.4.0 `app.asar` in `release/win-unpacked/resources/`; run it before replacing that packaged baseline.

## Interactive treemap (1.4)

- Distinct folder colours, clear gaps, and a striped free-space block make storage areas easier to tell apart.
- Switch between individual block colours and file-type colours; hover or focus a block for size, percentage, and item counts.
- Find a block without changing its relative area, select folders to drill down, and return to the root in one click.
- Use arrow keys to navigate, Enter to open, and the expandable All blocks list to reach tiny or empty items.
- PNG export preserves colours, labels, and the free-space pattern in both themes.

Run `npx electron scripts/smoke-treemap.cjs` after building for an isolated generated-fixture test covering colours, free space, search, keyboard navigation, export, and light/dark rendering. Preview images in `docs/treemap-*.png` use sample data, not a real drive.

## Performance update (1.3)

- Category/extension totals are accumulated during scan batches; dashboard refreshes no longer repeatedly group the whole file table.
- Database reads run in a dedicated worker with an eight-request queue limit and 8 MiB SQLite page caches.
- Folder traversal uses a disk-backed frontier and a bounded bottom-up rollup instead of keeping every folder and ancestor list in memory.
- Scans yield for 12 ms per 128 metadata operations and run at below-normal process priority when supported.
- Pause/Resume stops metadata indexing between batches; Stop resumes a paused worker to finish partial totals.
- Progress updates are limited to twice per second; summary refreshes are coalesced and spaced 2.5 seconds apart. Hidden treemaps are not queried.
- Reopening BlockIT focuses the existing app instead of launching another scanner.

Run `npx cross-env ELECTRON_RUN_AS_NODE=1 electron scripts/performance-check.cjs` after building for generated-file regression and benchmark checks. Results are saved in `docs/performance.json`. These check 4,000 files, folder totals, junction exclusion, pause/resume/cancel, and a 200,000-record query fixture. The gentler scanner can take longer on small folders; the main improvement is removing repeated database work and reducing contention during long scans. Whole-drive performance still depends on hardware and other applications.

## Earlier UI improvements (1.1–1.2)

Version 1.2 introduces a calmer sage-and-cream light theme (default for new profiles), softer dark colours, larger type, fewer decorative labels, and summary cards limited to Overview. Existing theme preferences are preserved; use the sun/moon control to switch themes.

- Search across all indexed folders with a short debounce to keep typing responsive.
- Select files for a details panel showing sizes, estimated disk use, dates, and location.
- Folder navigation is preserved during background scan updates.
- Recycle actions use native confirmation, reject actions during scanning, and update the writable index.
- Clear completion/cancellation/error status and persistent result counts.
- Packaging outputs are separate from frontend build files.

Run `npx electron scripts/smoke-ui.cjs` after building for an isolated Electron UI smoke test with generated sample files. It writes a screenshot to `docs/ui-smoke.png`.

## Safety and privacy

- File contents and metadata never leave the computer.
- Symbolic links and junctions are not followed.
- The renderer cannot access Node.js or arbitrary paths.
- The only delete operation sends a confirmed item to the Windows Recycle Bin.
- BlockIT never moves, permanently deletes, or automatically cleans user files.
