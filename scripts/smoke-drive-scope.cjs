const {app,BrowserWindow,ipcMain}=require('electron');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
(async()=>{
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'blockit-drive-scope-'));
 app.setPath('userData',path.join(base,'profile'));
 const roots=[path.join(base,'DriveC'),path.join(base,'DriveD')];
 for(let i=0;i<2;i++){await fs.mkdir(path.join(roots[i],'Nested'),{recursive:true});await fs.writeFile(path.join(roots[i],'Nested','report-'+i+'.txt'),'fixture');}
 require('../dist-electron/main.js');await app.whenReady();
 let win;const sleep=()=>new Promise(r=>setTimeout(r,100));
 for(let i=0;i<100;i++){win=BrowserWindow.getAllWindows()[0];if(win)break;await sleep();}
 const js=async code=>{try{return await win.webContents.executeJavaScript(code)}catch(e){console.error(code);throw e}};
 async function wait(code){for(let i=0;i<150;i++){if(await js(code).catch(()=>false))return;await sleep();}throw Error(code);}
 await wait('!!document.querySelector(".welcome")');
 ipcMain.removeHandler('drives:list');
 ipcMain.handle('drives:list',()=>roots.map((root,i)=>({root,label:['C: test drive','D: test drive'][i],type:'local',totalBytes:100,freeBytes:50})));
 await win.loadFile(path.resolve(__dirname,"../dist/index.html"));await wait('!!document.querySelector(".welcome")');
 await js('document.querySelector(".nav-item[aria-label=\\"File Explorer\\"]").click()');
 await wait('document.querySelectorAll(".explorer-scope option").length===3');
 async function select(root){await js('(()=>{const el=document.querySelector(".explorer-scope select");Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,"value").set.call(el,'+JSON.stringify(root)+');el.dispatchEvent(new Event("change",{bubbles:true}));})()');}
 await select(roots[0]);
 await js('(()=>{const el=document.querySelector(".explorer-search input");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(el,"report");el.dispatchEvent(new Event("input",{bubbles:true}));})()');
 await wait('document.querySelector(".explorer-table").textContent.includes("report-0.txt")');
 await select(roots[1]);
 await wait('document.querySelector(".explorer-table").textContent.includes("report-1.txt")');
 assert(!await js('document.querySelector(".explorer-table").textContent.includes("report-0.txt")'),'No results from previous drive');
 assert.equal(await js('document.querySelector(".explorer-search input").value'),'report','Drive switch preserves query');
 await js('document.querySelector(".explorer-table tbody tr").focus()');
 assert((await js('document.querySelector(".explorer-footer").textContent')).includes(path.join(roots[1],'Nested','report-1.txt')),'Full path readable');
 console.log('PASS: drive selector from This PC, scope isolation using two fixture roots, query preserved across drive changes, selected-file full path.');
 app.quit();
})().catch(e=>{console.error(e);app.exit(1)});
