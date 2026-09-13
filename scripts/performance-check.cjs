const {Worker}=require('node:worker_threads');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {randomUUID}=require('node:crypto');
const assert=require('node:assert/strict');
const Database=require('better-sqlite3');
async function scan(workerPath,root,base,control=false) {
  const scanId=randomUUID(),dbPath=path.join(base,scanId+'.db');
  const started=performance.now(),cpu=process.cpuUsage();
  const worker=new Worker(workerPath,{workerData:{scanId,root,dbPath,volumeTotalBytes:1e9,volumeFreeBytes:1e8,clusterSize:4096,excludedPaths:[]}});
  let peakRss=0,pauseRequested=false,resumeSent=false,resumeRequested=false,pausedAt=0,pauseMs=0,stopAt=0;
  const sampling=setInterval(()=>{peakRss=Math.max(peakRss,process.memoryUsage().rss);},50);
  const result=await new Promise((resolve,reject)=>{
    worker.on('error',reject);
    worker.on('message',message=>{
      if(message.type==='error') reject(new Error(message.message));
      if(control && message.type==='progress') {
        // Fast scans can finish before the second throttled progress update.
        // The first indexed entry may be a folder. Do not wait for a file count
        // threshold that a small fast scan only reports at completion.
        if(!pauseRequested&&message.progress.status==='scanning'&&!message.progress.message) {pauseRequested=true;worker.postMessage({type:'pause'});}
        if(message.progress.status==='paused'&&!resumeSent) {
          resumeSent=true;pausedAt=Date.now();
          setTimeout(()=>{
            const db=new Database(dbPath,{readonly:true});
            const before=db.prepare("SELECT COUNT(*) n FROM nodes").get().n;db.close();
            setTimeout(()=>{
              const next=new Database(dbPath,{readonly:true});
              const after=next.prepare("SELECT COUNT(*) n FROM nodes").get().n;next.close();
              try{assert.equal(after,before,'Paused scanner does no more indexing');}catch(error){reject(error);}
              pauseMs=Date.now()-pausedAt;resumeRequested=true;worker.postMessage({type:'resume'});
            },250);
          },100);
        }
        if(resumeRequested&&!stopAt&&message.progress.status==='scanning') {
          stopAt=Date.now();worker.postMessage({type:'cancel'});
        }
      }
      if(message.type==='done') resolve(message);
    });
  });
  await new Promise(resolve=>worker.once('exit',resolve));
  clearInterval(sampling);
  const cancelLatencyMs=control?Date.now()-stopAt:undefined;
  const cpuUsed=process.cpuUsage(cpu);
  const db=new Database(dbPath,{readonly:true});
  const run=db.prepare('SELECT * FROM scan_runs').get();
  const sums=db.prepare("SELECT COALESCE(SUM(size),0) bytes,COUNT(*) files FROM nodes WHERE kind='file'").get();
  const rootNode=db.prepare('SELECT * FROM nodes WHERE parent_id IS NULL').get();
  assert.equal(run.total_size,sums.bytes);assert.equal(run.file_count,sums.files);
  assert.equal(rootNode.size,sums.bytes);assert.equal(rootNode.file_count,sums.files);
  const folders=db.prepare("SELECT * FROM nodes WHERE kind='folder'").all();
  for(const folder of folders) {
    const expected=db.prepare(`WITH RECURSIVE descendants(id) AS (SELECT id FROM nodes WHERE parent_id=? UNION ALL
      SELECT n.id FROM nodes n JOIN descendants d ON n.parent_id=d.id)
      SELECT COALESCE(SUM(CASE WHEN kind='file' THEN size ELSE 0 END),0) size,COALESCE(SUM(kind='file'),0) files
      FROM nodes WHERE id IN (SELECT id FROM descendants)`).get(folder.id);
    assert.equal(folder.size,expected.size);assert.equal(folder.file_count,expected.files);
  }
  if(control) {assert(resumeSent,'Pause acknowledged');assert(run.file_count>0,'Cancellation preserves partial file results');assert.equal(result.status,'idle');assert(Date.now()-stopAt<3000,'Cancel drains promptly');}
  db.close();
  return {durationMs:Math.round(performance.now()-started-pauseMs),cpuMs:Math.round((cpuUsed.user+cpuUsed.system)/1000),peakProcessRssMB:Math.round(peakRss/1024**2),files:run.file_count,cancelLatencyMs,dbPath};
}
async function main() {
  const base=await fs.mkdtemp(path.join(os.tmpdir(),'blockit-perf-'));
  const root=path.join(base,'fixture');
  await fs.mkdir(root);
  for(let folder=0;folder<40;folder++) {
    const dir=path.join(root,'folder-'+folder,'nested');
    await fs.mkdir(dir,{recursive:true});
    for(let batch=0;batch<10;batch++) await Promise.all(Array.from({length:10},(_,j)=>fs.writeFile(path.join(dir,(batch*10+j)+'.txt'),'sample')));
  }
  // A directory junction must never cause duplicate traversal.
  await fs.symlink(path.join(root,'folder-0'),path.join(root,'shortcut'),'junction');
  const baseline=await scan(path.join(__dirname,'baseline-scanner.cjs'),root,base);
  const current=await scan(path.join(__dirname,'../dist-electron/scanner-worker.js'),root,base);
  assert.equal(current.files,4000);assert.equal(current.files,baseline.files);
  // A broad folder makes the first progress update contain files, so Stop is
  // tested against actual partial file results, not only an empty folder tree.
  const controlRoot=path.join(base,'control-fixture');await fs.mkdir(controlRoot);
  for(let batch=0;batch<400;batch++)await Promise.all(Array.from({length:100},(_,i)=>fs.writeFile(path.join(controlRoot,'file-'+(batch*100+i)+'.txt'),'sample')));
  const controls=await scan(path.join(__dirname,'../dist-electron/scanner-worker.js'),controlRoot,base,true);
  const db=new Database(current.dbPath);
  // Expand only generated metadata for a 200k-row repeated-summary benchmark.
  db.exec("DELETE FROM nodes; DELETE FROM aggregates;");
  const scanId=db.prepare('SELECT id FROM scan_runs').get().id;
  const rootId=Number(db.prepare("INSERT INTO nodes(parent_id,name,path,kind,size) VALUES (NULL,'root','root','folder',20000000)").run().lastInsertRowid);
  const insert=db.prepare("INSERT INTO nodes(parent_id,name,path,kind,extension,category,size,allocated_size) VALUES (?,'sample','sample','file',?,'Documents',100,4096)");
  db.transaction(()=>{for(let i=0;i<200000;i++) insert.run(rootId,'ext'+(i%20));})();
  db.exec("INSERT INTO aggregates SELECT 'category',category,SUM(size),SUM(allocated_size),COUNT(*) FROM nodes WHERE kind='file' GROUP BY category; INSERT INTO aggregates SELECT 'extension',extension,SUM(size),SUM(allocated_size),COUNT(*) FROM nodes WHERE kind='file' GROUP BY extension;");
  const legacy=db.prepare("SELECT category,SUM(size),SUM(allocated_size),COUNT(*) FROM nodes WHERE kind='file' GROUP BY category");
  const optimized=db.prepare("SELECT name,size,allocatedSize,count FROM aggregates WHERE dimension='category'");
  const time=fn=>{const start=performance.now();for(let i=0;i<20;i++)fn();return +(performance.now()-start).toFixed(2);};
  const summary={rows:200000,iterations:20,legacyMs:time(()=>legacy.all()),incrementalMs:time(()=>optimized.all())};
  db.close();
  const queryWorker=new Worker(path.join(__dirname,'../dist-electron/query-worker.js'),{workerData:{directory:base}});
  let queryId=0;
  const request=(operation,...args)=>new Promise((resolve,reject)=>{
    const id=++queryId;
    const handler=message=>{
      if(message.id!==id)return;
      queryWorker.off('message',handler);
      if(message.error)reject(new Error(message.error));else resolve(message.result);
    };
    queryWorker.on('message',handler);queryWorker.postMessage({id,operation,args});
  });
  let ticks=0;
  const heartbeat=setInterval(()=>ticks++,5);
  const tree=await request('treemap',scanId,rootId);
  assert(tree.length<=181,'Treemap IPC payload is bounded');
  assert.equal(tree.reduce((sum,node)=>sum+node.size,0),20000000,'Treemap includes every byte');
  const result=await request('nodes',{scanId,view:'search',search:'sample',page:1,pageSize:50});
  assert.equal(result.items.length,50);assert.equal(result.total,200000);
  const overview=await request('summary',scanId);
  assert.equal(overview.categories[0].size,20000000);
  clearInterval(heartbeat);await queryWorker.terminate();
  assert(ticks>1,'Host event loop stays responsive while worker queries execute');
  const report={fixtureFiles:4000,baseline,current,controls,summary,queryChecks:{treemapRows:tree.length,searchRows:result.items.length,matchingRows:result.total,hostHeartbeatTicks:ticks},note:'Local generated metadata benchmark; not a whole-drive throughput or laptop resource guarantee. CPU and RSS measure the Electron test host only, excluding the native helper; do not use them as a whole-app resource comparison.'};
  await fs.mkdir(path.join(__dirname,'../docs'),{recursive:true});
  await fs.writeFile(path.join(__dirname,'../docs/performance.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
}
main().catch(error=>{console.error(error);process.exit(1);});
