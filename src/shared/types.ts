export type ScanStatus =
  | 'idle'
  | 'scanning'
  | 'paused'
  | 'cancelling'
  | 'completed'
  | 'completed_with_warnings'
  | 'failed';

export type FileCategory =
  | 'Documents'
  | 'Images'
  | 'Videos'
  | 'Audio'
  | 'Archives'
  | 'Applications'
  | 'Code'
  | 'System'
  | 'Other';

export interface DriveTarget {
  root: string;
  label: string;
  type: 'local' | 'removable' | 'network' | 'optical' | 'unknown';
  totalBytes: number;
  freeBytes: number;
}

export interface ScanProgress {
  scanId: string;
  status: ScanStatus;
  currentPath: string;
  files: number;
  folders: number;
  bytes: number;
  warnings: number;
  elapsedMs: number;
  message?: string;
}

export interface ScanSummary {
  scanId: string;
  rootId: number;
  rootPath: string;
  label: string;
  status: ScanStatus;
  startedAt: number;
  completedAt: number | null;
  totalBytes: number;
  allocatedBytes: number;
  fileCount: number;
  folderCount: number;
  warningCount: number;
  volumeTotalBytes: number;
  volumeFreeBytes: number;
  categories: AggregateRow[];
  extensions: AggregateRow[];
  topFiles: FileNode[];
  topFolders: FileNode[];
}

export interface AggregateRow {
  name: string;
  size: number;
  allocatedSize: number;
  count: number;
}

export interface FileNode {
  id: number;
  parentId: number | null;
  name: string;
  path: string;
  kind: 'file' | 'folder' | 'link';
  extension: string;
  category: FileCategory;
  size: number;
  allocatedSize: number;
  modifiedAt: number;
  attributes: string;
  itemCount: number;
  fileCount: number;
  folderCount: number;
}

export interface NodeQuery {
  scanId: string;
  parentId?: number | null;
  view?: 'browse' | 'category' | 'large' | 'old' | 'search';
  search?: string;
  extension?: string;
  category?: FileCategory | '';
  minSize?: number;
  olderThan?: number;
  kind?: '' | 'file' | 'folder';
  sortBy?: 'name' | 'size' | 'allocatedSize' | 'modifiedAt' | 'itemCount';
  sortDir?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

export interface QueryResult {
  items: FileNode[];
  total: number;
  page: number;
  pageSize: number;
}

export interface TreemapNode extends FileNode {
  synthetic?: boolean;
  syntheticKind?: 'free' | 'remainder';
}

export type SizeUnit = 'dynamic' | 'bytes' | 'KB' | 'MB' | 'GB' | 'TB';

export interface AppSettings {
  theme: 'dark' | 'light';
  unit: SizeUnit;
  showHeader: boolean;
  showFileTypes: boolean;
  showTreemap: boolean;
  showLabels: boolean;
  showFreeSpace: boolean;
  useAllocatedSize: boolean;
  confirmRecycle: boolean;
  largeFileThreshold: number;
  oldFileDays: number;
}

export interface ActionResult {
  ok: boolean;
  message?: string;
  succeeded?: number[];
  failed?: Array<{ id: number; message: string }>;
}

export interface BlockItApi {
  drives: { list(): Promise<DriveTarget[]> };
  dialog: { selectFolder(): Promise<string | null> };
  scan: {
    start(root: string): Promise<{ scanId: string }>;
    cancel(scanId: string): Promise<void>;
    pause(scanId: string): Promise<void>;
    resume(scanId: string): Promise<void>;
    onProgress(callback: (progress: ScanProgress) => void): () => void;
    launchTarget(): Promise<string | null>;
    rescanElevated(scanId: string): Promise<ActionResult>;
  };
  data: {
    summary(scanId: string): Promise<ScanSummary>;
    nodes(query: NodeQuery): Promise<QueryResult>;
    treemap(scanId: string, parentId: number): Promise<TreemapNode[]>;
    warnings(scanId: string): Promise<Array<{ path: string; message: string }>>;
    ancestors(scanId: string, nodeId: number): Promise<Array<{id:number;name:string}>>;
  };
  actions: {
    open(scanId: string, nodeId: number): Promise<ActionResult>;
    reveal(scanId: string, nodeId: number): Promise<ActionResult>;
    copyPath(scanId: string, nodeId: number): Promise<ActionResult>;
    trash(scanId: string, nodeIds: number[]): Promise<ActionResult>;
    exportCsv(query: NodeQuery): Promise<ActionResult>;
    exportTreemap(dataUrl: string): Promise<ActionResult>;
  };
  settings: {
    get(): Promise<AppSettings>;
    update(patch: Partial<AppSettings>): Promise<AppSettings>;
  };
}

declare global {
  interface Window {
    blockit: BlockItApi;
  }
}
