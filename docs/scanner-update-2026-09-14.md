# BlockIT scanner update - 2026-09-14

Target: D:\Projects\BlockIT. Reference: D:\BlockIT-scanner-1.8-mft\BlockIT-scanner-1.8-mft (read-only throughout).

Compared target acd5ca7 with GitHub main 6f70ed0fa5eec943ccdae46d97f38331a8b94218. Merged GitHub's current UI and query interfaces into the existing performance branch, retaining its corrected scanner.

The reference and GitHub native scanner share the same DirectoryReader.cs. Their volume continuation dispatch resets volume mode on `next`, allowing a scan to end after the first 4,096 entries. They also lack the worker's final insert-buffer flush. The target already fixed these; this update preserves those fixes and the multi-batch regression coverage.

Direct NTFS scans now start one helper rather than starting all eight parallel walk helpers. Additional lanes start only if direct-volume scanning falls back to directory walking. Folder scans retain their parallel walk path. Direct NTFS access still requires the app's existing administrator prompt.

Paired synthetic NTFS benchmark (9,000 files, 63,000 bytes, three alternating trials): baseline 690/504/475 ms; updated 447/460/428 ms. Median 504 -> 447 ms (11.3% less elapsed time). All six outputs have identical tree digests, correct database row counts and rollups, and pass SQLite integrity_check. This is fixture evidence, not a cold-cache or whole-drive speed claim.

Validation: build, lint, 23 unit tests, native MFT fixture tests including three-batch continuation and engine handoff, native/portable parity (4,905 files), query/CSV regression suite, Electron scan/browse UI, treemap UI, and action-boundary UI tests passed. File actions in UI tests use disposable fixtures and mocked Windows integrations.

Reproduce the end-to-end NTFS regression with `npm run build:main` then `npm run test:volume-worker`. For paired timing, set BEFORE_WORKER to the preserved .bench/before-startup/scanner-worker.js before running that test. The baseline is local and ignored by Git.

Pause/resume/cancel performance validation also passed: cancellation acknowledged and drained in 78 ms with 4,096 partial file rows preserved. The 4,000-file generated folder fixture completed in 469 ms versus the legacy baseline's 1,222 ms; this comparison includes previously existing scanner improvements.
