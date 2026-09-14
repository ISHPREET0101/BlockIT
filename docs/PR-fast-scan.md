# PR: perf/fast-scan — scanner correctness fix, benchmarked speedups, advanced treemap

**Branch:** `perf/fast-scan` (cut from `main` at `4f399bd`) — `main` is untouched.
**Base:** `main` (v1.5.0 engine). **Head:** scanner 1.9 engine + treemap 2.

## What this branch contains

1. **The 1.8 scanner work, merged in.** Parallel native directory walk (C# helper
   over a JSON-line protocol, 4,096-entry demand-driven batches, one helper process
   per lane), NTFS MFT volume mode for drive roots, in-memory depth-first roll-up
   frontier, post-enumeration index build, `scan_id`-free node rows, live
   `scan_top` lists. Verified in `docs/verification-1.6.md`, `-1.7.md`, `-1.8.md`.
2. **The volume-mode dispatch fix (release blocker).** Elevated MFT scans used to
   truncate after the first batch. Both sides of the protocol are corrected; see
   below.
3. **A committed multi-batch regression test** (`scripts/volume-fixture-check.cjs`),
   because the original fixture fitted in one batch and never exercised the
   continuation path.
4. **An advanced treemap.** Nested multi-level blocks, five colour modes with a
   legend, pointer tooltip, minimum-share filter, depth control, cartographic
   palette, keyboard and export behaviour preserved.
5. **Benchmarks, docs and tests** listed under Deliverables.

## The fix (4 files, small diff)

| File | Change |
|---|---|
| `native/DirectoryReader.cs` | A `next` request now inherits the active engine (`startsVolume` + sticky `volumeRequest`), so volume continuations reach `WriteVolumeBatch(null, ...)` and reuse the loaded MFT state instead of hitting the empty walk writer. |
| `electron/native-directory.ts` | New `readVolumeNext()` that sends `{"op":"next"}` for volume continuations. |
| `electron/scanner-worker.ts` | `nativeEnumerate()` uses `readVolumeNext()` for volume continuations. |
| `scripts/volume-fixture-check.cjs` | Committed crafted-MFT test, now with a 9,000-file image that forces three batches. |

Evidence that the test is meaningful: against the **unfixed** helper the new
fixture returns 4,096 of 9,000 entries and fails; against the fixed helper it
returns all 9,000 across three batches and passes.

## Risks

- **MFT parsing** reads real NTFS structures and needs administrator rights. It is
  covered by crafted-image tests and by a real elevated whole-drive run recorded in
  `docs/BENCHMARKS.md`, but the parser remains the highest-risk component. It
  refuses malformed run lists rather than guessing, and any first-read failure
  falls back to the walk engine with a warning.
- **Parallel lanes** add a small .NET helper process per lane (below normal
  priority, bounded batches). Memory is modestly higher than 1.5; the lane budget
  collapses to one lane when measured open latency suggests a mechanical disk.
- **Behaviour changes** are limited to the treemap presentation and to the removal
  of the constant `scan_id` column from the per-scan database (one database holds
  one scan; queries were rewritten accordingly and the regression suite covers
  pagination, cache invalidation and CSV export).
- **Not verified here:** cold-cache HDD/network/removable scans, antivirus prompts,
  a clean-machine install, and non-NTFS volumes (ReFS/exFAT/BitLocker fall back to
  the walk or compatibility engine).

## Rollback

Delete or abandon the branch. `main` was never modified and no history was
rewritten, so rollback is `git push origin --delete perf/fast-scan` (or simply not
merging). Every change is additive on top of `main`; the previous engine remains a
`git checkout main` away, and the compatibility scanner (`metadataEngine:
'portable'`) can be forced per scan without reverting code.

## Review checklist

- [x] `npm test` — unit tests including the protocol transport suite.
- [x] `npm run lint` — strict unused-code checks.
- [x] `npm run test:volume` — crafted MFT images incl. multi-batch continuation.
- [x] `npm run test:native` — native vs compatibility engine parity.
- [x] `npm run test:regression` — edge cases, pagination, CSV, IPC validation.
- [x] `npm run test:performance` — generated-fixture timing plus recursive totals.
- [x] `npm run test:ui` — Electron UI, treemap and action suites, both themes.
- [x] `npm run bench:scan suite` — paired before/after with tree-digest parity.
- [ ] Real elevated whole-drive MFT run on a machine with a full system volume
      (recorded separately; see `docs/BENCHMARKS.md`).
