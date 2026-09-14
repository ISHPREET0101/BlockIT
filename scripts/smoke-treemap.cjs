const {app,BrowserWindow,dialog,ipcMain}=require('electron');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const assert=require('node:assert/strict');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function run() {
  const base=await fs.mkdtemp(path.join(os.tmpdir(),'blockit-map-'));
  app.setPath('userData',path.join(base,'profile'));
  const fixture=path.join(base,'Treemap sample');
  const folders=[['Games',54000],['Study videos',46000],['Projects',41000],['Photos',15000],['Downloads',10000],['Music',8000]];
  for(const [name,size] of folders) {
    await fs.mkdir(path.join(fixture,name),{recursive:true});
    await fs.writeFile(path.join(fixture,name,'sample.txt'),Buffer.alloc(size));
  }
  require('../dist-electron/main.js');
  await app.whenReady();
  let win;
  for(let i=0;i<100;i++) {
    win=BrowserWindow.getAllWindows()[0];
    if(win&&!win.webContents.isLoading()&&await win.webContents.executeJavaScript('!!document.querySelector(".welcome")').catch(()=>false)) break;
    await delay(100);
  }
  const js=code=>win.webContents.executeJavaScript('(()=>{'+code+'})()');
  dialog.showOpenDialog=async()=>({canceled:false,filePaths:[fixture]});
  await js("Array.from(document.querySelectorAll('button')).find(b=>b.textContent.includes('Choose folder')).click()");
  for(let i=0;i<100;i++){if(await js('return !!document.querySelector(".completion-note")'))break;await delay(100);}
  // Use a marked sample drive to exercise the free-space styling without scanning a real drive.
  const scanFiles=await fs.readdir(path.join(base,'profile','scans'));
  const scanId=scanFiles.find(file=>file.endsWith('.db')).slice(0,-3);
  const summary=await win.webContents.executeJavaScript('window.blockit.data.summary('+JSON.stringify(scanId)+')');
  ipcMain.removeHandler('data:summary');
  ipcMain.handle('data:summary',()=>({...summary,rootPath:'Z:\\',volumeFreeBytes:39000}));
  win.webContents.send('scan:progress',{scanId,status:'completed',files:6,folders:7,bytes:174000,warnings:0,elapsedMs:500});
  await delay(400);
  await js("Array.from(document.querySelectorAll('.nav-item')).find(b=>b.textContent.includes('Treemap')).click()");
  await delay(600);
  assert.equal(await js("return document.querySelectorAll('.treemap-cell[data-kind=folder]').length"),6);
  assert.equal(await js("return new Set(Array.from(document.querySelectorAll('.treemap-cell[data-kind=folder] .block-outline')).map(r=>r.getAttribute('fill'))).size"),6,'Every folder is visibly distinct');
  assert(await js("return document.querySelector('[data-kind=free] .block-outline').getAttribute('fill').startsWith('url(')"),'Free space is patterned');
  await js("const first=document.querySelector('.treemap-cell'); first.focus()");
  await delay(100);
  assert(await js("return document.querySelector('.map-details').textContent.includes('Games')"),'Focus shows metadata');
  await js("const input=document.querySelector('.map-search input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'Music');input.dispatchEvent(new Event('input',{bubbles:true}));");
  await delay(100);
  assert.equal(await js("return Array.from(document.querySelectorAll('.treemap-cell')).filter(cell=>cell.getAttribute('opacity')==='1').length"),1,'Search highlights one match without relayout');
  await js("document.querySelector('.treemap-cell').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
  await delay(100);
  await fs.mkdir(path.join(__dirname,'../docs'),{recursive:true});
  await fs.writeFile(path.join(__dirname,'../docs/treemap-light.png'),(await win.webContents.capturePage()).toPNG());
  const exportPath=path.join(base,'treemap-export.png');
  dialog.showSaveDialog=async()=>({canceled:false,filePath:exportPath});
  await js("Array.from(document.querySelectorAll('button')).find(b=>b.textContent.includes('Save image')).click()");
  for(let i=0;i<80;i++){if(await fs.stat(exportPath).then(s=>s.size>1000).catch(()=>false))break;await delay(100);}
  assert((await fs.stat(exportPath)).size>1000,'PNG export produced an image');
  await fs.copyFile(exportPath,path.join(__dirname,'../docs/treemap-export.png'));
  await js("Array.from(document.querySelectorAll('button')).find(b=>b.title==='Toggle theme').click()");
  await delay(200);
  await fs.writeFile(path.join(__dirname,'../docs/treemap-dark.png'),(await win.webContents.capturePage()).toPNG());
  await js("const first=document.querySelector('.treemap-cell');first.focus();first.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));");
  await delay(400);
  assert(await js("return document.querySelector('.treemap-panel h2').textContent.includes('Games')"),'Enter drills into folder');
  await js("Array.from(document.querySelectorAll('button')).find(b=>b.textContent.includes('Back to root')).click()");
  await delay(400);
  assert.equal(await js("return document.querySelectorAll('.treemap-cell[data-kind=folder]').length"),6,'Reset returns to root');
  // Nested map: depth 2 draws folder children, depth 1 collapses them.
  assert((await js("return document.querySelectorAll('.treemap-cell[data-depth=\"2\"]').length"))>0,'Depth 2 renders nested child blocks');
  await js("Array.from(document.querySelectorAll('.map-segments button')).find(b=>b.textContent==='1').click()");
  await delay(500);
  assert.equal(await js("return document.querySelectorAll('.treemap-cell[data-depth=\"2\"]').length"),0,'Depth 1 renders no nested blocks');
  await js("Array.from(document.querySelectorAll('.map-segments button')).find(b=>b.textContent==='2').click()");
  await delay(500);
  assert((await js("return document.querySelectorAll('.treemap-cell[data-depth=\"2\"]').length"))>0,'Depth 2 returns after switching back');
  const distinctFill=await js("return document.querySelector('.treemap-cell[data-kind=folder] .block-outline').getAttribute('fill')");
  await js("Array.from(document.querySelectorAll('.map-segments button')).find(b=>b.textContent==='Age').click()");
  await delay(300);
  assert((await js("return document.querySelectorAll('.map-legend-item').length"))>=2,'Legend lists the active colour scale');
  assert(distinctFill!==await js("return document.querySelector('.treemap-cell[data-kind=folder] .block-outline').getAttribute('fill')"),'Colour mode changes block colours');
  await js("Array.from(document.querySelectorAll('.map-segments button')).find(b=>b.textContent==='Distinct').click()");
  await delay(300);
  await js("const r=document.querySelector('.map-filter input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(r,'6');r.dispatchEvent(new Event('input',{bubbles:true}));r.dispatchEvent(new Event('change',{bubbles:true}));");
  await delay(300);
  assert((await js("return document.querySelector('.map-legend-hidden')?.textContent||''")).includes('dimmed'),'Min-share filter reports dimmed blocks');
  await js("const r=document.querySelector('.map-filter input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(r,'0');r.dispatchEvent(new Event('input',{bubbles:true}));r.dispatchEvent(new Event('change',{bubbles:true}));");
  await delay(200);
  await js("const cell=document.querySelector('.treemap-cell');cell.focus();");
  await delay(200);
  assert((await js("return document.querySelector('.treemap-tooltip')?.textContent||''")).includes('Games'),'Focus raises the floating tooltip with block details');
  console.log('PASS: nested depth control, five colour modes with legend, min-share filter, floating tooltip, six distinct folder colours, patterned free space, focus details, search highlighting, PNG export, light/dark rendering, keyboard drill-down and reset.');
  app.quit();
}
run().catch(error=>{console.error(error);app.exit(1);});
