// End-to-end synthetic NTFS scan: never reads the real volume's file records.
const {Worker}=require('node:worker_threads');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const assert=require('node:assert/strict');
const {randomUUID,createHash}=require('node:crypto');
const Database=require('better-sqlite3');
const {buildBulkImage}=require('./volume-fixture-check.cjs');
const fileCount=Number(process.env.FIXTURE_FILES)||9000;
assert(Number.isInteger(fileCount)&&fileCount>0&&fileCount<=250000);
const trials=Number(process.env.TRIALS)||3;
async function scan(workerPath,base,imagePath) {
  const scanId=randomUUID(),dbPath=path.join(base,scanId+'.db');
  const start=performance.now(); let done,engine,timing;
  const worker=new Worker(workerPath,{env:{...process.env,BLOCKIT_VOLUME_IMAGE:imagePath,BLOCKIT_SCAN_TIMING:'1',BLOCKIT_FORCE_WALK:'0'},workerData:{scanId,root:path.parse(base).root,dbPath,clusterSize:4096,volumeTotalBytes:1e12,volumeFreeBytes:1e11,nativeHelperPath:path.resolve(__dirname,'../build/native/blockit-enumerator.exe')}});
  await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>{worker.terminate();reject(new Error('Scan timed out'));},30000);
    worker.on('message',m=>{if(m.type==='done')done=m;if(m.type==='engine')engine=m.engine;if(m.type==='timing')timing=m.timing;if(m.type==='error'){clearTimeout(timeout);reject(new Error(m.message));}});
    worker.on('error',e=>{clearTimeout(timeout);reject(e);});
    worker.on('exit',code=>{clearTimeout(timeout);code===0&&done?resolve():reject(new Error('Incomplete worker exit '+code));});
  });
  const ms=Math.round(performance.now()-start);
  const db=new Database(dbPath,{readonly:true});
  try {
    assert.equal(engine,'volume'); assert.equal(done.status,'completed');
    const run=db.prepare('SELECT * FROM scan_runs').get();
    const totals=db.prepare("SELECT COUNT(*) files,SUM(size) bytes FROM nodes WHERE kind='file'").get();
    assert.equal(totals.files,fileCount); assert.equal(totals.bytes,fileCount*7);
    assert.equal(run.file_count,totals.files); assert.equal(run.total_size,totals.bytes);
    const root=db.prepare('SELECT * FROM nodes WHERE parent_id IS NULL').get();
    assert.equal(root.file_count,fileCount); assert.equal(root.size,fileCount*7);
    assert.equal(db.pragma('integrity_check',{simple:true}),'ok');
    const rows=db.prepare('SELECT path,kind,size,file_count,folder_count FROM nodes ORDER BY path').all();
    return {ms,lanes:timing.lanes,files:totals.files,bytes:totals.bytes,hash:createHash('sha256').update(JSON.stringify(rows)).digest('hex')};
  } finally {db.close();}
}
(async()=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'blockit-volume-worker-'));
  const imagePath=path.join(base,'bulk.img');buildBulkImage(imagePath,fileCount);
  const afterPath=path.resolve(__dirname,'../dist-electron/scanner-worker.js');
  const beforePath=process.env.BEFORE_WORKER&&path.resolve(process.env.BEFORE_WORKER);
  const before=[],after=[];
  try {
    for(let i=0;i<(beforePath?trials:1);i++) {
      if(beforePath&&i%2===0)before.push(await scan(beforePath,base,imagePath));
      after.push(await scan(afterPath,base,imagePath));
      if(beforePath&&i%2===1)before.push(await scan(beforePath,base,imagePath));
    }
    assert(after.every(r=>r.lanes===1),'Direct volume mode starts exactly one lane');
    assert([...before,...after].every(r=>r.hash===after[0].hash),'Every scan produces identical complete output');
    const median=rs=>rs.map(r=>r.ms).sort((a,b)=>a-b)[Math.floor(rs.length/2)];
    const report={fixtureFiles:fileCount,before,after,beforeMedianMs:before.length?median(before):null,afterMedianMs:median(after),note:'Synthetic NTFS image on this machine; not a real whole-drive speed guarantee.'};
    console.log(JSON.stringify(report,null,2));
    fs.writeFileSync(path.resolve(process.env.BENCH_REPORT || path.join(__dirname,'../docs/volume-worker-performance.json')),JSON.stringify(report,null,2)+'\n');
    console.log('PASS volume worker: all batches and trailing rows persisted, exact rollups, one helper, database integrity.');
  } finally {
    const target=path.resolve(base),prefix=path.resolve(os.tmpdir())+path.sep;
    assert(target.startsWith(prefix)&&path.basename(target).startsWith('blockit-volume-worker-'));
    fs.rmSync(target,{recursive:true,force:true});
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
