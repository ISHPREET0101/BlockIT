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
