// Whole-drive scan integration check. Runs the scanner worker against a drive
// root (default C:\) and verifies that the volume engine completes and that every
// published total matches the node table:
//   - run.file_count / run.total_size equal the file-row count and size sum
//   - the root roll-up equals the run totals
//   - warning_count equals the number of warning rows
// The volume path needs administrator rights; without them the scan falls back to
// the walk engine and this check reports that instead of failing on reachability.
// Metadata only: nothing is written outside the temporary scan database.
const {Worker} = require('node:worker_threads');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const Database = require('better-sqlite3');

const ROOT = process.env.SCAN_ROOT || 'C:\\';
const WORKER = path.resolve(process.env.WORKER || path.join(__dirname, '../dist-electron/scanner-worker.js'));
const HELPER = path.resolve(process.env.HELPER || path.join(__dirname, '../build/native/blockit-enumerator.exe'));

(async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'blockit-drive-'));
  const scanId = randomUUID(), dbPath = path.join(base, scanId + '.db');
  const started = performance.now();
  let engine = '?';
  const worker = new Worker(WORKER, {workerData: {
    scanId, root: ROOT, dbPath, volumeTotalBytes: 1e12, volumeFreeBytes: 1e11, clusterSize: 4096,
    excludedPaths: [base], nativeHelperPath: HELPER,
  }});
  const done = await new Promise((resolve, reject) => {
    worker.on('message', m => { if (m.type === 'engine') engine = m.engine; if (m.type === 'done') resolve(m); if (m.type === 'error') reject(new Error(m.message)); });
    worker.on('error', reject);
  });
  await new Promise(resolve => worker.once('exit', resolve));
  const wallMs = Math.round(performance.now() - started);

  const db = new Database(dbPath, {readonly: true});
  const sums = db.prepare(`SELECT COUNT(*) AS nodes,
    SUM(CASE WHEN kind='file' THEN 1 ELSE 0 END) AS files,
    SUM(CASE WHEN kind='file' THEN size ELSE 0 END) AS bytes FROM nodes`).get();
  const run = db.prepare('SELECT status,total_size,file_count,folder_count,warning_count FROM scan_runs').get();
  const root = db.prepare('SELECT size,file_count,folder_count FROM nodes WHERE parent_id IS NULL').get();
  const warnings = db.prepare('SELECT COUNT(*) AS n FROM warnings').get().n;
  db.close();

  assert.equal(done.status, run.status, 'worker status matches the stored run status');
  assert.equal(run.status, 'completed', 'a whole-drive scan completes');
  assert.equal(run.file_count, sums.files, 'published file count equals the file rows (no counted-but-unwritten tail)');
  assert.equal(run.total_size, sums.bytes, 'published total size equals the file row size sum');
  assert.equal(root.size, run.total_size, 'root roll-up equals the run total size');
  assert.equal(root.file_count, run.file_count, 'root roll-up equals the run file count');
  assert.equal(run.warning_count, warnings, 'warning count equals the warning rows');
  assert.equal(engine, 'volume', 'a drive root uses the MFT volume engine when elevated');

  console.log(JSON.stringify({root: ROOT, engine, status: run.status, wallMs,
    nodes: sums.nodes, files: sums.files, bytes: sums.bytes, warnings}, null, 2));
  console.log('PASS drive scan: volume engine completed with totals consistent with the node table.');
  process.exit(0);
})().catch(error => { console.error('FAIL drive scan: ' + error.message); process.exit(1); });
