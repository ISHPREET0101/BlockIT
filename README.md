# BlockIT 1.9.1

BlockIT is a local-first Windows storage explorer. It provides two complementary workflows:

- **File Explorer** browses folders immediately and searches filenames across the current folder or a selected drive such as `C:` or `D:`.
- **Storage analysis** scans file metadata, explains where disk space is used, and presents overview, category, large-file, old-file and interactive treemap views.

BlockIT does not upload file information, inspect file contents, automatically reorganize files or permanently delete anything.

## Download

Download the tested portable build from the public release:

[Download BlockIT Portable 1.9.1](https://github.com/ISHPREET0101/BlockIT/releases/download/v1.9.1/BlockIT-Portable-1.9.1-x64.exe)

The same executable is attached to the `v1.9.1` release in both repositories:

- [BlockIT source repository](https://github.com/ISHPREET0101/BlockIT)
- [BlockIT Final Release repository](https://github.com/ISHPREET0101/BlockIT-Final-Release)

Release integrity:

| Property | Value |
|---|---|
| Version | `1.9.1` |
| Platform | 64-bit Windows 10 or Windows 11 |
| File | `BlockIT-Portable-1.9.1-x64.exe` |
| Size | `87,913,126` bytes |
| SHA-256 | `3914A9F680C4211361DFE97FEF11DEB4806E65CF707C68FF957990382211C9B4` |

The application is not code-signed. Windows SmartScreen may show a warning after download. Confirm the filename and SHA-256 value before selecting **More info → Run anyway**.

## Start the portable application

1. Download `BlockIT-Portable-1.9.1-x64.exe`.
2. Optionally verify its checksum in PowerShell:

   ```powershell
   Get-FileHash .\BlockIT-Portable-1.9.1-x64.exe -Algorithm SHA256
   ```

3. Double-click the executable. Installation and administrator access are not required.
4. Open **File Explorer** for immediate browsing, or choose a drive/folder and select **Scan** for storage analysis.

The portable application stores preferences and temporary scan indexes in the signed-in Windows user's application-data directory. Old scan databases are automatically eligible for cleanup after seven days.

## File Explorer

The **File Explorer** entry is available in the sidebar even when no storage scan has been started.

### Browse folders

- Select any available drive card or use **Open folder**.
- Use the address field to enter an absolute Windows path.
- Use Back, Forward and Up to navigate.
- Double-click a folder to enter it.
- Double-click a file to open it with the Windows default application.
- Select an item to expose **Open**, **Show in Windows** and **Copy path** actions.
- Results are paginated at 100 items per page.

### Search a particular drive

1. Open **File Explorer**.
2. In **Search in**, choose **Current folder**, `C:`, `D:` or another detected drive.
3. Enter part of a filename in the search field.
4. Results appear while the background index is being built.
5. Select **Refresh** when files have changed and the index must be rebuilt.

Search is case-insensitive and matches filenames recursively within the selected scope. It does not search inside document contents.

The first search for a scope builds an in-memory index in a worker thread. Later queries reuse that index, which makes repeated searches much faster. The index is not uploaded or persisted between application sessions. A scope is limited to 500,000 indexed entries; if that limit is reached, choose a smaller folder for complete results. Inaccessible folders, symbolic links and junction-like entries are skipped and reported without stopping the rest of the search.

## Storage analysis

### Start a scan

1. Select a detected drive or choose a folder.
2. Select **Scan**.
3. Keep BlockIT open while metadata is indexed.
4. Use **Pause**, **Resume** or **Stop** when needed.
5. Review warnings for protected locations that Windows did not allow the current user to read.

BlockIT scans metadata such as paths, names, sizes, timestamps and attributes. It does not read ordinary file contents. The native Windows enumerator processes metadata in bounded batches. If the native helper cannot start, BlockIT falls back to a compatibility scanner.

Directory symbolic links and junctions are not followed. This prevents recursive loops and avoids unintentionally crossing into locations outside the selected root.

### Views

| View | Purpose |
|---|---|
| Overview | Total indexed size, drive usage, free space, largest folders and largest files |
| Treemap | Proportional visual map of occupied storage with drill-down, back navigation and zoom |
| Browse | Indexed folder-by-folder navigation inside the completed scan |
| Categories | Documents, images, video, audio, archives, applications, code, system and other files |
| Large files | Files above the configurable size threshold |
| Old files | Files older than the configured number of days |
| Search | Indexed name/path search across the scanned root |

### Treemap behavior

- The treemap becomes available after its folder index is ready; unrelated indexes may still be completing.
- Only occupied items are visualized. Free disk space is shown elsewhere and does not distort block proportions.
- Select a folder block to drill down and use the back arrow to return one level.
- Fullscreen mode preserves navigation, search, depth, colour, size filter and legend controls.
- Hover or keyboard focus shows item details and the full path.
- **Copy path** copies the validated path without navigating away.
- PNG export saves the current visualization.

### File actions and deletion safety

BlockIT can open an indexed item, reveal it in Windows Explorer, copy its full path or move it to the Windows Recycle Bin.

Recycle actions require confirmation. Before an action runs, the main process validates that the current live path remains inside the scanned root and has not been replaced with a symbolic link or junction. BlockIT does not offer permanent deletion and never removes files automatically.

## Privacy and security model

- All indexing and queries run locally.
- File contents and metadata are not transmitted to a server.
- Electron context isolation and renderer sandboxing are enabled.
- Node.js access is disabled in the renderer.
- Renderer requests cross a narrow preload API and are validated in the main process.
- File Explorer rejects relative paths and unsupported device-path forms.
- Symbolic links are excluded from File Explorer indexing.
- Storage scans do not traverse reparse points.
- Settings writes are serialized and saved through a temporary file before replacement.
- The application requests no administrator privileges for normal browsing or scanning.

## Architecture

| Area | Responsibility |
|---|---|
| `src/` | React renderer, navigation, tables, File Explorer UI and treemap |
| `electron/main.ts` | Window lifecycle, IPC registration, scan coordination, settings and protected file actions |
| `electron/preload.ts` | Context-isolated API exposed to the renderer |
| `electron/explorer.ts` | Validated File Explorer IPC, worker lifecycle and Windows shell actions |
| `electron/explorer-worker.ts` | Background folder enumeration and reusable filename index |
| `electron/scanner-worker.ts` | Storage metadata scanning and SQLite writes |
| `electron/query-worker.ts` | Background scan-database queries |
| `native/DirectoryReader.cs` | Native Windows metadata enumerator |
| `scripts/` | Build, benchmark and active regression/smoke checks |

Storage scan results use SQLite databases under the application's user-data directory. Query work runs outside the renderer so large datasets do not block the interface.

## Develop from source

Requirements:

- 64-bit Windows 10 or Windows 11
- Node.js 20 or newer
- npm
- Windows .NET Framework C# compiler for the native helper

```powershell
git clone https://github.com/ISHPREET0101/BlockIT.git
cd BlockIT
npm ci
npm run dev
```

`npm ci` installs exactly the dependency versions recorded in `package-lock.json`. The development command builds the native/main-process code, starts Vite and launches Electron.

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` | Build Electron/native code and start the development application |
| `npm run build` | Type-check and build the Electron and renderer bundles |
| `npm run lint` | Run strict TypeScript unused-variable and unused-parameter checks |
| `npm test` | Run unit tests with Vitest |
| `npm run test:explorer` | Test File Explorer browsing, pagination, indexing, drive scope, refresh and actions |
| `npm run test:ui` | Test the existing scan, table, treemap and confirmed-action UI flows |
| `npm run test:scanner` | Run the scanner smoke test |
| `npm run test:native` | Compare native enumeration behavior across important filesystem cases |
| `npm run test:regression` | Exercise scanner failures, recovery and safety regressions |
| `npm run test:performance` | Run generated metadata/query responsiveness checks |
| `npm run test:volume` | Validate synthetic NTFS volume parsing fixtures |
| `npm run test:volume-worker` | Validate complete volume-worker persistence and rollups |
| `npm run test:drive` | Run the opt-in real-drive MFT check |
| `npm run preview:explorer` | Open the built File Explorer preview harness |
| `npm run bench:scan` | Run the scanner benchmark utility |
| `npm run package:win` | Generate the icon, build the app and create NSIS/portable x64 packages |
| `npm run test:packaged` | Validate a packaged application build |

Generated builds, icons, test screenshots, benchmark output, databases, logs and temporary worktrees are intentionally ignored. They should not be committed as source files. The only repository-tracked executable is the current portable build in the Final Release repository.

## Build Windows packages

```powershell
npm ci
npm run package:win
```

Outputs are written under `release/`. Packaging regenerates `build/icon.ico`, compiles the native helper, builds Electron and React code, then creates installer and portable executables.

Run `npm run test:packaged` after packaging. Release assets published on GitHub should be checksum-verified against the local artifact before announcing them.

## Troubleshooting

### Search initially looks incomplete

The index is still building. Wait until the status says **Index ready**. If the filesystem changed, select **Refresh**. For very large drives, choose a narrower folder if the 500,000-entry limit is reached.

### A folder or file is missing

Protected locations may be inaccessible to the current Windows account. Symbolic links and junctions are deliberately excluded. Check the warning count and search a narrower location if necessary.

### A scan appears slower than expected

Runtime depends on drive type, filesystem cache, file count, antivirus activity and other disk work. SSD, HDD, removable and network drives can behave very differently. Benchmark fixture timings are not whole-drive guarantees.

### Windows displays SmartScreen

The executable is currently unsigned. Verify that it came from the official release and confirm the SHA-256 value shown in this README.

### A packaged build is not found by the packaged test

Run `npm run package:win` first. The packaged check expects the generated application under `release/`.

## Known limitations

- Windows is the supported platform.
- File Explorer search matches filenames, not file contents.
- The in-memory File Explorer index is rebuilt after restarting the application.
- Search results reflect the last index build until **Refresh** is selected.
- Protected folders remain subject to Windows permissions.
- The filename index is capped at 500,000 entries per selected scope.
- The application is not code-signed.
- Scan and benchmark times vary by machine and should not be treated as universal performance claims.

## Repository roles

| Repository | Role |
|---|---|
| `ISHPREET0101/BlockIT` | Public source, tests, build configuration and public release asset |
| `ISHPREET0101/BlockIT-Final-Release` | Mirrored source plus the current portable executable tracked under `release/` |

Historical benchmark snapshots, superseded version reports, generated screenshots and one-off profiling utilities were removed from both active branches. The README now contains the maintained user, developer, safety and verification documentation.

## License

MIT