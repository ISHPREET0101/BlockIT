# BlockIT 1.6 verification

Verified locally on Windows x64, September 13, 2026. Only generated fixtures were scanned; no real drive scans or real user-file deletion tests were performed.

## Speed

Three alternating paired full scans against packaged 1.5.0, using 20,000 generated files across 40 nested folders:

| | Trial 1 | Trial 2 | Trial 3 | Median |
|---|---:|---:|---:|---:|
| 1.5 | 4,480 ms | 4,460 ms | 5,092 ms | 4,480 ms |
| Native scanner candidate | 1,772 ms | 1,733 ms | 2,294 ms | 1,772 ms |

Median time decreased 60%; throughput increased approximately 2.5×. Helper startup is included. These were warm-cache local tests, not whole-drive, HDD, network, or cold-cache measurements. Raw results: `scanner-comparison-1.6.json`.

## Checks

- Strict type checking and unused-code linting.
- 18 unit tests, including native transport backpressure, cancellation, startup failure, malformed output and timeout handling.
- Native versus compatibility metadata: exact file/folder totals, allocation estimates, extensions, timestamps, empty files/folders, Unicode and >260-character paths, junctions and exclusions. Unavailable-helper fallback records a warning and retains exact results.
- Actual native protocol: 256-entry maximum batches, no unsolicited read-ahead, missing-folder errors and EOF shutdown.
- SQLite/query regression: inaccessible/disappearing entries (injected into compatibility scanning), 100,005 generated rows, stable pagination, validation, cache invalidation and complete CSV export.
- Pause/resume/Stop with partial file results: 128 indexed files retained, cancellation-to-worker-exit 84 ms in the recorded run. Partial and completed folder totals reconciled exactly.
- 200,000-row query checks: 181 treemap rows, 50 file rows per page, correct totals and a responsive host event loop.
- Isolated Electron UI suites: scan/navigation/search, treemap interactions and PNG export in both themes, settings persistence, IPC validation and mocked Recycle Bin actions.
- Installer and portable x64 builds. Packaged archive worker executed in Electron with the shipped native helper and produced exact fixture totals.

The native helper runs below normal priority and requests one batch at a time. SQLite caches remain bounded and scanning still yields cooperatively. Reported CPU/RSS in `performance.json` describe the Electron test host only, not the separate native helper or whole laptop; they are not evidence of reduced total memory use.

## Remaining manual verification

Whole-drive throughput and laptop-wide responsiveness under real workloads, cold-cache HDD/removable/network scans, UAC relaunch, antivirus/SmartScreen prompts, installer use and launch on a clean Windows machine remain unverified. The native worker smoke check is not a clean-machine installation test. No NTFS MFT/USN parser was added.

## Reproduce

```powershell
npm run build
npm test
npm run lint
npm run test:native
npm run test:scanner
npm run test:regression
npm run test:performance
npm run test:ui
npm run package:win
npm run test:packaged
```

The separate paired benchmark `scripts/compare-v15.cjs` requires an original packaged 1.5.0 archive; the normal packaging command replaces `release/win-unpacked` with the new version.
