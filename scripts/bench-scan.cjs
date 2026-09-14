// Paired before/after scanner benchmark. Runs two scanner workers over the same
// tree on the same machine, alternating pairs, and records wall time plus DB
// tallies. Also verifies output parity: for every paired run the produced trees
// must match node-for-node (same paths, kinds, sizes and totals). Metadata only;
// fixtures are ordinary temp files.
//
// Modes:
//   node scripts/bench-scan.cjs generate <dir> <small|medium|large>
//   node scripts/bench-scan.cjs run <root> <label> [--before <worker>] [--after <worker>] [--trials N] [--out file]
//   node scripts/bench-scan.cjs suite            (generate all profiles, run all, write docs/benchmark-1.9.json)
const {Worker}=require('node:worker_threads');
const fs=require('node:fs/promises');
const fss=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const {randomUUID}=require('node:crypto');

const ROOT=path.resolve(__dirname,'..');
const BEFORE=path.resolve(process.env.BEFORE_WORKER||path.join(ROOT,'.bench/main15/worker/scanner-worker.js'));
const AFTER=path.resolve(process.env.AFTER_WORKER||path.join(ROOT,'dist-electron/scanner-worker.js'));
const HELPER=path.resolve(process.env.HELPER||path.join(ROOT,'build/native/blockit-enumerator.exe'));
const TRIALS=Math.max(1,Number(process.env.TRIALS)||3);

async function writeFiles(dir,names,payload){await fs.mkdir(dir,{recursive:true});for(let i=0;i<names.length;i+=256)await Promise.all(names.slice(i,i+256).map(name=>fs.writeFile(path.join(dir,name),payload)));}

async function generate(root,profile){
  await fs.rm(root,{recursive:true,force:true});
  await fs.mkdir(root,{recursive:true});
  let files=0,dirs=1;
  if(profile==='small'){
    for(let f=0;f<40;f++){const dir=path.join(root,'folder-'+f,'nested');await writeFiles(dir,Array.from({length:100},(_,j)=>j+'.txt'),'sample');files+=100;dirs+=2;}
    await fs.symlink(path.join(root,'folder-0'),path.join(root,'shortcut'),'junction');
  } else if(profile==='medium'){
    for(let a=0;a<30;a++)for(let b=0;b<10;b++){const dir=path.join(root,'area-'+a,'part-'+b,'leaf');await writeFiles(dir,Array.from({length:100},(_,j)=>j+'.dat'),'sample-data');files+=100;dirs+=3;}
    await fs.symlink(path.join(root,'area-0'),path.join(root,'shortcut'),'junction');
  } else if(profile==='large'){
    // Wide fan-out plus a very deep chain and one very large flat folder.
    for(let a=0;a<40;a++)for(let b=0;b<20;b++){const dir=path.join(root,'group-'+a,'bucket-'+b);await writeFiles(dir,Array.from({length:100},(_,j)=>j+'.bin'),'b');files+=100;dirs+=2;}
    let deep=root;for(let d=0;d<80;d++){deep=path.join(deep,'level-'+d);await writeFiles(deep,['a.txt','b.txt'],'x');files+=2;dirs+=1;}
    await writeFiles(path.join(root,'flat-heavy'),Array.from({length:6000},(_,j)=>'f'+j+'.log'),'log-line');files+=6000;dirs+=1;
    await fs.symlink(path.join(root,'group-0'),path.join(root,'shortcut'),'junction');
  } else throw new Error('unknown profile '+profile);
  return {root,files,dirs};
}

function tallies(dbPath){
  const Database=require('better-sqlite3');
  const db=new Database(dbPath,{readonly:true});
  const t=db.prepare(`SELECT COUNT(*) nodes,
    SUM(CASE WHEN kind='file' THEN 1 ELSE 0 END) files,
    SUM(CASE WHEN kind='folder' THEN 1 ELSE 0 END) folders,
    SUM(CASE WHEN kind='link' THEN 1 ELSE 0 END) links,
    SUM(CASE WHEN kind='file' THEN size ELSE 0 END) bytes FROM nodes`).get();
  const warnings=db.prepare('SELECT COUNT(*) n FROM warnings').get().n;
  // Structure is compared by parent *path*, not by the internal autoincrement
  // id, because traversal order may assign different ids for an identical tree.
  const rows=db.prepare("SELECT n.path,n.kind,n.size,p.path AS parentPath FROM nodes n LEFT JOIN nodes p ON p.id=n.parent_id ORDER BY n.path").all();
  const digest=crypto.createHash('sha256');
  for(const r of rows)digest.update(r.path+'\u0000'+r.kind+'\u0000'+r.size+'\u0000'+(r.parentPath||'')+'\n');
  const rootRow=db.prepare('SELECT size,file_count,folder_count FROM nodes WHERE parent_id IS NULL').get();
  const agg=db.prepare("SELECT dimension,name,size,count FROM aggregates ORDER BY dimension,name").all();
  db.close();
  return {nodes:Number(t.nodes),files:Number(t.files),folders:Number(t.folders),links:Number(t.links),bytes:Number(t.bytes),warnings,
    rootSize:Number(rootRow.size),rootFiles:Number(rootRow.file_count),rootFolders:Number(rootRow.folder_count),
    treeHash:digest.digest('hex'),
    aggregates:agg.map(a=>`${a.dimension}:${a.name}:${a.size}:${a.count}`).join('|')};
}

async function scan(workerPath,root,base,useHelper){
  const scanId=randomUUID(),dbPath=path.join(base,scanId+'.db');
  const started=performance.now();
  let engine='?';
  const worker=new Worker(workerPath,{workerData:{scanId,root,dbPath,volumeTotalBytes:1e12,volumeFreeBytes:1e11,clusterSize:4096,excludedPaths:[base],
    ...(useHelper?{nativeHelperPath:HELPER}:{})}});
  const result=await new Promise((resolve,reject)=>{
    worker.on('message',m=>{if(m.type==='engine')engine=m.engine;if(m.type==='done')resolve(m);if(m.type==='error')reject(new Error(m.message));});
    worker.on('error',reject);
  });
  await new Promise(resolve=>worker.once('exit',resolve));
  const ms=Math.round(performance.now()-started);
  return {ms,engine,status:result.status,...tallies(dbPath)};
}

function median(runs){const s=[...runs].sort((a,b)=>a.ms-b.ms);return s[Math.floor(s.length/2)].ms;}

async function benchmark(root,label,trials){
  const base=await fs.mkdtemp(path.join(os.tmpdir(),'blockit-bench-'));
  const before=[],after=[];
  for(let i=0;i<trials;i++){
    before.push(await scan(BEFORE,root,base,false));
    after.push(await scan(AFTER,root,base,true));
  }
  const b=before[before.length-1],a=after[after.length-1];
  const parity={sameNodes:b.nodes===a.nodes,sameFiles:b.files===a.files,sameFolders:b.folders===a.folders,
    sameBytes:b.bytes===a.bytes,sameTreeHash:b.treeHash===a.treeHash,sameAggregates:b.aggregates===a.aggregates,
    sameRootTotals:b.rootSize===a.rootSize&&b.rootFiles===a.rootFiles&&b.rootFolders===a.rootFolders,
    beforeWarnings:b.warnings,afterWarnings:a.warnings};
  const report={label,root,trials,
    before:{medianMs:median(before),engine:b.engine==='?'?'portable-1.5-walk':b.engine,runs:before.map(r=>({ms:r.ms,nodes:r.nodes,files:r.files,bytes:r.bytes}))},
    after:{medianMs:median(after),engine:a.engine,runs:after.map(r=>({ms:r.ms,nodes:r.nodes,files:r.files,bytes:r.bytes}))},
    tallies:{nodes:a.nodes,files:a.files,folders:a.folders,links:a.links,bytes:a.bytes},
    parity,
    speedup:+(median(before)/median(after)).toFixed(2)};
  await fs.rm(base,{recursive:true,force:true}).catch(()=>{});
  return report;
}

function print(report){
  const p=report.parity, ok=p.sameNodes&&p.sameFiles&&p.sameFolders&&p.sameBytes&&p.sameTreeHash&&p.sameAggregates&&p.sameRootTotals;
  console.log(`\n[${report.label}] ${report.root}`);
  console.log(`  before : ${report.before.medianMs} ms (engine ${report.before.engine})`);
  console.log(`  after  : ${report.after.medianMs} ms (engine ${report.after.engine})`);
  console.log(`  speedup: ${report.speedup}x   files=${report.tallies.files} nodes=${report.tallies.nodes} bytes=${report.tallies.bytes}`);
  console.log(`  parity : ${ok?'EXACT MATCH':'MISMATCH '+JSON.stringify(p)}`);
  if(!ok)process.exitCode=1;
}

async function main(){
  const [mode,arg1,arg2]=process.argv.slice(2);
  if(mode==='generate'){const r=await generate(path.resolve(arg1),arg2);console.log(JSON.stringify(r));return;}
  if(mode==='run'){
    let before=BEFORE,after=AFTER,trials=TRIALS,out=null;
    for(let i=3;i<process.argv.length;i++){
      if(process.argv[i]==='--before')before=path.resolve(process.argv[++i]);
      else if(process.argv[i]==='--after')after=path.resolve(process.argv[++i]);
      else if(process.argv[i]==='--trials')trials=Number(process.argv[++i]);
      else if(process.argv[i]==='--out')out=process.argv[++i];
    }
    const report=await benchmark(path.resolve(arg1),arg2||path.basename(arg1),trials);
    print(report);
    if(out)await fs.writeFile(out,JSON.stringify(report,null,2));
    return;
  }
  if(mode==='suite'){
    const benchRoot=path.resolve(process.env.BENCH_FIXTURES||path.join(ROOT,'.bench/fixtures'));
    const profiles=['small','medium','large'];
    const gen=[];
    for(const p of profiles){const g=await generate(path.join(benchRoot,p),p);gen.push(g);console.log(`generated ${p}: ${g.files} files`);}
    const reports=[];
    for(const p of profiles)reports.push(await benchmark(path.join(benchRoot,p),`generated-${p}`,TRIALS));
    const real=process.env.REAL_TREE||'D:\\Projects';
    if(fss.existsSync(real))reports.push(await benchmark(real,'real-world-D:\\Projects',Math.max(1,Math.min(TRIALS,2))));
    const machine={platform:os.platform(),release:os.release(),cpus:os.cpus().length,cpuModel:os.cpus()[0]&&os.cpus()[0].model,totalMemGB:+(os.totalmem()/1024**3).toFixed(1),node:process.version,
      beforeWorker:BEFORE,afterWorker:AFTER};
    const payload={machine,method:'Paired alternating full scans on the same tree and machine; warm filesystem cache; worker startup, index build and SQLite checkpoint included; parity asserted node-for-node via SHA-256 tree digest plus totals and aggregates.',
      profiles:reports};
    for(const r of reports)print(r);
    const out=process.env.OUT||path.join(ROOT,'docs/benchmark-1.9.json');
    await fs.writeFile(out,JSON.stringify(payload,null,2));
    console.log('\nwrote '+out);
    return;
  }
  console.error('usage: bench-scan.cjs generate <dir> <small|medium|large> | run <root> <label> | suite');
  process.exit(2);
}
main().catch(e=>{console.error(e);process.exit(1);});
