# BlockIT 1.5 verification

## Changes reviewed and exercised

Scanner traversal and cancellation, SQLite reads and aggregation, query-worker lifecycle, preferences, preload contracts, Explorer/clipboard/Recycle Bin boundaries, CSV/PNG export, React navigation and table state, and treemap interactions.

## Passing local checks

- Type checking and TypeScript unused-code checks (`npm run lint`).
- 13 unit tests: classification, sizes, allocation estimates, treemap colours, IPC input validation, preferences, path containment, and CSV escaping.
- Generated scanner/performance suite: 4,000 files, exact folder totals, junction exclusion, pause/resume/cancellation, 200,000-row queries, bounded treemap payload, and a responsive host event loop.
- Regression suite: injected access-denied/disappearing-file errors, empty files, Unicode and long paths, a junction cycle, at most four metadata lookups in flight, zero-value filters, invalid query rejection, real breadcrumb chains, stable pagination, changed-index count invalidation, out-of-range page clamping, complete treemap totals, and a streamed 100,004-row CSV.
- Three Electron UI suites: first launch, preload isolation, single instance, actual sample-folder scans, browse/search navigation, corrected search breadcrumbs, file details, mandatory confirmation, mocked recycling and index reconciliation, treemap colours/search/keyboard navigation, PNG export, both themes, settings-write races, changed-junction rejection, overlapping selections, and zero remaining-file totals.

## Measured comparison

Three paired trials against the packaged 1.4.0 worker, using the same generated files. Median traversal time: **1,696 ms before / 1,300 ms after** (about 23% lower).

Twenty paginated queries over 200,000 synthetic rows with many equal sizes: **6,868.4 ms before / 21 ms after**. This workload specifically exercises repeated counts and the former equal-size sorting bottleneck. It does not predict every search or sort.

Raw measurements: `optimization-comparison.json`. Additional scanner/control measurements: `performance.json`.

## Boundaries

- These are local fixture measurements, not whole-drive, cold-cache, or laptop-wide resource guarantees.
- Windows Recycle Bin, Explorer, and clipboard transports were mocked; no actual user files or clipboard contents were changed.
- Access-denied and disappearing-file tests use injected filesystem errors. Junction and long-path tests use real disposable filesystem entries.
- Interactive UAC acceptance/cancellation, disconnected network drives, and clean-machine installation still need manual validation. Filesystem calls to unresponsive devices can take longer to return.
- A scan is a snapshot. Files can change after scanning, allocated sizes remain estimates, and hard-linked files may be counted more than once.
- No claim that every possible bug has been eliminated. No permanent deletion or automatic organization was introduced.
