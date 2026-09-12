const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');

async function run() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'blockit-ui-'));
  app.setPath('userData', path.join(base, 'profile'));
  const fixture = path.join(base, 'Library');
  await fs.mkdir(path.join(fixture, 'Pictures'), { recursive: true });
  await fs.mkdir(path.join(fixture, 'Documents'));
  await fs.writeFile(path.join(fixture, 'Pictures', 'holiday.jpg'), Buffer.alloc(1048576));
  await fs.writeFile(path.join(fixture, 'Documents', 'project-notes.txt'), 'Test document');
  require('../dist-electron/main.js');
  await app.whenReady();
  let win;
  for (let i = 0; i < 100; i++) {
    win = BrowserWindow.getAllWindows()[0];
    if (win && !win.webContents.isLoading() && await win.webContents.executeJavaScript('!!document.querySelector(".welcome")').catch(() => false)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(win, 'Window exists');
  const js = async code => {
    try { return await win.webContents.executeJavaScript(code); }
    catch (error) { console.error('Failed UI step:', code); throw error; }
  };
  assert(await js('!!window.blockit && typeof window.require === "undefined"'), 'Sandboxed preload works');
  const {spawn}=require('node:child_process');
  const second=spawn(process.execPath,[path.join(__dirname,'second-instance.cjs'),path.join(base,'profile')],{windowsHide:true,stdio:'ignore'});
  await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>{second.kill();reject(new Error('Duplicate instance did not exit'));},5000);
    second.on('error',reject);
    second.on('exit',code=>{clearTimeout(timeout);code===0?resolve():reject(new Error('Duplicate exit '+code));});
  });
  // Select the fixture through the native picker boundary, then exercise the real UI scan handler.
  const { dialog } = require('electron');
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fixture] });
  await js(`Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Choose folder')).click()`);
  for (let i = 0; i < 100; i++) {
    if (await js('!!document.querySelector(".completion-note")')) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(await js('document.body.textContent.includes("2 files")'), 'Actual scan completed');
  await js(`Array.from(document.querySelectorAll('.nav-item')).find(b => b.textContent.includes('Browse')).click()`);
  await new Promise(resolve => setTimeout(resolve, 400));
  assert(await js('document.querySelectorAll("tbody tr").length === 2'), 'Browse shows both folders');
  await js(`Array.from(document.querySelectorAll('tbody tr')).find(r => r.textContent.includes('Pictures')).dispatchEvent(new MouseEvent('dblclick', {bubbles:true}))`);
  await new Promise(resolve => setTimeout(resolve, 400));
  assert(await js('document.querySelector("tbody").textContent.includes("holiday.jpg")'), 'Folder drill-down works');
  await js(`document.querySelector('tbody tr').click()`);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert(await js('document.querySelector(".inspector").textContent.includes("holiday.jpg")'), 'Details panel works');
  await js(`document.querySelector('[aria-label="Close details"]').click(); const input=document.querySelector('.search-box input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'project-notes'); input.dispatchEvent(new Event('input',{bubbles:true}));`);
  await new Promise(resolve => setTimeout(resolve, 700));
  assert(await js('document.querySelector("tbody").textContent.includes("project-notes.txt")'), 'Search crosses folder boundaries');
  await js(`{ const input=document.querySelector('.search-box input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'Documents'); input.dispatchEvent(new Event('input',{bubbles:true})); }`);
  await new Promise(resolve=>setTimeout(resolve,700));
  await js(`Array.from(document.querySelectorAll('tbody tr')).find(row=>row.children[1].textContent==='folder'&&row.textContent.includes('Documents')).dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`);
  await new Promise(resolve=>setTimeout(resolve,400));
  assert.deepEqual(await js('Array.from(document.querySelectorAll(".breadcrumbs button")).map(button=>button.textContent)'),['Library','Documents'],'Search navigation rebuilds the real ancestor chain');
  await js(`{ const input=document.querySelector('.search-box input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'project-notes'); input.dispatchEvent(new Event('input',{bubbles:true})); }`);
  await new Promise(resolve=>setTimeout(resolve,700));
  // Mock only Windows trash transport; exercise the real confirmation and index reconciliation.
  const { shell } = require('electron');
  let trashCalls = 0;
  shell.trashItem = async itemPath => {
    assert.equal(itemPath, path.join(fixture, 'Documents', 'project-notes.txt'));
    trashCalls++;
    await fs.rename(itemPath, path.join(base, 'recycled-test-document.txt'));
  };
  dialog.showMessageBox = async () => ({ response: 0 });
  await js('document.querySelector("tbody tr").click()');
  await new Promise(resolve => setTimeout(resolve, 100));
  await js('document.querySelector(".inspector .danger-button").click()');
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(trashCalls, 0, 'Cancelling confirmation does not recycle');
  dialog.showMessageBox = async () => ({ response: 1 });
  await js('document.querySelector("tbody tr").click()');
  await new Promise(resolve => setTimeout(resolve, 100));
  await js('document.querySelector(".inspector .danger-button").click()');
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(trashCalls, 1, 'Confirmed action uses trash transport once');
  assert.equal(await js('document.querySelectorAll("tbody tr").length'), 0, 'Recycled item removed from index');
  await js(`(() => { const input=document.querySelector('.search-box input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,''); input.dispatchEvent(new Event('input',{bubbles:true})); Array.from(document.querySelectorAll('.nav-item')).find(b => b.textContent.includes('Overview')).click(); })()`);
  await new Promise(resolve => setTimeout(resolve, 500));
  assert(await js('document.querySelector(".metric-card").textContent.includes("1 files")'), 'Aggregate file count reconciled');
  await fs.mkdir(path.join(__dirname, '..', 'docs'), { recursive: true });
  await fs.writeFile(path.join(__dirname, '..', 'docs', 'ui-smoke.png'), (await win.webContents.capturePage()).toPNG());
  console.log('PASS: Electron preload isolation, scan, browse, drill-down, details, global search, confirmation cancellation, mocked trash, index reconciliation. Screenshot: docs/ui-smoke.png');
  app.quit();
}
run().catch(error => { console.error(error); app.exit(1); });
