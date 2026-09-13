import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, shell } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { setPriority, constants as osConstants } from 'node:os';
import { mapNode } from './queries';
import { defaultSettings, settingsPatch, scanIdentifier, nodeIdentifier, validateQuery } from '../src/shared/validation';
import { insideRoot, validateLivePath } from './path-safety';
import { NativeDirectoryReader } from './native-directory';
import Database from 'better-sqlite3';
import type {
  ActionResult,
  AppSettings,
  DriveTarget,
  FileNode,
  NodeQuery,
  ScanProgress,
  ScanSummary,
} from '../src/shared/types';

const execFileAsync = promisify(execFile);
const activeWorkers = new Map<string, Worker>();
let mainWindow: BrowserWindow | null = null;
let queryWorker: Worker | undefined;
let querySequence=0;
let startingScan=false;
let recycling=false, exporting=false, elevating=false;
const queryRequests=new Map<number,{resolve:(value:any)=>void;reject:(reason:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
function readQuery<T>(operation:string,...args:unknown[]):Promise<T> {
  if(queryRequests.size>=8) return Promise.reject(new Error('A query is still running. Try again shortly.'));
  if(!queryWorker) {
    queryWorker=new Worker(path.join(__dirname,'query-worker.js'),{workerData:{directory:scanDirectory()}});
    const worker=queryWorker;
    queryWorker.on('message',({id,result,error})=>{
      const request=queryRequests.get(id);queryRequests.delete(id); if(request) clearTimeout(request.timer);
      if(error) request?.reject(new Error(error)); else request?.resolve(result);
    });
    const fail=(error:Error)=>{
      if(queryWorker!==worker) return;
      for(const request of queryRequests.values()) {clearTimeout(request.timer);request.reject(error);}
      queryRequests.clear();queryWorker=undefined;
    };
    worker.on('error',fail);
    worker.on('exit',()=>fail(new Error('The query worker stopped. Please try again.')));
  }
  return new Promise<T>((resolve,reject)=>{
    const id=++querySequence;
    const timer=setTimeout(()=>{
      const worker=queryWorker;
      for(const request of queryRequests.values()) {clearTimeout(request.timer);request.reject(new Error('The query took too long. Try a narrower filter.'));}
      queryRequests.clear();queryWorker=undefined;void worker?.terminate();
    },operation==='export'?600_000:60_000);
    queryRequests.set(id,{resolve,reject,timer});
    queryWorker!.postMessage({id,operation,args});
  });
}

function scanDirectory(): string {
  return path.join(app.getPath('userData'), 'scans');
}

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

function databasePath(scanId: string): string {
  scanIdentifier(scanId);
  return path.join(scanDirectory(), `${scanId}.db`);
}

function helperPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'blockit-enumerator.exe')
    : path.join(__dirname, '../build/native/blockit-enumerator.exe');
}

// Ask the helper whether the process can open the volume directly; that is
// exactly the capability the fast MFT scan needs, so no other elevation check
// is required. Cached per drive for the session.
const volumeProbes = new Map<string, { admin: boolean; ntfs: boolean }>();
async function probeVolume(root: string): Promise<{ admin: boolean; ntfs: boolean }> {
  const drive = root.slice(0, 2).toLowerCase();
  const cached = volumeProbes.get(drive);
  if (cached) return cached;
  const reader = new NativeDirectoryReader(helperPath());
  try {
    await reader.ready;
    const result = await reader.probeVolume(root);
    volumeProbes.set(drive, result);
    return result;
  } finally { reader.close(); }
}

// Relaunch through UAC with the scan root handed over; the elevated instance
// starts the scan itself (scan:launch-target).
async function relaunchElevated(rootPath: string): Promise<void> {
  const encoded = Buffer.from(rootPath, 'utf8').toString('base64url');
  const executable = process.execPath.replace(/'/g, "''");
  const appPath = app.getAppPath().replace(/'/g, "''");
  const launchArguments = app.isPackaged
    ? `'--scan-root-base64=${encoded}'`
    : `'${appPath}','--scan-root-base64=${encoded}'`;
  const script = `$ErrorActionPreference='Stop'; Start-Process -FilePath '${executable}' -Verb RunAs -ArgumentList ${launchArguments}`;
  // The elevated app must acquire its own lock. Keep this window alive if UAC is cancelled.
  app.releaseSingleInstanceLock();
  try {
    await execFileAsync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true});
    app.quit();
  } catch (error) {
    if(!app.hasSingleInstanceLock()) app.requestSingleInstanceLock();
    throw error;
  }
}

async function readSettings(): Promise<AppSettings> {
  try {
    const saved = JSON.parse(await fs.readFile(settingsPath(), 'utf8')) as Partial<AppSettings>;
    return { ...defaultSettings, ...settingsPatch(saved) };
  } catch {
    return { ...defaultSettings };
  }
}

let settingsWrites: Promise<unknown> = Promise.resolve();
function saveSettings(input: Partial<AppSettings>): Promise<AppSettings> {
  const patch=settingsPatch(input);
  const write=settingsWrites.catch(()=>undefined).then(async()=>{
  const next = { ...(await readSettings()), ...patch };
  await fs.mkdir(app.getPath('userData'), { recursive: true });
  const temporary = `${settingsPath()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(next, null, 2), 'utf8');
  await fs.rename(temporary, settingsPath());
  nativeTheme.themeSource = next.theme;
  return next;
  });
  settingsWrites=write;
  return write;
}

async function cleanOldScans(): Promise<void> {
  const directory = scanDirectory();
  await fs.mkdir(directory, { recursive: true });
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.db(?:-wal|-shm)?$/.test(entry.name)) continue;
    const itemPath = path.join(directory, entry.name);
    try {
      const stat = await fs.stat(itemPath);
      if (stat.mtimeMs < cutoff) await fs.unlink(itemPath);
    } catch {
      // A currently active database may be locked; leave it for the next launch.
    }
  }
}

async function listDrives(): Promise<DriveTarget[]> {
  const command = [
    'Get-CimInstance Win32_LogicalDisk',
    "Where-Object { $_.DriveType -in 2,3,4,5 }",
    'Select-Object DeviceID,VolumeName,DriveType,Size,FreeSpace',
    'ConvertTo-Json -Compress',
  ].join(' | ');
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      windowsHide: true,
      timeout: 8_000,
      maxBuffer: 1024 * 1024,
    });
    const parsed = JSON.parse(stdout.trim()) as Record<string, unknown> | Array<Record<string, unknown>>;
    const rows = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
    return rows.map((row) => {
      const driveType = Number(row.DriveType);
      const type: DriveTarget['type'] = driveType === 2 ? 'removable' : driveType === 3 ? 'local' : driveType === 4 ? 'network' : driveType === 5 ? 'optical' : 'unknown';
      const root = `${String(row.DeviceID)}\\`;
      const volume = String(row.VolumeName || '').trim();
      return {
        root,
        label: volume ? `${volume} (${String(row.DeviceID)})` : `${type[0].toUpperCase()}${type.slice(1)} disk (${String(row.DeviceID)})`,
        type,
        totalBytes: Number(row.Size || 0),
        freeBytes: Number(row.FreeSpace || 0),
      };
    });
  } catch {
    const candidates = Array.from({ length: 24 }, (_, index) => `${String.fromCharCode(67 + index)}:\\`);
    const drives = await Promise.all(candidates.map(async (root): Promise<DriveTarget | null> => {
      try {
        const info = await fs.statfs(root);
        return {
          root,
          label: `Disk (${root.slice(0, 2)})`,
          type: 'unknown',
          totalBytes: Number(info.blocks) * Number(info.bsize),
          freeBytes: Number(info.bavail) * Number(info.bsize),
        };
      } catch {
        return null;
      }
    }));
    return drives.filter((drive): drive is DriveTarget => drive !== null);
  }
}

function openDatabase(scanId: string, readonly = true): Database.Database {
  const db=new Database(databasePath(scanId), { readonly, fileMustExist: true });
  db.pragma('cache_size = -8192');
  db.pragma('temp_store = FILE');
  return db;
}


async function startScan(rootInput: string): Promise<{ scanId: string }> {
  if(typeof rootInput!=='string'||!rootInput||rootInput.length>32767||rootInput.includes('\0')) throw new Error('Invalid scan location.');
  if(recycling||exporting||elevating) throw new Error('Wait for the current file operation to finish.');
  if (startingScan || activeWorkers.size) throw new Error('Wait for the current scan to stop before starting another.');
  startingScan=true;
  try {
  const root = path.resolve(rootInput);
  const stat = await fs.lstat(root);
  if (!stat.isDirectory()||stat.isSymbolicLink()) throw new Error('Choose a real folder or drive to scan, not a shortcut or junction.');
  // Whole-drive scans get one chance at the fast MFT engine, which needs
  // administrator rights; offering it up front beats a slow scan by default.
  // Cancelling UAC simply continues with the standard scan.
  if (process.platform === 'win32' && /^[a-zA-Z]:\\?$/i.test(root) && mainWindow) {
    let probe: { admin: boolean; ntfs: boolean };
    try { probe = await probeVolume(root); } catch { probe = { admin: false, ntfs: false }; }
    if (!probe.admin && probe.ntfs) {
      const choice = await dialog.showMessageBox(mainWindow, {
        type: 'question', buttons: ['Restart as administrator', 'Scan without elevation'], defaultId: 0, cancelId: 1,
        title: 'Fast drive scan available',
        message: 'Scan this drive much faster as administrator?',
        detail: 'Administrator rights let BlockIT read the drive index (MFT) directly — typically several times faster for a whole drive, and the only way to finish large drives quickly. Without them the scan uses the standard directory method.',
      });
      if (choice.response === 0) {
        try { await relaunchElevated(root); return { scanId: '' }; }
        catch { /* UAC declined or failed: scan without elevation below. */ }
      }
    }
  }
  const volume = await fs.statfs(root);
  const scanId = randomUUID();
  await fs.mkdir(scanDirectory(), { recursive: true });
  const worker = new Worker(path.join(__dirname, 'scanner-worker.js'), {
    workerData: {
      scanId,
      root,
      dbPath: databasePath(scanId),
      volumeTotalBytes: Number(volume.blocks) * Number(volume.bsize),
      volumeFreeBytes: Number(volume.bavail) * Number(volume.bsize),
      clusterSize: Number(volume.bsize) || 4096,
      excludedPaths: [scanDirectory()],
      nativeHelperPath: app.isPackaged ? path.join(process.resourcesPath, 'blockit-enumerator.exe') : undefined,
    },
  });
  activeWorkers.set(scanId, worker);
  worker.on('message', (message: { type: string; progress?: ScanProgress }) => {
    if (message.type === 'progress' && message.progress) {
      for (const window of BrowserWindow.getAllWindows()) window.webContents.send('scan:progress', message.progress);
    }
  });
  worker.on('error', (error) => {
    activeWorkers.delete(scanId);
    const progress: ScanProgress = {
      scanId,
      status: 'failed',
      currentPath: root,
      files: 0,
      folders: 0,
      bytes: 0,
      warnings: 0,
      elapsedMs: 0,
      message: error.message,
    };
    mainWindow?.webContents.send('scan:progress', progress);
  });
  worker.on('exit',()=>activeWorkers.delete(scanId));
  return { scanId };
  } finally { startingScan=false; }
}

function resolveNode(scanId: string, nodeId: number, writable = false): { db: Database.Database; node: FileNode; rootPath: string } {
  nodeIdentifier(nodeId);
  const db = openDatabase(scanId, !writable);
  try {
  const row = db.prepare('SELECT * FROM nodes WHERE id = ?').get(nodeId) as Record<string, unknown> | undefined;
  const run = db.prepare('SELECT root_path FROM scan_runs WHERE id = ?').get(scanId) as { root_path: string } | undefined;
  if (!row || !run) {
    db.close();
    throw new Error('This item is no longer available in the active scan.');
  }
  const node = mapNode(row);
  if (!insideRoot(run.root_path,node.path)) {
    db.close();
    throw new Error('The selected item is outside the scanned location.');
  }
  return { db, node, rootPath: run.root_path };
  } catch(error) {if(db.open)db.close();throw error;}
}

async function nodeAction(scanId: string, nodeId: number, action: 'open' | 'reveal' | 'copy'): Promise<ActionResult> {
  let resolved: ReturnType<typeof resolveNode> | undefined;
  try {
    resolved = resolveNode(scanId, nodeId);
    await validateLivePath(resolved.rootPath,resolved.node.path);
    if (action === 'copy') clipboard.writeText(resolved.node.path);
    if (action === 'reveal') shell.showItemInFolder(resolved.node.path);
    if (action === 'open') {
      const error = await shell.openPath(resolved.node.path);
      if (error) throw new Error(error);
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  } finally {
    resolved?.db.close();
  }
}

async function trashNodes(scanId: string, nodeIds: number[]): Promise<ActionResult> {
  if (activeWorkers.size||startingScan||exporting) return { ok: false, message: 'Wait until the scan or export finishes before recycling items.' };
  scanIdentifier(scanId);
  if(!Array.isArray(nodeIds)||nodeIds.length>100) return {ok:false,message:'Select between 1 and 100 items.'};
  nodeIds.forEach(nodeIdentifier);
  const succeeded: number[] = [];
  const failed: Array<{ id: number; message: string }> = [];
  let unique = [...new Set(nodeIds)];
  if (!unique.length) return { ok: false, message: 'Select an item first.' };
  let previews = unique.map((id) => {
    const item = resolveNode(scanId, id);
    try { return item.node; } finally { item.db.close(); }
  });
  // Selecting a folder and one of its descendants must not double-count or recycle twice.
  previews=previews.filter(node=>!previews.some(parent=>parent.id!==node.id&&parent.kind==='folder'&&insideRoot(parent.path,node.path,false)));
  unique=previews.map(node=>node.id);
  if(previews.some(node=>node.parentId==null)) return {ok:false,message:'The scan root cannot be recycled.'};
  if(previews.some(node=>node.kind==='folder')) {
    const summary=await readQuery<ScanSummary>('summary',scanId);
    if(!['completed','completed_with_warnings'].includes(summary.status)) return {ok:false,message:'Finish a fresh scan before recycling a folder. Partial scans cannot account for its contents.'};
  }
  const confirmation = await dialog.showMessageBox(mainWindow!, {
    type: 'warning', buttons: ['Cancel', 'Move to Recycle Bin'], defaultId: 0, cancelId: 0,
    title: 'Recycle selected items?', message: `Move ${previews.length} item(s) to the Windows Recycle Bin?`,
    detail: `${previews.map((node) => node.path).join('\n')}\n\nIndexed logical size: ${previews.reduce((sum, node) => sum + node.size, 0).toLocaleString()} bytes.\nSizes reflect the scan and may omit inaccessible or changed files. Recycling a folder includes all of its current contents.`,
  });
  if (confirmation.response !== 1) return { ok: false, message: 'Recycle cancelled.' };
  for (const nodeId of unique) {
    let resolved: ReturnType<typeof resolveNode> | undefined;
    let recycled=false;
    try {
      resolved = resolveNode(scanId, nodeId, true);
      if (path.resolve(resolved.node.path).toLowerCase() === path.resolve(resolved.rootPath).toLowerCase()) {
        throw new Error('The scan root cannot be recycled.');
      }
      await validateLivePath(resolved.rootPath,resolved.node.path,false);
      await shell.trashItem(resolved.node.path);
      recycled=true;
      succeeded.push(nodeId);
      await readQuery('reconcile',scanId,nodeId);
    } catch (error) {
      failed.push({ id: nodeId, message: (recycled?'Item was recycled, but its cached totals could not be updated. Rescan this location. ':'')+(error instanceof Error ? error.message : String(error)) });
    } finally {
      resolved?.db.close();
    }
  }
  if(succeeded.length) {
    await readQuery('invalidate');
    try {
      const db=openDatabase(scanId,false);
      try {
        const root=db.prepare('SELECT root_path FROM scan_runs WHERE id=?').get(scanId) as {root_path:string};
        const volume=await fs.statfs(root.root_path);
        db.prepare('UPDATE scan_runs SET volume_free_size=? WHERE id=?').run(Number(volume.bavail)*Number(volume.bsize),scanId);
      } finally {db.close();}
    } catch { /* Recycle may not release space until the bin is emptied; keep last capacity if unavailable. */ }
  }
  return { ok: failed.length === 0, succeeded, failed, message: failed.length ? failed.map(item=>item.message).join('\n') : undefined };
}

async function exportCsv(input: NodeQuery): Promise<ActionResult> {
  if(exporting||recycling||activeWorkers.size||startingScan) return {ok:false,message:'Finish or stop the scan before exporting. Only one file operation can run at a time.'};
  exporting=true;
  try {
    const query=validateQuery(input);
    const result=await dialog.showSaveDialog(mainWindow!,{
      title:'Export BlockIT results',defaultPath:'blockit-storage.csv',
      filters:[{name:'CSV file',extensions:['csv']}],
    });
    if(result.canceled||!result.filePath) return {ok:false,message:'Export cancelled.'};
    const count=await readQuery<number>('export',query,result.filePath);
    return {ok:true,message:`Exported ${count.toLocaleString()} items.`};
  } catch(error) {return {ok:false,message:error instanceof Error?error.message:String(error)};}
  finally {exporting=false;}
}

async function createWindow(): Promise<void> {
  const settings = await readSettings();
  nativeTheme.themeSource = settings.theme;
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1080,
    minHeight: 700,
    show: false,
    backgroundColor: settings.theme === 'dark' ? '#0b1220' : '#f4f7fb',
    title: 'BlockIT',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.removeMenu();
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  if (process.env.VITE_DEV_SERVER_URL) await mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  else await mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}

function registerIpc(): void {
  ipcMain.handle('drives:list', () => listDrives());
  ipcMain.handle('dialog:select-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory'], title: 'Choose a folder to scan' });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('scan:start', (_event, root: string) => startScan(root));
  ipcMain.handle('scan:cancel', (_event, scanId: string) => {
    activeWorkers.get(scanId)?.postMessage({ type: 'cancel' });
  });
  ipcMain.handle('scan:pause',(_event,scanId:string)=>activeWorkers.get(scanId)?.postMessage({type:'pause'}));
  ipcMain.handle('scan:resume',(_event,scanId:string)=>activeWorkers.get(scanId)?.postMessage({type:'resume'}));
  ipcMain.handle('scan:launch-target', () => {
    const argument = process.argv.find((value) => value.startsWith('--scan-root-base64='));
    if (!argument) return null;
    try { return Buffer.from(argument.split('=')[1], 'base64url').toString('utf8'); } catch { return null; }
  });
  ipcMain.handle('scan:rescan-elevated', async (_event, scanId: string): Promise<ActionResult> => {
    if(elevating||activeWorkers.size||startingScan||recycling||exporting) return {ok:false,message:'Finish or stop the current operation before restarting as administrator.'};
    elevating=true;
    try {
      const db = openDatabase(scanId);
      const run = db.prepare('SELECT root_path FROM scan_runs WHERE id = ?').get(scanId) as { root_path: string } | undefined;
      db.close();
      if (!run) throw new Error('Scan not found.');
      await relaunchElevated(run.root_path);
      return { ok: true };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    } finally {elevating=false;}
  });
  ipcMain.handle('data:summary', (_event, scanId: string) => readQuery('summary',scanId));
  ipcMain.handle('data:nodes', (_event, query: NodeQuery) => readQuery('nodes',validateQuery(query)));
  ipcMain.handle('data:ancestors', (_event, scanId: string, nodeId: number) => readQuery('ancestors',scanIdentifier(scanId),nodeIdentifier(nodeId)));
  ipcMain.handle('data:treemap', (_event, scanId: string, parentId: number) => readQuery('treemap',scanId,parentId));
  ipcMain.handle('data:warnings', (_event, scanId: string) => {
    const db = openDatabase(scanId);
    try { return db.prepare('SELECT path, message FROM warnings WHERE scan_id = ? ORDER BY id DESC LIMIT 200').all(scanId); }
    finally { db.close(); }
  });
  ipcMain.handle('actions:open', (_event, scanId: string, nodeId: number) => nodeAction(scanId, nodeId, 'open'));
  ipcMain.handle('actions:reveal', (_event, scanId: string, nodeId: number) => nodeAction(scanId, nodeId, 'reveal'));
  ipcMain.handle('actions:copy-path', (_event, scanId: string, nodeId: number) => nodeAction(scanId, nodeId, 'copy'));
  ipcMain.handle('actions:trash', async (_event, scanId: string, nodeIds: number[]): Promise<ActionResult> => {
    if(recycling) return {ok:false,message:'A recycle operation is already in progress.'};
    recycling=true;
    try {return await trashNodes(scanId,nodeIds);}
    catch(error) {return {ok:false,message:error instanceof Error?error.message:String(error)};}
    finally {recycling=false;}
  });
  ipcMain.handle('actions:export-csv', (_event, query: NodeQuery) => exportCsv(query));
  ipcMain.handle('actions:export-treemap', async (_event, dataUrl: string): Promise<ActionResult> => {
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,') || dataUrl.length > 25_000_000) return { ok: false, message: 'Invalid treemap image.' };
    const result = await dialog.showSaveDialog(mainWindow!, { defaultPath: 'blockit-treemap.png', filters: [{ name: 'PNG image', extensions: ['png'] }] });
    if (result.canceled || !result.filePath) return { ok: false, message: 'Export cancelled.' };
    await fs.writeFile(result.filePath, Buffer.from(dataUrl.split(',')[1], 'base64'));
    return { ok: true, message: 'Treemap image saved.' };
  });
  ipcMain.handle('settings:get', () => readSettings());
  ipcMain.handle('settings:update', (_event, patch: Partial<AppSettings>) => saveSettings(patch));
}

const ownsInstance=app.requestSingleInstanceLock();
if(!ownsInstance) app.quit();
app.on('second-instance',()=>{
  if(mainWindow?.isMinimized()) mainWindow.restore();
  mainWindow?.show();mainWindow?.focus();
});
if(ownsInstance) app.whenReady().then(async () => {
  try {setPriority(0,osConstants.priority.PRIORITY_BELOW_NORMAL);} catch {}
  await cleanOldScans();
  registerIpc();
  await createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); });
});

app.on('window-all-closed', () => {
  for (const worker of activeWorkers.values()) worker.postMessage({ type: 'cancel' });
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit',()=>{void queryWorker?.terminate();});
