import { promises as fs } from 'node:fs';
import path from 'node:path';

export function insideRoot(root: string, item: string, allowRoot = true): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(item));
  return (allowRoot || relative !== '') && relative !== '..' && !relative.startsWith('..'+path.sep) && !path.isAbsolute(relative);
}

export async function validateLivePath(root: string, item: string, allowRoot = true): Promise<void> {
  if (!insideRoot(root, item, allowRoot)) throw new Error('This item is outside the scanned location.');
  // Do not trust a path whose ancestor was replaced with a junction after scanning.
  const [rootStat, itemStat, realRoot, realItem] = await Promise.all([fs.lstat(root), fs.lstat(item), fs.realpath(root), fs.realpath(item)]);
  if (rootStat.isSymbolicLink() || itemStat.isSymbolicLink() || !insideRoot(realRoot, realItem, allowRoot)) {
    throw new Error('This path changed or points outside the scan. Rescan before continuing.');
  }
}
