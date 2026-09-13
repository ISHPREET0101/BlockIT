import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { NativeDirectoryReader } from './native-directory';

const mocks = vi.hoisted(() => ({spawn:vi.fn()}));
vi.mock('node:child_process', () => ({spawn:mocks.spawn}));

class Child extends EventEmitter {
  stdout = new PassThrough();
  stdin = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn();
  send(value: unknown) { this.stdout.write(JSON.stringify(value)+'\n'); }
}
let child: Child;
beforeEach(() => { child = new Child(); mocks.spawn.mockReturnValue(child); });
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); child.stdout.end(); });

describe('bounded native metadata transport', () => {
  it('uses a hidden process without a shell and waits for a request', async () => {
    const reader = new NativeDirectoryReader('reader.exe');
    expect(mocks.spawn).toHaveBeenCalledWith('reader.exe',[String(process.pid)],{windowsHide:true,stdio:'pipe'});
    child.send({ready:1}); await reader.ready;
    expect(child.stdin.readableLength).toBe(0);
    const result = reader.read('C:\\sample'); await Promise.resolve();
    expect(JSON.parse(child.stdin.read().toString())).toEqual({op:'open',path:'C:\\sample',x:[]});
    await expect(reader.read()).rejects.toThrow('already busy');
    child.send({entries:[],done:true});
    await expect(result).resolves.toEqual({entries:[],done:true});
    expect(child.stdin.readableLength).toBe(0);
    reader.close();
  });
  it('rejects an outstanding request immediately on cancellation', async () => {
    const reader = new NativeDirectoryReader('reader.exe');
    child.send({ready:1}); await reader.ready;
    const result = reader.read('C:\\sample'); await Promise.resolve();
    const assertion = expect(result).rejects.toThrow('closed');
    reader.close(); await assertion; expect(child.kill).toHaveBeenCalled();
  });
  it('reports startup failures without an unhandled rejection', async () => {
    const reader = new NativeDirectoryReader('missing.exe');
    const assertion = expect(reader.ready).rejects.toThrow('ENOENT');
    child.emit('error',new Error('ENOENT')); await assertion;
  });
  it('times out a blocked directory request and stops the helper', async () => {
    vi.useFakeTimers();
    const reader = new NativeDirectoryReader('reader.exe');
    child.send({ready:1}); await reader.ready;
    const result = reader.read('C:\\sample'); await Promise.resolve();
    const assertion = expect(result).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(30000); await assertion;
    expect(child.kill).toHaveBeenCalled();
  });
  it('rejects malformed responses instead of waiting forever', async () => {
    const reader = new NativeDirectoryReader('reader.exe');
    child.send({ready:1}); await reader.ready;
    const result = reader.read('C:\\sample'); await Promise.resolve();
    const assertion = expect(result).rejects.toThrow('Invalid');
    child.stdout.write('not-json\n'); await assertion;
    expect(child.kill).toHaveBeenCalled();
  });
  it('issues volume and probe requests and enforces one at a time', async () => {
    const reader = new NativeDirectoryReader('reader.exe');
    child.send({ready:1}); await reader.ready;
    const volume = reader.readVolume('C:\\', ['c:\\excluded']); await Promise.resolve();
    expect(JSON.parse(child.stdin.read().toString())).toEqual({op:'volume',path:'C:\\',x:['c:\\excluded']});
    // No read-ahead and no interleaving: the busy reader refuses new work.
    await expect(reader.probeVolume('C:\\')).rejects.toThrow('already busy');
    await expect(reader.read('C:\\x')).rejects.toThrow('already busy');
    child.send({entries:[],dirs:[],doneDirs:[],done:true,denied:true});
    await expect(volume).resolves.toEqual({entries:[],dirs:[],doneDirs:[],done:true,denied:true});
    const probe = reader.probeVolume('C:\\'); await Promise.resolve();
    expect(JSON.parse(child.stdin.read().toString())).toEqual({op:'admin',path:'C:\\'});
    child.send({admin:true,ntfs:true});
    await expect(probe).resolves.toEqual({admin:true,ntfs:true});
    reader.close();
  });
  it('gives the volume load a longer timeout than directory requests', async () => {
    vi.useFakeTimers();
    const reader = new NativeDirectoryReader('reader.exe');
    child.send({ready:1}); await reader.ready;
    const volume = reader.readVolume('C:\\'); await Promise.resolve();
    const volumeAssertion = expect(volume).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(30000);
    expect(child.kill).not.toHaveBeenCalled();   // a 30s directory timeout must not kill the MFT load
    await vi.advanceTimersByTimeAsync(120000); await volumeAssertion;
    expect(child.kill).toHaveBeenCalled();
  });
});
