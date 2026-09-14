# BlockIT 1.9 verification

Verified locally on Windows x64 (AMD Ryzen 7 7435HS, 16 logical cores,
23.7 GB, NVMe SSD, Windows 10.0.26200), September 14, 2026.
Benchmarks use generated fixtures plus one live development tree; one elevated
whole-drive `C:\` MFT run was performed. No real user files were deleted or moved.

## Speed

Paired alternating scans, same machine and tree, warm filesystem cache, worker and
helper startup plus index build included. "Before" is the archived v1.5.0 worker
(the code on `main`). Method and raw numbers: `docs/BENCHMARKS.md`,
`docs/benchmark-1.9.json`.

| Profile | Before (1.5) | After (1.9) | Speedup |
|---|---:|---:|---:|
| 4,000 files | 1,683 ms | 588 ms | 2.86x |
| 30,000 files | 9,806 ms | 1,076 ms | 9.11x |
| 86,160 files (deep and wide) | 24.3 s | 2,030 ms | 11.95x |
| live `D:\Projects`, 315,707 nodes | 206.9 s | 6,633 ms | 31.19x |
| elevated whole-drive `C:\` MFT scan | truncated after 4,096 entries | 79.8 s | n/a |

## What changed

- **Volume-mode dispatch fix (release blocker).** `native/DirectoryReader.cs` kept
  `volumeRequest = op == "volume"`, so the first `{"op":"next"}` of an MFT walk was
  routed to the directory-walk writer, which answered `done: true` against empty
  walk state. Elevated drive scans stopped after 4,096 of roughly 2.8 million
  entries. Routing is now sticky for the life of a volume walk, continuations pass
  `null` so the loaded MFT state is reused, and `electron/native-directory.ts`
  gained `readVolumeNext()`.
- **Volume-path flush fix**, found while reconciling the MFT totals. File rows queue
  into batches of `INSERT_CHUNK` (128). `processDirectory()` flushed the queue after
  every walk job, but the volume scan runs through one direct call in `run()`, so up
  to 127 of the last file rows were counted into the run totals and folder roll-ups
  yet never inserted. On `C:\` this showed as `file_count` exceeding the file rows
  by 31 and `total_size` exceeding the row size sum by 27,391,939 bytes. `run()` now
  flushes before finalisation; after the fix every published total equals the node
  table.
- **Committed regression coverage.** `scripts/volume-fixture-check.cjs` crafts NTFS
  volume images and now includes a 9,000-file image that forces three batches
  (`npm run test:volume`). `scripts/mft-scan-check.cjs` (`npm run test:drive`)
  asserts that a whole-drive scan completes and that all published totals equal the
  node table, which is the assertion that catches the flush class of bug.
- **Treemap 2.** Nested multi-level blocks with a depth control, five colour modes
  (Distinct, Types, Size, Age, Levels) each with a legend, a floating pointer
  tooltip, and a minimum-share filter, in a cartographic ochre and sage palette.
  Search, keyboard navigation, free space and PNG export are preserved, and
  `scripts/smoke-treemap.cjs` covers the new controls alongside the old behaviour.

## Checks

- `npm test` - 23 unit tests including the native transport suite.
- `npm run lint` - strict unused-code checks.
- `npm run test:volume` - crafted MFT images: structure, exclusions, sparse runs,
  Unicode names, and a multi-batch continuation that fails against the unfixed
  helper (4,096 of 9,000 entries) and passes against the fixed one.
- `npm run test:native` - native versus compatibility parity on a generated fixture
  (long and Unicode paths, junctions, exclusions, fallback).
- `npm run test:regression` - inaccessible and disappearing entries, 100,005 rows,
  stable pagination, cache invalidation, complete CSV export.
- `npm run test:performance` - generated-fixture timing, recursive folder-total
  verification and 200,000-row query checks.
- `npm run test:ui` - isolated Electron suites: scan, browse, search, treemap
  interactions and export in both themes, settings, IPC validation, mocked recycle.
- `npm run bench:scan suite` - paired before/after with SHA-256 tree-digest, totals
  and aggregate parity on every generated profile.
- `npm run test:drive` - elevated whole-drive `C:\` scan: engine `volume`, status
  `completed`, totals equal to the node table, 0 warnings.
- Real-tree reconciliation - the new engine differed from 1.5 on exactly four rows
  of `D:\Projects`, all `.asar` archives that Electron's `fs` reports as
  directories, so the older engine created folder rows and failed with `ENOTDIR`
  (its four warnings). The native engine records them as files with their real
  sizes. Both new runs agreed with each other and both old runs agreed with each
  other, so this is a systematic engine difference, not tree drift.

## Remaining manual verification

Cold-cache, HDD, network, removable and non-NTFS (ReFS/exFAT/BitLocker) volumes;
antivirus and SmartScreen prompts; installer and UAC relaunch on a clean machine;
laptop-wide responsiveness under real workloads. Whole-drive MFT scanning was
measured on one NVMe machine.

## Reproduce

```powershell
npm run build
npm test
npm run lint
npm run test:volume
npm run test:native
npm run test:regression
npm run test:performance
npm run test:ui
npm run bench:scan suite
npm run test:drive          # needs an elevated shell
```
