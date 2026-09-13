// Large-fixture scan benchmark: measures end-to-end scan time and phase timings
// for the built scanner worker against a generated tree. Read-only harness.
const {Worker}=require('node:worker_threads');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {randomUUID}=require('node:crypto');
const Database=require('better-sqlite3');

const FILE_COUNT=Number(process.env.BENCH_FILES||120000);
const FOLDER_COUNT=Number(process.env.BENCH_FOLDERS||1200);

async function buildFixture(base) {
  const root=path.join(base,'fixture');
  await fs.mkdir(root,{recursive:true});
  let made=0;
  for(let f=0;f<FOLDER_COUNT;f++) {
    const dir=path.join(root,'dir-'+f);
    await fs.mkdir(dir,{recursive:true});
    const per=Math.ceil(FILE_COUNT/FOLDER_COUNT);
    for(let batch=0;batch<per;batch+=200) {
      await Promise.all(Array.from({length:Math.min(200,per-batch)},(_,j)=>{
        const i=batch+j;
        return fs.writeFile(path.join(dir,'f'+i+'.'+(i%2?'bin':'txt')),'x'.repeat(i%37));
      }));
      made+=Math.min(200,per-batch);
    }
  }
  return {root,made};
}

async function scan(workerPath,root,base,label) {
  const scanId=randomUUID(),dbPath=path.join(base,scanId+'.db');
  const started=performance.now();
  let firstProgressAt,done;
  const worker=new Worker(workerPath,{workerData:{scanId,root,dbPath,volumeTotalBytes:1e9,volumeFreeBytes:1e8,clusterSize:4096,excludedPaths:[],...JSON.parse(process.env.BENCH_OPTS||'{}')}});
  const result=await new Promise((resolve,reject)=>{
    worker.on('message',message=>{
      if(message.type==='progress'&&!firstProgressAt&&message.progress.files>0) firstProgressAt=performance.now();
      if(message.type==='engine') console.log(label,'engine:',message.engine);
      if(message.type==='done') resolve(message);
      if(message.type==='error') reject(new Error(message.message));
    });
    worker.on('error',reject);
  });
  await new Promise(resolve=>worker.once('exit',resolve));
  const durationMs=performance.now()-started;
  const db=new Database(dbPath,{readonly:true});
  const run=db.prepare('SELECT * FROM scan_runs').get();
  const files=run.file_count,folders=run.folder_count;
  db.close();
  return {label,durationMs:Math.round(durationMs),files,folders,filesPerSec:Math.round(files/(durationMs/1000)),dbPath};
}

async function main() {
  const base=await fs.mkdtemp(path.join(os.tmpdir(),'blockit-bench-'));
  console.log('Building fixture:',FILE_COUNT,'files across',FOLDER_COUNT,'folders...');
  const t0=performance.now();
  const {root,made}=await buildFixture(base);
  console.log('Fixture ready in',Math.round(performance.now()-t0),'ms —',made,'files');
  const target=path.resolve(__dirname,process.env.BENCH_WORKER||'../dist-electron/scanner-worker.js');
  const trials=Number(process.env.BENCH_TRIALS||3);
  const results=[];
  for(let i=0;i<trials;i++) results.push(await scan(target,root,base,'trial'+(i+1)));
  results.sort((a,b)=>a.durationMs-b.durationMs);
  console.log(JSON.stringify(results,null,2));
  console.log('Median:',results[Math.floor(trials/2)].durationMs+'ms',
    results[Math.floor(trials/2)].filesPerSec,'files/s');
  if(process.env.BENCH_KEEP!=='1') await fs.rm(base,{recursive:true,force:true});
}
main().catch(error=>{console.error(error);process.exit(1);});
