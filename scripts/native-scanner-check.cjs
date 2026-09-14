const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {Worker}=require('node:worker_threads');
const {spawn}=require('node:child_process');
const readline=require('node:readline');
const {once}=require('node:events');
const {randomUUID}=require('node:crypto');
const Database=require('better-sqlite3');
const assert=require('node:assert/strict');
const helper=path.resolve(__dirname,'../build/native/blockit-enumerator.exe');
async function scan(root,base,options={}) {
  const scanId=randomUUID(),dbPath=path.join(base,scanId+'.db');
  const worker=new Worker(path.resolve(__dirname,'../dist-electron/scanner-worker.js'),{workerData:{root,scanId,dbPath,clusterSize:4096,volumeTotalBytes:1e9,volumeFreeBytes:1e8,...options}});
  let engine,result;
  await new Promise((resolve,reject)=>{
    worker.on('message',message=>{if(message.type==='engine')engine=message.engine;if(message.type==='done')result=message;if(message.type==='error')reject(new Error(message.message));});
    worker.on('error',reject);worker.on('exit',code=>code===0?resolve():reject(new Error('Worker exit '+code)));
  });
  const db=new Database(dbPath,{readonly:true});
  const nodes=db.prepare('SELECT name,path,kind,extension,category,size,allocated_size,modified_at,attributes,file_count,folder_count FROM nodes ORDER BY path').all();
  const run=db.prepare('SELECT * FROM scan_runs').get();db.close();
  return {engine,result,nodes,run};
}
async function main() {
  assert.equal(process.platform,'win32');
  const base=await fs.mkdtemp(path.join(os.tmpdir(),'blockit-native-'));
  const root=path.join(base,'fixture');await fs.mkdir(root);
  for(let batch=0;batch<6;batch++)await Promise.all(Array.from({length:100},(_,i)=>fs.writeFile(path.join(root,'file-'+(batch*100+i)+'.txt'),'sample')));
  await fs.writeFile(path.join(root,'empty.txt'),'');
  await fs.mkdir(path.join(root,'empty-folder'));
  // A wide folder exercises 4096-entry batch boundaries end to end.
  await fs.mkdir(path.join(root,'batchy'));
  for(let batch=0;batch<43;batch++)await Promise.all(Array.from({length:100},(_,i)=>fs.writeFile(path.join(root,'batchy','wide-'+(batch*100+i)+'.txt'),'sample')));
  // More subdirectories than the helper's 2,048-dir walk cap: dirs beyond the
  // cap are handed to the caller as pending and walked from the worker's stack,
  // so markers straddling the boundary prove those subtrees are not dropped.
  await fs.mkdir(path.join(root,'sprawling'));
  for(let batch=0;batch<22;batch++)await Promise.all(Array.from({length:100},(_,i)=>fs.mkdir(path.join(root,'sprawling','sub-'+(batch*100+i)))));
  for(const marker of ['sub-0','sub-2040','sub-2199'])await fs.writeFile(path.join(root,'sprawling',marker,'marker.txt'),'sample');
  const long=path.join(root,...Array.from({length:6},(_,i)=>'long-'+i+'x'.repeat(40)));
  await fs.mkdir(long,{recursive:true});
  const unicode=path.join(long,'文件-😀.tar.gz');await fs.writeFile(unicode,'unicode');
  await fs.symlink(root,path.join(root,'cycle'),'junction');
  const excluded=path.join(root,'excluded');await fs.mkdir(excluded);await fs.writeFile(path.join(excluded,'private.txt'),'excluded');
  // NTFS propagates child mtime changes into the parent's directory index
  // lazily; the native walk reads mtimes through the parent. Let the fixture
  // settle so both engines read the same steady-state metadata.
  await new Promise(r=>setTimeout(r,2000));
  const native=await scan(root,base,{excludedPaths:[excluded]});
  const portable=await scan(root,base,{excludedPaths:[excluded],metadataEngine:'portable'});
  assert.equal(native.engine,'native');assert.equal(native.result.status,'completed');
  assert.equal(native.run.file_count,4905);assert.equal(native.run.total_size,29425);
  assert(native.nodes.some(n=>n.path.endsWith('sprawling\\sub-2199\\marker.txt')),'Beyond-cap pending subtree was walked');
  assert.equal(native.nodes.filter(n=>n.kind==='link').length,1);
  assert.equal(native.nodes.length,portable.nodes.length);
  for(let i=0;i<native.nodes.length;i++) {
    const {modified_at:a,attributes:ignoredA,...one}=native.nodes[i];
    const {modified_at:b,attributes:ignoredB,...two}=portable.nodes[i];
    assert.deepEqual(one,two);
    // Walk mode reads folder mtimes through the parent's directory index,
    // which NTFS may not refresh after the folder's own contents changed
    // moments before the scan; files keep a tight tolerance.
    const tolerance=native.nodes[i].kind==='folder'?5000:20;
    assert(Math.abs(a-b)<tolerance,`Windows timestamp mismatch for ${one.path}: native=${a}, stat=${b}`);
  }
  const fallback=await scan(root,base,{excludedPaths:[excluded],nativeHelperPath:path.join(base,'missing.exe')});
  assert.equal(fallback.run.file_count,4905);assert.equal(fallback.run.total_size,29425);
  assert.equal(fallback.result.status,'completed_with_warnings');assert.equal(fallback.run.warning_count,1);
  // Exercise the actual native protocol: bounded batches, no unsolicited
  // read-ahead while paused, self metadata on open, empty, Unicode/extended
  // paths and missing folders.
  const child=spawn(helper,[String(process.pid)],{windowsHide:true,stdio:'pipe'});
  const lines=readline.createInterface({input:child.stdout});
  const queue=[];lines.on('line',line=>queue.push(JSON.parse(line)));
  const receive=async()=>{const deadline=Date.now()+10000;while(!queue.length){assert(Date.now()<deadline,'Native protocol timeout');await new Promise(r=>setTimeout(r,5));}return queue.shift();};
  const request=async data=>{child.stdin.write(JSON.stringify(data)+'\n');return receive();};
  try {
    assert.deepEqual(await receive(),{ready:1});
    let batch=await request({op:'open',path:root});
    // One batch spans directory boundaries: the walk streams the root's own
    // entries and keeps going through prefetched children until the cap.
    assert.equal(batch.entries.length,4096);assert.equal(batch.done,false);
    assert(batch.self&&batch.self.directory&&!batch.self.reparse,'Open responses carry self metadata');
    assert.equal(batch.self.path.toLowerCase(),root.toLowerCase());
    await new Promise(r=>setTimeout(r,150));assert.equal(queue.length,0,'Reader must wait for demand');
    let count=batch.entries.length;
    while(!batch.done){batch=await request({op:'next'});assert(batch.entries.length<=4096);assert.equal(batch.self,null);count+=batch.entries.length;}
    // 4,904 tree entries (including excluded\private.txt — the probe passes no
    // exclusion list) plus the helper-local markers; NTFS enumerates in
    // directory-index (lexicographic) order, so exactly one of the three
    // sprawling markers falls beyond the 2,046-dir helper cap into pending.
    assert.equal(count,4906);
    batch=await request({op:'open',path:path.join(root,'batchy')});
    assert.equal(batch.entries.length,4096);assert.equal(batch.done,false);
    await new Promise(r=>setTimeout(r,150));assert.equal(queue.length,0,'Reader must wait for demand');
    count=batch.entries.length;
    while(!batch.done){batch=await request({op:'next'});count+=batch.entries.length;}
    assert.equal(count,4300);
    batch=await request({op:'open',path:path.join(root,'empty-folder')});assert.equal(batch.entries.length,0);assert.equal(batch.done,true);assert.equal(batch.error,null);
    batch=await request({op:'open',path:long});assert.equal(batch.entries[0].n,'文件-😀.tar.gz');assert.equal(batch.entries[0].s,7);
    batch=await request({op:'open',path:path.join(base,'not-there')});assert(batch.error);assert.equal(batch.done,true);assert.equal(batch.self,null);
    const exited=once(child,'exit');child.stdin.end();await exited;
  } finally {child.kill();lines.close();}
  console.log('PASS native/portable totals, 4905 files incl. beyond-cap pending subtrees, long/Unicode paths, junctions, exclusions, fallback, 4096-entry demand batches, self metadata, empty/missing folders and EOF cleanup.');
}
main().catch(error=>{console.error(error);process.exit(1);});
