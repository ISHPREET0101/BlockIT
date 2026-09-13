// Paired alternating real-drive scans: packaged 1.7 worker (archived copy,
// with the helper that shipped beside its app.asar) versus the 1.8 worker on
// the same drive root. Read-only metadata scanning; each scan writes its
// database into an excluded temp directory outside the scanned tree. The 1.8
// engine reports its mode per run ('volume' = MFT, 'native' = walk lanes,
// 'portable' = compatibility), which the report records so fallback runs are
// never mistaken for MFT runs.
const {Worker}=require('node:worker_threads');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {randomUUID}=require('node:crypto');

const OLD_WORKER=process.env.OLD_WORKER||path.resolve(__dirname,'../.bench/old17/scanner-worker.js');
const OLD_HELPER=process.env.OLD_HELPER||path.resolve(__dirname,'../.bench/old17/blockit-enumerator.exe');
const NEW_WORKER=path.resolve(__dirname,'../dist-electron/scanner-worker.js');
const ROOT=path.resolve(process.env.SCAN_ROOT||'C:\\');
const TRIALS=Math.max(1,Number(process.env.TRIALS)||3);
const OUT=process.env.OUT||path.resolve(__dirname,'../docs/scanner-comparison-1.8.json');

function summarize(runs) {
  const sorted=[...runs].sort((a,b)=>a.ms-b.ms);
  const median=sorted[Math.floor(sorted.length/2)];
  return {runs:runs.map(r=>({ms:r.ms,engine:r.engine,status:r.status,nodes:r.nodes,files:r.files,folders:r.folders,bytes:r.bytes})),
    medianMs:median.ms,medianEngine:median.engine,medianNodes:median.nodes};
}

async function scan(workerPath,helperPath,base) {
  const scanId=randomUUID(),dbPath=path.join(base,scanId+'.db');
  const started=performance.now();
  let engine='?',lastLog=0;
  const worker=new Worker(workerPath,{workerData:{scanId,root:ROOT,dbPath,volumeTotalBytes:1e12,volumeFreeBytes:1e11,clusterSize:4096,excludedPaths:[base],
    ...(helperPath?{nativeHelperPath:helperPath}:{})}});
  const result=await new Promise((resolve,reject)=>{
    worker.on('message',message=>{
      if(message.type==='engine')engine=message.engine;
      if(message.type==='progress'&&message.progress.status==='scanning') {
        const p=message.progress;
        if(Date.now()-lastLog>30000) {
          lastLog=Date.now();
          console.error(`  [+${((performance.now()-started)/1000).toFixed(0)}s] files=${p.files} folders=${p.folders} cur=${p.currentPath}`);
        }
      }
      if(message.type==='done')resolve(message);
      if(message.type==='error')reject(new Error(message.message));
    });
    worker.on('error',reject);
  });
  await new Promise(resolve=>worker.once('exit',resolve));
  const tallies={nodes:0,files:0,folders:0,bytes:0};
  try {
    const Database=require('better-sqlite3');
    const db=new Database(dbPath,{readonly:true});
    Object.assign(tallies,db.prepare(`SELECT COUNT(*) nodes,
      SUM(CASE WHEN kind='file' THEN 1 ELSE 0 END) files,
      SUM(CASE WHEN kind!='file' THEN 1 ELSE 0 END) folders,
      SUM(CASE WHEN kind='file' THEN size ELSE 0 END) bytes
      FROM nodes`).get());
    const warnings=db.prepare('SELECT COUNT(*) n FROM warnings').get().n;
    tallies.warnings=warnings;
    db.close();
  } catch (error) { tallies.error=error.message; }
  return {ms:Math.round(performance.now()-started),engine,status:result.status,...tallies};
}

async function main() {
  const base=await fs.mkdtemp(path.join(os.tmpdir(),'blockit-compare18-'));
  const before=[],after=[];
  for(let i=0;i<TRIALS;i++) {
    console.error(`pair ${i+1}/${TRIALS}: 1.7 worker on ${ROOT}`);
    before.push(await scan(OLD_WORKER,OLD_HELPER,base));
    console.error(`  1.7: ${(before[before.length-1].ms/1000).toFixed(1)}s engine=${before[before.length-1].engine} nodes=${before[before.length-1].nodes}`);
    console.error(`pair ${i+1}/${TRIALS}: 1.8 worker on ${ROOT}`);
    after.push(await scan(NEW_WORKER,null,base));
    console.error(`  1.8: ${(after[after.length-1].ms/1000).toFixed(1)}s engine=${after[after.length-1].engine} nodes=${after[after.length-1].nodes}`);
  }
  const report={baseline:'Packaged 1.7 scanner worker (archived build, shipped helper)',current:'1.8 scanner worker',
    root:ROOT,trials:TRIALS,before:summarize(before),after:summarize(after),
    note:'Alternating paired full scans of a real drive root, warm filesystem cache, helper startup, index build and checkpoint included. The 1.8 engine field distinguishes MFT volume scans from walk-lane fallback. Real-drive, same-machine measurement; not a cross-machine or cold-cache guarantee.'};
  await fs.writeFile(OUT,JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
  await new Promise(r=>setTimeout(r,200));
  await fs.rm(base,{recursive:true,force:true}).catch(()=>{});
  process.exit(0);
}
main().catch(error=>{console.error(error);process.exit(1);});
