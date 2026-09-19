import { parentPort } from 'node:worker_threads';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ExplorerEntry, ExplorerResult } from '../src/shared/types';

let generation = 0;
let root = '';
let entries: ExplorerEntry[] = [];
let indexing = false;
let skipped = 0;
let limited = false;
const limit = 500_000;

async function buildIndex(folder: string, token: number) {
  const queue = [folder];
  let cursor = 0;
  try {
    while (cursor < queue.length && token === generation && !limited) {
      const batch = queue.slice(cursor, cursor + 8);
      cursor += batch.length;
      await Promise.all(batch.map(async directory => {
        try {
          const children = await fs.readdir(directory, { withFileTypes: true });
          if (token !== generation) return;
          for (const child of children) {
            if (entries.length >= limit) { limited = true; break; }
            if (child.isSymbolicLink()) { skipped++; continue; }
            if (!child.isDirectory() && !child.isFile()) continue;
            const item = { name: child.name, path: path.join(directory, child.name), kind: child.isDirectory() ? 'folder' as const : 'file' as const };
            entries.push(item);
            if (child.isDirectory()) queue.push(item.path);
          }
        } catch { if (token === generation) skipped++; }
      }));
    }
  } finally { if (token === generation) indexing = false; }
}

parentPort!.on('message', async ({ id, operation, folder, search = '', page = 1, refresh = false }) => {
  try {
    if (operation === 'stop') {
      generation++; root = ''; entries = []; indexing = false;
      parentPort!.postMessage({ id, result: null }); return;
    }
    const stat = await fs.lstat(folder);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Choose a regular folder or drive.');
    let items: ExplorerEntry[];
    if (operation === 'list') {
      if (refresh) { generation++; root = ''; entries = []; indexing = false; }
      const children = await fs.readdir(folder, { withFileTypes: true });
      items = children.filter(child => !child.isSymbolicLink() && (child.isFile() || child.isDirectory())).map(child => ({ name: child.name, path: path.join(folder, child.name), kind: child.isDirectory() ? 'folder' : 'file' }));
      items.sort((a, b) => Number(b.kind === 'folder') - Number(a.kind === 'folder') || a.name.localeCompare(b.name, undefined, { numeric: true }));
    } else {
      if (folder !== root || refresh) {
        generation++; root = folder; entries = []; skipped = 0; limited = false; indexing = true;
        void buildIndex(folder, generation);
      }
      const needle = search.trim().toLocaleLowerCase();
      items = entries.filter(item => item.name.toLocaleLowerCase().includes(needle));
    }
    const result: ExplorerResult = { folder, parent: path.dirname(folder), items: items.slice((page - 1) * 100, page * 100), total: items.length, indexing: operation === 'search' && indexing, indexed: operation === 'search' ? entries.length : 0, skipped: operation === 'search' ? skipped : 0, limited: operation === 'search' && limited };
    parentPort!.postMessage({ id, result });
  } catch (error) { parentPort!.postMessage({ id, error: String(error) }); }
});
