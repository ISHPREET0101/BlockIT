import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ArrowUp, Copy, FileText, FolderOpen, HardDrive, RefreshCw, Search } from 'lucide-react';
import type { DriveTarget, ExplorerEntry, ExplorerResult } from '../shared/types';
import './FileExplorer.css';

export function FileExplorer({ drives }: { drives: DriveTarget[] }) {
  const [history, setHistory] = useState(['']);
  const [position, setPosition] = useState(0);
  const folder = history[position];
  const [address, setAddress] = useState('');
  const [search, setSearch] = useState('');
  const [scope, setScope] = useState('');
  const searchRoot = scope || folder;
  const readFolder = search.trim() ? searchRoot : folder;
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<ExplorerResult | null>(null);
  const [selected, setSelected] = useState<ExplorerEntry | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const refresh = useRef(false);
  useEffect(() => () => { void window.blockit.explorer.stop().catch(() => {}); }, []);
  useEffect(() => { setAddress(folder); setSelected(null); setNotice(''); }, [folder]);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    setResult(null); setError(''); setSelected(null);
    if (!readFolder) { setBusy(false); return; }
    setBusy(true);
    const read = async () => {
      try {
        const rebuild = refresh.current; refresh.current = false;
        const next = await window.blockit.explorer.read(readFolder, search, page, rebuild);
        if (!alive) return;
        setResult(next); setBusy(false);
        if (next.indexing) timer = setTimeout(() => void read(), 500);
      } catch (reason) { if (alive) { setError(String(reason)); setBusy(false); } }
    };
    timer = setTimeout(() => void read(), search.trim() ? 150 : 0);
    return () => { alive = false; clearTimeout(timer); };
  }, [readFolder, search, page, revision]);
  function navigate(next: string) {
    setSearch(''); setScope(''); setPage(1);
    setHistory(previous => [...previous.slice(0, position + 1), next]); setPosition(position + 1);
  }
  function travel(offset: number) { setSearch(''); setScope(''); setPage(1); setPosition(position + offset); }
  async function choose() {
    try { const next = await window.blockit.explorer.choose(); if (next) navigate(next); }
    catch (reason) { setError(String(reason)); }
  }
  async function action(item: ExplorerEntry, operation: 'open' | 'reveal' | 'copy') {
    try { await window.blockit.explorer.action(item.path, operation); setNotice(operation === 'copy' ? 'Path copied.' : 'Opened in Windows.'); }
    catch (reason) { setError(String(reason)); }
  }
  function open(item: ExplorerEntry) { if (item.kind === 'folder') navigate(item.path); else void action(item, 'open'); }
  return <section className="file-explorer workspace" aria-label="File Explorer">
    <div className="page-title-row"><div><span className="eyebrow">Your files, within reach · v1.9.1</span><h1>File Explorer</h1></div><button className="ghost-button" onClick={() => void choose()}><FolderOpen size={16} /> Open folder</button></div>
    <div className="explorer-location">
      <button className="icon-button" aria-label="Back" disabled={position === 0} onClick={() => travel(-1)}><ArrowLeft size={18} /></button>
      <button className="icon-button" aria-label="Forward" disabled={position === history.length - 1} onClick={() => travel(1)}><ArrowRight size={18} /></button>
      <button className="icon-button" aria-label="Up one folder" disabled={!result || Boolean(search.trim()) || result.parent === folder} onClick={() => result && navigate(result.parent)}><ArrowUp size={18} /></button>
      <form onSubmit={event => { event.preventDefault(); if (address.trim()) navigate(address.trim()); }}><FolderOpen size={17} /><input aria-label="Folder path" placeholder="Enter a folder path, e.g. D:\Projects" value={address} onChange={event => setAddress(event.target.value)} /><button className="text-button" type="submit">Go</button></form>
      <button className="icon-button" aria-label="Refresh folder and search index" disabled={!readFolder} onClick={() => { refresh.current = true; setPage(1); setRevision(value => value + 1); }}><RefreshCw size={18} /></button>
    </div>
    <div className="explorer-drive-row"><button className="ghost-button" onClick={() => navigate('')}><HardDrive size={15} /> This PC</button>{drives.map(drive => <button className="ghost-button" key={drive.root} onClick={() => navigate(drive.root)}>{drive.label}</button>)}</div>
    <div className="explorer-search"><label className="explorer-scope">Search in <select aria-label="Search location" value={scope} onChange={event => { setScope(event.target.value); setPage(1); }}><option value="">{folder ? 'Current folder' : 'Select a drive'}</option>{drives.map(drive => <option key={drive.root} value={drive.root}>{drive.label}</option>)}</select></label><Search size={19} /><input aria-label="Search this folder and subfolders" disabled={!searchRoot} placeholder={scope ? 'Search filenames anywhere on ' + scope.slice(0,2) : 'Search filenames in this folder and all subfolders'} value={search} onChange={event => { setSearch(event.target.value); setPage(1); }} />{search && <button className="text-button" onClick={() => { setSearch(''); setPage(1); }}>Clear</button>}<span>Fast search</span></div>
    <div className="explorer-status" role="status">{busy ? 'Loading…' : !readFolder ? 'Choose a drive or open a folder to get started. No storage scan needed.' : result ? result.total.toLocaleString() + (search.trim() ? ' matches' : ' items') + (search.trim() ? ' · ' + (result.indexing ? 'Indexing…' : 'Index ready') + ' · ' + result.indexed.toLocaleString() + ' entries indexed' : '') : ''}{result?.skipped ? ' · ' + result.skipped + ' inaccessible folders or links skipped' : ''}{result?.limited ? ' · Index limit reached; choose a smaller folder for complete results.' : ''}</div>
    {search.trim() && <p className="explorer-hint">Searching {searchRoot}. The first search builds a local index. Later searches reuse it. Refresh to include filesystem changes.</p>}
    {error && <div className="completion-note error" role="alert">{error}</div>}
    <div className="explorer-table panel"><table><thead><tr><th>Name</th><th>Type</th><th>Location</th></tr></thead><tbody>{result?.items.map(item => <tr key={item.path} tabIndex={0} aria-selected={selected?.path === item.path} className={selected?.path === item.path ? 'selected' : ''} onClick={() => setSelected(item)} onFocus={() => setSelected(item)} onDoubleClick={() => open(item)} onKeyDown={event => { if (event.key === 'Enter') open(item); }}><td>{item.kind === 'folder' ? <FolderOpen size={18} /> : <FileText size={18} />}<span>{item.name}</span></td><td>{item.kind === 'folder' ? 'Folder' : 'File'}</td><td title={item.path}>{item.path}</td></tr>)}</tbody></table>{!busy && !result?.items.length && <div className="empty-table">{!readFolder ? 'Your drives and folders are ready to explore.' : result?.indexing ? 'Searching as files are indexed…' : search.trim() ? 'No matching filenames.' : error ? 'This location could not be opened.' : 'This folder is empty.'}</div>}</div>
    <div className="explorer-footer"><span>{selected ? selected.path : 'Double-click a folder to browse, or a file to open it.'}</span>{selected && <><button className="ghost-button" onClick={() => open(selected)}>Open</button><button className="ghost-button" onClick={() => void action(selected, 'reveal')}>Show in Windows</button><button className="ghost-button" onClick={() => void action(selected, 'copy')}><Copy size={14} /> Copy path</button></>}</div>
    {notice && <div role="status" className="explorer-hint">{notice}</div>}
    {result && result.total > 100 && <div className="explorer-pagination"><button className="ghost-button" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button><span>Page {page} of {Math.ceil(result.total / 100)}</span><button className="ghost-button" disabled={page * 100 >= result.total} onClick={() => setPage(page + 1)}>Next</button></div>}
  </section>;
}