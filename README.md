# BlockIT 1.8.2

BlockIT is a private, local-first Windows storage explorer. It scans a drive or folder in the background and turns storage use into an interactive treemap without uploading file metadata or reading file contents.

## Download and run

Download [BlockIT Portable 1.8.2](https://github.com/ISHPREET0101/BlockIT/releases/latest/download/BlockIT-Portable-1.8.2-x64.exe) from the latest GitHub Release, then double-click the EXE. It requires 64-bit Windows 10 or Windows 11 and does not require installation or administrator access.

Windows may show a SmartScreen prompt because the app is not code-signed. Confirm that the download came from this repository before choosing **More info -> Run anyway**.

## Features

- Fast native Windows metadata scanning with bounded parallel readers and normal user permissions.
- Early treemap availability while secondary search and category indexes finish.
- Overview, nested treemap, categories, large-file and old-file views.
- Fullscreen treemap with visible controls, a minimized Explore rail and up to 4x zoom.
- Search, full-path details, Copy path, colour modes and PNG treemap export.
- Occupied-space-only treemap; unused drive space is excluded.
- Pause, resume and stop controls during long scans.
- Confirmed Recycle Bin actions with path validation and junction protection.
- Compatibility scanner fallback if the native helper cannot start.

## Run from source

Requirements: 64-bit Windows 10 or Windows 11, Node.js 20 or newer, npm, and the Windows .NET Framework C# compiler.

```powershell
git clone https://github.com/ISHPREET0101/BlockIT.git
cd BlockIT
npm ci
npm run dev
```

BlockIT does not require administrator access. Protected Windows locations that ordinary user permissions cannot read are skipped and reported as warnings.

## Basic usage

1. Choose a drive or select **Choose folder**.
2. Start the scan and leave BlockIT open while it indexes metadata.
3. Use **Overview**, **Treemap**, categories, large files, old files and search to inspect storage use.
4. Pause, resume or stop the scan whenever needed.
5. Review the full path before using the confirmed **Recycle** action.

## Build a Windows package

```powershell
npm ci
npm run package:win
```

The installer and portable executable are generated locally under `release/`. Build outputs remain excluded from the source tree; tested portable builds are published as GitHub Release assets.

## Verification

```powershell
npm run build
npm run lint
npm test
npm run test:native
npm run test:regression
npm run test:performance
npm run test:ui
```

The native scanner checks exact parity with the compatibility scanner across Unicode and long paths, exclusions, junctions, bounded batches and folders beyond the active frontier. Performance checks cover responsive pause and cancellation. UI checks cover treemap rendering, navigation, path copying and file actions.

## Scanning design

Native directory readers collect file metadata in bounded batches. Active directory slots and cached paths are reused, database inserts are batched, and folder totals accumulate during enumeration. The folder index is built first so the treemap can open before unrelated indexes finish.

Junctions and directory symbolic links are never traversed. Normal user scans do not attempt direct-volume access or request elevation. Scan time depends on drive speed, filesystem cache, file count and other running applications.

## Privacy and safety

- File contents and metadata stay on the computer.
- The renderer cannot access arbitrary local paths.
- BlockIT does not automatically clean, move or permanently delete files.
- Recycling requires confirmation and uses the Windows Recycle Bin.

## License

MIT
