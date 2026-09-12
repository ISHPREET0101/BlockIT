import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, Archive, BarChart3, Box, ChevronRight, Clock3, Database, FileArchive,
  FileCode2, FileImage, FileMusic, FileText, Film, Filter, FolderOpen, HardDrive,
  LayoutDashboard, Menu, Moon, MoreHorizontal, Play, RefreshCw, Search, Settings,
  ShieldCheck, Square, Sun, Trash2, X, Pause,
} from 'lucide-react';
import { DataTable } from './components/DataTable';
import { TreemapView } from './components/Treemap';
import { categoryColors } from './shared/categories';
import { formatBytes } from './shared/format';
import { defaultSettings } from './shared/validation';
import type {
  ActionResult, AppSettings, DriveTarget, FileCategory, FileNode, NodeQuery,
  QueryResult, ScanProgress, ScanSummary, TreemapNode,
} from './shared/types';

type View = 'overview' | 'treemap' | 'browse' | 'categories' | 'large' | 'old';

const categories: Array<{ name: FileCategory; icon: typeof FileText }> = [
  { name: 'Documents', icon: FileText }, { name: 'Images', icon: FileImage },
  { name: 'Videos', icon: Film }, { name: 'Audio', icon: FileMusic },
  { name: 'Archives', icon: FileArchive }, { name: 'Applications', icon: Box },
  { name: 'Code', icon: FileCode2 }, { name: 'System', icon: Database },
  { name: 'Other', icon: MoreHorizontal },
];

const navItems: Array<{ id: View; label: string; icon: typeof LayoutDashboard }> = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'treemap', label: 'Treemap', icon: BarChart3 },
  { id: 'browse', label: 'Browse', icon: FolderOpen },
  { id: 'categories', label: 'Categories', icon: Archive },
  { id: 'large', label: 'Large files', icon: HardDrive },
  { id: 'old', label: 'Old files', icon: Clock3 },
];

function percent(value: number, total: number): string {
  return total > 0 ? `${Math.min(100, (value / total) * 100).toFixed(1)}%` : '0%';
}

function App() {
  const [settings, setSettings] = useState(defaultSettings);
  const [drives, setDrives] = useState<DriveTarget[]>([]);
  const [target, setTarget] = useState('');
  const [view, setView] = useState<View>('overview');
  const [scanId, setScanId] = useState<string | null>(null);
  const scanIdRef = useRef<string | null>(null);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [summary, setSummary] = useState<ScanSummary | null>(null);
  const [parentId, setParentId] = useState<number | null>(null);
  const [breadcrumbs, setBreadcrumbs] = useState<Array<{ id: number; name: string }>>([]);
  const [treemapNodes, setTreemapNodes] = useState<TreemapNode[]>([]);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [resultKey, setResultKey] = useState('');
  const [queryError, setQueryError] = useState('');
  const [treeKey, setTreeKey] = useState('');
  const [isStarting, setIsStarting] = useState(false);
  const startingRef = useRef(false);
  const navigationSequence = useRef(0);
  const [selected, setSelected] = useState<FileNode | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<FileCategory>('Documents');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [extension, setExtension] = useState('');
  const [kind, setKind] = useState<'' | 'file' | 'folder'>('');
  const [sortBy, setSortBy] = useState<NonNullable<NodeQuery['sortBy']>>('size');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(1);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [warnings, setWarnings] = useState<Array<{ path: string; message: string }> | null>(null);
  const [toast, setToast] = useState<{ tone: 'good' | 'bad'; message: string } | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const lastRefresh = useRef(0);
  const summaryInFlight = useRef(false);
  const refreshAgain = useRef(false);

  const refreshSummary = useCallback(async (id: string) => {
    if (summaryInFlight.current) {refreshAgain.current=true;return;}
    summaryInFlight.current=true;
    try {
      const next = await window.blockit.data.summary(id);
      if (scanIdRef.current !== id) return;
      setSummary(next);
      setParentId((current) => current ?? next.rootId);
      setBreadcrumbs((current) => current.length ? current : [{ id: next.rootId, name: next.label }]);
      setRefreshVersion((version) => version + 1);
    } catch {
      // The worker may still be creating its first committed batch.
    } finally {
      summaryInFlight.current=false;
      if(refreshAgain.current) {
        refreshAgain.current=false;
        if(scanIdRef.current) void refreshSummary(scanIdRef.current);
      }
    }
  }, []);

  useEffect(() => {
    let mounted=true;
    void window.blockit.settings.get().then(savedSettings => {
        if(!mounted) return;
        setSettings(savedSettings);
        document.documentElement.dataset.theme = savedSettings.theme;
      }).catch(error=>showResult({ok:false,message:String(error)}));
    void window.blockit.drives.list().then(availableDrives=>{
        if(!mounted) return;
        setDrives(availableDrives);
        if (availableDrives[0]) setTarget(current=>current||availableDrives[0].root);
      }).catch(error=>showResult({ok:false,message:'Could not list drives: '+String(error)}));
    void window.blockit.scan.launchTarget().then(root=>{if(mounted&&root) void beginScan(root);}).catch(error=>showResult({ok:false,message:String(error)}));
    const unsubscribe = window.blockit.scan.onProgress((next) => {
      if (scanIdRef.current !== next.scanId) return;
      setProgress(next);
      const now = Date.now();
      if (now - lastRefresh.current > 2500 || ['paused','completed', 'completed_with_warnings', 'failed', 'idle'].includes(next.status)) {
        lastRefresh.current = now;
        void refreshSummary(next.scanId);
      }
    });
    return ()=>{mounted=false;unsubscribe();};
    // The launch handler intentionally runs once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const beginScan = async (root = target) => {
    if (!root || startingRef.current) return;
    startingRef.current=true;setIsStarting(true);
    try {
      setSearch('');
      setDebouncedSearch('');
      const started = await window.blockit.scan.start(root);
      navigationSequence.current++;
      setTarget(root);setPage(1);setExtension('');setKind('');
      scanIdRef.current = started.scanId;
      setScanId(started.scanId);
      setSummary(null);
      setResult(null);
      setTreemapNodes([]);
      setSelected(null);
      setParentId(null);
      setBreadcrumbs([]);
      setProgress({ scanId: started.scanId, status: 'scanning', currentPath: root, files: 0, folders: 0, bytes: 0, warnings: 0, elapsedMs: 0 });
      setView('overview');
    } catch (error) {
      showResult({ ok: false, message: error instanceof Error ? error.message : String(error) });
    } finally {startingRef.current=false;setIsStarting(false);}
  };

  const selectFolder = async () => {
    const folder = await window.blockit.dialog.selectFolder();
    if (folder) {
      setTarget(folder);
      await beginScan(folder);
    }
  };

  const hasSummary = summary !== null;
  const oldCutoff = useMemo(()=>Date.now()-settings.oldFileDays*86_400_000,[settings.oldFileDays,scanId]);
  const query = useMemo<NodeQuery | null>(() => {
    if (!scanId || !hasSummary) return null;
    const base: NodeQuery = { scanId, search: debouncedSearch, extension, kind, sortBy, sortDir, page, pageSize: 100 };
    if (debouncedSearch.trim()) return { ...base, view: 'search' };
    if (view === 'browse') return { ...base, view: 'browse', parentId };
    if (view === 'categories') return { ...base, view: 'category', category: selectedCategory };
    if (view === 'large') return { ...base, view: 'large', minSize: settings.largeFileThreshold };
    if (view === 'old') return { ...base, view: 'old', olderThan: oldCutoff };
    return null;
  }, [scanId, hasSummary, debouncedSearch, extension, kind, sortBy, sortDir, page, view, parentId, selectedCategory, settings.largeFileThreshold, oldCutoff]);
  const queryKey = query ? JSON.stringify(query) : '';

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 250);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    if (!query) return;
    let alive = true;
    setQueryError('');
    void window.blockit.data.nodes(query).then((next) => {
      if (alive) {setResult(next);setResultKey(queryKey);if(next.page!==query.page)setPage(next.page);}
    }).catch(error => { if (alive) {setResult(null);setResultKey(queryKey);setQueryError(String(error));} });
    return () => { alive = false; };
  }, [query, refreshVersion]);

  useEffect(() => {
    if (!scanId || parentId == null || view!=='treemap' || !settings.showTreemap || debouncedSearch.trim()) return;
    let alive = true;
    void window.blockit.data.treemap(scanId, parentId).then((nodes) => { if (alive) {setTreemapNodes(nodes);setTreeKey(scanId+':'+parentId);} }).catch(error => { if (alive) {setTreemapNodes([]);showResult({ok:false,message:String(error)});} });
    return () => { alive = false; };
  }, [scanId, parentId, refreshVersion,view,settings.showTreemap,debouncedSearch]);

  useEffect(() => { setPage(1); setSelected(null); }, [view, search, extension, kind, selectedCategory, parentId, settings.largeFileThreshold, settings.oldFileDays, sortBy, sortDir]);
  useEffect(() => { if (toast) { const timer = setTimeout(() => setToast(null), 3600); return () => clearTimeout(timer); } }, [toast]);

  const showResult = useCallback((action: ActionResult) => setToast({ tone: action.ok ? 'good' : 'bad', message: action.message || (action.ok ? 'Done.' : 'Something went wrong.') }), []);

  const updateSettings = async (patch: Partial<AppSettings>) => {
    try {
    const next = await window.blockit.settings.update(patch);
    setSettings(next);
    document.documentElement.dataset.theme = next.theme;
    } catch(error) {showResult({ok:false,message:'Could not save settings: '+String(error)});}
  };

  const openNode = useCallback(async (node: FileNode) => {
    const sequence=++navigationSequence.current;
    if (node.kind === 'folder' && scanId) {
      try {
      const chain=await window.blockit.data.ancestors(scanId,node.id);
      if(sequence!==navigationSequence.current || scanIdRef.current!==scanId) return;
      setSearch('');
      setDebouncedSearch('');
      setParentId(node.id);
      setBreadcrumbs(chain);
      setView(view === 'treemap' ? 'treemap' : 'browse');
      } catch(error) {showResult({ok:false,message:String(error)});}
    } else if (scanId) showResult(await window.blockit.actions.open(scanId, node.id));
  }, [scanId,view,showResult]);

  const selectCrumb = useCallback((id: number) => {
    navigationSequence.current++;
    setBreadcrumbs((crumbs) => crumbs.slice(0, crumbs.findIndex(crumb=>crumb.id===id) + 1));
    setParentId(id);
  }, []);

  const recycleItem = async (node: FileNode) => {
    if (!scanId) return;
    const action = await window.blockit.actions.trash(scanId, [node.id]);
    setSelected(null);
    if(action.succeeded?.length && node.kind==='folder' && breadcrumbs.some(crumb=>crumb.id===node.id)) {
      navigationSequence.current++;
      setParentId(summary?.rootId??null);
      setBreadcrumbs(summary?[{id:summary.rootId,name:summary.label}]:[]);
    }
    showResult({ ...action, message: action.ok ? 'Item moved to the Windows Recycle Bin.' : action.message });
    await refreshSummary(scanId);
  };

  const runSelectedAction = async (action: 'open' | 'reveal' | 'copy', node: FileNode) => {
    if (!scanId) return;
    const result = action === 'open' ? await window.blockit.actions.open(scanId, node.id)
      : action === 'reveal' ? await window.blockit.actions.reveal(scanId, node.id)
        : await window.blockit.actions.copyPath(scanId, node.id);
    showResult({ ...result, message: result.ok && action === 'copy' ? 'Path copied.' : result.message });
  };

  const changeSort = (field: NonNullable<NodeQuery['sortBy']>) => {
    if (sortBy === field) setSortDir((direction) => direction === 'asc' ? 'desc' : 'asc');
    else { setSortBy(field); setSortDir(field === 'name' ? 'asc' : 'desc'); }
  };

  const topCategory = summary?.categories[0];
  const scannedBytes = summary?.totalBytes ?? progress?.bytes ?? 0;
  const driveUsed = summary ? Math.max(0, summary.volumeTotalBytes - summary.volumeFreeBytes) : 0;
  const isScanning = isStarting || progress?.status === 'scanning' || progress?.status === 'cancelling' || progress?.status === 'paused';
  const currentTitle = navItems.find((item) => item.id === view)?.label || 'Overview';
  const displayedTreemapNodes = useMemo<TreemapNode[]>(() => {
    if(treeKey!==scanId+':'+parentId) return [];
    if (!settings.showFreeSpace || !summary || parentId !== summary.rootId || summary.volumeFreeBytes <= 0 || !/^[a-z]:\\$/i.test(summary.rootPath)) return treemapNodes;
    return [...treemapNodes, {
      id: -9_007_199_254_740_000,
      parentId: summary.rootId,
      name: 'Free space',
      path: '',
      kind: 'file',
      extension: '',
      category: 'Other',
      size: summary.volumeFreeBytes,
      allocatedSize: summary.volumeFreeBytes,
      modifiedAt: 0,
      attributes: '',
      itemCount: 0,
      fileCount: 0,
      folderCount: 0,
      synthetic: true,
      syntheticKind: 'free',
    }];
  }, [treemapNodes, settings.showFreeSpace, summary, parentId,treeKey,scanId]);
  const onMapOpen=useCallback((node:TreemapNode)=>node.kind==='folder'?void openNode(node):setSelected(node),[openNode]);
  const onMapReset=useCallback(()=>{if(summary)selectCrumb(summary.rootId);},[summary?.rootId,selectCrumb]);
  const onMapExport=useCallback(async(dataUrl:string)=>showResult(await window.blockit.actions.exportTreemap(dataUrl)),[showResult]);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><img src="./blockit-mark.svg" alt="" /><div><strong>BlockIT</strong><span>Storage explorer</span></div></div>
        <nav>
          <span className="nav-label">Explore</span>
          {navItems.map(({ id, label, icon: Icon }) => (
            <button key={id} className={view === id ? 'nav-item active' : 'nav-item'} onClick={() => setView(id)} disabled={!scanId}>
              <Icon size={18} /><span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="privacy-card"><ShieldCheck size={19} /><div><strong>Private by design</strong><span>Everything stays on this PC.</span></div></div>
        <button className="nav-item settings-link" onClick={() => setSettingsOpen(true)}><Settings size={18} /> Settings</button>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="target-picker">
            <HardDrive size={18} />
            <select value={target} onChange={(event) => setTarget(event.target.value)} aria-label="Scan target">
              {!drives.some((drive) => drive.root === target) && target && <option value={target}>{target}</option>}
              {drives.map((drive) => <option key={drive.root} value={drive.root}>{drive.label}</option>)}
            </select>
          </div>
          <button className="primary-button" onClick={() => void beginScan()} disabled={!target || isScanning}><Play size={16} /> Scan</button>
          <button className="ghost-button" onClick={() => void selectFolder()} disabled={isScanning}><FolderOpen size={16} /> Choose folder</button>
          {isScanning && !isStarting && <button className="stop-button" onClick={() => scanId && window.blockit.scan.cancel(scanId)}><Square size={14} /> Stop</button>}
          {isScanning && !isStarting && progress?.status!=='cancelling' && <button className="ghost-button" onClick={()=>scanId && (progress?.status==='paused'?window.blockit.scan.resume(scanId):window.blockit.scan.pause(scanId))}>{progress?.status==='paused'?<Play size={15}/>:<Pause size={15}/>} {progress?.status==='paused'?'Resume':'Pause'}</button>}
          <div className="top-spacer" />
          <button className="icon-button" title="Toggle theme" onClick={() => void updateSettings({ theme: settings.theme === 'dark' ? 'light' : 'dark' })}>
            {settings.theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
          </button>
          <button className="icon-button" title="Settings" onClick={() => setSettingsOpen(true)}><Menu size={19} /></button>
        </header>

        {isScanning && progress && (
          <div className="scan-strip">
            <div className="scan-pulse" /><div className="scan-copy"><strong>{progress.status === 'cancelling' ? 'Stopping scan safely…' : progress.message || 'Scanning gently in the background'}</strong><span title={progress.currentPath}>{progress.currentPath}</span></div>
            <div className="scan-stats"><span>{progress.files.toLocaleString()} files</span><span>{formatBytes(progress.bytes, settings.unit)}</span><span>{Math.round(progress.elapsedMs / 1000)}s</span></div>
          </div>
        )}

        {!scanId ? (
          <Welcome drives={drives} settings={settings} onScan={(root) => { setTarget(root); void beginScan(root); }} onFolder={() => void selectFolder()} />
        ) : (
          <div className="workspace">
            <div className="page-title-row">
              <div><span className="eyebrow">{summary?.rootPath || target}</span><h1>{debouncedSearch.trim() ? 'Search results' : currentTitle}</h1></div>
              <div className="toolbar">
                <div className="search-box"><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search name or path" /></div>
                <button className={filtersOpen ? 'ghost-button active' : 'ghost-button'} onClick={() => setFiltersOpen((open) => !open)}><Filter size={16} /> Filters</button>
                {query && <button className="ghost-button" onClick={async () => showResult(await window.blockit.actions.exportCsv(query))}>Export CSV</button>}
              </div>
            </div>

            {filtersOpen && (
              <div className="filter-bar">
                <label>Extension<input value={extension} onChange={(event) => setExtension(event.target.value)} placeholder="e.g. mp4" /></label>
                <label>Type<select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}><option value="">Files & folders</option><option value="file">Files only</option><option value="folder">Folders only</option></select></label>
                {view === 'large' && <label>Minimum MB<input type="number" min="1" value={Math.round(settings.largeFileThreshold / 1024 ** 2)} onChange={(event) => void updateSettings({ largeFileThreshold: Math.max(1, Number(event.target.value)) * 1024 ** 2 })} /></label>}
                {view === 'old' && <label>Older than days<input type="number" min="1" value={settings.oldFileDays} onChange={(event) => void updateSettings({ oldFileDays: Math.max(1, Number(event.target.value)) })} /></label>}
                <button className="text-button" onClick={() => { setSearch(''); setExtension(''); setKind(''); }}>Clear filters</button>
              </div>
            )}

            {summary && settings.showHeader && view === 'overview' && !debouncedSearch.trim() && (
              <div className="metric-grid">
                <Metric label="Your files" value={formatBytes(scannedBytes, settings.unit)} hint={`${summary.fileCount.toLocaleString()} files`} accent="purple" />
                <Metric label="Drive used" value={formatBytes(driveUsed, settings.unit)} hint={percent(driveUsed, summary.volumeTotalBytes)} accent="blue" />
                <Metric label="Free space" value={formatBytes(summary.volumeFreeBytes, settings.unit)} hint={percent(summary.volumeFreeBytes, summary.volumeTotalBytes)} accent="green" />
              </div>
            )}

            {(view === 'browse' || view === 'treemap') && breadcrumbs.length > 0 && !debouncedSearch.trim() && (
              <div className="breadcrumbs">{breadcrumbs.map((crumb, index) => <span key={crumb.id}><button onClick={() => selectCrumb(crumb.id)}>{crumb.name}</button>{index < breadcrumbs.length - 1 && <ChevronRight size={14} />}</span>)}</div>
            )}

            {progress && !isScanning && <div className={`completion-note ${progress.status === 'failed' ? 'error' : ''}`} role="status">{progress.status === 'failed' ? `Scan failed: ${progress.message}` : progress.status === 'idle' ? 'Scan stopped. These are your results so far.' : `Scan complete · ${(summary?.fileCount??progress.files).toLocaleString()} files`}{!!summary?.warningCount && <button className="text-button" onClick={async () => setWarnings(await window.blockit.data.warnings(summary.scanId))}>{summary.warningCount} skipped items</button>}</div>}

            {view === 'overview' && summary && !debouncedSearch.trim() && (
              <Overview summary={summary} settings={settings} topCategory={topCategory}
                onFolder={(node) => { setParentId(node.id); setBreadcrumbs([{ id: summary.rootId, name: summary.label }, { id: node.id, name: node.name }]); setView('browse'); }}
                onFile={setSelected} />
            )}

            {view === 'categories' && summary && !debouncedSearch.trim() && (
              <div className="category-grid">
                {categories.map(({ name, icon: Icon }) => {
                  const aggregate = summary.categories.find((item) => item.name === name);
                  return <button key={name} className={selectedCategory === name ? 'category-card active' : 'category-card'} onClick={() => setSelectedCategory(name)}>
                    <span className="category-icon" style={{ color: categoryColors[name], background: `${categoryColors[name]}18` }}><Icon size={19} /></span>
                    <span><strong>{name}</strong><small>{formatBytes(aggregate?.size || 0, settings.unit)} · {(aggregate?.count || 0).toLocaleString()}</small></span>
                  </button>;
                })}
              </div>
            )}

            {view === 'treemap' && settings.showTreemap && !debouncedSearch.trim() && (
              <TreemapView nodes={displayedTreemapNodes} title={breadcrumbs.at(-1)?.name || summary?.label || 'Storage'} settings={settings}
                canReset={breadcrumbs.length > 1} onOpen={onMapOpen} onReset={onMapReset} onExport={onMapExport} />
            )}

            {query && (
              <DataTable result={resultKey===queryKey?result:null} loading={resultKey!==queryKey} error={queryError} canRecycle={!isScanning} settings={settings} selected={selected} query={query} onSelect={setSelected}
                onOpen={(node) => void openNode(node)} onReveal={(node) => void runSelectedAction('reveal', node)}
                onCopy={(node) => void runSelectedAction('copy', node)} onTrash={(node) => void recycleItem(node)}
                onSort={changeSort} onPage={setPage} />
            )}
          </div>
        )}
      </main>

      {selected && <div className="inspector" aria-label="Selected item details"><div className="drawer-head"><div><span className="eyebrow">Item details</span><h2>{selected.name}</h2></div><button className="icon-button" aria-label="Close details" onClick={() => setSelected(null)}><X size={19} /></button></div><div className="inspector-size">{formatBytes(selected.size, settings.unit)}</div><p className="helper">Logical file size</p><dl><dt>Category</dt><dd>{selected.kind === 'folder' ? 'Folder' : selected.category}</dd><dt>Estimated disk use</dt><dd>{formatBytes(selected.allocatedSize, settings.unit)}</dd><dt>Modified</dt><dd>{new Date(selected.modifiedAt).toLocaleString()}</dd><dt>Contents</dt><dd>{selected.kind === 'folder' ? `${selected.fileCount.toLocaleString()} files, ${selected.folderCount.toLocaleString()} folders` : selected.extension || 'No extension'}</dd><dt>Attributes</dt><dd>{selected.attributes || 'None recorded'}</dd><dt>Location</dt><dd className="inspector-path">{selected.path}</dd></dl><button className="primary-button" onClick={() => { void openNode(selected); setSelected(null); }}><FolderOpen size={16} />Open</button><button className="ghost-button" onClick={() => void runSelectedAction('reveal', selected)}>Show in Explorer</button><button className="ghost-button" onClick={() => void runSelectedAction('copy', selected)}>Copy full path</button><button className="danger-button" disabled={isScanning || selected.parentId == null} onClick={() => void recycleItem(selected)}><Trash2 size={16} />Move to Recycle Bin</button></div>}

      {settingsOpen && <SettingsPanel settings={settings} onChange={(patch) => void updateSettings(patch)} onClose={() => setSettingsOpen(false)} onElevate={scanId ? async () => showResult(await window.blockit.scan.rescanElevated(scanId)) : undefined} />}
      {warnings && <WarningsDialog warnings={warnings} onClose={() => setWarnings(null)} />}
      {toast && <div className={`toast ${toast.tone}`}><span>{toast.message}</span><button onClick={() => setToast(null)}><X size={15} /></button></div>}
    </div>
  );
}

function Welcome({ drives, settings, onScan, onFolder }: { drives: DriveTarget[]; settings: AppSettings; onScan(root: string): void; onFolder(): void }) {
  return <div className="welcome">
    <div className="welcome-copy"><span className="eyebrow">Your space, made simple</span><h1>See what’s filling up your PC.</h1><p>BlockIT builds a private visual map of your storage, then helps you explore it without moving or uploading a single file.</p><button className="primary-button large" onClick={onFolder}><FolderOpen size={18} /> Choose a folder</button></div>
    <div className="drive-section"><div className="section-title"><div><span className="eyebrow">Available storage</span><h2>Choose a drive</h2></div><RefreshCw size={18} /></div>
      <div className="drive-grid">{drives.map((drive) => { const used = drive.totalBytes - drive.freeBytes; return <button className="drive-card" key={drive.root} onClick={() => onScan(drive.root)}>
        <div className="drive-card-head"><span className="drive-icon"><HardDrive size={21} /></span><div><strong>{drive.label}</strong><small>{drive.type}</small></div><ChevronRight size={18} /></div>
        <div className="capacity-bar"><span style={{ width: percent(used, drive.totalBytes) }} /></div>
        <div className="drive-meta"><span>{formatBytes(used, settings.unit)} used</span><span>{formatBytes(drive.freeBytes, settings.unit)} free</span></div>
      </button>; })}</div>
    </div>
  </div>;
}

function Metric({ label, value, hint, accent, onClick }: { label: string; value: string; hint: string; accent: string; onClick?: () => void }) {
  return <button className={`metric-card ${onClick ? 'clickable-card' : ''}`} onClick={onClick} disabled={!onClick}><span className={`metric-accent ${accent}`} /><span className="metric-label">{label}</span><strong>{value}</strong><small>{hint}</small></button>;
}

function Overview({ summary, settings, topCategory, onFolder, onFile }: {
  summary: ScanSummary; settings: AppSettings; topCategory?: ScanSummary['categories'][number]; onFolder(node: FileNode): void; onFile(node: FileNode): void;
}) {
  const total = summary.totalBytes;
  const topFive = summary.topFiles.slice(0, 5).reduce((sum, node) => sum + node.size, 0);
  return <>
    <div className="insight-banner"><div className="insight-icon"><BarChart3 size={22} /></div><div><span className="eyebrow">Storage insight</span><strong>{topCategory ? `${topCategory.name} use ${percent(topCategory.size, total)} of scanned space.` : 'BlockIT is learning where your space is going.'}</strong><p>{summary.topFiles.length ? `Your ${Math.min(5,summary.topFiles.length)} largest file(s) account for ${formatBytes(topFive, settings.unit)}. Review them below—nothing is removed automatically.` : 'Useful insights will appear as files are indexed.'}</p></div></div>
    <div className="overview-grid">
      <section className="panel"><div className="panel-heading"><div><span className="eyebrow">Folders</span><h2>Top space consumers</h2></div></div>
        <div className="rank-list">{summary.topFolders.map((node) => <button key={node.id} onClick={() => onFolder(node)}><span className="folder-chip"><FolderOpen size={16} /></span><span className="rank-name"><strong>{node.name}</strong><small>{node.itemCount.toLocaleString()} items</small></span><span className="rank-value"><strong>{formatBytes(node.size, settings.unit)}</strong><small>{percent(node.size, total)}</small></span><ChevronRight size={16} /></button>)}{summary.topFolders.length === 0 && <div className="empty-table">Folder totals appear when the scan completes.</div>}</div>
      </section>
      <section className="panel"><div className="panel-heading"><div><span className="eyebrow">Files</span><h2>Largest individual files</h2></div></div>
        <div className="rank-list">{summary.topFiles.map((node) => <button key={node.id} onClick={() => onFile(node)}><span className="file-color" style={{ background: categoryColors[node.category] }} /><span className="rank-name"><strong>{node.name}</strong><small>{node.category}</small></span><span className="rank-value"><strong>{formatBytes(node.size, settings.unit)}</strong><small>{node.extension || 'file'}</small></span></button>)}{summary.topFiles.length === 0 && <div className="empty-table">Largest files will appear during the scan.</div>}</div>
      </section>
    </div>
    {settings.showFileTypes && <section className="panel"><div className="panel-heading"><div><span className="eyebrow">File types</span><h2>What kind of data is this?</h2></div></div><div className="category-bars">{summary.categories.slice(0, 9).map((item) => <div key={item.name}><span>{item.name}</span><div><i style={{ width: percent(item.size, total), background: categoryColors[item.name as FileCategory] || categoryColors.Other }} /></div><strong>{formatBytes(item.size, settings.unit)}</strong></div>)}</div></section>}
  </>;
}

function SettingsPanel({ settings, onChange, onClose, onElevate }: { settings: AppSettings; onChange(patch: Partial<AppSettings>): void; onClose(): void; onElevate?: () => void }) {
  const toggle = (key: keyof AppSettings, label: string) => <label className="toggle-row"><span>{label}</span><input type="checkbox" checked={Boolean(settings[key])} onChange={(event) => onChange({ [key]: event.target.checked })} /></label>;
  return <div className="drawer-backdrop" onMouseDown={onClose}><aside className="settings-drawer" onMouseDown={(event) => event.stopPropagation()}>
    <div className="drawer-head"><div><span className="eyebrow">Preferences</span><h2>Settings</h2></div><button className="icon-button" onClick={onClose}><X size={19} /></button></div>
    <section><h3>Appearance</h3><label className="field-row"><span>Theme</span><select value={settings.theme} onChange={(event) => onChange({ theme: event.target.value as AppSettings['theme'] })}><option value="dark">Dark</option><option value="light">Light</option></select></label><label className="field-row"><span>Size units</span><select value={settings.unit} onChange={(event) => onChange({ unit: event.target.value as AppSettings['unit'] })}>{['dynamic', 'bytes', 'KB', 'MB', 'GB', 'TB'].map((unit) => <option key={unit}>{unit}</option>)}</select></label>{toggle('showHeader', 'Show summary cards')}{toggle('showFileTypes', 'Show file-type breakdown')}{toggle('showTreemap', 'Show treemap')}</section>
    <section><h3>Treemap</h3>{toggle('showLabels', 'Show names and sizes')}{toggle('showFreeSpace', 'Show free space')}{toggle('useAllocatedSize', 'Use estimated disk usage')}<p className="helper">Disk usage is estimated from the volume allocation unit. Compressed and sparse files can differ.</p></section>
    <section><h3>Safety</h3><p className="helper">Recycle Bin actions always require confirmation. BlockIT has no permanent delete or automatic file-moving command.</p>{onElevate && <button className="ghost-button full" onClick={onElevate}><ShieldCheck size={16} /> Rescan as administrator</button>}</section>
  </aside></div>;
}

function WarningsDialog({ warnings, onClose }: { warnings: Array<{ path: string; message: string }>; onClose(): void }) {
  return <div className="modal-backdrop"><div className="modal warning-modal"><span className="modal-icon warning"><AlertTriangle size={22} /></span><h2>Skipped items</h2><p>BlockIT continued safely when Windows denied access or an item changed during scanning.</p><div className="warning-list">{warnings.map((warning, index) => <div key={`${warning.path}-${index}`}><strong>{warning.path}</strong><span>{warning.message}</span></div>)}</div><div className="modal-actions"><button className="primary-button" onClick={onClose}>Done</button></div></div></div>;
}

export default App;
