const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const directory = path.join(process.env.APPDATA, 'blockit-storage-explorer', 'scans');
const latest = fs.readdirSync(directory)
  .filter((name) => name.endsWith('.db'))
  .map((name) => ({ path: path.join(directory, name), modified: fs.statSync(path.join(directory, name)).mtimeMs }))
  .sort((a, b) => b.modified - a.modified)[0];

if (!latest) throw new Error('No BlockIT scan database was found.');
const db = new Database(latest.path, { readonly: true });
console.log(db.prepare(`
  SELECT status, root_path AS rootPath, total_size AS totalSize,
    file_count AS fileCount, folder_count AS folderCount, warning_count AS warningCount
  FROM scan_runs ORDER BY started_at DESC LIMIT 1
`).get());
db.close();
