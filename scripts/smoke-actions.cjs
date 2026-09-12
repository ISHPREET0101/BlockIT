const {app,BrowserWindow,dialog,shell,clipboard}=require('electron');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const assert=require('node:assert/strict');
const Database=require('better-sqlite3');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function main() {
  const base=await fs.mkdtemp(path.join(os.tmpdir(),'blockit-actions-'));
  const profile=path.join(base,'profile'),root=path.join(base,'fixture'),outside=path.join(base,'outside');
  app.setPath('userData',profile);
  await fs.mkdir(path.join(root,'..notes'),{recursive:true});await fs.mkdir(outside);
  await fs.writeFile(path.join(root,'..notes','one.txt'),'abc');
  await fs.writeFile(path.join(root,'..notes','two.txt'),'12345');
  await fs.writeFile(path.join(outside,'private.txt'),'not indexed');
  await fs.writeFile(path.join(outside,'one.txt'),'outside replacement');
  require('../dist-electron/main.js');await app.whenReady();
  let win;
  for(let i=0;i<100;i++) {
    win=BrowserWindow.getAllWindows()[0];
    if(win&&!win.webContents.isLoading()&&await win.webContents.executeJavaScript('!!document.querySelector(".welcome")').catch(()=>false))break;
    await delay(100);
  }
  assert(win);
  const js=code=>win.webContents.executeJavaScript(code);
  // Concurrent writes used to race on settings.json.tmp and discard preferences.
  await js("Promise.all([window.blockit.settings.update({unit:'MB'}),window.blockit.settings.update({theme:'dark'}),window.blockit.settings.update({showLabels:false})])");
  const settings=await js('window.blockit.settings.get()');
  assert.equal(settings.unit,'MB');assert.equal(settings.theme,'dark');assert.equal(settings.showLabels,false);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(profile,'settings.json'),'utf8')),settings);
  assert.equal((await js('window.blockit.settings.update({confirmRecycle:false})')).confirmRecycle,true);
  await assert.rejects(js("window.blockit.settings.update({theme:'broken'})"));
  await assert.rejects(js("window.blockit.data.nodes({scanId:'../outside',sortBy:'size'})"));
  assert.equal((await js('window.blockit.actions.exportTreemap(null)')).ok,false);
  dialog.showOpenDialog=async()=>({canceled:false,filePaths:[root]});
  await js("Array.from(document.querySelectorAll('button')).find(b=>b.textContent.includes('Choose folder')).click()");
  for(let i=0;i<100;i++){if(await js('!!document.querySelector(".completion-note")'))break;await delay(100);}
  const file=(await fs.readdir(path.join(profile,'scans'))).find(p=>p.endsWith('.db'));
  const scanId=file.slice(0,-3),db=new Database(path.join(profile,'scans',file));
  const nodes=db.prepare('SELECT id,name,path,parent_id FROM nodes').all();
  const folder=nodes.find(n=>n.name==='..notes'),one=nodes.find(n=>n.name==='one.txt'),rootNode=nodes.find(n=>n.parent_id==null);
  const invoke=(method,...args)=>js('window.blockit.'+method+'('+args.map(arg=>JSON.stringify(arg)).join(',')+')');
  let opened=0,copied='',recycled=0,confirmations=0;
  shell.openPath=async()=>{opened++;return '';};shell.showItemInFolder=()=>{opened++;};clipboard.writeText=value=>{copied=value;};
  assert.equal((await invoke('actions.copyPath',scanId,one.id)).ok,true,'Dot-prefixed children are valid');
  assert.equal(copied,one.path);
  const bogus=Number(db.prepare("INSERT INTO nodes(scan_id,parent_id,name,path,kind,size) VALUES (?,?,?,?,'file',1)").run(scanId,rootNode.id,'outside',path.join(outside,'private.txt')).lastInsertRowid);
  assert.equal((await invoke('actions.open',scanId,bogus)).ok,false);assert.equal(opened,0);
  db.prepare('DELETE FROM nodes WHERE id=?').run(bogus);
  assert.equal((await invoke('actions.open',scanId,-1)).ok,false);
  // Replace an indexed ancestor with a real junction after scanning.
  const moved=path.join(base,'original-notes');await fs.rename(folder.path,moved);
  await fs.symlink(outside,folder.path,'junction');
  assert.equal((await invoke('actions.reveal',scanId,one.id)).ok,false);assert.equal(opened,0);
  await fs.unlink(folder.path);await fs.rename(moved,folder.path);
  dialog.showMessageBox=async()=>{confirmations++;return {response:0};};
  assert.equal((await invoke('actions.trash',scanId,[rootNode.id])).ok,false);assert.equal(confirmations,0);
  assert.equal((await invoke('actions.trash',scanId,[folder.id])).ok,false);assert.equal(confirmations,1);
  shell.trashItem=async item=>{recycled++;assert.equal(item,folder.path);await fs.rename(item,path.join(base,'mock-recycle-bin'));};
  dialog.showMessageBox=async(_window,options)=>{
    confirmations++;assert(options.message.includes('1 item(s)'),'Overlapping selections are deduplicated');return {response:1};
  };
  // The parent and selected child should be one confirmed action, never two removals.
  const result=await invoke('actions.trash',scanId,[folder.id,one.id]);
  assert.equal(result.ok,true);assert.equal(recycled,1);
  const summary=await invoke('data.summary',scanId);
  assert.equal(summary.totalBytes,0);assert.equal(summary.fileCount,0);assert.equal(summary.folderCount,1);assert.equal(summary.categories.length,0);
  db.close();
  win.webContents.send('scan:progress',{scanId,status:'completed',files:2,folders:2,bytes:8,warnings:0,elapsedMs:100});
  await delay(400);
  assert(await js('document.querySelector(".metric-card").textContent.includes("0 files")'),'Zero files must not fall back to old progress counts');
  await js("Array.from(document.querySelectorAll('.nav-item')).find(b=>b.textContent.includes('Browse')).click()");await delay(200);
  assert.equal(await js('document.querySelectorAll("tbody tr").length'),0);
  console.log('PASS: concurrent settings persistence, invalid IPC values, mandatory confirmation, dot-prefixed names, out-of-root and changed-junction rejection, overlapping recycle selections, zero totals, query invalidation. All file actions used disposable files and mocked Windows integrations.');
  app.quit();
}
main().catch(error=>{console.error(error);app.exit(1);});
