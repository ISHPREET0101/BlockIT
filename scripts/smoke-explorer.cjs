const { app, BrowserWindow, clipboard, dialog } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
async function run() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'blockit-explorer-'));
  app.setPath('userData', path.join(base, 'profile'));
  const root = path.join(base, 'Library');
  await fs.mkdir(path.join(root, 'Documents'), { recursive: true });
  await fs.mkdir(path.join(root, 'Pictures'));
  await fs.writeFile(path.join(root, 'Documents', 'project-notes.txt'), 'Explorer fixture');
  await Promise.all(Array.from({ length: 115 }, (_, i) => fs.writeFile(path.join(root, 'Pictures', 'photo-' + i + '.jpg'), 'fixture')));
  require('../dist-electron/main.js');
  await app.whenReady();
  let win;
  const pause = () => new Promise(r => setTimeout(r, 100));
  async function wait(code) {
    for (let i = 0; i < 200; i++) {
      if (await win.webContents.executeJavaScript(code).catch(() => false)) return;
      await pause();
    }
    throw new Error('Timed out: ' + code);
  }
  for (let i = 0; i < 100; i++) { win = BrowserWindow.getAllWindows()[0]; if (win) break; await pause(); }
  const js = code => win.webContents.executeJavaScript(code);
  await wait('!!document.querySelector(".welcome")');
  await js('document.querySelector("[aria-label=\\"File Explorer\\"]").click()');
  await wait('!!document.querySelector(".file-explorer")');
  assert(await js('!document.querySelector(".nav-item[aria-label=\\"File Explorer\\"]").disabled'), 'Available without scan');
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] });
  await js('Array.from(document.querySelectorAll(".file-explorer button")).find(b=>b.textContent.includes("Open folder")).click()');
  await wait('document.querySelectorAll(".explorer-table tbody tr").length === 2');
  await js('Array.from(document.querySelectorAll(".explorer-table tr")).find(r=>r.textContent.includes("Pictures") && r.querySelector("td")).dispatchEvent(new MouseEvent("dblclick",{bubbles:true}))');
  await wait('document.querySelectorAll(".explorer-table tbody tr").length === 100');
  await js('Array.from(document.querySelectorAll(".explorer-pagination button")).find(b=>b.textContent==="Next").click()');
  await wait('document.querySelectorAll(".explorer-table tbody tr").length === 15');
  await js('document.querySelector("[aria-label=\\"Back\\"]").click()');
  await wait('document.querySelectorAll(".explorer-table tbody tr").length === 2');
  const input = (selector, value) => js('(()=>{const el=document.querySelector(' + JSON.stringify(selector) + ');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(el,' + JSON.stringify(value) + ');el.dispatchEvent(new Event("input",{bubbles:true}));})()');
  await input('.explorer-search input', 'PROJECT-NOTES');
  await wait('document.querySelector(".explorer-status").textContent.includes("Index ready") && document.querySelector(".explorer-table").textContent.includes("project-notes.txt")');
  const started = Date.now();
  const cached = await js('window.blockit.explorer.read(' + JSON.stringify(root) + ',"photo-",1,false)');
  assert.equal(cached.total, 115);
  assert.equal(cached.indexing, false);
  console.log('Cached search, 118 entries: ' + (Date.now() - started) + ' ms (fixture only)');
  await js('document.querySelector(".explorer-table tbody tr").click()');
  await js('Array.from(document.querySelectorAll(".explorer-footer button")).find(b=>b.textContent.includes("Copy path")).click()');
  await wait('document.querySelector(".file-explorer").textContent.includes("Path copied.")');
  assert.equal(clipboard.readText(), path.join(root, 'Documents', 'project-notes.txt'));
  await fs.writeFile(path.join(root, 'project-notes-new.txt'), 'New');
  assert.equal((await js('window.blockit.explorer.read(' + JSON.stringify(root) + ',"project-notes",1,false)')).total, 1, 'Cache retained until refresh');
  await js('document.querySelector("[aria-label=\\"Refresh folder and search index\\"]").click()');
  await wait('document.querySelector(".explorer-status").textContent.includes("2 matches") && document.querySelector(".explorer-status").textContent.includes("Index ready")');
  assert(await js('window.blockit.explorer.read("relative","",1,false).then(()=>false,()=>true)'), 'Relative paths rejected');
  assert(await js('window.blockit.explorer.read(' + JSON.stringify(root) + ',"",0,false).then(()=>false,()=>true)'), 'Bad pages rejected');
  await input('.explorer-search input', 'no-such-file-unique');
  await wait('document.querySelector(".explorer-table").textContent.includes("No matching filenames.")');
  await input('.explorer-location input', path.join(root, 'missing'));
  await js('document.querySelector(".explorer-location form").requestSubmit()');
  await wait('!!document.querySelector(".file-explorer [role=alert]")');
  await js('document.querySelector("[aria-label=\\"Back\\"]").click()');
  await wait('document.querySelector(".explorer-status").textContent.includes("3 items")');
  await input('.explorer-search input', 'project');
  await wait('document.querySelector(".explorer-status").textContent.includes("Index ready")');
  await fs.writeFile(path.join(__dirname, '..', 'docs', 'file-explorer-preview.png'), (await win.webContents.capturePage()).toPNG());
  await js('window.blockit.settings.update({theme:"light"}).then(()=>{document.documentElement.dataset.theme="light"})');
  await fs.writeFile(path.join(__dirname, '..', 'docs', 'file-explorer-light.png'), (await win.webContents.capturePage()).toPNG());
  console.log('PASS: no-scan entry, live folders, pagination, back, recursive case-insensitive search, cache, refresh, copy, validation, empty results, missing folder, theme captures.');
  app.quit();
}
run().catch(error => { console.error(error); app.exit(1); });
