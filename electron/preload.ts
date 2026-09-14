import { contextBridge, ipcRenderer } from 'electron';
import type { AppSettings, BlockItApi, NodeQuery, ScanProgress } from '../src/shared/types';

const api: BlockItApi = {
  drives: { list: () => ipcRenderer.invoke('drives:list') },
  dialog: { selectFolder: () => ipcRenderer.invoke('dialog:select-folder') },
  scan: {
    start: (root: string) => ipcRenderer.invoke('scan:start', root),
    cancel: (scanId: string) => ipcRenderer.invoke('scan:cancel', scanId),
    pause: (scanId: string) => ipcRenderer.invoke('scan:pause',scanId),
    resume: (scanId: string) => ipcRenderer.invoke('scan:resume',scanId),
    launchTarget: () => ipcRenderer.invoke('scan:launch-target'),
    rescanElevated: (scanId: string) => ipcRenderer.invoke('scan:rescan-elevated', scanId),
    onProgress(callback: (progress: ScanProgress) => void) {
      const listener = (_event: Electron.IpcRendererEvent, progress: ScanProgress) => callback(progress);
      ipcRenderer.on('scan:progress', listener);
      return () => ipcRenderer.removeListener('scan:progress', listener);
    },
  },
  data: {
    summary: (scanId: string) => ipcRenderer.invoke('data:summary', scanId),
    nodes: (query: NodeQuery) => ipcRenderer.invoke('data:nodes', query),
    treemap: (scanId: string, parentId: number) => ipcRenderer.invoke('data:treemap', scanId, parentId),
    treemapTree: (scanId: string, parentId: number, depth: number) => ipcRenderer.invoke('data:treemap-tree', scanId, parentId, depth),
    warnings: (scanId: string) => ipcRenderer.invoke('data:warnings', scanId),
    ancestors: (scanId: string, nodeId: number) => ipcRenderer.invoke('data:ancestors', scanId, nodeId),
  },
  actions: {
    open: (scanId: string, nodeId: number) => ipcRenderer.invoke('actions:open', scanId, nodeId),
    reveal: (scanId: string, nodeId: number) => ipcRenderer.invoke('actions:reveal', scanId, nodeId),
    copyPath: (scanId: string, nodeId: number) => ipcRenderer.invoke('actions:copy-path', scanId, nodeId),
    trash: (scanId: string, nodeIds: number[]) => ipcRenderer.invoke('actions:trash', scanId, nodeIds),
    exportCsv: (query: NodeQuery) => ipcRenderer.invoke('actions:export-csv', query),
    exportTreemap: (dataUrl: string) => ipcRenderer.invoke('actions:export-treemap', dataUrl),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    update: (patch: Partial<AppSettings>) => ipcRenderer.invoke('settings:update', patch),
  },
};

contextBridge.exposeInMainWorld('blockit', api);
