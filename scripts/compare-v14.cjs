// A paired benchmark against the packaged 1.4.0 app. Uses generated files only.
const fs=require('node:fs/promises');
const path=require('node:path');
const {Worker}=require('node:worker_threads');
const {randomUUID}=require('node:crypto');
const asar=require('@electron/asar');
const Database=require('better-sqlite3');
const assert=require('node:assert/strict');
const workspace=path.resolve(__dirname,'..');
const archive=path.join(workspace,'release','win-unpacked','resources','app.asar');
const median=values=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
async function scan(workerPath,root,base) {
  const scanId=randomUUID(),dbPath=path.join(base,scanId+'.db'),start=performance.now();
  const worker=new Worker(workerPath,{workerData:{root,scanId,dbPath,clusterSize:4096,volumeTotalBytes:1e9,volumeFreeBytes:1e8}});
  let result;
  await new Promise((resolve,reject)=>{
    worker.on('message',message=>{if(message.type==='done')result=message;if(message.type==='error')reject(new Error(message.message));});
    worker.on('error',reject);worker.on('exit',code=>code===0?resolve():reject(new Error('Worker exit '+code)));
  });
  assert.equal(result.status,'completed');
  const db=new Database(dbPath,{readonly:true});const run=db.prepare('SELECT * FROM scan_runs').get();
  assert.equal(run.file_count,4000);assert.equal(run.total_size,24000);db.close();
  return {ms:Math.round(performance.now()-start),dbPath,scanId};
}
async function queries(workerPath,base,scanId) {
  const worker=new Worker(workerPath,{workerData:{directory:base}});
  let sequence=0;
  const request=query=>new Promise((resolve,reject)=>{
    const id=++sequence,handler=message=>{
      if(message.id!==id)return;worker.off('message',handler);message.error?reject(new Error(message.error)):resolve(message.result);
    };worker.on('message',handler);worker.postMessage({id,operation:'nodes',args:[query]});
  });
  try {
    await request({scanId,view:'search',search:'sample',page:1,pageSize:50,sortDir:'asc'});
    const start=performance.now();
    for(let page=1;page<=20;page++) {
      const result=await request({scanId,view:'search',search:'sample',page,pageSize:50,sortDir:'asc'});
      assert.equal(result.total,200000);assert.equal(result.items.length,50);
    }
    return +(performance.now()-start).toFixed(1);
  } finally {await worker.terminate();}
}
async function main() {
  const version=JSON.parse(asar.extractFile(archive,'package.json').toString()).version;
  assert.equal(version,'1.4.0','Run before replacing the 1.4.0 packaged baseline');
  const base=await fs.mkdtemp(path.join(workspace,'.benchmark-'));
  const oldScanner=path.join(base,'old-scanner.cjs'),oldQuery=path.join(base,'old-query.cjs');
  await fs.writeFile(oldScanner,asar.extractFile(archive,'dist-electron/scanner-worker.js'));
  await fs.writeFile(oldQuery,asar.extractFile(archive,'dist-electron/query-worker.js'));
  const root=path.join(base,'fixture');
  for(let folder=0;folder<40;folder++) {
    const dir=path.join(root,'folder-'+folder,'nested');await fs.mkdir(dir,{recursive:true});
    for(let batch=0;batch<10;batch++) await Promise.all(Array.from({length:10},(_,i)=>fs.writeFile(path.join(dir,(batch*10+i)+'.txt'),'sample')));
  }
  const currentScanner=path.join(workspace,'dist-electron/scanner-worker.js'),currentQuery=path.join(workspace,'dist-electron/query-worker.js');
  const before=[],after=[];let last;
  for(let trial=0;trial<3;trial++) {
    if(trial%2===0) {before.push((await scan(oldScanner,root,base)).ms);last=await scan(currentScanner,root,base);after.push(last.ms);}
    else {last=await scan(currentScanner,root,base);after.push(last.ms);before.push((await scan(oldScanner,root,base)).ms);}
  }
  const db=new Database(last.dbPath);db.exec('DELETE FROM nodes; DELETE FROM aggregates;');
  const insert=db.prepare("INSERT INTO nodes(scan_id,parent_id,name,path,kind,extension,category,size,allocated_size) VALUES (?,NULL,'sample','sample','file','txt','Documents',?,4096)");
  db.transaction(()=>{for(let i=0;i<200000;i++) insert.run(last.scanId,i%3);})();db.close();
  const oldQueries=[],newQueries=[];
  for(let trial=0;trial<3;trial++) {
    oldQueries.push(await queries(oldQuery,base,last.scanId));newQueries.push(await queries(currentQuery,base,last.scanId));
  }
  const report={baseline:'Packaged 1.4.0',current:'1.5.0 candidate',fixtureFiles:4000,scanMs:{before,after,beforeMedian:median(before),afterMedian:median(after)},pages20Ms:{rows:200000,before:oldQueries,after:newQueries,beforeMedian:median(oldQueries),afterMedian:median(newQueries)},note:'Three paired local trials with generated data; cached filesystem, no whole-drive or laptop-wide guarantee.'};
  await fs.writeFile(path.join(workspace,'docs/optimization-comparison.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
}
main().catch(error=>{console.error(error);process.exit(1);});
