import { parentPort, workerData } from 'node:worker_threads';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { categorize, extensionOf } from '../src/shared/categories';
import { estimatedAllocatedSize } from '../src/shared/format';
import { insideRoot } from './path-safety';
import type { ScanProgress, ScanStatus } from '../src/shared/types';

const data = workerData as { scanId: string; root: string; dbPath: string; volumeTotalBytes: number; volumeFreeBytes: number; clusterSize: number; excludedPaths?: string[] };
const db = new Database(data.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('cache_size = -8192');
db.pragma('temp_store = FILE');
let status: ScanStatus = 'scanning';
let cancelled = false, paused = false, finalizing = false;
let files = 0, folders = 1, bytes = 0, allocatedBytes = 0, warnings = 0;
let rows = 0, lastCommit = Date.now(), lastProgress = 0, currentPath = data.root;
let flushCurrentFolder: (() => void) | undefined;
const startedAt = Date.now();
const excluded = (data.excludedPaths || []).map(p => path.resolve(p).toLowerCase());
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
  CREATE INDEX IF NOT EXISTS idx_nodes_size ON nodes(scan_id, size DESC);
  CREATE INDEX IF NOT EXISTS idx_nodes_category ON nodes(scan_id, category, size DESC);
  CREATE INDEX IF NOT EXISTS idx_nodes_extension ON nodes(scan_id, extension, size DESC);
`);
db.exec(`
  CREATE INDEX idx_files_size ON nodes(scan_id,kind,size DESC);
  CREATE INDEX idx_children_size ON nodes(scan_id,parent_id,size DESC);
  CREATE TABLE pending_folders (id INTEGER PRIMARY KEY, path TEXT NOT NULL, phase INTEGER NOT NULL DEFAULT 0);
  CREATE INDEX pending_phase ON pending_folders(phase,id DESC);
  CREATE TABLE aggregates (dimension TEXT NOT NULL, name TEXT NOT NULL, size INTEGER NOT NULL DEFAULT 0,
    allocatedSize INTEGER NOT NULL DEFAULT 0, count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(dimension,name));
  CREATE TRIGGER update_aggregates_on_delete AFTER DELETE ON nodes WHEN OLD.kind='file' BEGIN
    UPDATE aggregates SET size=size-OLD.size,allocatedSize=allocatedSize-OLD.allocated_size,count=count-1
      WHERE (dimension='category' AND name=OLD.category) OR (dimension='extension' AND name=OLD.extension);
  END;
`);
const insertNode=db.prepare(`INSERT INTO nodes
  (scan_id,parent_id,name,path,kind,extension,category,size,allocated_size,modified_at,attributes)
  VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
const insertWarning=db.prepare('INSERT INTO warnings(scan_id,path,message) VALUES (?,?,?)');
const pendingInsert=db.prepare('INSERT INTO pending_folders VALUES (?,?,0)');
const pendingNext=db.prepare('SELECT * FROM pending_folders ORDER BY id DESC LIMIT 1');
const pendingDelete=db.prepare('DELETE FROM pending_folders WHERE id=?');
const pendingVisited=db.prepare('UPDATE pending_folders SET phase=1 WHERE id=?');
const nodeById=db.prepare('SELECT * FROM nodes WHERE id=?');
const unfinishedParents=db.prepare('SELECT id FROM pending_folders WHERE phase=1 ORDER BY id DESC LIMIT 256');
const folderTotals=db.prepare('UPDATE nodes SET size=?,allocated_size=?,file_count=?,folder_count=?,item_count=? WHERE id=?');
const parentTotals=db.prepare(`UPDATE nodes SET size=size+?,allocated_size=allocated_size+?,
  file_count=file_count+?,folder_count=folder_count+?,item_count=item_count+? WHERE id=?`);
const updateRun=db.prepare('UPDATE scan_runs SET total_size=?,allocated_size=?,file_count=?,folder_count=?,warning_count=? WHERE id=?');
const aggregateUpsert=db.prepare(`INSERT INTO aggregates VALUES (?,?,?,?,?) ON CONFLICT(dimension,name)
  DO UPDATE SET size=size+excluded.size,allocatedSize=allocatedSize+excluded.allocatedSize,count=count+excluded.count`);
const aggregateBatch=new Map<string,{dimension:string;name:string;size:number;allocated:number;count:number}>();
function aggregate(dimension:string,name:string,size:number,allocated:number) {
  const key=dimension+':'+name;
  const row=aggregateBatch.get(key)||{dimension,name,size:0,allocated:0,count:0};
  row.size+=size; row.allocated+=allocated; row.count++; aggregateBatch.set(key,row);
}
function progress(force=false) {
  const now=Date.now();
  if (!force && now-lastProgress<500) return;
  lastProgress=now;
  const payload:ScanProgress={scanId:data.scanId,status,currentPath,files,folders,bytes,warnings,elapsedMs:now-startedAt,
    message:paused?'Paused — resume when ready':finalizing?'Finishing folder totals…':undefined};
  parentPort?.postMessage({type:'progress',progress:payload});
}
function commit(force=false) {
  if (!db.inTransaction || (!force && rows<1024 && Date.now()-lastCommit<1000)) return;
  flushCurrentFolder?.();
  for(const row of aggregateBatch.values()) aggregateUpsert.run(row.dimension,row.name,row.size,row.allocated,row.count);
  aggregateBatch.clear();
  updateRun.run(bytes,allocatedBytes,files,folders,warnings,data.scanId);
  db.exec('COMMIT'); rows=0; lastCommit=Date.now(); progress();
}
function begin() { if (!db.inTransaction) db.exec('BEGIN'); }
function warn(p:string,error:unknown) {
  if(warnings<1000) insertWarning.run(data.scanId,p,String(error).slice(0,800));
  warnings++; rows++;
}
parentPort?.on('message',({type}:{type:string})=>{
  if(type==='cancel') {cancelled=true;paused=false;status='cancelling';}
  if(type==='pause'&&!cancelled) {paused=true;status='paused';}
  if(type==='resume'&&!cancelled) {paused=false;status='scanning';}
  progress(true);
});
async function breathe() {
  commit();
  await new Promise(resolve=>setTimeout(resolve,12));
  if(paused) commit(true);
  while(paused&&!cancelled) await new Promise(resolve=>setTimeout(resolve,80));
  begin();
}

// Only four metadata requests at a time: overlap filesystem latency without an
// unbounded Promise.all or a full directory listing in memory.
async function* entriesWithStats(directory: Awaited<ReturnType<typeof fs.opendir>>) {
  let batch: string[]=[];
  const read = (names: string[]) => Promise.all(names.map(async name => {
    const entryPath=path.join(directory.path,name);
    try { return {name,entryPath,stat:await fs.lstat(entryPath),error:undefined}; }
    catch(error) { return {name,entryPath,stat:undefined,error}; }
  }));
  for await(const entry of directory) {
    if(cancelled) break;
    const normalized=path.resolve(directory.path,entry.name).toLowerCase();
    if(excluded.some(p=>normalized===p||normalized.startsWith(p+path.sep))) continue;
    batch.push(entry.name);
    if(batch.length===4) {
      if(paused) await breathe();
      if(cancelled) break;
      yield await read(batch); batch=[];
    }
  }
  if(batch.length&&!cancelled) { if(paused) await breathe(); if(!cancelled) yield await read(batch); }
}
async function run() {
  db.prepare(`INSERT INTO scan_runs(id,root_path,label,status,started_at,volume_total_size,volume_free_size)
    VALUES (?,?,?,'scanning',?,?,?)`).run(data.scanId,data.root,path.basename(data.root)||data.root,startedAt,data.volumeTotalBytes,data.volumeFreeBytes);
  const rootStat=await fs.lstat(data.root);
  if(!rootStat.isDirectory()||rootStat.isSymbolicLink()) throw new Error('Choose a real folder to scan.');
  const realRoot=await fs.realpath(data.root);
  const rootId=Number(insertNode.run(data.scanId,null,path.basename(data.root)||data.root,data.root,'folder','','Other',0,0,rootStat.mtimeMs,'').lastInsertRowid);
  pendingInsert.run(rootId,data.root); begin();
  let work=0;
  while(!cancelled) {
    const current=pendingNext.get() as {id:number;path:string;phase:number}|undefined;
    if(!current) break;
    if(current.phase===1) {
      rollUp(current.id);
      if(++work%128===0) await breathe();
      commit();begin();continue;
    }
    pendingVisited.run(current.id);
    let size=0,allocated=0,fileCount=0,folderCount=0;
    flushCurrentFolder=()=>folderTotals.run(size,allocated,fileCount,folderCount,fileCount+folderCount,current.id);
    currentPath=current.path;
    try {
      const stat=await fs.lstat(current.path);
      if(stat.isSymbolicLink() || !stat.isDirectory() || !insideRoot(realRoot,await fs.realpath(current.path))) {
        throw new Error('Folder changed or now points outside this scan; skipped.');
      }
      const directory=await fs.opendir(current.path);
      for await(const batch of entriesWithStats(directory)) {
        for(const entry of batch) {
        if(cancelled) break;
        if(paused) await breathe();
        if(cancelled) break;
        const entryPath=entry.entryPath;
        currentPath=entryPath;
        try {
          if(!entry.stat) throw entry.error;
          const stat=entry.stat;
          if(!stat.isFile()&&!stat.isDirectory()&&!stat.isSymbolicLink()) throw new Error('Unsupported special filesystem entry; skipped.');
          const kind=stat.isSymbolicLink()?'link':stat.isDirectory()?'folder':'file';
          const extension=kind==='file'?extensionOf(entry.name):'';
          const category=kind==='file'?categorize(extension):'Other';
          const itemSize=kind==='file'?stat.size:0;
          const itemAllocated=estimatedAllocatedSize(itemSize,data.clusterSize);
          const attributes=[entry.name.startsWith('.')?'Hidden':'',(stat.mode&0o200)===0?'Read-only':''].filter(Boolean).join(', ');
          const id=Number(insertNode.run(data.scanId,current.id,entry.name,entryPath,kind,extension,category,itemSize,itemAllocated,stat.mtimeMs,attributes).lastInsertRowid);
          if(kind==='folder') {pendingInsert.run(id,entryPath);folders++;folderCount++;}
          if(kind==='file') {
            files++;fileCount++;bytes+=itemSize;allocatedBytes+=itemAllocated;size+=itemSize;allocated+=itemAllocated;
            aggregate('category',category,itemSize,itemAllocated);aggregate('extension',extension,itemSize,itemAllocated);
          }
          rows++;
        } catch(error) {warn(entryPath,error);}
        if(++work%128===0) await breathe();
        progress();
        }
      }
    } catch(error) {warn(current.path,error);}
    folderTotals.run(size,allocated,fileCount,folderCount,fileCount+folderCount,current.id);
    flushCurrentFolder=undefined;
    rows++;
    if(++work%128===0) await breathe();
    commit();begin();
  }
  commit(true);finalizing=true;progress(true);
  // Completed subtrees have already been accumulated. On cancellation, only
  // the open ancestor chain remains, not every folder on the drive.
  while(true) {
    const batch=unfinishedParents.all() as Array<{id:number}>;
    if(!batch.length) break;
    begin();
    for(const item of batch) {
      rollUp(item.id);
    }
    commit(true);await breathe();
  }
  commit(true);db.exec('DELETE FROM pending_folders');
  status=cancelled?'idle':warnings?'completed_with_warnings':'completed';
  db.prepare('UPDATE scan_runs SET status=?,completed_at=? WHERE id=?').run(status,Date.now(),data.scanId);
  progress(true);
  parentPort?.postMessage({type:'done',scanId:data.scanId,rootId,status});
}
function rollUp(id:number) {
  const node=nodeById.get(id) as Record<string,number>;
  if(node.parent_id!=null) parentTotals.run(node.size,node.allocated_size,node.file_count,node.folder_count,node.file_count+node.folder_count,node.parent_id);
  pendingDelete.run(id);rows++;
}
run().catch(error=>{
  if(db.inTransaction) db.exec('ROLLBACK');
  status='failed';
  try {db.prepare('UPDATE scan_runs SET status=?,completed_at=? WHERE id=?').run(status,Date.now(),data.scanId);} catch {}
  parentPort?.postMessage({type:'progress',progress:{scanId:data.scanId,status,currentPath,files,folders,bytes,warnings,elapsedMs:Date.now()-startedAt,message:String(error)}});
  parentPort?.postMessage({type:'error',scanId:data.scanId,message:String(error)});
}).finally(()=>{db.close();parentPort?.close();});
