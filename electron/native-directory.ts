import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

export interface EntryMetadata {
  name: string;
  kind: 'file' | 'folder' | 'link';
  size: number;
  modifiedAt: number;
  attributes: string;
}
// Compact subtree-walk records from the native helper. Entries reference their
// parent directory by walk index; dirs announce newly discovered folders.
export interface EntryRecord { p: number; n: string; k: 'file' | 'folder' | 'link'; s: number; m: number; a: string }
export interface DirRecord { i: number; p: number; n: string; m: number }
export interface WalkError { i: number; e: string }
export interface DirectorySelf {
  modifiedAt: number;
  path: string;
  directory: boolean;
  reparse: boolean;
}
interface Batch { entries: EntryRecord[]; dirs?: DirRecord[]; doneDirs?: number[]; pending?: DirRecord[]; errors?: WalkError[]; done: boolean; error?: string | null; self?: DirectorySelf | null; denied?: boolean; unsupported?: boolean }
export class NativeDirectoryTimeoutError extends Error {
  constructor() { super('Directory metadata request timed out.'); }
}
export class VolumeAccessDeniedError extends Error {
  constructor() { super('Administrator rights are required for the fast drive scan.'); }
}
export class VolumeUnavailableError extends Error {}

// One outstanding request per reader, at most 4096 entries/directories per response. Pausing
// cannot queue a drive's worth of metadata in either process. No shell, scripts
// or file contents. A scan opens several readers in parallel to overlap
// directory round trips; each reader still serves exactly one directory at a
// time and waits for demand between batches.
export class NativeDirectoryReader {
  private child: ChildProcessWithoutNullStreams;
  private pending?: { resolve: (value: unknown) => void; reject: (error: Error) => void };
  private failure?: Error;
  readonly ready: Promise<void>;

  constructor(executable: string) {
    this.child = spawn(executable, [String(process.pid)], { windowsHide: true, stdio: 'pipe' });
    const lines = createInterface({ input: this.child.stdout });
    this.ready = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => this.fail(new Error('Native reader startup timed out.')), 10000);
      this.pending = {
        resolve: value => {
          clearTimeout(timeout);
          if ((value as {ready?:number}).ready === 1) resolve();
          else { reject(new Error('Unsupported native reader.')); this.close(); }
        },
        reject: error => { clearTimeout(timeout); reject(error); },
      };
    });
    lines.on('line', line => {
      const pending = this.pending;
      this.pending = undefined;
      if (!pending) { this.fail(new Error('Unexpected native reader response.')); return; }
      try { pending.resolve(JSON.parse(line)); }
      catch { pending.reject(new Error('Invalid native reader response.')); this.close(); }
    });
    this.child.on('error', error => this.fail(error));
    this.child.on('exit', () => { lines.close(); this.fail(new Error('Native reader stopped.')); });
    this.child.stdin.on('error', error => this.fail(error));
    this.child.stderr.resume();
  }
  private fail(error: Error) {
    this.failure ??= error;
    this.pending?.reject(error);
    this.pending = undefined;
    this.child.kill();
  }
  close() { this.fail(new Error('Native reader closed.')); }
  async read(directory?: string, exclude?: string[]): Promise<Batch> {
    await this.ready;
    if (this.failure) throw this.failure;
    if (this.pending) throw new Error('Native reader is already busy.');
    return new Promise<Batch>((resolve, reject) => {
      const timeout = setTimeout(() => this.fail(new NativeDirectoryTimeoutError()), 30000);
      this.pending = {
        resolve: value => { clearTimeout(timeout); resolve(value as Batch); },
        reject: error => { clearTimeout(timeout); reject(error); },
      };
      const request = directory === undefined ? {op:'next'} : {op:'open',path:directory,x:exclude??[]};
      this.child.stdin.write(JSON.stringify(request) + '\n');
    });
  }
  // Whole-volume request: the helper loads and parses the Master File Table in
  // one go before the first batch, so this call earns a much longer timeout.
  async readVolume(directory: string, exclude?: string[]): Promise<Batch> {
    await this.ready;
    if (this.failure) throw this.failure;
    if (this.pending) throw new Error('Native reader is already busy.');
    return new Promise<Batch>((resolve, reject) => {
      const timeout = setTimeout(() => this.fail(new NativeDirectoryTimeoutError()), 150000);
      this.pending = {
        resolve: value => { clearTimeout(timeout); resolve(value as Batch); },
        reject: error => { clearTimeout(timeout); reject(error); },
      };
      this.child.stdin.write(JSON.stringify({op:'volume',path:directory,x:exclude??[]}) + '\n');
    });
  }
  // Continuation of a volume walk: the helper routes a bare "next" to the
  // volume writer while a volume walk is active, so batches keep streaming
  // until done. Batches are already parsed, so the standard bound applies.
  async readVolumeNext(): Promise<Batch> {
    await this.ready;
    if (this.failure) throw this.failure;
    if (this.pending) throw new Error('Native reader is already busy.');
    return new Promise<Batch>((resolve, reject) => {
      const timeout = setTimeout(() => this.fail(new NativeDirectoryTimeoutError()), 30000);
      this.pending = {
        resolve: value => { clearTimeout(timeout); resolve(value as Batch); },
        reject: error => { clearTimeout(timeout); reject(error); },
      };
      this.child.stdin.write(JSON.stringify({op:'next'}) + '\n');
    });
  }
  // Cheap elevation/filesystem probe used before starting a drive scan; never
  // changes scan state, so the same reader can serve a scan afterwards.
  async probeVolume(directory: string): Promise<{admin: boolean; ntfs: boolean}> {
    await this.ready;
    if (this.failure) throw this.failure;
    if (this.pending) throw new Error('Native reader is already busy.');
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => this.fail(new NativeDirectoryTimeoutError()), 10000);
      this.pending = {
        resolve: value => { clearTimeout(timeout); resolve(value as {admin: boolean; ntfs: boolean}); },
        reject: error => { clearTimeout(timeout); reject(error); },
      };
      this.child.stdin.write(JSON.stringify({op:'admin',path:directory}) + '\n');
    });
  }
  // Pause/resume carry no response: they bound the helper's work while the
  // worker is not reading, so the helper never blocks mid-write for long.
  control(op: 'pause' | 'resume') {
    if (!this.failure) this.child.stdin.write(JSON.stringify({op}) + '\n');
  }
}
