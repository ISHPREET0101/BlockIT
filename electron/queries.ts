import Database from 'better-sqlite3';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { csvCell, scanIdentifier, nodeIdentifier, validateQuery } from '../src/shared/validation';
import type { FileNode, NodeQuery, QueryResult, ScanSummary, TreemapNode } from '../src/shared/types';
let directory='';
let cached: { scanId: string; db: Database.Database; version: number } | undefined;
const counts = new Map<string, number>();
let closeTimer: ReturnType<typeof setTimeout> | undefined;
export function closeDatabases() {
  if (closeTimer) clearTimeout(closeTimer);
  cached?.db.close(); cached = undefined; counts.clear();
}
export function configureDirectory(value:string) { closeDatabases(); directory=value; }
const defaultSettings={largeFileThreshold:500*1024**2,oldFileDays:365};
function openDatabase(scanId:string) {
  scanIdentifier(scanId);
  if (cached?.scanId !== scanId) {
    closeDatabases();
    const db=new Database(path.join(directory,scanId+'.db'),{readonly:true,fileMustExist:true,timeout:1000});
    db.pragma('cache_size = -8192'); db.pragma('temp_store = FILE');
    cached={scanId,db,version:-1};
  }
  const version = Number(cached!.db.pragma('data_version', {simple:true}));
  if (version !== cached!.version) { counts.clear(); cached!.version=version; }
  if (closeTimer) clearTimeout(closeTimer);
  closeTimer=setTimeout(closeDatabases,30_000); closeTimer.unref();
  return cached!.db;
}
export function mapNode(row: Record<string, unknown>): FileNode {
  return {
    id: Number(row.id),
    parentId: row.parent_id == null ? null : Number(row.parent_id),
    name: String(row.name),
    path: String(row.path),
    kind: String(row.kind) as FileNode['kind'],
    extension: String(row.extension || ''),
    category: String(row.category) as FileNode['category'],
    size: Number(row.size),
    allocatedSize: Number(row.allocated_size),
    modifiedAt: Number(row.modified_at),
    attributes: String(row.attributes || ''),
    itemCount: Number(row.item_count || 0),
    fileCount: Number(row.file_count || 0),
    folderCount: Number(row.folder_count || 0),
  };
}

// One database holds exactly one scan, so nodes rows carry no scan_id column
// and queries filter nothing beyond the user's criteria.
function queryParts(query: NodeQuery): { where: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (query.view === 'browse') {
    clauses.push(query.parentId == null ? 'parent_id IS NULL' : 'parent_id = ?');
    if (query.parentId != null) params.push(query.parentId);
  }
  if (query.view === 'category') {
    clauses.push("kind = 'file'");
    if(query.category) { clauses.push('category = ?'); params.push(query.category); }
  }
  if (query.view === 'large') clauses.push("kind = 'file'", 'size >= ?');
  if (query.view === 'large') params.push(query.minSize ?? defaultSettings.largeFileThreshold);
  if (query.view === 'old') clauses.push("kind = 'file'", 'modified_at <= ?');
  if (query.view === 'old') params.push(query.olderThan ?? Date.now() - defaultSettings.oldFileDays * 86_400_000);
  if (query.search?.trim()) {
    clauses.push('(name LIKE ? ESCAPE \'\\\' OR path LIKE ? ESCAPE \'\\\')');
    const escaped = query.search.trim().replace(/[\\%_]/g, '\\$&');
    params.push(`%${escaped}%`, `%${escaped}%`);
  }
  if (query.extension?.trim()) {
    clauses.push('extension = ?');
    params.push(query.extension.replace(/^\./, '').toLowerCase());
  }
  if (query.category && query.view !== 'category') {
    clauses.push('category = ?');
    params.push(query.category);
  }
  if (query.minSize != null && query.view !== 'large') {
    clauses.push('size >= ?');
    params.push(Math.max(0, query.minSize));
  }
  if (query.olderThan != null && query.view !== 'old') {
    clauses.push('modified_at <= ?');
    params.push(query.olderThan);
  }
  if (query.kind) {
    clauses.push('kind = ?');
    params.push(query.kind);
  }
  return { where: clauses.length ? clauses.join(' AND ') : '1=1', params };
}

export function queryNodes(input: NodeQuery): QueryResult {
  const query = validateQuery(input);
  const db = openDatabase(query.scanId);
  return db.transaction(() => {
    const { where, params } = queryParts(query);
    const sortMap = {
      name: 'name COLLATE NOCASE',
      size: 'size',
      allocatedSize: 'allocated_size',
      modifiedAt: 'modified_at',
      itemCount: 'item_count',
    } as const;
    const sort = sortMap[query.sortBy || 'size'];
    const direction = query.sortDir === 'asc' ? 'ASC' : 'DESC';
    const pageSize = Math.min(500, Math.max(1, query.pageSize || 100));
    const countKey=JSON.stringify([where,params]);
    let total=counts.get(countKey);
    if(total == null) {
      total=Number((db.prepare(`SELECT COUNT(*) AS count FROM nodes WHERE ${where}`).get(...params) as {count:number}).count);
      if(counts.size>=64) counts.delete(counts.keys().next().value!);
      counts.set(countKey,total);
    }
    const page = Math.min(query.page || 1, Math.max(1, Math.ceil(total/pageSize)));
    // Descending size indexes have ascending row IDs; reverse both for ascending scans.
    const tie = direction === 'DESC' ? 'ASC' : 'DESC';
    const rows = db.prepare(`SELECT * FROM nodes WHERE ${where} ORDER BY ${sort} ${direction}, id ${tie} LIMIT ? OFFSET ?`)
      .all(...params, pageSize, (page - 1) * pageSize) as Array<Record<string, unknown>>;
    return { items: rows.map(mapNode), total, page, pageSize };
  })();
}

export function getSummary(scanId: string): ScanSummary {
  const db = openDatabase(scanId);
  return db.transaction(() => {
    const run = db.prepare('SELECT * FROM scan_runs WHERE id = ?').get(scanId) as Record<string, unknown> | undefined;
    if (!run) throw new Error('The scan is still starting.');
    const root = db.prepare('SELECT id FROM nodes WHERE parent_id IS NULL LIMIT 1').get() as { id: number } | undefined;
    if (!root) throw new Error('The scan has not committed its root yet.');
    const aggregate = (field: 'category' | 'extension') => db.prepare(`
      SELECT CASE WHEN name='' THEN '(no extension)' ELSE name END AS name,size,allocatedSize,count
      FROM aggregates WHERE dimension=? AND count>0 ORDER BY size DESC LIMIT 50
    `).all(field) as ScanSummary['categories'];
    // While the scan runs, secondary indexes do not exist yet; the scanner
    // publishes its live top lists to a tiny table so refreshes stay cheap.
    let topFiles: Array<Record<string, unknown>>|undefined;
    let topFolders: Array<Record<string, unknown>>|undefined;
    if (String(run.status) === 'scanning' || String(run.status) === 'paused' || String(run.status) === 'cancelling') {
      try {
        topFiles = db.prepare("SELECT * FROM scan_top WHERE kind='file' ORDER BY size DESC").all() as Array<Record<string, unknown>>;
        topFolders = db.prepare("SELECT * FROM scan_top WHERE kind='folder' ORDER BY size DESC").all() as Array<Record<string, unknown>>;
      } catch { topFiles = undefined; topFolders = undefined; }
    }
    if (!topFiles || !topFolders || (topFiles.length === 0 && topFolders.length === 0)) {
      topFiles = db.prepare("SELECT * FROM nodes WHERE kind = 'file' ORDER BY size DESC LIMIT 8").all() as Array<Record<string, unknown>>;
      topFolders = db.prepare("SELECT * FROM nodes WHERE kind = 'folder' AND parent_id = ? ORDER BY size DESC LIMIT 8").all(root.id) as Array<Record<string, unknown>>;
    }
    return {
      scanId,
      rootId: Number(root.id),
      rootPath: String(run.root_path),
      label: String(run.label),
      status: String(run.status) as ScanSummary['status'],
      startedAt: Number(run.started_at),
      completedAt: run.completed_at == null ? null : Number(run.completed_at),
      totalBytes: Number(run.total_size),
      allocatedBytes: Number(run.allocated_size),
      fileCount: Number(run.file_count),
      folderCount: Number(run.folder_count),
      warningCount: Number(run.warning_count),
      volumeTotalBytes: Number(run.volume_total_size),
      volumeFreeBytes: Number(run.volume_free_size),
      categories: aggregate('category'),
      extensions: aggregate('extension'),
      topFiles: topFiles.map(mapNode),
      topFolders: topFolders.map(mapNode),
    };
  })();
}

export function treemapChildren(scanId: string, parentId: number, depth = 1): TreemapNode[] {
  if (!Number.isInteger(depth) || depth < 1 || depth > 3) throw new Error("Invalid treemap depth");
  nodeIdentifier(parentId);
  const db = openDatabase(scanId);
  return db.transaction(() => {
    // Bound IPC payload and SVG work even on scans with millions of entries.
    let remaining = 2500;
    const readChildren = (parentId: number, level: number): TreemapNode[] => {
      const rows = db.prepare('SELECT * FROM nodes WHERE parent_id=? ORDER BY size DESC LIMIT 180').all(parentId) as Array<Record<string,unknown>>;
      const visible: TreemapNode[] = rows.map(mapNode);
      remaining -= visible.length;
      if (visible.length === 180) {
        const totals = db.prepare(`SELECT COUNT(*) AS count,SUM(size) AS size,SUM(allocated_size) AS allocated,
          SUM(kind='file') AS files,SUM(kind='folder') AS folders FROM nodes WHERE parent_id=?`)
          .get(parentId) as {count:number;size:number;allocated:number;files:number;folders:number};
        const count=totals.count-visible.length;
        if (count>0) { remaining--; visible.push({
          id:-parentId,parentId,name:count.toLocaleString()+' smaller items',path:'',kind:'file',extension:'',category:'Other',
          size:totals.size-visible.reduce((sum,node)=>sum+node.size,0),
          allocatedSize:totals.allocated-visible.reduce((sum,node)=>sum+node.allocatedSize,0),
          modifiedAt:0,attributes:'',itemCount:count,
          fileCount:totals.files-visible.filter(node=>node.kind==='file').length,
          folderCount:totals.folders-visible.filter(node=>node.kind==='folder').length,synthetic:true,syntheticKind:'remainder'
        }); }
      }
      if (level > 1) for (const node of visible) {
        if (node.kind === "folder" && !node.synthetic && remaining >= 181) {
          node.children = readChildren(node.id, level - 1);
        }
      }
      return visible;
    };
    return readChildren(parentId, depth);
  })();
}

export function ancestors(scanId: string, nodeId: number): Array<{id:number;name:string}> {
  nodeIdentifier(nodeId);
  const db=openDatabase(scanId);
  return db.transaction(() => {
    const chain: Array<{id:number;name:string}>=[], seen=new Set<number>();
    const get=db.prepare('SELECT id,name,parent_id FROM nodes WHERE id=?');
    let cursor: number|null=nodeId;
    while(cursor != null && chain.length<4096) {
      if(seen.has(cursor)) throw new Error('Invalid folder hierarchy. Rescan this location.');
      seen.add(cursor);
      const node=get.get(cursor) as {id:number;name:string;parent_id:number|null}|undefined;
      if(!node) throw new Error('This folder is no longer indexed.');
      chain.unshift({id:node.id,name:node.name}); cursor=node.parent_id;
    }
    return chain;
  })();
}

export function reconcileRemoval(scanId: string, nodeId: number): void {
  scanIdentifier(scanId); nodeIdentifier(nodeId); closeDatabases();
  const db=new Database(path.join(directory,scanId+'.db'),{fileMustExist:true,timeout:1000});
  db.pragma('cache_size = -8192');db.pragma('temp_store = FILE');
  try {
    db.transaction(()=>{
      const row=db.prepare('SELECT * FROM nodes WHERE id=?').get(nodeId) as Record<string,unknown>|undefined;
      if(!row) return;
      const node=mapNode(row);
      if(node.parentId==null) throw new Error('The scan root cannot be removed.');
      const files=node.kind==='folder'?node.fileCount:node.kind==='file'?1:0;
      const folders=node.kind==='folder'?node.folderCount+1:0;
      db.prepare(`WITH RECURSIVE ancestors(id) AS (
        SELECT parent_id FROM nodes WHERE id=? UNION ALL
        SELECT n.parent_id FROM nodes n JOIN ancestors a ON n.id=a.id WHERE n.parent_id IS NOT NULL
      ) UPDATE nodes SET size=MAX(0,size-?),allocated_size=MAX(0,allocated_size-?),
        file_count=MAX(0,file_count-?),folder_count=MAX(0,folder_count-?),item_count=MAX(0,item_count-?)
        WHERE id IN (SELECT id FROM ancestors WHERE id IS NOT NULL)`)
        .run(nodeId,node.size,node.allocatedSize,files,folders,files+folders);
      db.prepare(`WITH RECURSIVE doomed(id) AS (
        SELECT ? UNION ALL SELECT n.id FROM nodes n JOIN doomed d ON n.parent_id=d.id
      ) DELETE FROM nodes WHERE id IN (SELECT id FROM doomed)`).run(nodeId);
      db.prepare(`UPDATE scan_runs SET total_size=MAX(0,total_size-?),allocated_size=MAX(0,allocated_size-?),
        file_count=MAX(0,file_count-?),folder_count=MAX(0,folder_count-?) WHERE id=?`)
        .run(node.size,node.allocatedSize,files,folders,scanId);
    })();
  } finally {db.close();}
}

export async function exportCsvFile(input: NodeQuery, outputPath: string): Promise<number> {
  const query=validateQuery(input);
  // Separate connection: a bounded read snapshot does not interfere with UI queries.
  const db=new Database(path.join(directory,query.scanId+'.db'),{readonly:true,fileMustExist:true,timeout:1000});
  db.pragma('cache_size = -8192'); db.pragma('temp_store = FILE');
  let output: Awaited<ReturnType<typeof fs.open>>|undefined;
  try {
    const {where,params}=queryParts(query);
    const columns={name:'name COLLATE NOCASE',size:'size',allocatedSize:'allocated_size',modifiedAt:'modified_at',itemCount:'item_count'};
    const direction=query.sortDir==='asc'?'ASC':'DESC';
    const iterator=db.prepare(`SELECT * FROM nodes WHERE ${where} ORDER BY ${columns[query.sortBy||'size']} ${direction}, id ${direction==='DESC'?'ASC':'DESC'}`).iterate(...params);
    output=await fs.open(outputPath,'w');
    await output.writeFile('\uFEFFName,Path,Type,Category,Extension,Size,Estimated allocated size,Modified\r\n');
    let count=0, buffer='';
    for(const row of iterator) {
      const node=mapNode(row as Record<string,unknown>);
      buffer += [node.name,node.path,node.kind,node.category,node.extension,node.size,node.allocatedSize,new Date(node.modifiedAt).toISOString()].map(csvCell).join(',')+'\r\n';
      count++;
      if(count%500===0 || buffer.length>=262144) { await output.writeFile(buffer);buffer=''; }
    }
    if(buffer) await output.writeFile(buffer);
    return count;
  } finally { await output?.close();db.close(); }
}
