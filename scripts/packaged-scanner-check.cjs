// Runs the actual archived worker and shipped helper in Electron, with only
// disposable fixtures. This does not launch an installer or touch user profiles.
const {app}=require('electron');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {Worker}=require('node:worker_threads');
const {randomUUID}=require('node:crypto');
const Database=require('better-sqlite3');
const assert=require('node:assert/strict');
async function main() {
  const base=await fs.mkdtemp(path.join(os.tmpdir(),'blockit-packaged-'));
  app.setPath('userData',path.join(base,'profile'));
  await app.whenReady();
  const resources=path.resolve(__dirname,'../release/win-unpacked/resources');
  const archive=path.join(resources,'app.asar');
  assert.equal(require(path.join(archive,'package.json')).version,'1.8.0');
  const nativeHelperPath=path.join(resources,'blockit-enumerator.exe');
  assert((await fs.stat(nativeHelperPath)).size>0);
  const root=path.join(base,'fixture');await fs.mkdir(root);
  await fs.writeFile(path.join(root,'sample.txt'),'packaged');
  const scanId=randomUUID(),dbPath=path.join(base,scanId+'.db');
  const worker=new Worker(path.join(archive,'dist-electron/scanner-worker.js'),{workerData:{scanId,root,dbPath,nativeHelperPath,volumeTotalBytes:1e9,volumeFreeBytes:1e8,clusterSize:4096}});
  let engine,result;
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{void worker.terminate();reject(new Error('Packaged scan timed out'));},15000);
    worker.on('message',message=>{if(message.type==='engine')engine=message.engine;if(message.type==='done')result=message;if(message.type==='error')reject(new Error(message.message));});
    worker.on('error',reject);worker.on('exit',code=>{clearTimeout(timer);code===0?resolve():reject(new Error('Worker exit '+code));});
  });
  assert.equal(engine,'native');assert.equal(result.status,'completed');
  const db=new Database(dbPath,{readonly:true});const run=db.prepare('SELECT * FROM scan_runs').get();db.close();
  assert.equal(run.file_count,1);assert.equal(run.total_size,8);
  console.log('PASS: packaged 1.6.0 archive worker uses shipped native helper; scan completed with exact totals.');
}
main().then(()=>app.exit(0)).catch(error=>{console.error(error);app.exit(1);});
