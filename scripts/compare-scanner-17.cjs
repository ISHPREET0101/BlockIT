// Paired alternating scans of the packaged 1.6 worker (archived copy) versus
// the 1.7 worker over the same generated fixtures. Read-only harness; only
// disposable fixtures are scanned.
const {Worker}=require('node:worker_threads');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {randomUUID}=require('node:crypto');

const OLD_WORKER=process.env.OLD_WORKER;
const NEW_WORKER=path.resolve(__dirname,'../dist-electron/scanner-worker.js');

async function buildFixture(base,name,folders,per) {
  const root=path.join(base,name);
  await fs.mkdir(root,{recursive:true});
  for(let f=0;f<folders;f++) {
    const dir=path.join(root,'folder-'+f,'nested');
    await fs.mkdir(dir,{recursive:true});
    for(let batch=0;batch<per;batch+=200) {
      await Promise.all(Array.from({length:Math.min(200,per-batch)},(_,j)=>fs.writeFile(path.join(dir,(batch*10+j)+'.'+(j%2?'dat':'txt')),'sample')));
    }
  }
  return root;
}

async function scan(workerPath,root,base) {
  const scanId=randomUUID(),dbPath=path.join(base,scanId+'.db');
  const started=performance.now();
  const worker=new Worker(workerPath,{workerData:{scanId,root,dbPath,volumeTotalBytes:1e9,volumeFreeBytes:1e8,clusterSize:4096,excludedPaths:[]}});
  const result=await new Promise((resolve,reject)=>{
    worker.on('message',message=>{
      if(message.type==='done')resolve(message);
      if(message.type==='error')reject(new Error(message.message));
    });
    worker.on('error',reject);
  });
  await new Promise(resolve=>worker.once('exit',resolve));
  return {ms:Math.round(performance.now()-started),files:result.status==='completed'||result.status==='completed_with_warnings'?result.status:'?',status:result.status};
}

async function paired(root,base,trials) {
  const before=[],after=[];
  for(let i=0;i<trials;i++) {
    before.push((await scan(OLD_WORKER,root,base)).ms);
    after.push((await scan(NEW_WORKER,root,base)).ms);
  }
  const median=a=>[...a].sort((x,y)=>x-y)[Math.floor(a.length/2)];
  return {before,after,beforeMedian:median(before),afterMedian:median(after)};
}

async function main() {
  const base=await fs.mkdtemp(path.join(os.tmpdir(),'blockit-compare-'));
  const small=await buildFixture(base,'small',40,500);      // 20,000 files, 80 folders
  const large=await buildFixture(base,'large',1200,100);    // 120,000 files, 2,400 folders
  const smallResult=await paired(small,base,3);
  const largeResult=await paired(large,base,3);
  const report={baseline:'Packaged 1.6 scanner worker (archived build)',current:'1.7 scanner worker',
    small:{fixtureFiles:20000,...smallResult},
    large:{fixtureFiles:120000,folders:2400,...largeResult},
    note:'Alternating paired local trials, warm filesystem cache, helper startup included. Generated tiny files; not a whole-drive, HDD, network or cold-cache measurement.'};
  await fs.writeFile(path.join(__dirname,'../docs/scanner-comparison-1.7.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
  await fs.rm(base,{recursive:true,force:true});
}
main().catch(error=>{console.error(error);process.exit(1);});
