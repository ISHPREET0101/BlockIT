"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// electron/scanner-worker.ts
var import_node_worker_threads = require("worker_threads");
var import_node_fs = require("fs");
var import_node_path = __toESM(require("path"));
var import_better_sqlite3 = __toESM(require("better-sqlite3"));

// src/shared/categories.ts
var groups = {
  Documents: /* @__PURE__ */ new Set(["doc", "docx", "odt", "pdf", "ppt", "pptx", "rtf", "txt", "xls", "xlsx", "csv", "md"]),
  Images: /* @__PURE__ */ new Set(["avif", "bmp", "gif", "heic", "ico", "jpeg", "jpg", "png", "psd", "svg", "tif", "tiff", "webp"]),
  Videos: /* @__PURE__ */ new Set(["avi", "flv", "m4v", "mkv", "mov", "mp4", "mpeg", "mpg", "webm", "wmv"]),
  Audio: /* @__PURE__ */ new Set(["aac", "flac", "m4a", "mp3", "ogg", "wav", "wma"]),
  Archives: /* @__PURE__ */ new Set(["7z", "bz2", "cab", "gz", "iso", "rar", "tar", "tgz", "zip"]),
  Applications: /* @__PURE__ */ new Set(["appx", "exe", "msi", "msix", "pak"]),
  Code: /* @__PURE__ */ new Set(["c", "cpp", "cs", "css", "go", "h", "html", "java", "js", "jsx", "json", "kt", "php", "py", "rb", "rs", "sql", "swift", "ts", "tsx", "vue", "xml", "yaml", "yml"]),
  System: /* @__PURE__ */ new Set(["bin", "cat", "dat", "dll", "drv", "mui", "sys"])
};
function extensionOf(name) {
  const index = name.lastIndexOf(".");
  return index > 0 && index < name.length - 1 ? name.slice(index + 1).toLowerCase() : "";
}
function categorize(extension) {
  const normalized = extension.replace(/^\./, "").toLowerCase();
  for (const [category, extensions] of Object.entries(groups)) {
    if (extensions.has(normalized)) return category;
  }
  return "Other";
}

// src/shared/format.ts
var factors = {
  bytes: 1,
  KB: 1024,
  MB: 1024 ** 2,
  GB: 1024 ** 3,
  TB: 1024 ** 4
};
function estimatedAllocatedSize(size, clusterSize) {
  if (size <= 0) return 0;
  const safeCluster = clusterSize > 0 ? clusterSize : 4096;
  return Math.ceil(size / safeCluster) * safeCluster;
}

// electron/scanner-worker.ts
var data = import_node_worker_threads.workerData;
var db = new import_better_sqlite3.default(data.dbPath);
var cancelled = false;
var status = "scanning";
var files = 0;
var folders = 0;
var bytes = 0;
var warnings = 0;
var currentPath = data.root;
var lastProgress = 0;
var rowsInTransaction = 0;
var startedAt = Date.now();
var excludedPaths = (data.excludedPaths || []).map((item) => import_node_path.default.resolve(item).toLowerCase());
import_node_worker_threads.parentPort?.on("message", (message) => {
  if (message.type === "cancel") {
    cancelled = true;
    status = "cancelling";
    emitProgress("Cancelling safely\u2026");
  }
});
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
db.pragma("foreign_keys = ON");
db.exec(`
  CREATE TABLE IF NOT EXISTS scan_runs (
    id TEXT PRIMARY KEY,
    root_path TEXT NOT NULL,
    label TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    completed_at INTEGER,
    total_size INTEGER NOT NULL DEFAULT 0,
    allocated_size INTEGER NOT NULL DEFAULT 0,
    file_count INTEGER NOT NULL DEFAULT 0,
    folder_count INTEGER NOT NULL DEFAULT 0,
    warning_count INTEGER NOT NULL DEFAULT 0,
    volume_total_size INTEGER NOT NULL DEFAULT 0,
    volume_free_size INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS nodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scan_id TEXT NOT NULL,
    parent_id INTEGER,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    kind TEXT NOT NULL,
    extension TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT 'Other',
    size INTEGER NOT NULL DEFAULT 0,
    allocated_size INTEGER NOT NULL DEFAULT 0,
    modified_at INTEGER NOT NULL DEFAULT 0,
    attributes TEXT NOT NULL DEFAULT '',
    item_count INTEGER NOT NULL DEFAULT 0,
    file_count INTEGER NOT NULL DEFAULT 0,
    folder_count INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY(parent_id) REFERENCES nodes(id)
  );
  CREATE TABLE IF NOT EXISTS warnings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scan_id TEXT NOT NULL,
    path TEXT NOT NULL,
    message TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(scan_id, parent_id);
  CREATE INDEX IF NOT EXISTS idx_nodes_size ON nodes(scan_id, size DESC);
  CREATE INDEX IF NOT EXISTS idx_nodes_category ON nodes(scan_id, category, size DESC);
  CREATE INDEX IF NOT EXISTS idx_nodes_extension ON nodes(scan_id, extension, size DESC);
`);
var insertRun = db.prepare(`
  INSERT INTO scan_runs
  (id, root_path, label, status, started_at, volume_total_size, volume_free_size)
  VALUES (?, ?, ?, 'scanning', ?, ?, ?)
`);
var insertNode = db.prepare(`
  INSERT INTO nodes
  (scan_id, parent_id, name, path, kind, extension, category, size, allocated_size, modified_at, attributes)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
var insertWarning = db.prepare("INSERT INTO warnings (scan_id, path, message) VALUES (?, ?, ?)");
var updateFolder = db.prepare(`
  UPDATE nodes SET size = ?, allocated_size = ?, item_count = ?, file_count = ?, folder_count = ? WHERE id = ?
`);
function attributesFor(name, mode) {
  const attributes = [];
  if (name.startsWith(".")) attributes.push("Hidden");
  if ((mode & 128) === 0) attributes.push("Read-only");
  return attributes.join(", ");
}
function isExcluded(itemPath) {
  const normalized = import_node_path.default.resolve(itemPath).toLowerCase();
  return excludedPaths.some((excluded) => normalized === excluded || normalized.startsWith(`${excluded}${import_node_path.default.sep}`));
}
function emitProgress(message, force = false) {
  const now = Date.now();
  if (!force && now - lastProgress < 120) return;
  lastProgress = now;
  const progress = {
    scanId: data.scanId,
    status,
    currentPath,
    files,
    folders,
    bytes,
    warnings,
    elapsedMs: now - startedAt,
    message
  };
  import_node_worker_threads.parentPort?.postMessage({ type: "progress", progress });
}
function beginBatch() {
  if (!db.inTransaction) db.exec("BEGIN");
}
function commitBatch(force = false) {
  if (!db.inTransaction) return;
  if (force || rowsInTransaction >= 500) {
    db.prepare(`UPDATE scan_runs SET total_size = ?, file_count = ?, folder_count = ?, warning_count = ? WHERE id = ?`).run(bytes, files, folders, warnings, data.scanId);
    db.exec("COMMIT");
    rowsInTransaction = 0;
    emitProgress();
    if (!force) db.exec("BEGIN");
  }
}
function warn(itemPath, error) {
  const message = error instanceof Error ? error.message : String(error);
  insertWarning.run(data.scanId, itemPath, message.slice(0, 800));
  warnings += 1;
  rowsInTransaction += 1;
}
async function run() {
  const label = import_node_path.default.basename(import_node_path.default.parse(data.root).root === data.root ? data.root : data.root) || data.root;
  insertRun.run(data.scanId, data.root, label, startedAt, data.volumeTotalBytes, data.volumeFreeBytes);
  const rootStat = await import_node_fs.promises.lstat(data.root, { bigint: false });
  const rootResult = insertNode.run(
    data.scanId,
    null,
    label,
    data.root,
    "folder",
    "",
    "Other",
    0,
    0,
    rootStat.mtimeMs,
    attributesFor(label, rootStat.mode)
  );
  const rootId = Number(rootResult.lastInsertRowid);
  const aggregates = /* @__PURE__ */ new Map([
    [rootId, { size: 0, allocatedSize: 0, fileCount: 0, folderCount: 0 }]
  ]);
  const stack = [{ directoryPath: data.root, nodeId: rootId, ancestors: [rootId] }];
  folders = 1;
  beginBatch();
  while (stack.length > 0 && !cancelled) {
    const current = stack.pop();
    currentPath = current.directoryPath;
    let directory;
    try {
      directory = await import_node_fs.promises.opendir(current.directoryPath);
    } catch (error) {
      warn(current.directoryPath, error);
      commitBatch();
      continue;
    }
    try {
      for await (const entry of directory) {
        if (cancelled) break;
        const entryPath = import_node_path.default.join(current.directoryPath, entry.name);
        if (isExcluded(entryPath)) continue;
        currentPath = entryPath;
        try {
          const stat = await import_node_fs.promises.lstat(entryPath, { bigint: false });
          const isLink = stat.isSymbolicLink() || entry.isSymbolicLink();
          const kind = isLink ? "link" : stat.isDirectory() ? "folder" : "file";
          const extension = kind === "file" ? extensionOf(entry.name) : "";
          const category = kind === "file" ? categorize(extension) : "Other";
          const size = kind === "file" ? stat.size : 0;
          const allocatedSize = kind === "file" ? estimatedAllocatedSize(size, data.clusterSize) : 0;
          const result = insertNode.run(
            data.scanId,
            current.nodeId,
            entry.name,
            entryPath,
            kind,
            extension,
            category,
            size,
            allocatedSize,
            stat.mtimeMs,
            attributesFor(entry.name, stat.mode)
          );
          const id = Number(result.lastInsertRowid);
          rowsInTransaction += 1;
          if (kind === "folder") {
            folders += 1;
            aggregates.set(id, { size: 0, allocatedSize: 0, fileCount: 0, folderCount: 0 });
            for (const ancestor of current.ancestors) aggregates.get(ancestor).folderCount += 1;
            stack.push({ directoryPath: entryPath, nodeId: id, ancestors: [...current.ancestors, id] });
          } else if (kind === "file") {
            files += 1;
            bytes += size;
            for (const ancestor of current.ancestors) {
              const aggregate = aggregates.get(ancestor);
              aggregate.size += size;
              aggregate.allocatedSize += allocatedSize;
              aggregate.fileCount += 1;
            }
          }
          commitBatch();
          emitProgress();
        } catch (error) {
          warn(entryPath, error);
          commitBatch();
        }
      }
    } catch (error) {
      warn(current.directoryPath, error);
      commitBatch();
    }
  }
  commitBatch(true);
  const updateFolders = db.transaction(() => {
    for (const [id, aggregate] of aggregates) {
      updateFolder.run(
        aggregate.size,
        aggregate.allocatedSize,
        aggregate.fileCount + aggregate.folderCount,
        aggregate.fileCount,
        aggregate.folderCount,
        id
      );
    }
  });
  updateFolders();
  const rootAggregate = aggregates.get(rootId);
  status = cancelled ? "idle" : warnings > 0 ? "completed_with_warnings" : "completed";
  db.prepare(`
    UPDATE scan_runs SET status = ?, completed_at = ?, total_size = ?, allocated_size = ?,
      file_count = ?, folder_count = ?, warning_count = ? WHERE id = ?
  `).run(status, Date.now(), rootAggregate.size, rootAggregate.allocatedSize, files, folders, warnings, data.scanId);
  emitProgress(cancelled ? "Scan cancelled" : warnings ? "Scan complete with warnings" : "Scan complete", true);
  import_node_worker_threads.parentPort?.postMessage({ type: "done", scanId: data.scanId, rootId, status });
}
run().catch((error) => {
  status = "failed";
  const message = error instanceof Error ? error.message : String(error);
  try {
    if (db.inTransaction) db.exec("ROLLBACK");
    db.prepare("UPDATE scan_runs SET status = ?, completed_at = ? WHERE id = ?").run(status, Date.now(), data.scanId);
  } catch {
  }
  emitProgress(message, true);
  import_node_worker_threads.parentPort?.postMessage({ type: "error", scanId: data.scanId, message });
}).finally(() => {
  db.close();
  import_node_worker_threads.parentPort?.close();
});
