const { Worker } = require('node:worker_threads');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const Database = require('better-sqlite3');

async function main() {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'blockit-smoke-'));
  const fixture = path.join(base, 'scan-root');
  const cache = path.join(base, 'cache');
  await fsp.mkdir(fixture);
  await fsp.mkdir(cache);
  const dbPath = path.join(cache, 'scan.db');
  await fsp.mkdir(path.join(fixture, 'Documents'));
  await fsp.mkdir(path.join(fixture, 'Media'));
  await fsp.writeFile(path.join(fixture, 'Documents', 'notes.txt'), Buffer.alloc(1536, 1));
  await fsp.writeFile(path.join(fixture, 'Media', 'clip.mp4'), Buffer.alloc(8193, 2));
  const scanId = randomUUID();
  const worker = new Worker(path.join(__dirname, '..', 'dist-electron', 'scanner-worker.js'), {
    workerData: { scanId, root: fixture, dbPath, volumeTotalBytes: 100000, volumeFreeBytes: 50000, clusterSize: 4096, excludedPaths: [cache] },
  });
  const result = await new Promise((resolve, reject) => {
    worker.on('message', (message) => {
      if (message.type === 'done') resolve(message);
      if (message.type === 'error') reject(new Error(message.message));
    });
    worker.on('error', reject);
  });
  if (!result || result.status !== 'completed') throw new Error(`Unexpected worker result: ${JSON.stringify(result)}`);
  const db = new Database(dbPath, { readonly: true });
  const run = db.prepare('SELECT * FROM scan_runs WHERE id = ?').get(scanId);
  const categoryRows = db.prepare("SELECT category, COUNT(*) count FROM nodes WHERE kind = 'file' GROUP BY category").all();
  const links = db.prepare("SELECT COUNT(*) count FROM nodes WHERE kind = 'link'").get().count;
  db.close();
  if (run.file_count !== 2 || run.folder_count !== 3 || run.total_size !== 9729) throw new Error(`Incorrect scan totals: ${JSON.stringify(run)}`);
  if (run.allocated_size !== 16384) throw new Error(`Incorrect allocated total: ${run.allocated_size}`);
  if (!categoryRows.some((row) => row.category === 'Documents') || !categoryRows.some((row) => row.category === 'Videos')) throw new Error(`Incorrect categories: ${JSON.stringify(categoryRows)}`);
  if (links !== 0) throw new Error('Unexpected links in fixture.');
  const resolvedBase=path.resolve(base);
  if(path.dirname(resolvedBase)!==path.resolve(os.tmpdir())||!path.basename(resolvedBase).startsWith('blockit-smoke-')) throw new Error('Unexpected fixture cleanup path');
  fs.rmSync(resolvedBase, { recursive: true, force: true });
  console.log('Scanner smoke test passed: traversal, SQLite persistence, totals, allocation estimates, and categories.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
