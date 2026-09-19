import { ipcMain, shell, clipboard, dialog, app } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

function localPath(value: unknown): string {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0') || /^\\\\[?.]\\/.test(value) || value.slice(2).includes(':')) throw new Error('Enter an absolute folder path.');
  return path.normalize(value);
}

export function registerExplorer() {
  let worker: Worker | undefined;
  let sequence = 0;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const reset = (error: Error) => {
    const previous = worker; worker = undefined;
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear(); void previous?.terminate();
  };
  const request = (payload: Record<string, unknown>) => {
    if (pending.size >= 8) throw new Error('Explorer is busy. Try again shortly.');
    if (!worker) {
      const current = new Worker(path.join(__dirname, 'explorer-worker.js'));
      worker = current;
      current.on('message', ({ id, result, error }) => {
        const task = pending.get(id); if (!task) return;
        clearTimeout(task.timer); pending.delete(id);
        if (error) task.reject(new Error(error)); else task.resolve(result);
      });
      current.on('error', error => { if (worker === current) reset(error); });
      current.on('exit', () => { if (worker === current) reset(new Error('Explorer stopped. Please retry.')); });
    }
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => reset(new Error('Folder access timed out. Try another location.')), 30_000);
      pending.set(id, { resolve, reject, timer }); worker!.postMessage({ ...payload, id });
    });
  };
  ipcMain.handle('explorer:read', (_event, folder, search, page, refresh) => {
    if (typeof search !== 'string' || search.length > 256 || !Number.isInteger(page) || page < 1 || page > 100_000 || typeof refresh !== 'boolean') throw new Error('Invalid explorer query.');
    return request({ operation: search.trim() ? 'search' : 'list', folder: localPath(folder), search, page, refresh });
  });
  ipcMain.handle('explorer:stop', () => { reset(new Error('Explorer closed.')); });
  ipcMain.handle('explorer:choose', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'], title: 'Open folder in File Explorer' });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('explorer:action', async (_event, input, action) => {
    const target = localPath(input);
    if (!['open', 'reveal', 'copy'].includes(action)) throw new Error('Invalid explorer action.');
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink()) throw new Error('Shortcuts and junctions are not supported.');
    if (action === 'copy') clipboard.writeText(target);
    else if (action === 'reveal') shell.showItemInFolder(target);
    else { const error = await shell.openPath(target); if (error) throw new Error(error); }
  });
  app.on('before-quit', () => reset(new Error('Application closed.')));
}
