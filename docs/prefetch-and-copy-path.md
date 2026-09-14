# Treemap copy path and scan prefetch - 2026-09-14

Previous verified work was pushed first to GitHub main and perf/fast-scan at 1dd762ac4d1121035e827c993525131be73c3a4e.

The treemap now has a Copy path button next to the full displayed path. Hover/focus details remain selected when moving to the button, so both mouse and keyboard users can reach it. Escape still clears the details. Synthetic free-space/grouped items have no copy action. Copy uses the existing validated actions:copy-path IPC handler and shows success/failure feedback.

The scanner now prefetches at most one native metadata batch while inserting the current batch into SQLite. This overlaps native enumeration/serialization with database writes, preserves record order, and keeps memory bounded. The prior MFT completeness fixes, single-helper direct volume startup, fallback, exclusions, and cancellation handling remain in place.

Five paired alternating runs against the previous scanner on a synthetic NTFS image containing 120,000 files (840,000 bytes):

- Before: 1959, 1748, 1722, 1746, 1688 ms; median 1746 ms.
- After: 1543, 1497, 1481, 1470, 1473 ms; median 1481 ms.
- Median elapsed time decreased 15.2%. All ten complete outputs have identical SHA-256 tree digests, exact file/byte counts and root rollups, and pass SQLite integrity_check.

These measurements include worker startup, native parsing, all database writes, index creation and shutdown. They describe this generated fixture on this machine, not a guaranteed real-drive gain. The source baseline is preserved locally in ignored .bench/before-prefetch/scanner-worker.js. Detailed results are in prefetch-performance.json.

Validation passed: build, lint, 23 unit tests, synthetic multi-batch NTFS fixtures, native/portable parity (4,905 files), query/CSV regressions, and Electron UI suites. The UI copy test uses the real validated handler with a mocked clipboard write to avoid changing the user's clipboard; it verifies the exact full path, keyboard reachability, no navigation, and no copy action for free space.

Pause/resume/cancel performance validation passed; cancellation drained in 64 ms with 4,096 partial file rows and consistent totals.
