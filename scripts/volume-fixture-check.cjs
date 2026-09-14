// Crafts synthetic NTFS volume images and drives the helper's volume mode
// through them (BLOCKIT_VOLUME_IMAGE seam), asserting exact tree, sizes, flags,
// exclusions, extension-record skipping, sparse-gap record numbering, protocol
// shapes, and multi-batch ("next") continuation of a volume walk.
// Metadata only; every image is a regular temp file. No admin rights needed.
const {spawn} = require('node:child_process');
const readline = require('node:readline');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLUSTER = 4096, RECORD = 1024, SECTOR = 512;
const TIME = 134010000000000000n;   // FILETIME; ms = 1756526400000

function attrHeader(type, length, nonResident, nameOff) {
  const b = Buffer.alloc(16);
  b.writeUInt32LE(type, 0); b.writeUInt32LE(length, 4);
  b[8] = nonResident; b[9] = 0; b.writeUInt16LE(nameOff, 10);
  return b;
}
function si(modified, flags) {
  const content = Buffer.alloc(0x30);
  content.writeBigInt64LE(TIME, 0); content.writeBigInt64LE(TIME, 8);
  content.writeBigInt64LE(TIME, 0x10); content.writeBigInt64LE(TIME, 0x18);
  content.writeUInt32LE(flags, 0x20);
  const b = Buffer.concat([attrHeader(0x10, 0x18 + content.length, 0, 0x18), Buffer.alloc(8), content]);
  b.writeUInt32LE(content.length, 0x10); b.writeUInt16LE(0x18, 0x14);
  return b;
}
function fileName(parent, name, namespace, realSize) {
  const nameBuf = Buffer.from(name, 'utf16le');
  const content = Buffer.alloc(0x42 + nameBuf.length);
  content.writeBigInt64LE(BigInt(parent), 0);
  content.writeBigInt64LE(TIME, 0x08);
  content.writeBigInt64LE(BigInt(realSize), 0x28); content.writeBigInt64LE(BigInt(realSize), 0x30);
  content[0x40] = name.length; content[0x41] = namespace;
  nameBuf.copy(content, 0x42);
  const padded = (content.length + 7) & ~7;
  const body = Buffer.concat([content, Buffer.alloc(padded - content.length)]);
  const b = Buffer.concat([attrHeader(0x30, 0x18 + body.length, 0, 0x18), Buffer.alloc(8), body]);
  b.writeUInt32LE(content.length, 0x10); b.writeUInt16LE(0x18, 0x14);
  return b;
}
function dataNonResident(realSize, runBytes) {
  const b = Buffer.alloc(0x48);
  b.writeUInt32LE(0x80, 0); b.writeUInt32LE(0x48, 4);
  b[8] = 1; b.writeUInt16LE(0x40, 10);
  b.writeBigInt64LE(0n, 0x10); b.writeBigInt64LE(0n, 0x18);
  b.writeUInt16LE(0x40, 0x20);
  b.writeBigInt64LE(BigInt(realSize), 0x28); b.writeBigInt64LE(BigInt(realSize), 0x30); b.writeBigInt64LE(BigInt(realSize), 0x38);
  runBytes.copy(b, 0x40);
  return b;
}
function dataResident(bytes) {
  const b = Buffer.concat([attrHeader(0x80, 0x18 + bytes.length, 0, 0x18), Buffer.alloc(8), bytes]);
  b.writeUInt32LE(bytes.length, 0x10); b.writeUInt16LE(0x18, 0x14);
  return b;
}
function attributeList(entries) {
  const parts = [];
  for (const ref of entries) {
    const e = Buffer.alloc(0x20);
    e.writeUInt32LE(0x30, 0); e.writeUInt16LE(0x20, 4); e[8] = 0; e[9] = 0x1e;
    e.writeBigInt64LE(0n, 8); e.writeBigInt64LE(BigInt(ref), 16);
    parts.push(e);
  }
  const content = Buffer.concat(parts);
  const b = Buffer.concat([attrHeader(0x20, 0x18 + content.length, 0, 0x18), Buffer.alloc(8), content]);
  b.writeUInt32LE(content.length, 0x10); b.writeUInt16LE(0x18, 0x14);
  return b;
}
function record(recNum, flags, attributes) {
  const b = Buffer.alloc(RECORD);
  b.write('FILE', 0, 'ascii');
  b.writeUInt16LE(0x30, 4); b.writeUInt16LE(3, 6);
  b.writeUInt16LE(1, 0x10); b.writeUInt16LE(1, 0x12);
  b.writeUInt16LE(0x38, 0x14); b.writeUInt16LE(flags, 0x16);
  b.writeUInt16LE(1, 0x30);            // USA sequence number
  b.writeUInt16LE(0xaaaa, 0x32); b.writeUInt16LE(0xbbbb, 0x34);   // fixups
  b.writeUInt16LE(1, SECTOR - 2); b.writeUInt16LE(1, 2 * SECTOR - 2);  // clobbered tails
  let pos = 0x38;
  for (const attr of attributes) { attr.copy(b, pos); pos += attr.length; }
  return b;
}

function bootSector(mftLcn) {
  const boot = Buffer.alloc(512);
  boot.write('NTFS    ', 3, 'ascii');
  boot.writeUInt16LE(SECTOR, 0x0b); boot[0x0d] = CLUSTER / SECTOR;
  boot.writeBigInt64LE(BigInt(mftLcn), 0x30);
  boot[0x40] = 0xf6;                          // -10 -> 1024-byte records
  return boot;
}

// Small structural image: sparse $MFT run list, DOS alias, deleted record,
// extension record, reparse dir, resident/non-resident/sparse data, exclusions.
function buildSmallImage(imagePath) {
  const image = Buffer.alloc(200 * CLUSTER + 16 * CLUSTER);
  bootSector(100).copy(image, 0);

  // $MFT: run1 clusters 100-109 (records 0-39), sparse gap (40-47), run2
  // clusters 200-213 (records 48-103). recordCount = 106496/1024 = 104.
  // Datarun headers: low nibble sizes the length field, high nibble the offset
  // field - so the sparse middle entry is 0x01, not 0x10.
  const runs = Buffer.from([0x11, 0x0a, 100, 0x01, 0x02, 0x11, 0x0e, 100, 0x00]);
  const records = new Map();
  records.set(0, record(0, 1, [si(TIME, 0x20), fileName(5, '$MFT', 1, 106496), dataNonResident(106496, runs)]));
  records.set(5, record(5, 3, [si(TIME, 0x10), fileName(5, '.', 3, 0)]));
  records.set(24, record(24, 3, [si(TIME, 0x10), fileName(5, 'Users', 3, 0)]));
  records.set(25, record(25, 1, [si(TIME, 0x20), fileName(24, 'a.txt', 3, 100000000), dataNonResident(100000000, Buffer.from([0x01, 0x00]))]));
  records.set(26, record(26, 1, [si(TIME, 0x23), fileName(24, 'protected.log', 3, 2048), dataNonResident(2048, Buffer.from([0x01, 0x00]))]));
  records.set(27, record(27, 3, [si(TIME, 0x400 | 0x10), fileName(24, 'Junction', 3, 0)]));
  records.set(28, record(28, 1, [si(TIME, 0x20), fileName(27, 'inside.txt', 3, 50), dataNonResident(50, Buffer.from([0x01, 0x00]))]));
  records.set(29, record(29, 1, [si(TIME, 0x20), fileName(24, 'ünïcode_名前.dat', 1, 4096), dataNonResident(4096, Buffer.from([0x01, 0x00]))]));
  records.set(30, record(30, 1, [si(TIME, 0x20), fileName(24, 'REALFI~1.TXT', 2, 512), fileName(24, 'real file.txt', 3, 512), dataNonResident(512, Buffer.from([0x01, 0x00]))]));
  records.set(31, record(31, 1, [si(TIME, 0x20), fileName(24, 'hl.txt', 3, 4096), dataNonResident(4096, Buffer.from([0x01, 0x00])), attributeList([48])]));
  records.set(33, record(33, 0, [si(TIME, 0x20), fileName(24, 'gone.tmp', 3, 8192)]));           // deleted: skipped
  records.set(34, record(34, 1, [si(TIME, 0x20), fileName(24, 'tiny.dat', 3, 7), dataResident(Buffer.from('NTFS!!~'))]));
  records.set(38, record(38, 3, [si(TIME, 0x10), fileName(24, 'Deep', 3, 0)]));
  records.set(39, record(39, 3, [si(TIME, 0x10), fileName(38, 'Nest', 3, 0)]));
  records.set(48, record(48, 1, [si(TIME, 0x20), fileName(24, 'second-link.txt', 3, 4096)]));   // extension record: must never surface
  records.set(52, record(52, 3, [si(TIME, 0x10), fileName(24, 'Vault', 3, 0)]));
  records.set(53, record(53, 1, [si(TIME, 0x20), fileName(52, 'secret.txt', 3, 1234), dataNonResident(1234, Buffer.from([0x01, 0x00]))]));
  records.set(56, record(56, 1, [si(TIME, 0x20), fileName(24, 'spillover.bin', 3, 7000000), dataNonResident(7000000, Buffer.from([0x22, 0x81, 0x07, 0x01, 0x00]))]));  // 1921 clusters at LCN 1: across the sparse gap
  records.set(57, record(57, 3, [si(TIME, 0x10), fileName(5, 'Late', 3, 0)]));
  records.set(58, record(58, 1, [si(TIME, 0x20), fileName(57, 'x.bin', 3, 10), dataNonResident(10, Buffer.from([0x01, 0x00]))]));

  for (const [recNum, rec] of records) {
    const run = recNum < 40 ? 0 : 1;
    const within = run === 0 ? recNum * RECORD : (recNum - 48) * RECORD;
    const offset = run === 0 ? 100 * CLUSTER : 200 * CLUSTER;
    if (recNum >= 40 && recNum < 48) throw new Error('test bug: record in the sparse gap');
    rec.copy(image, offset + within);
  }
  fs.writeFileSync(imagePath, image);
  return { records };
}

// Bulk image: one contiguous 3000-cluster $MFT (12000 records) holding BULK_COUNT
// tiny resident files under \Users. Forces the volume walk past the 4096-entry
// per-batch limit, so the "next" continuation path is exercised end to end.
function buildBulkImage(imagePath, bulkCount) {
  const MFT_LCN = 100, RUN_CLUSTERS = 3000, RECORDS = RUN_CLUSTERS * CLUSTER / RECORD; // 12000
  const image = Buffer.alloc((MFT_LCN + RUN_CLUSTERS) * CLUSTER);
  bootSector(MFT_LCN).copy(image, 0);

  const mftSize = RUN_CLUSTERS * CLUSTER;
  // header 0x22: 2-byte length field (low nibble) + 2-byte offset field (high nibble)
  const runs = Buffer.alloc(5);
  runs[0] = 0x22; runs.writeUInt16LE(RUN_CLUSTERS, 1); runs.writeUInt16LE(MFT_LCN, 3);

  const records = new Map();
  records.set(0, record(0, 1, [si(TIME, 0x20), fileName(5, '$MFT', 1, mftSize), dataNonResident(mftSize, runs)]));
  records.set(5, record(5, 3, [si(TIME, 0x10), fileName(5, '.', 3, 0)]));
  records.set(24, record(24, 3, [si(TIME, 0x10), fileName(5, 'Users', 3, 0)]));
  const resident = dataResident(Buffer.from('NTFS!!~'));
  const first = 1000;
  if (first + bulkCount > RECORDS) throw new Error('test bug: bulk records exceed the $MFT');
  for (let i = 0; i < bulkCount; i++) {
    const recNum = first + i;
    const name = 'bulk-' + String(i).padStart(5, '0') + '.dat';
    records.set(recNum, record(recNum, 1, [si(TIME, 0x20), fileName(24, name, 3, 7), resident]));
  }
  for (const [recNum, rec] of records) {
    rec.copy(image, MFT_LCN * CLUSTER + recNum * RECORD);
  }
  fs.writeFileSync(imagePath, image);
  return { records: records.size, expectedFiles: bulkCount, expectedBytes: bulkCount * 7, mftRecords: RECORDS };
}

function openHelper(helper, imagePath) {
  const child = spawn(helper, [String(process.pid)], { windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, BLOCKIT_VOLUME_IMAGE: imagePath } });
  const lines = readline.createInterface({ input: child.stdout });
  const request = payload => new Promise((resolve, reject) => {
    lines.once('line', line => { try { resolve(JSON.parse(line)); } catch (error) { reject(error); } });
    child.stdin.write(JSON.stringify(payload) + '\n');
  });
  const ready = new Promise(resolve => lines.once('line', resolve));
  return { child, request, ready };
}

// Drives a full volume scan through the wire protocol: one "volume" request,
// then repeated "next" until the helper reports done. Returns every batch.
function driveImage(helper, imagePath, scanPath, exclude) {
  return new Promise((resolve, reject) => {
    const { child, request, ready } = openHelper(helper, imagePath);
    (async () => {
      await ready;
      const batches = [];
      let batch = await request({ op: 'volume', path: scanPath, x: exclude || [] });
      for (;;) {
        batches.push(batch);
        if (batch.error || batch.denied || batch.unsupported || batch.done) break;
        batch = await request({ op: 'next' });
      }
      child.kill();
      resolve(batches);
    })().catch(reject);
  });
}

function collect(batches) {
  const files = [], links = [], dirs = [];
  let bytes = 0;
  for (const batch of batches) {
    if (batch.error) console.error('helper error: ' + batch.error + ' denied=' + batch.denied + ' unsupported=' + batch.unsupported);
    for (const e of batch.entries || []) {
      if (e.k === 'file') { files.push([e.n, e.s, e.a, e.m]); bytes += e.s; }
      else links.push([e.n, e.s, e.a]);
    }
    for (const d of batch.dirs || []) dirs.push([d.i, d.p, d.n, d.m]);
  }
  return { files, links, dirs, bytes, batches: batches.length, done: batches.length > 0 && batches[batches.length - 1].done, self: batches[0] && batches[0].self };
}

function assert(condition, message) {
  if (!condition) { console.error('FAIL ' + message); process.exitCode = 1; }
  else console.log('ok   ' + message);
}

module.exports = { buildBulkImage };

if (require.main === module) (async () => {
  const helper = path.resolve(__dirname, '../build/native/blockit-enumerator.exe');
  if (!fs.existsSync(helper)) { console.error('helper not built: ' + helper + ' (run npm run build:main first)'); process.exit(1); }
  const base = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'blockit-vol-'));
  const imagePath = path.join(base, 'volume.img');
  buildSmallImage(imagePath);

  // 1. Full scan from the root.
  const all = collect(await driveImage(helper, imagePath, 'Q:\\', []));
  assert(all.done, 'root scan completes');
  assert(all.self && all.self.directory === true && all.self.path === 'Q:\\', 'self metadata on open');
  const fileNames = all.files.map(f => f[0]).sort();
  const expectedNames = ['a.txt', 'hl.txt', 'protected.log', 'real file.txt', 'secret.txt', 'spillover.bin', 'tiny.dat', 'x.bin', 'ünïcode_名前.dat'].sort();
  assert(JSON.stringify(fileNames) === JSON.stringify(expectedNames),
    'files exactly as crafted, DOS alias/deleted/extension/link-child excluded: ' + JSON.stringify(fileNames));
  const sizeOf = Object.fromEntries(all.files.map(f => [f[0], f[1]]));
  assert(sizeOf['a.txt'] === 100000000 && sizeOf['tiny.dat'] === 7 && sizeOf['spillover.bin'] === 7000000 && sizeOf['real file.txt'] === 512,
    'resident, non-resident and sparse-gap record sizes read correctly');
  assert(all.links.length === 1 && all.links[0][0] === 'Junction' && all.links[0][1] === 0 && all.links[0][2] === 'Reparse point',
    'reparse dir reported as link with zero size');
  const protectedFile = all.files.find(f => f[0] === 'protected.log');
  assert(protectedFile[2] === 'Read-only, Hidden, ', 'attribute string matches walk-engine format: "' + protectedFile[2] + '"');
  assert(protectedFile[3] === 1756526400000, 'mtime converted from FILETIME');
  assert(all.dirs.length === 5 && all.dirs.map(d => d[2]).sort().join() === 'Deep,Late,Nest,Users,Vault', 'dirs announced once each: ' + all.dirs.map(d => d[2]));
  assert(all.dirs.every(d => d[1] >= 0), 'dir parents reference valid walk indices');

  // 2. Excluded subtree never announced.
  const excluded = collect(await driveImage(helper, imagePath, 'Q:\\', ['q:\\users\\vault']));
  const expectedExcluded = fileNames.filter(n => n !== 'secret.txt');
  assert(JSON.stringify(excluded.files.map(f => f[0]).sort()) === JSON.stringify(expectedExcluded), 'exclusion drops the subtree');
  assert(!excluded.dirs.some(d => d[2] === 'Vault'), 'excluded dir not announced');

  // 3. Subtree root resolution.
  const deep = collect(await driveImage(helper, imagePath, 'Q:\\Users\\Deep', []));
  assert(deep.dirs.length === 1 && deep.dirs[0][2] === 'Nest' && deep.dirs[0][1] === 0, 'subtree root resolves through the path');
  assert(deep.files.length === 0 && deep.self.path === 'Q:\\Users\\Deep', 'subtree scan reports the requested root');

  // 4. Admin probe answers without state changes.
  {
    const { child, request, ready } = openHelper(helper, imagePath);
    await ready;
    const probe = await request({ op: 'admin', path: 'Q:\\' });
    assert(probe.admin === true && probe.ntfs === true, 'admin probe reads the image as NTFS');
    const after = await request({ op: 'admin', path: 'Q:\\' });
    assert(after.admin === true, 'probe is repeatable');
    child.kill();
  }

  // 5. REGRESSION: a volume walk larger than one 4096-entry batch must stream
  //    across several "next" continuations and finish with every entry. Before
  //    the dispatch fix, the first "next" was routed to the walk writer (empty
  //    state), so the scan stopped after batch 1 with a bogus done:true.
  {
    const bulkCount = 9000;                     // 4096 + 4096 + 808 => 3 batches
    const bulkPath = path.join(base, 'bulk.img');
    const bulk = buildBulkImage(bulkPath, bulkCount);
    const scan = collect(await driveImage(helper, bulkPath, 'Q:\\', []));
    assert(scan.batches >= 3, 'multi-batch volume walk issues at least three batches (got ' + scan.batches + ')');
    assert(scan.files.length === bulkCount,
      'multi-batch volume walk returns every entry across continuations (expected ' + bulkCount + ', got ' + scan.files.length + ')');
    assert(scan.bytes === bulk.expectedBytes, 'multi-batch volume walk byte total is exact (' + scan.bytes + ')');
    assert(scan.done, 'multi-batch volume walk reports done on the final batch');
    assert(scan.files.every(f => f[1] === 7), 'every bulk file keeps its crafted size');
    assert(scan.dirs.length === 1 && scan.dirs[0][2] === 'Users', 'bulk fixture announces exactly the Users directory');
  }

  // 6. Engine handoff on one helper process: after a volume walk completes, a
  //    directory walk must run on the walk engine rather than inherit the sticky
  //    volume routing. This is the edge case the sticky flag introduces.
  {
    const { child, request, ready } = openHelper(helper, imagePath);
    await ready;
    let batch = await request({ op: 'volume', path: 'Q:\\', x: [] });
    let guard = 0;
    while (!batch.done && !batch.error && guard++ < 50) batch = await request({ op: 'next' });
    assert(batch.done, 'engine handoff: volume walk completes first');
    const walk = await request({ op: 'open', path: base, x: [] });
    assert(Array.isArray(walk.entries), 'engine handoff: open after a volume walk returns a walk batch');
    assert(walk.entries.some(entry => entry.n.endsWith('.img')), 'engine handoff: the walk sees real directory entries');
    let more = walk;
    guard = 0;
    while (!more.done && !more.error && guard++ < 50) more = await request({ op: 'next' });
    assert(more.done, 'engine handoff: the walk continuation terminates');
    child.kill();
  }

  await fs.promises.rm(base, { recursive: true, force: true });
  console.log(process.exitCode ? 'VOLUME FIXTURE CHECK FAILED' : 'volume fixture check passed');
  setTimeout(() => process.exit(process.exitCode || 0), 200);
})().catch(error => { console.error(error); process.exit(1); });
