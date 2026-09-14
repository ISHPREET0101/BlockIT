# Treemap feature verification

Implemented on scanner-1.8-mft:

- Distinct, Types, Size, Age and Levels colour modes with legends.
- One, two or three nested levels, loaded through the existing query worker.
- A minimum-size slider that hides small rectangles without changing the layout; the block list retains empty and hidden entries.
- Block search matches names and paths. Existing PNG export, keyboard navigation, folder drill-down, free-space stripes and root reset remain available.
- Distinct colours account for rectangle adjacency.

Nested requests validate depth (1-3), retain the existing 180-entry per-folder limit plus an aggregate remainder, and cap the total response at 2,500 nodes. Folders beyond the nesting budget remain visible and can be opened individually. Folder sizes are not added again to their descendants when laying out nested blocks. Size colours use binary byte boundaries; age colours use modification timestamps and explicitly mark unknown dates.

Verified locally on Windows with disposable scan fixtures:

- npm run lint
- npm test: 23 tests passed
- npm run build
- npm run test:ui: base UI, expanded treemap interactions, and file-action checks passed
- npm run test:regression: passed, including 100,005 generated rows and bounded treemap totals
- Visually inspected the light-theme Electron screenshot.

The treemap smoke test checks five modes, three-level data and rendering, invalid-depth rejection, minimum-size filtering, zero-byte list access, search, PNG export, light/dark capture, keyboard opening and root reset. Expected invalid-input errors appear in test logs. File-action tests use disposable fixtures and mocked Windows integrations. This verification does not represent a full-volume MFT scan or a packaged installer test.
