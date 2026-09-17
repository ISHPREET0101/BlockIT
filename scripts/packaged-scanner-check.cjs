// Exercise the shipped executable outside the checkout so missing dependencies
// cannot resolve from development node_modules. Uses a disposable scan/profile.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const net = require('node:net');
const assert = require('node:assert/strict');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'blockit-standalone-'));
  const isolated = path.join(base, 'app');
  const portable = process.env.BLOCKIT_TEST_PORTABLE;
  await fs.mkdir(isolated, { recursive: true });
  if (portable) await fs.copyFile(path.resolve(portable), path.join(isolated, 'BlockIT.exe'));
  else await fs.cp(path.resolve(__dirname, '../release/win-unpacked'), isolated, { recursive: true });
  const fixture = path.join(base, 'fixture');
  await fs.mkdir(path.join(fixture, 'nested'), { recursive: true });
  await fs.writeFile(path.join(fixture, 'sample.txt'), 'packaged');
  await fs.writeFile(path.join(fixture, 'nested', 'second.txt'), 'isolated');
  const env = { ...process.env };
  delete env.NODE_PATH;
  delete env.NODE_OPTIONS;
  delete env.ELECTRON_RUN_AS_NODE;
  const reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(path.join(isolated, 'BlockIT.exe'), [
    '--user-data-dir=' + path.join(base, 'profile'),
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + port,
    '--scan-root-base64=' + Buffer.from(fixture).toString('base64url'),
  ], { cwd: base, env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let logs = '', launchError;
  child.stderr.on('data', chunk => { logs += chunk; });
  child.on('error', error => { launchError = error; });
  let socket;
  try {
    let target;
    for (let i = 0; i < 300; i++) {
      if (launchError) throw launchError;
      if (child.exitCode !== null) throw new Error('Packaged app exited: ' + logs);
      const targets = await fetch('http://127.0.0.1:' + port + '/json/list').then(r => r.json()).catch(() => []);
      target = targets.find(item => item.type === 'page');
      if (target) break;
      await delay(100);
    }
    assert(target, 'Packaged renderer became available: ' + logs);
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    let sequence = 0;
    const pending = new Map();
    socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data);
      if (!pending.has(message.id)) return;
      const { resolve, reject, timer } = pending.get(message.id);
      pending.delete(message.id); clearTimeout(timer);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    });
    const evaluate = async expression => {
      const id = ++sequence;
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('Renderer evaluation timed out')); }, 15000);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
      });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    let completed = false;
    for (let i = 0; i < 200; i++) {
      const state = await evaluate('({text:document.body?.innerText||"",completed:!!document.querySelector(".completion-note")})');
      if (/Scan failed:|Cannot find module/.test(state.text)) throw new Error(state.text);
      if (state.completed) { assert(state.text.includes('2 files'), state.text); completed = true; break; }
      await delay(100);
    }
    assert(completed, 'Standalone UI scan completed');
    assert.equal(await evaluate('typeof window.blockit.scan.rescanElevated'), 'undefined', 'No elevation API is exposed');
    await evaluate('[...document.querySelectorAll("button")].find(b=>b.textContent.trim()==="Settings").click()');
    assert.equal(await evaluate('/administrator|elevation/i.test(document.body.innerText)'), false, 'Settings has no administrator control');
    await evaluate('document.querySelector(".settings-drawer .drawer-head button").click()');
    await evaluate('[...document.querySelectorAll(".nav-item")].find(b=>b.textContent.includes("Treemap")).click()');
    let blocks = 0;
    for (let i = 0; i < 100; i++) {
      blocks = await evaluate('document.querySelectorAll(".treemap-cell").length');
      if (blocks) break;
      await delay(100);
    }
    assert(blocks > 0, 'Standalone treemap rendered');
    assert(await evaluate('document.querySelector(".map-back")?.disabled'), 'Packaged back arrow is disabled at root');
    await evaluate('document.querySelector(".treemap-cell[data-kind=folder]").dispatchEvent(new MouseEvent("click",{bubbles:true}))');
    for(let i=0;i<100;i++) { if(await evaluate('document.querySelector(".treemap-panel h2")?.textContent==="nested"')) break; await delay(100); }
    assert.equal(await evaluate('document.querySelector(".treemap-panel h2").textContent'),'nested');
    await evaluate('document.querySelector(".map-back").click()');
    for(let i=0;i<100;i++) { if(await evaluate('document.querySelector(".map-back")?.disabled')) break; await delay(100); }
    assert(await evaluate('document.querySelector(".map-back").disabled'), 'Packaged back arrow returns to root');
    // Verify byte totals through the shipped query worker as well as the UI.
    await evaluate('window.__packagedProgress=null; window.blockit.scan.onProgress(p=>{window.__packagedProgress=p}); undefined');
    const { scanId } = await evaluate('window.blockit.scan.start(' + JSON.stringify(fixture) + ')');
    let summary;
    for (let i = 0; i < 100; i++) {
      const progress = await evaluate('window.__packagedProgress');
      if (progress?.scanId === scanId && progress.status === 'completed') {
        summary = await evaluate('window.blockit.data.summary(' + JSON.stringify(scanId) + ')');
        break;
      }
      if (progress?.status === 'failed') throw new Error('Standalone follow-up scan failed: ' + progress.message);
      await delay(100);
    }
    assert(summary, 'Standalone follow-up scan completed');
    assert.equal(summary.status, 'completed');
    assert.equal(summary.fileCount, 2);
    assert.equal(summary.totalBytes, 16);
    console.log('PASS: isolated shipped executable completed UI scan, rendered treemap and returned exact totals (2 files, 16 bytes).');
  } finally {
    socket?.close();
    // Portable launchers can detach; close only processes using this test profile.
    spawnSync('powershell.exe', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='BlockIT.exe'\" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:BLOCKIT_TEST_PROFILE) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"], { windowsHide: true, stdio: 'ignore', env: { ...process.env, BLOCKIT_TEST_PROFILE: path.join(base, 'profile') } });
    child.kill();
    await delay(1000);
    // Only this test-created temporary directory is eligible for cleanup.
    await fs.rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
