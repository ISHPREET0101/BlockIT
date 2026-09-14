import { parentPort, workerData } from 'node:worker_threads';
import { configureDirectory,getSummary,queryNodes,treemapChildren,ancestors,closeDatabases,exportCsvFile,reconcileRemoval } from './queries';
configureDirectory(workerData.directory);
parentPort?.on('message',async ({id,operation,args})=>{
  try {
    let result;
    if(operation==='summary') result=getSummary(args[0]);
    else if(operation==='nodes') result=queryNodes(args[0]);
    else if(operation==='treemap') result=treemapChildren(args[0],args[1],args[2]);
    else if(operation==='ancestors') result=ancestors(args[0],args[1]);
    else if(operation==='invalidate') {closeDatabases();result=true;}
    else if(operation==='export') result=await exportCsvFile(args[0],args[1]);
    else if(operation==='reconcile') {reconcileRemoval(args[0],args[1]);result=true;}
    else throw new Error('Unsupported query');
    parentPort?.postMessage({id,result});
  } catch(error) {parentPort?.postMessage({id,error:String(error)});}
});
