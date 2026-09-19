const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
app.setPath('userData', path.join(__dirname, '..', 'build', 'preview-explorer-restored-profile'));
require('../dist-electron/main.js');
(async () => {
  await app.whenReady();
  let win;
  for (let i=0;i<150;i++) {
    win=BrowserWindow.getAllWindows()[0];
    if (win && await win.webContents.executeJavaScript('!!document.querySelector(".welcome")').catch(()=>false)) break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  if (!win) throw new Error('Preview window did not open.');
  await win.webContents.executeJavaScript('document.querySelector(".nav-item[aria-label=\\"File Explorer\\"]").click()');
  await new Promise(resolve=>setTimeout(resolve,200));
  await win.webContents.executeJavaScript('(()=>{const el=document.querySelector(".explorer-location input");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(el,'+JSON.stringify(path.resolve(__dirname,'..'))+');el.dispatchEvent(new Event("input",{bubbles:true}));})()');
  await new Promise(resolve=>setTimeout(resolve,100));
  await win.webContents.executeJavaScript('document.querySelector(".explorer-location form").requestSubmit()');
  for(let i=0;i<150;i++) {
    if (await win.webContents.executeJavaScript('!!document.querySelector(".explorer-table tbody tr")')) break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  await new Promise(resolve=>setTimeout(resolve,1500));
  await win.webContents.executeJavaScript('document.querySelector(".explorer-table tbody tr")?.click()');
  await new Promise(resolve=>setTimeout(resolve,200));
  await fs.writeFile(path.join(__dirname,'..','docs','file-explorer-preview.png'),(await win.webContents.capturePage()).toPNG());
  win.show(); win.focus();
})().catch(error=>{ console.error(error); app.exit(1); });
