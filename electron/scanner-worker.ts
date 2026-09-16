import { parentPort, workerData } from 'node:worker_threads';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { categorize, extensionOf } from '../src/shared/categories';
import { estimatedAllocatedSize } from '../src/shared/format';
import { insideRoot } from './path-safety';
import { performance } from 'node:perf_hooks';
import { NativeDirectoryReader, NativeDirectoryTimeoutError, VolumeAccessDeniedError, VolumeUnavailableError, type EntryMetadata } from './native-directory';
import type { ScanProgress, ScanStatus } from '../src/shared/types';

const data = workerData as { scanId: string; root: string; dbPath: string; volumeTotalBytes: number; volumeFreeBytes: number; clusterSize: number; excludedPaths?: string[]; metadataEngine?: 'portable' | 'volume-fixture'; nativeHelperPath?: string; lanes?: number };
const db = new Database(data.dbPath);
db.pragma('page_size = 16384');
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
// Fewer, larger checkpoints: committing every few thousand rows no longer
// stalls on a WAL sync, which profiling showed costing more than the inserts.
// Checkpoints are taken explicitly at scan end: mid-scan checkpoints
// copy the whole WAL while the scanner is trying to enumerate.
db.pragma('wal_autocheckpoint = 0');
db.pragma('cache_size = -65536');
db.pragma('temp_store = FILE');
let status: ScanStatus = 'scanning';
let cancelled = false, paused = false, finalizing = false;
let files = 0, folders = 1, bytes = 0, allocatedBytes = 0, warnings = 0;
let rows = 0, lastCommit = Date.now(), lastProgress = 0, currentPath = data.root;
let nativeHelperWarned = false, enginePosted = false, slowStorage = false, dirsOpened = 0;
let engineName:'volume'|'native' = 'native';
const latencyWindow: number[] = [];
let latencySum = 0;
const startedAt = Date.now();
// Optional phase diagnostics for whole-drive profiling (BLOCKIT_SCAN_TIMING=1).
const TIMING = process.env.BLOCKIT_SCAN_TIMING === '1';
const T: Record<string, number> = TIMING ? {read:0,readN:0,insert:0,commit:0,commitN:0,drain:0,idx:0,probeSelfNull:0,dirs:0} : (undefined as unknown as Record<string, number>);
let enumWallStart = 0, enumWallEnd = 0;
function reportTiming() {
  if(TIMING) parentPort?.postMessage({type:'timing',timing:{...T, enumWall: enumWallEnd ? enumWallEnd - enumWallStart : 0, lanes: lanes.length, slowStorage, files, folders, engine: engineName}});
}
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
    id INTEGER PRIMARY KEY,
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
    id INTEGER PRIMARY KEY,
    scan_id TEXT NOT NULL,
    path TEXT NOT NULL,
    message TEXT NOT NULL
  );
  CREATE TABLE aggregates (dimension TEXT NOT NULL, name TEXT NOT NULL, size INTEGER NOT NULL DEFAULT 0,
    allocatedSize INTEGER NOT NULL DEFAULT 0, count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(dimension,name));
  CREATE TRIGGER update_aggregates_on_delete AFTER DELETE ON nodes WHEN OLD.kind='file' BEGIN
    UPDATE aggregates SET size=size-OLD.size,allocatedSize=allocatedSize-OLD.allocated_size,count=count-1
      WHERE (dimension='category' AND name=OLD.category) OR (dimension='extension' AND name=OLD.extension);
  END;
`);
// Secondary indexes are built once after enumeration instead of maintained on
// every insert: rows land in an append-only table during the scan, and live
// treemap queries wait for the folder index.
// idx_files_size is omitted: size-ordered queries (largest files, large-file
// view) scan idx_nodes_size and filter kind as a residual, which stays cheap
// because folders are a small share of rows.
let treemapReady = false;
const TREEMAP_INDEX = "CREATE INDEX IF NOT EXISTS idx_children_size ON nodes(parent_id,size DESC)";
const RESULT_INDEXES = `
  CREATE INDEX IF NOT EXISTS idx_nodes_size ON nodes(size DESC);
  CREATE INDEX IF NOT EXISTS idx_nodes_category ON nodes(category,size DESC);
  CREATE INDEX IF NOT EXISTS idx_nodes_extension ON nodes(extension,size DESC);

`;
// Live top lists for the dashboard during a scan: the worker maintains them in
// memory and republishes a tiny table per commit, so the UI never runs
// size-ordered queries against the unindexed, still-growing table.
db.exec(`CREATE TABLE IF NOT EXISTS scan_top (
  kind TEXT NOT NULL, id INTEGER NOT NULL, name TEXT NOT NULL, path TEXT NOT NULL,
  extension TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT 'Other',
  size INTEGER NOT NULL DEFAULT 0, allocated_size INTEGER NOT NULL DEFAULT 0,
  modified_at INTEGER NOT NULL DEFAULT 0, attributes TEXT NOT NULL DEFAULT '',
  item_count INTEGER NOT NULL DEFAULT 0, file_count INTEGER NOT NULL DEFAULT 0,
  folder_count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(kind,id));`);
const TOP_LIMIT=8;
type TopRow={id:number;name:string;path:string;extension:string;category:string;size:number;allocated_size:number;modified_at:number;attributes:string;item_count:number;file_count:number;folder_count:number};
const topFileRows: TopRow[] = [];
const topFolderRows: TopRow[] = [];
let topDirty = false;
const scanTopDelete=db.prepare('DELETE FROM scan_top');
const scanTopInsert=db.prepare(`INSERT INTO scan_top (kind,id,name,path,extension,category,size,allocated_size,modified_at,attributes,item_count,file_count,folder_count)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
function noteTopFile(id:number,metadata:EntryMetadata,entryPath:string,extension:string,category:string,size:number,allocated:number) {
  const last=topFileRows[topFileRows.length-1];
  if(topFileRows.length>=TOP_LIMIT&&last&&size<=last.size) return;
  const row:TopRow={id,name:metadata.name,path:entryPath,extension,category,size,allocated_size:allocated,modified_at:metadata.modifiedAt,attributes:metadata.attributes,item_count:1,file_count:1,folder_count:0};
  const index=topFileRows.findIndex(existing=>size>existing.size);
  if(index===-1) topFileRows.push(row); else topFileRows.splice(index,0,row);
  if(topFileRows.length>TOP_LIMIT) topFileRows.length=TOP_LIMIT;
  topDirty=true;
}
function noteTopFolder(row:TopRow) {
  const last=topFolderRows[topFolderRows.length-1];
  if(topFolderRows.length>=TOP_LIMIT&&last&&row.size<=last.size) return;
  const index=topFolderRows.findIndex(existing=>row.size>existing.size);
  if(index===-1) topFolderRows.push(row); else topFolderRows.splice(index,0,row);
  if(topFolderRows.length>TOP_LIMIT) topFolderRows.length=TOP_LIMIT;
  topDirty=true;
}
function publishTopLists() {
  if(!topDirty) return;
  scanTopDelete.run();
  for(const row of topFileRows) scanTopInsert.run('file',row.id,row.name,row.path,row.extension,row.category,row.size,row.allocated_size,row.modified_at,row.attributes,row.item_count,row.file_count,row.folder_count);
  for(const row of topFolderRows) scanTopInsert.run('folder',row.id,row.name,row.path,row.extension,row.category,row.size,row.allocated_size,row.modified_at,row.attributes,row.item_count,row.file_count,row.folder_count);
  topDirty=false;
}
// One database holds exactly one scan, so rows carry no scan_id column.
const NODE_COLUMNS='(parent_id,name,path,kind,extension,category,size,allocated_size,modified_at,attributes)';
const insertNode=db.prepare(`INSERT INTO nodes${NODE_COLUMNS} VALUES (?,?,?,?,?,?,?,?,?,?)`);
const INSERT_CHUNK=128;
const insertChunk=db.prepare(`INSERT INTO nodes${NODE_COLUMNS} VALUES ${Array.from({length:INSERT_CHUNK},()=>'(?,?,?,?,?,?,?,?,?,?)').join(',')}`);
const CHUNK_PARAMS=INSERT_CHUNK*10;
const insertWarning=db.prepare('INSERT INTO warnings(scan_id,path,message) VALUES (?,?,?)');
// Paths of folder rows awaiting enumeration, kept in memory instead of one
// SELECT per popped job; completed folders drop their entry.
const pathById=new Map<number,string>();
const folderTotals=db.prepare('UPDATE nodes SET size=?,allocated_size=?,file_count=?,folder_count=?,item_count=? WHERE id=?');
const folderTotalsFresh=db.prepare('UPDATE nodes SET size=?,allocated_size=?,file_count=?,folder_count=?,item_count=?,modified_at=? WHERE id=?');
const updateRun=db.prepare('UPDATE scan_runs SET total_size=?,allocated_size=?,file_count=?,folder_count=?,warning_count=? WHERE id=?');
const aggregateUpsert=db.prepare(`INSERT INTO aggregates VALUES (?,?,?,?,?) ON CONFLICT(dimension,name)
  DO UPDATE SET size=size+excluded.size,allocatedSize=allocatedSize+excluded.allocatedSize,count=count+excluded.count`);
const aggregateBatch=new Map<string,Map<string,{dimension:string;name:string;size:number;allocated:number;count:number}>>();
function aggregate(dimension:string,name:string,size:number,allocated:number) {
  let rows=aggregateBatch.get(dimension);
  if(!rows) { rows=new Map(); aggregateBatch.set(dimension,rows); }
  const row=rows.get(name)||{dimension,name,size:0,allocated:0,count:0};
  row.size+=size; row.allocated+=allocated; row.count++; rows.set(name,row);
}
function progress(force=false) {
  const now=Date.now();
  if (!force && now-lastProgress<500) return;
  lastProgress=now;
  const payload:ScanProgress={scanId:data.scanId,status,currentPath,files,folders,bytes,warnings,elapsedMs:now-startedAt,
    treemapReady,
    message:paused?'Paused — resume when ready':finalizing?(treemapReady?'Treemap ready — preparing other views…':'Preparing treemap…'):undefined};
  parentPort?.postMessage({type:'progress',progress:payload});
}
function commit(force=false) {
  if (!db.inTransaction || (!force && rows<65536 && Date.now()-lastCommit<1000)) return;
  for(const rows of aggregateBatch.values())
    for(const row of rows.values()) aggregateUpsert.run(row.dimension,row.name,row.size,row.allocated,row.count);
  aggregateBatch.clear();
  publishTopLists();
  updateRun.run(bytes,allocatedBytes,files,folders,warnings,data.scanId);
  const _c0 = TIMING ? performance.now() : 0;
  db.exec('COMMIT'); rows=0; lastCommit=Date.now(); progress();
  if(TIMING) {T.commit += performance.now() - _c0;T.commitN++;}
}
function begin() { if (!db.inTransaction) db.exec('BEGIN'); }
function warn(p:string,error:unknown) {
  if(warnings<1000) insertWarning.run(data.scanId,p,String(error).slice(0,800));
  warnings++; rows++;
}
function warnReaderUnavailable(error:unknown) {
  if(!nativeHelperWarned) { nativeHelperWarned=true; warn(data.root,'Fast metadata reader unavailable; using compatibility scanning. '+String(error)); }
}
parentPort?.on('message',({type}:{type:string})=>{
  if(type==='cancel') {
    cancelled=true;paused=false;status='cancelling';
    for(const lane of lanes) lane.reader?.close();
  }
  if(type==='pause'&&!cancelled) {paused=true;status='paused';for(const lane of lanes) lane.reader?.control('pause');}
  if(type==='resume'&&!cancelled) {paused=false;status='scanning';for(const lane of lanes) lane.reader?.control('resume');}
  progress(true);
});
let restSince = performance.eventLoopUtilization();
async function breathe() {
  commit();
  // Rest briefly after CPU-active work so one saturated core cannot starve the
  // app; otherwise a cheap loop yield is enough to let messages through.
  if(performance.eventLoopUtilization(restSince).active >= 8) {
    await new Promise(resolve=>setTimeout(resolve,1));
    restSince = performance.eventLoopUtilization();
  } else await new Promise<void>(resolve=>setImmediate(resolve));
  if(paused) commit(true);
  while(paused&&!cancelled) await new Promise(resolve=>setTimeout(resolve,80));
  begin();
}

// Depth-first frontier of folder ids awaiting enumeration. A folder's totals
// are assembled in memory: its own direct counts plus everything its completed
// children push up. Each folder row is written exactly once, at completion —
// no per-child roll-up statements touch the database.
const stack: number[] = [];
const awaiting = new Map<number, number>();      // folder -> discovered children not yet completed
const childTotals = new Map<number, number[]>(); // folder -> [size,allocated,files,folders,items] pushed up by completed children
const directAcc = new Map<number, FolderAcc>();  // enumeration finished, waiting on children
const parentOf = new Map<number, number>();      // discovered folder -> parent id (absent for the root)
let realRoot = '';
let inFlight = 0;
function tryComplete(startId:number) {
  let cursor: number | undefined = startId;
  while(cursor!=null) {
    const acc=directAcc.get(cursor);
    if(!acc) return;
    if((awaiting.get(cursor)??0)>0) return;
    directAcc.delete(cursor); awaiting.delete(cursor); pathById.delete(cursor);
    const extra=childTotals.get(cursor)??[0,0,0,0,0];
    childTotals.delete(cursor);
    const size=acc.size+extra[0], allocated=acc.allocated+extra[1], fileCount=acc.fileCount+extra[2], folderCount=acc.folderCount+extra[3];
    const itemCount=(acc.fileCount+acc.folderCount)+extra[4];
    if(acc.modifiedAt>0) folderTotalsFresh.run(size,allocated,fileCount,folderCount,itemCount,acc.modifiedAt,cursor);
    else folderTotals.run(size,allocated,fileCount,folderCount,itemCount,cursor);
    rows++;
    noteTopFolder({id:cursor,name:acc.name,path:acc.path,extension:'',category:'Other',size,allocated_size:allocated,
      modified_at:acc.modifiedAt,attributes:'',item_count:itemCount,file_count:fileCount,folder_count:folderCount});
    const parent=parentOf.get(cursor);
    parentOf.delete(cursor);
    if(parent==null||parent===-1) return;
    let totals=childTotals.get(parent);
    if(!totals) { totals=[0,0,0,0,0]; childTotals.set(parent,totals); }
    totals[0]+=size; totals[1]+=allocated; totals[2]+=fileCount; totals[3]+=folderCount; totals[4]+=itemCount;
    awaiting.set(parent,(awaiting.get(parent)??1)-1);
    cursor=parent;
  }
}
async function drainPartial() {
  const _d0 = TIMING ? performance.now() : 0;
  flushBatch();
  // Cancellation leaves finished, partial and never-scanned folders. A
  // folder's total comes entirely from memory (its direct counts plus
  // completed children's pushes), so one pass writes every affected row;
  // never-enumerated folders keep their zero rows.
  begin();
  let work=0;
  for(const id of [...directAcc.keys()].sort((a,b)=>b-a)) {
    const acc=directAcc.get(id);
    if(!acc) continue;
    const extra=childTotals.get(id)??[0,0,0,0,0];
    childTotals.delete(id); directAcc.delete(id); awaiting.delete(id); parentOf.delete(id); pathById.delete(id);
    const size=acc.size+extra[0], allocated=acc.allocated+extra[1], fileCount=acc.fileCount+extra[2], folderCount=acc.folderCount+extra[3];
    const itemCount=(acc.fileCount+acc.folderCount)+extra[4];
    if(acc.modifiedAt>0) folderTotalsFresh.run(size,allocated,fileCount,folderCount,itemCount,acc.modifiedAt,id);
    else folderTotals.run(size,allocated,fileCount,folderCount,itemCount,id);
    rows++;
    if(++work%4096===0) await breathe();
  }
  childTotals.clear(); awaiting.clear(); parentOf.clear();
  commit(true);
  if(TIMING) T.drain = performance.now() - _d0;
}

interface LaneJob { id: number; path: string }
interface Lane { reader: NativeDirectoryReader | undefined }
const lanes: Lane[] = [];
function takeDirectory(): LaneJob|undefined {
  while(stack.length) {
    const id=stack.pop()!;
    const rowPath=pathById.get(id);
    if(rowPath===undefined) continue;
    pathById.delete(id);
    return {id,path:rowPath};
  }
  return undefined;
}
function noteLatency(ms:number) {
  latencyWindow.push(ms); latencySum+=ms;
  if(latencyWindow.length>64) latencySum-=latencyWindow.shift()!;
  if(++dirsOpened===96) slowStorage = latencySum/latencyWindow.length>25 && !data.root.startsWith('\\\\');
}
function planExclusions(jobPath:string) {
  if(!excluded.length) return {skipAll:false,nameCheck:false};
  const lower=jobPath.toLowerCase();
  let skipAll=false,nameCheck=false;
  for(const p of excluded) {
    if(p===lower) { skipAll=true; break; }
    if(p.startsWith(lower+path.sep)) nameCheck=true;
  }
  return {skipAll,nameCheck};
}
function entryPathOf(jobPath:string,name:string) {
  return jobPath.endsWith(path.sep)?jobPath+name:jobPath+path.sep+name;
}
interface FolderAcc { size:number;allocated:number;fileCount:number;folderCount:number;modifiedAt:number;name:string;path:string }
// File rows queue into multi-row inserts; folder rows flush the queue first so
// their row id is known exactly when the enumeration frontier is pushed.
const batchParams: unknown[] = [];
function flushBatch() {
  if(!batchParams.length) return;
  const _f0 = TIMING ? performance.now() : 0;
  let offset=0;
  while(batchParams.length-offset>=CHUNK_PARAMS) {
    insertChunk.run(...batchParams.slice(offset,offset+CHUNK_PARAMS));
    offset+=CHUNK_PARAMS;
  }
  while(offset<batchParams.length) {
    insertNode.run(batchParams[offset],batchParams[offset+1],batchParams[offset+2],batchParams[offset+3],
      batchParams[offset+4],batchParams[offset+5],batchParams[offset+6],batchParams[offset+7],
      batchParams[offset+8],batchParams[offset+9]);
    offset+=10;
  }
  batchParams.length=0;
  if(TIMING) T.insert += performance.now() - _f0;
}
function recordEntry(parent:{id:number;path:string;acc:FolderAcc},name:string,kind:'file'|'folder'|'link',size:number,modifiedAt:number,attributes:string) {
  const entryPath=entryPathOf(parent.path,name);
  currentPath=entryPath;
  if(kind==='folder') {
    flushBatch();
    const id=Number(insertNode.run(parent.id,name,entryPath,kind,'','Other',0,0,modifiedAt,attributes).lastInsertRowid);
    pathById.set(id,entryPath);
    stack.push(id);folders++;parent.acc.folderCount++;
    awaiting.set(parent.id,(awaiting.get(parent.id)??0)+1);
    parentOf.set(id,parent.id);
    rows++;
    return;
  }
  const extension=kind==='file'?extensionOf(name):'';
  const category=kind==='file'?categorize(extension):'Other';
  const itemSize=kind==='file'?size:0;
  const itemAllocated=estimatedAllocatedSize(itemSize,data.clusterSize);
  if(kind==='file'&&(topFileRows.length<TOP_LIMIT||itemSize>topFileRows[topFileRows.length-1].size)) {
    // Top-list candidates flush the queue so their row id is exact.
    flushBatch();
    const id=Number(insertNode.run(parent.id,name,entryPath,kind,extension,category,itemSize,itemAllocated,modifiedAt,attributes).lastInsertRowid);
    noteTopFile(id,{name,kind,size,modifiedAt,attributes},entryPath,extension,category,itemSize,itemAllocated);
    files++;parent.acc.fileCount++;bytes+=itemSize;allocatedBytes+=itemAllocated;parent.acc.size+=itemSize;parent.acc.allocated+=itemAllocated;
    aggregate('category',category,itemSize,itemAllocated);aggregate('extension',extension,itemSize,itemAllocated);
    rows++;
    return;
  }
  batchParams.push(parent.id,name,entryPath,kind,extension,category,itemSize,itemAllocated,modifiedAt,attributes);
  if(kind==='file') {
    files++;parent.acc.fileCount++;bytes+=itemSize;allocatedBytes+=itemAllocated;parent.acc.size+=itemSize;parent.acc.allocated+=itemAllocated;
    aggregate('category',category,itemSize,itemAllocated);aggregate('extension',extension,itemSize,itemAllocated);
  }
  rows++;
  if(batchParams.length>=CHUNK_PARAMS) flushBatch();
}

let work=0;

// Walks a directory subtree through the helper: one open returns entries for
// the directory and prefetched descendants, tagged by walk index. Folder rows
// are created eagerly as the helper reports them; doneDirs completes a
// folder's totals. If the reader dies mid-walk the partial folders are
// finalized as-is with a warning (consistent totals, possibly missing
// subtrees; rescan refreshes) — per-directory fallback stays available until
// the first response arrives.
interface WalkNode { id:number; path:string; name:string; acc:FolderAcc }
function completeWalk(walk:Map<number,WalkNode>) {
  for(const node of walk.values()) {
    directAcc.set(node.id,node.acc);
    tryComplete(node.id);
  }
  walk.clear();
}
async function nativeEnumerate(lane:Lane,job:LaneJob,acc:FolderAcc,volume=false): Promise<'done'|'retry'> {
  const reader=lane.reader!;
  const walk=new Map<number,WalkNode>([[0,{id:job.id,path:job.path,name:path.basename(job.path)||job.path,acc}]]);
  let first = true;
  let emitted=false;
  let prefetched: ReturnType<NativeDirectoryReader["read"]> | undefined;
  while(!cancelled) {
    if(paused) await breathe();
    if(cancelled) { completeWalk(walk); return 'done'; }
    let batch;
    try {
      const opened = first;
      const openStart = performance.now();
      batch = prefetched ? await prefetched : volume && first
        ? await reader.readVolume(job.path, excluded)
        : volume
          ? await reader.readVolumeNext()
          : await reader.read(opened?job.path:undefined, excluded);
      prefetched=undefined;
      if(TIMING) { T.read += performance.now()-openStart; T.readN++; }
      if(opened && !volume) noteLatency(performance.now()-openStart);
    } catch(error) {
      // The reader is dead; later folders on this lane use compatibility
      // scanning. Do not duplicate emitted files or retry an unresponsive
      // provider call through the non-cancellable compatibility API.
      if(cancelled) { completeWalk(walk); return 'done'; }
      lane.reader = undefined;
      if(emitted) {
        completeWalk(walk);
        warnReaderUnavailable(error);
        warn(job.path,'Subtree walk interrupted; some folders may be incomplete. Rescan to refresh.');
        return 'done';
      }
      // A failed first volume read falls back to directory scanning; nothing
      // has been emitted yet, so the caller can retry the root through lanes.
      if(volume) throw error;
      warnReaderUnavailable(error);
      return !(error instanceof NativeDirectoryTimeoutError) ? 'retry' : 'done';
    }
    if(first) {
      first = false;
      if(batch.denied) throw new VolumeAccessDeniedError();
      if(batch.unsupported) throw new VolumeUnavailableError(batch.error || 'This volume does not support direct scanning.');
      if(volume && batch.error) throw new VolumeUnavailableError(batch.error);
      if(batch.self) {
        const self=batch.self;
        if(!self.directory||self.reparse||!insideRoot(realRoot,self.path)) {
          throw new Error('Folder changed or now points outside this scan; skipped.');
        }
        acc.modifiedAt=self.modifiedAt;
      } else {
        // Probe unavailable (unusual ACLs): keep the compatibility checks.
        if(TIMING) T.probeSelfNull++;
        const stat=await fs.lstat(job.path);
        if(stat.isSymbolicLink()||!stat.isDirectory()||!insideRoot(realRoot,await fs.realpath(job.path))) {
          throw new Error('Folder changed or now points outside this scan; skipped.');
        }
        acc.modifiedAt=stat.mtimeMs;
      }
    }
    // Keep at most one batch ahead: native enumeration/serialization overlaps
    // SQLite writes, without an unbounded queue or changing record order.
    if(!batch.done && !batch.error && !cancelled && !paused) {
      prefetched=volume?reader.readVolumeNext():reader.read();
      // Pause/cancel can close the reader before the next await consumes it.
      prefetched.catch(()=>{});
    }
    for(const dir of batch.dirs??[]) {
      const parent=walk.get(dir.p);
      if(!parent) continue;
      const childPath=entryPathOf(parent.path,dir.n);
      flushBatch();
      const id=Number(insertNode.run(parent.id,dir.n,childPath,'folder','','Other',0,0,dir.m,'').lastInsertRowid);
      pathById.set(id,childPath);
      folders++;
      parent.acc.folderCount++;
      awaiting.set(parent.id,(awaiting.get(parent.id)??0)+1);
      parentOf.set(id,parent.id);
      rows++;
      emitted=true;
      walk.set(dir.i,{id,path:childPath,name:dir.n,acc:{size:0,allocated:0,fileCount:0,folderCount:0,modifiedAt:dir.m,name:dir.n,path:childPath}});
    }
    if(batch.entries.length) {
      emitted=true;
      for(const entry of batch.entries) {
        if(cancelled) break;
        const parent=walk.get(entry.p);
        if(!parent) continue;
        try { recordEntry(parent,entry.n,entry.k,entry.s,entry.m,entry.a); }
        catch(error) {warn(entryPathOf(parent.path,entry.n),error);}
        if(++work%4096===0) await breathe();
        progress();
      }
    }
    // Pending dirs are scheduled before doneDirs: a dir completed in this
    // batch can own pending children (announced as its enumeration ended),
    // and scheduling them needs the parent's live walk entry, which doneDirs
    // removes.
    for(const dir of batch.pending??[]) {
      const parent=walk.get(dir.p);
      if(!parent) continue;
      const childPath=entryPathOf(parent.path,dir.n);
      flushBatch();
      const id=Number(insertNode.run(parent.id,dir.n,childPath,'folder','','Other',0,0,dir.m,'').lastInsertRowid);
      pathById.set(id,childPath);
      stack.push(id);folders++;parent.acc.folderCount++;
      awaiting.set(parent.id,(awaiting.get(parent.id)??0)+1);
      parentOf.set(id,parent.id);
      rows++;
    }
    for(const index of batch.doneDirs??[]) {
      const node=walk.get(index);
      if(!node) continue;
      directAcc.set(node.id,node.acc);
      tryComplete(node.id);
      walk.delete(index);
    }
    for(const failure of batch.errors??[]) {
      const node=walk.get(failure.i);
      if(node) warn(node.path,failure.e);
    }
    if(batch.error) { if(!cancelled) warn(job.path,batch.error); completeWalk(walk); return 'done'; }
    if(batch.done) { completeWalk(walk); return 'done'; }
  }
  completeWalk(walk);
  return 'done';
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
    batch.push(entry.name);
    if(batch.length===4) {
      if(paused) await breathe();
      if(cancelled) break;
      yield await read(batch); batch=[];
    }
  }
  if(batch.length&&!cancelled) { if(paused) await breathe(); if(!cancelled) yield await read(batch); }
}
// Compatibility enumeration is serialized across lanes so its bounded
// four-at-a-time metadata concurrency never multiplies with the lane count.
let portableTail: Promise<unknown> = Promise.resolve();
function withPortableLock<T>(fn:()=>Promise<T>):Promise<T> {
  const run=portableTail.then(fn,fn);
  portableTail=run.then(()=>undefined,()=>undefined);
  return run;
}
async function portableEnumerate(job:LaneJob,acc:FolderAcc): Promise<void> {
  const stat=await fs.lstat(job.path);
  if(stat.isSymbolicLink()||!stat.isDirectory()||!insideRoot(realRoot,await fs.realpath(job.path))) {
    throw new Error('Folder changed or now points outside this scan; skipped.');
  }
  acc.modifiedAt=stat.mtimeMs;
  const {skipAll,nameCheck}=planExclusions(job.path);
  const directory=await fs.opendir(job.path);
  for await(const batch of entriesWithStats(directory)) {
    for(const entry of batch) {
      if(cancelled) break;
      if(skipAll) break;
      currentPath=entry.entryPath;
      try {
        if(!entry.stat) throw entry.error;
        const stat=entry.stat;
        if(!stat.isFile()&&!stat.isDirectory()&&!stat.isSymbolicLink()) {
          throw new Error('Unsupported special filesystem entry; skipped.');
        }
        if(nameCheck) {
          const normalized=path.resolve(job.path,entry.name).toLowerCase();
          if(excluded.some(p=>normalized===p||normalized.startsWith(p+path.sep))) continue;
        }
        const metadata: EntryMetadata = {name:entry.name,kind:stat.isSymbolicLink()?'link':stat.isDirectory()?'folder':'file',
          size:stat.size,modifiedAt:stat.mtimeMs,
          attributes:[entry.name.startsWith('.')?'Hidden':'',(stat.mode&0o200)===0?'Read-only':''].filter(Boolean).join(', ')};
        recordEntry({id:job.id,path:job.path,acc},metadata.name,metadata.kind,metadata.size,metadata.modifiedAt,metadata.attributes);
      } catch(error) {warn(entry.entryPath,error);}
      if(++work%4096===0) await breathe();
      progress();
    }
  }
}
async function processDirectory(lane:Lane,job:LaneJob) {
  currentPath=job.path;
  const acc:FolderAcc={size:0,allocated:0,fileCount:0,folderCount:0,modifiedAt:0,name:'',path:''};
  try {
    if(lane.reader) {
      const outcome=await nativeEnumerate(lane,job,acc);
      if(outcome==='retry') await withPortableLock(()=>portableEnumerate(job,acc));
    } else {
      await withPortableLock(()=>portableEnumerate(job,acc));
    }
  } catch(error) {if(!cancelled) warn(job.path,error);}
  flushBatch();
  acc.name=path.basename(job.path)||job.path;
  acc.path=job.path;
  // A subtree walk that reported the job's own doneDirs already completed this
  // folder; completing it again would duplicate scan_top rows and double-count
  // its totals into its parent. parentOf loses the entry on completion.
  if(parentOf.has(job.id)) {
    directAcc.set(job.id,acc);
    tryComplete(job.id);
  }
  if(++work%128===0) await breathe();
  commit(); begin();
}
async function laneLoop(laneIndex:number) {
  const lane=lanes[laneIndex];
  if(lane.reader) {
    try { await lane.reader.ready; if(!enginePosted) {enginePosted=true;parentPort?.postMessage({type:'engine',engine:engineName});} }
    catch(error) { lane.reader=undefined; if(!cancelled) warnReaderUnavailable(error); }
  }
  while(!cancelled) {
    const job=(laneIndex===0||!slowStorage)?takeDirectory():undefined;
    if(job===undefined) {
      if(stack.length===0&&inFlight===0) return;
      if(paused) { commit(true); await new Promise(resolve=>setTimeout(resolve,80)); continue; }
      await new Promise(resolve=>setTimeout(resolve,4));
      continue;
    }
    inFlight++;
    try { await processDirectory(lane,job); } finally { inFlight--; }
  }
}
async function run() {
  db.prepare(`INSERT INTO scan_runs(id,root_path,label,status,started_at,volume_total_size,volume_free_size)
    VALUES (?,?,?,'scanning',?,?,?)`).run(data.scanId,data.root,path.basename(data.root)||data.root,startedAt,data.volumeTotalBytes,data.volumeFreeBytes);
  // Helper startup overlaps root validation and schema creation.
  const laneCount=Math.max(1,Math.min(data.lanes??Math.min(8,Math.max(2,(os.availableParallelism?.()??os.cpus().length)>>1)),16));
  // Real user scans use the normal-permission directory walker. Direct-volume
  // parsing is reserved for generated test images.
  const tryVolume=data.metadataEngine==='volume-fixture' && !!process.env.BLOCKIT_VOLUME_IMAGE;
  // Direct NTFS enumeration uses one helper; start walk lanes only on fallback.
  const initialLaneCount=tryVolume?1:laneCount;
  for(let i=0;i<initialLaneCount;i++) lanes.push({reader:undefined});
  if(process.platform==='win32' && data.metadataEngine!=='portable' && !cancelled) {
    const helper=data.nativeHelperPath || path.join(__dirname,'../build/native/blockit-enumerator.exe');
    for(const lane of lanes) lane.reader=new NativeDirectoryReader(helper);
    // Startup failures surface through each lane's ready await; mark the
    // rejections handled so a slow lane start cannot crash the worker first.
    for(const lane of lanes) lane.reader?.ready.catch(()=>{});
  }
  const rootStat=await fs.lstat(data.root);
  if(!rootStat.isDirectory()||rootStat.isSymbolicLink()) throw new Error('Choose a real folder to scan.');
  realRoot=await fs.realpath(data.root);
  const rootId=Number(insertNode.run(null,path.basename(data.root)||data.root,data.root,'folder','','Other',0,0,rootStat.mtimeMs,'').lastInsertRowid);
  // -1 marks "discovered but no parent": lets processDirectory tell an
  // already-completed walk root (parentOf deleted) from a pending one.
  parentOf.set(rootId,-1);
  pathById.set(rootId,data.root);
  begin();
  enumWallStart = performance.now();
  // Generated volume fixtures exercise the alternate engine; user scans always walk.
  let volumeOk=false;
  if(tryVolume && lanes[0].reader && !cancelled) {
    inFlight++;
    try {
      engineName='volume';
      enginePosted=true;
      parentPort?.postMessage({type:'engine',engine:'volume'});
      const rootAcc:FolderAcc={size:0,allocated:0,fileCount:0,folderCount:0,modifiedAt:0,name:path.basename(data.root)||data.root,path:data.root};
      volumeOk = await nativeEnumerate(lanes[0],{id:rootId,path:data.root},rootAcc,true)==='done';
    } catch(error) {
      if(error instanceof VolumeAccessDeniedError) throw error;
      else if(error instanceof VolumeUnavailableError) warn(data.root,'Fast drive scan skipped: '+error.message);
      else if(!cancelled) warn(data.root,'Fast drive scan failed; falling back to directory scanning.');
      volumeOk=false;
    } finally { inFlight--; }
    if(!volumeOk) {
      enginePosted=false;
      engineName='native';
      if(!lanes[0].reader) lanes[0].reader=new NativeDirectoryReader(data.nativeHelperPath || path.join(__dirname,'../build/native/blockit-enumerator.exe'));
    }
  }
  if(!volumeOk && !cancelled) {
    while(lanes.length<laneCount) {
      const reader=new NativeDirectoryReader(data.nativeHelperPath || path.join(__dirname,'../build/native/blockit-enumerator.exe'));
      reader.ready.catch(()=>{});
      lanes.push({reader});
    }
    stack.push(rootId);
  }
  await Promise.all(lanes.map((_,i)=>laneLoop(i)));
  // The volume path enumerates through one direct call instead of
  // processDirectory, so the tail of the queued file rows needs its own flush
  // before finalisation. Without it the last (up to INSERT_CHUNK-1) file rows
  // are counted into the run totals and folder roll-ups but never inserted.
  flushBatch();
  enumWallEnd = performance.now();
  if(cancelled||directAcc.size||childTotals.size) await drainPartial();
  commit(true);
  finalizing=true;progress(true);
  // Crash safety: each CREATE INDEX autocommits atomically, so an interrupted
  // build leaves the index absent, not corrupt, and the next run recreates it.
  const _x0 = TIMING ? performance.now() : 0;
  db.pragma('synchronous = OFF');
  // Random-key index writes (children, category) thrive on a big page cache.
  db.pragma('cache_size = -524288');
  db.pragma('mmap_size = 268435456');
  db.exec(TREEMAP_INDEX);
  treemapReady = true;
  progress(true);
  await new Promise<void>(resolve => setImmediate(resolve));
  db.exec(RESULT_INDEXES);
  db.pragma('mmap_size = 0');
  db.pragma('synchronous = NORMAL');
  db.pragma('cache_size = -65536');
  const _k0 = TIMING ? performance.now() : 0;
  db.pragma('wal_checkpoint(TRUNCATE)');
  if(TIMING) {T.chk = performance.now() - _k0;T.idx = performance.now() - _x0;}
  status=cancelled?'idle':warnings?'completed_with_warnings':'completed';
  db.prepare('UPDATE scan_runs SET status=?,completed_at=? WHERE id=?').run(status,Date.now(),data.scanId);
  progress(true);
  reportTiming();
  parentPort?.postMessage({type:'done',scanId:data.scanId,rootId,status});
}
run().catch(error=>{
  if(db.inTransaction) db.exec('ROLLBACK');
  status='failed';
  try {db.prepare('UPDATE scan_runs SET status=?,completed_at=? WHERE id=?').run(status,Date.now(),data.scanId);} catch {}
  parentPort?.postMessage({type:'progress',progress:{scanId:data.scanId,status,currentPath,files,folders,bytes,warnings,elapsedMs:Date.now()-startedAt,message:String(error)}});
  reportTiming();
  parentPort?.postMessage({type:'error',scanId:data.scanId,message:String(error)});
}).finally(()=>{
  for(const lane of lanes) lane.reader?.close();
  db.close();parentPort?.close();
});
