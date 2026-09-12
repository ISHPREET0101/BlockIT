// Fault injection only for the generated regression fixture inside workerData.root.
const fs=require('node:fs/promises');
const path=require('node:path');
const {workerData,parentPort}=require('node:worker_threads');
const original=fs.lstat;
let pending=0, maximum=0;
fs.lstat=async function(item,...args) {
  const relative=path.relative(workerData.root,String(item));
  if(!relative.startsWith('..')&&!path.isAbsolute(relative)) {
    if(path.basename(relative)==='denied-test.txt') throw Object.assign(new Error('Test access denied'),{code:'EACCES'});
    if(path.basename(relative)==='vanishing-test.txt') throw Object.assign(new Error('Test item disappeared'),{code:'ENOENT'});
  }
  pending++;if(pending>maximum) {maximum=pending;parentPort.postMessage({type:'test-concurrency',maximum});}
  try{return await original.call(fs,item,...args);} finally{pending--;}
};
