// Paired full-scan timings; generated files only. Run before packaging replaces v1.5.
const fs=require('node:fs/promises');
const path=require('node:path');
const {Worker}=require('node:worker_threads');
const {randomUUID}=require('node:crypto');
const asar=require('@electron/asar');
const Database=require('better-sqlite3');
const assert=require('node:assert/strict');
const workspace=path.resolve(__dirname,'..');
const archive=path.join(workspace,'release/win-unpacked/resources/app.asar');
const median=values=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
async function scan(workerPath,root,base,native) {
  const scanId=randomUUID(),dbPath=path.join(base,scanId+'.db'),start=performance.now();
  const worker=new Worker(workerPath,{workerData:{root,scanId,dbPath,clusterSize:4096,volumeTotalBytes:1e9,volumeFreeBytes:1e8}});
  let result,engine,previous=start,maxHeartbeatGapMs=0;
  const timer=setInterval(()=>{const now=performance.now();maxHeartbeatGapMs=Math.max(maxHeartbeatGapMs,now-previous);previous=now;},10);
  try {
    await new Promise((resolve,reject)=>{
      worker.on('message',message=>{
        if(message.type==='engine')engine=message.engine;
        if(message.type==='done')result=message;
        if(message.type==='error')reject(new Error(message.message));
      });
      worker.on('error',reject);worker.on('exit',code=>code===0?resolve():reject(new Error('Worker exit '+code)));
    });
  } finally {clearInterval(timer);}
  const ms=Math.round(performance.now()-start);
  assert.equal(result.status,'completed');
  if(native)assert.equal(engine,'native','Must measure the native engine, not fallback');
  const db=new Database(dbPath,{readonly:true});const run=db.prepare('SELECT * FROM scan_runs').get();
  assert.equal(run.file_count,20000);assert.equal(run.total_size,120000);
  assert.equal(db.prepare('SELECT size FROM nodes WHERE parent_id IS NULL').get().size,120000);
  db.close();
  return {ms,maxHeartbeatGapMs:Math.round(maxHeartbeatGapMs)};
}
async function main() {
  assert.equal(JSON.parse(asar.extractFile(archive,'package.json').toString()).version,'1.5.0');
  const base=await fs.mkdtemp(path.join(workspace,'.benchmark-native-'));
  const oldScanner=path.join(base,'old-scanner.cjs');
  await fs.writeFile(oldScanner,asar.extractFile(archive,'dist-electron/scanner-worker.js'));
  const root=path.join(base,'fixture');
  for(let folder=0;folder<40;folder++) {
    const dir=path.join(root,'folder-'+folder,'nested');await fs.mkdir(dir,{recursive:true});
    for(let batch=0;batch<50;batch++) await Promise.all(Array.from({length:10},(_,i)=>fs.writeFile(path.join(dir,(batch*10+i)+'.txt'),'sample')));
  }
  const currentScanner=path.join(workspace,'dist-electron/scanner-worker.js');
  const before=[],after=[];
  for(let trial=0;trial<3;trial++) {
    if(trial%2===0) {before.push(await scan(oldScanner,root,base,false));after.push(await scan(currentScanner,root,base,true));}
    else {after.push(await scan(currentScanner,root,base,true));before.push(await scan(oldScanner,root,base,false));}
  }
  const report={baseline:'Packaged 1.5.0',current:'1.6.0 candidate',fixtureFiles:20000,scanMs:{before,after,beforeMedian:median(before.map(x=>x.ms)),afterMedian:median(after.map(x=>x.ms))},
    note:'Three alternating paired local trials, generated tiny files, warm filesystem cache, helper startup included. Heartbeat is the test host, not laptop-wide responsiveness. No whole-drive, HDD, network or cold-cache guarantee.'};
  await fs.writeFile(path.join(workspace,'docs/scanner-comparison-1.6.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
}
main().catch(error=>{console.error(error);process.exit(1);});
