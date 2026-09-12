const {Worker}=require('node:worker_threads');
const fs=require('node:fs/promises');
const {createReadStream}=require('node:fs');
const readline=require('node:readline');
const os=require('node:os');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const assert=require('node:assert/strict');
const Database=require('better-sqlite3');

async function main() {
  const base=await fs.mkdtemp(path.join(os.tmpdir(),'blockit-regression-'));
  const root=path.join(base,'fixture');
  await fs.mkdir(path.join(root,'nested','Unicode-文件'),{recursive:true});
  const long=path.join(root,'nested',...Array.from({length:6},(_,i)=>'long-directory-'+i+'x'.repeat(32)));
  await fs.mkdir(long,{recursive:true});
  await fs.writeFile(path.join(long,'long-path.txt'),'long');
  await fs.writeFile(path.join(root,'nested','Unicode-文件','photo.JPG'),'abc');
  await fs.writeFile(path.join(root,'nested','archive.tar.gz'),'abcde');
  await fs.writeFile(path.join(root,'empty.txt'),'');
  await fs.writeFile(path.join(root,'denied-test.txt'),'not read');
  await fs.writeFile(path.join(root,'vanishing-test.txt'),'not read');
  await fs.symlink(root,path.join(root,'cycle'),'junction');
  const scanId=randomUUID(),dbPath=path.join(base,scanId+'.db');
  const worker=new Worker(path.join(__dirname,'../dist-electron/scanner-worker.js'),{
    workerData:{root,scanId,dbPath,clusterSize:4096,volumeTotalBytes:1e9,volumeFreeBytes:1e8},
    execArgv:['--require',path.join(__dirname,'scanner-faults.cjs')],
  });
  let maximum=0,done;
  await new Promise((resolve,reject)=>{
    worker.on('message',message=>{
      if(message.type==='test-concurrency') maximum=Math.max(maximum,message.maximum);
      if(message.type==='done') done=message;
      if(message.type==='error') reject(new Error(message.message));
    });
    worker.on('error',reject);worker.on('exit',code=>code===0?resolve():reject(new Error('Scanner exit '+code)));
  });
  assert.equal(done.status,'completed_with_warnings');assert(maximum<=4);
  const db=new Database(dbPath);
  const run=db.prepare('SELECT * FROM scan_runs').get();
  assert.equal(run.file_count,4);assert.equal(run.total_size,12);assert.equal(run.warning_count,2);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM nodes WHERE kind='link'").get().n,1);
  assert.equal(db.prepare("SELECT extension FROM nodes WHERE name='archive.tar.gz'").get().extension,'gz');
  const rootId=db.prepare('SELECT id FROM nodes WHERE parent_id IS NULL').get().id;
  assert.equal(db.prepare('SELECT size FROM nodes WHERE id=?').get(rootId).size,12);

  const reader=new Worker(path.join(__dirname,'../dist-electron/query-worker.js'),{workerData:{directory:base}});
  let sequence=0;
  const pending=new Map();
  reader.on('message',message=>{
    const request=pending.get(message.id);if(!request)return;
    pending.delete(message.id);clearTimeout(request.timer);
    message.error?request.reject(new Error(message.error)):request.resolve(message.result);
  });
  const request=(operation,...args)=>new Promise((resolve,reject)=>{
    const id=++sequence;const timer=setTimeout(()=>reject(new Error(operation+' timed out')),30000);
    pending.set(id,{resolve,reject,timer});reader.postMessage({id,operation,args});
  });
  try {
    assert.equal((await request('nodes',{scanId,view:'large',minSize:0})).total,4,'Zero size boundary includes empty files');
    assert.equal((await request('nodes',{scanId,view:'old',olderThan:0})).total,0,'Epoch boundary is not replaced with a default');
    assert.equal((await request('nodes',{scanId,view:'category'})).total,4,'Categories contain files, not directories');
    const photo=db.prepare("SELECT id FROM nodes WHERE name='photo.JPG'").get();
    assert.deepEqual((await request('ancestors',scanId,photo.id)).map(n=>n.name),['fixture','nested','Unicode-文件','photo.JPG']);
    for(const query of [{scanId,sortBy:'size;DROP TABLE nodes'}, {scanId,page:-1}, {scanId,minSize:NaN}, {scanId:'../outside'}, {scanId,kind:'symlink'}]) await assert.rejects(request('nodes',query));

    // Expand only generated metadata. Every indexed node belongs to this disposable fixture.
    const insert=db.prepare("INSERT INTO nodes(scan_id,parent_id,name,path,kind,extension,category,size,allocated_size,modified_at) VALUES (?,?,?,?,'file','txt','Documents',?,?,?)");
    const count=100005;
    db.transaction(()=>{
      for(let i=0;i<count;i++) insert.run(scanId,rootId,'row-'+String(i).padStart(6,'0')+'.txt',path.join(root,'row-'+i+'.txt'),i%3,4096,1234);
    })();
    const first=await request('nodes',{scanId,view:'search',search:'row-',pageSize:37,sortDir:'asc'});
    assert.equal(first.total,count);assert.equal(first.items.length,37);
    const second=await request('nodes',{scanId,view:'search',search:'row-',page:2,pageSize:37,sortDir:'asc'});
    assert.equal(new Set([...first.items,...second.items].map(n=>n.id)).size,74,'Equal sizes do not duplicate rows across pages');
    const before=performance.now();
    for(let page=1;page<=20;page++) await request('nodes',{scanId,view:'search',search:'row-',page,pageSize:50});
    const pagesMs=+(performance.now()-before).toFixed(1);
    const removed=first.items[0].id;
    db.prepare('DELETE FROM nodes WHERE id=?').run(removed);
    assert.equal((await request('nodes',{scanId,view:'search',search:'row-'})).total,count-1,'External writes invalidate cached counts');
    const last=await request('nodes',{scanId,view:'search',search:'row-',page:999999,pageSize:500});
    assert.equal(last.page,Math.ceil((count-1)/500));assert(last.items.length>0);
    const empty=await request('nodes',{scanId,view:'search',search:'not-present-123',page:999});
    assert.equal(empty.page,1);assert.equal(empty.total,0);
    const tree=await request('treemap',scanId,rootId);
    assert(tree.length<=181);
    const expected=db.prepare('SELECT SUM(size) n FROM nodes WHERE parent_id=?').get(rootId).n;
    assert.equal(tree.reduce((sum,n)=>sum+n.size,0),expected);
    const output=path.join(base,'all-results.csv');
    const exported=await request('export',{scanId,view:'search',search:'row-'},output);
    assert.equal(exported,count-1,'CSV is not silently truncated at 100,000');
    let lines=0;for await(const line of readline.createInterface({input:createReadStream(output)})) lines++;
    assert.equal(lines,exported+1);
    console.log(JSON.stringify({status:'PASS',checks:['warning continuation','empty files','Unicode and long paths','junction cycle exclusion','bounded metadata concurrency','zero-value filters','IPC query validation','breadcrumb ancestry','stable pagination','count invalidation','page clamping','bounded treemap totals','complete streamed CSV'],maximumMetadataConcurrency:maximum,generatedRows:count,pages20Ms:pagesMs,csvRows:exported},null,2));
  } finally {db.close();await reader.terminate();}
}
main().catch(error=>{console.error(error);process.exit(1);});
