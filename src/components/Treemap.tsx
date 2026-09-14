import { memo, useEffect, useId, useMemo, useRef, useState } from 'react';
import { hierarchy, treemap } from 'd3-hierarchy';
import { Download, Focus, RotateCcw, Search, ArrowUpRight, Layers, SlidersHorizontal } from 'lucide-react';
import { formatBytes } from '../shared/format';
import { ageSpan, blockColors, colorModeLabels, legendFor, readableText, treemapFill, type TreemapColorMode } from '../shared/treemap';
import type { AppSettings, TreemapNode } from '../shared/types';

interface TreemapProps {
  nodes: TreemapNode[];
  title: string;
  settings: AppSettings;
  depth: number;
  canReset: boolean;
  onDepthChange(depth: number): void;
  onOpen(node: TreemapNode): void;
  onReset(): void;
  onExport(dataUrl: string): Promise<void>;
}

interface Datum { node: TreemapNode | null; children: Datum[] }
interface Cell { node: TreemapNode; x: number; y: number; width: number; height: number; depth: number; container: boolean; share: number }

const WIDTH = 1200;
const HEIGHT = 560;

function toDatum(nodes: TreemapNode[]): Datum[] {
  return nodes.map(node => ({ node, children: node.children?.length ? toDatum(node.children) : [] }));
}
function flatten(nodes: TreemapNode[]): TreemapNode[] {
  const out: TreemapNode[] = [];
  const walk = (list: TreemapNode[]) => { for (const node of list) { out.push(node); if (node.children) walk(node.children); } };
  walk(nodes);
  return out;
}

export const TreemapView = memo(function TreemapView({ nodes, title, settings, depth, canReset, onDepthChange, onOpen, onReset, onExport }: TreemapProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const instance = useId().replace(/:/g, '');
  const [activeId, setActiveId] = useState<number | null>(null);
  const [mode, setMode] = useState<TreemapColorMode>('item');
  const [search, setSearch] = useState('');
  const [minShare, setMinShare] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  useEffect(() => { setActiveId(null); setSearch(''); }, [nodes[0]?.parentId, depth]);

  const every = useMemo(() => flatten(nodes), [nodes]);
  const colors = useMemo(() => blockColors(nodes), [nodes]);
  const sizeOf = (node: TreemapNode) => settings.useAllocatedSize ? node.allocatedSize : node.size;
  const total = nodes.reduce((sum, node) => sum + sizeOf(node), 0);
  const share = (node: TreemapNode) => total > 0 ? (sizeOf(node) / total * 100).toFixed(1) + '%' : '0%';
  const active = every.find(node => node.id === activeId) ?? nodes.find(node => node.id === activeId);
  const now = useMemo(() => Date.now(), [nodes]);
  const maxSize = useMemo(() => every.reduce((max, node) => Math.max(max, sizeOf(node)), 0), [every, settings.useAllocatedSize]);
  const span = useMemo(() => ageSpan(every, now), [every, now]);
  const matches = (node: TreemapNode) => node.name.toLowerCase().includes(search.trim().toLowerCase());
  const matched = every.filter(matches).length;
  const legend = useMemo(() => legendFor(mode), [mode]);

  const laid = useMemo<Cell[]>(() => {
    const usable = nodes.filter(node => sizeOf(node) > 0);
    if (!usable.length) return [];
    // A synthetic root holds every top-level node as a sibling; internal nodes
    // take their value from their children so rolled-up folder sizes are not
    // counted twice.
    const outer = hierarchy<Datum>({ node: null, children: toDatum(usable) }, datum => datum.children)
      .sum(datum => (datum.children && datum.children.length) ? 0 : sizeOf((datum as Datum).node!))
      .sort((a, b) => (b.value || 0) - (a.value || 0));
    const laidOut = treemap<Datum>()
      .size([WIDTH, HEIGHT])
      .paddingOuter(node => node.depth === 0 ? 10 : 3)
      .paddingInner(node => node.depth === 0 ? 10 : 3)
      .paddingTop(node => (node.depth >= 1 && node.children && node.children.length) ? 20 : 0)
      .round(true)(outer);
    return laidOut.descendants().filter(node => node.depth >= 1 && (node.data as Datum).node).map(node => ({
      node: (node.data as Datum).node!,
      x: node.x0, y: node.y0, width: node.x1 - node.x0, height: node.y1 - node.y0,
      depth: node.depth, container: Boolean(node.children && node.children.length),
      share: (node.value || 0) / (outer.value || 1) * 100,
    }));
  }, [nodes, settings.useAllocatedSize]);

  const dimmed = (cell: Cell) => minShare > 0 && cell.share < minShare;
  const hiddenCount = laid.filter(dimmed).length;
  const background = settings.theme === 'dark' ? '#1b2322' : '#f4efe4';
  const frame = settings.theme === 'dark' ? '#e9e2d2' : '#5b4a33';

  const activate = (node: TreemapNode) => {
    setActiveId(node.id);
    if (!node.synthetic) { setSearch(''); onOpen(node); }
  };
  const trackPointer = (event: React.MouseEvent) => {
    const tip = tipRef.current, wrap = wrapRef.current;
    if (!tip || !wrap) return;
    const rect = wrap.getBoundingClientRect();
    const flip = event.clientX - rect.left > rect.width - 340;
    tip.style.transform = `translate(${Math.round(event.clientX - rect.left + (flip ? -330 : 16))}px, ${Math.round(event.clientY - rect.top + 16)}px)`;
  };
  const savePng = async () => {
    if (!svgRef.current || exporting) return;
    setExporting(true); setExportError('');
    let url = '';
    try {
      const clone = svgRef.current.cloneNode(true) as SVGSVGElement;
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      // Export the complete map, independent of transient hover/search highlighting.
      clone.querySelectorAll('.treemap-cell').forEach(cell => cell.setAttribute('opacity', '1'));
      clone.querySelectorAll('.block-outline').forEach(outline => { outline.setAttribute('stroke', background); outline.setAttribute('stroke-width', '1'); });
      url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml;charset=utf-8' }));
      const picture = new Image();
      await new Promise<void>((resolve, reject) => { picture.onload = () => resolve(); picture.onerror = () => reject(new Error('Image rendering failed')); picture.src = url; });
      const canvas = document.createElement('canvas'); canvas.width = 2400; canvas.height = 1120;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Image export is unavailable');
      context.drawImage(picture, 0, 0, canvas.width, canvas.height);
      await onExport(canvas.toDataURL('image/png'));
    } catch { setExportError('Could not save the image. Please try again.'); }
    finally { if (url) URL.revokeObjectURL(url); setExporting(false); }
  };

  return <section className="panel treemap-panel">
    <div className="panel-heading">
      <div><h2>{title}</h2><p className="map-hint">Bigger blocks use more space. Nested blocks show what is inside each folder.</p></div>
      <div className="toolbar compact">
        {canReset && <button className="ghost-button" onClick={onReset}><RotateCcw size={16} /> Back to root</button>}
        <button className="ghost-button" disabled={exporting || !laid.length} onClick={() => void savePng()}><Download size={16} /> {exporting ? 'Saving…' : 'Save image'}</button>
      </div>
    </div>
    <div className="map-controls">
      <div className="map-segments" role="group" aria-label="Colour blocks by">
        {(Object.keys(colorModeLabels) as TreemapColorMode[]).map(key =>
          <button key={key} aria-pressed={mode === key} onClick={() => setMode(key)}>{colorModeLabels[key]}</button>)}
      </div>
      <div className="map-segments" role="group" aria-label="Nesting depth">
        {[1, 2, 3].map(level =>
          <button key={level} aria-pressed={depth === level} onClick={() => onDepthChange(level)}><Layers size={13} />{level}</button>)}
      </div>
      <label className="map-search"><Search size={15} /><input aria-label="Find a block" value={search} onChange={event => setSearch(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') setSearch(''); }} placeholder="Find a block…" /></label>
      <label className="map-filter"><SlidersHorizontal size={14} /><input aria-label="Hide blocks smaller than this share" type="range" min="0" max="12" step="0.5" value={minShare} onChange={event => setMinShare(Number(event.target.value))} /><span>{minShare > 0 ? '≥' + minShare.toFixed(1) + '%' : 'All'}</span></label>
      <span className="map-caption">{search ? matched + ' matching blocks' : laid.length + ' blocks · ' + formatBytes(total, settings.unit)}</span>
    </div>
    <div className="map-legend" aria-hidden={mode === 'item'}>
      <span className="map-legend-caption">{legend.caption}</span>
      {legend.entries.map(entry => <span key={entry.label} className="map-legend-item"><i style={{ background: entry.color }} />{entry.label}</span>)}
      {hiddenCount > 0 && <span className="map-legend-hidden">{hiddenCount} blocks below {minShare.toFixed(1)}% dimmed</span>}
    </div>
    {exportError && <p role="alert" className="map-mode-note">{exportError}</p>}
    {!laid.length ? <div className="empty-visual"><Focus size={34} /><span>No sized items yet. Empty items remain available in the list below.</span></div> :
      <div className="treemap-wrap" ref={wrapRef} onMouseMove={trackPointer}>
        <svg ref={svgRef} viewBox={'0 0 ' + WIDTH + ' ' + HEIGHT} role="group" aria-label={'Interactive storage map for ' + title}>
          <defs>
            <pattern id={instance + '-free'} width="12" height="12" patternUnits="userSpaceOnUse">
              <rect width="12" height="12" fill="#eee3c8" />
              <path d="M-3 3L3-3 M0 12L12 0 M9 15L15 9" stroke="#cbb98d" strokeWidth="1.5" />
            </pattern>
            <pattern id={instance + '-rest'} width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="8" height="8" fill="#8a8577" />
              <path d="M0 0V8" stroke="#736e60" strokeWidth="3" />
            </pattern>
          </defs>
          <rect width={WIDTH} height={HEIGHT} fill={background} />
          {laid.map((cell, index) => {
            const node = cell.node, width = cell.width, height = cell.height;
            const free = node.syntheticKind === 'free', rest = node.synthetic && !free;
            const fill = free ? 'url(#' + instance + '-free)' : rest ? 'url(#' + instance + '-rest)' : treemapFill(node, { colors, mode, maxSize, now, ageSpanMs: span, depth: cell.depth });
            const ink = readableText(free || rest ? (free ? '#eee3c8' : '#8a8577') : fill.startsWith('#') ? fill : '#cbb98d');
            const isActive = node.id === activeId;
            const clip = instance + '-clip-' + index;
            const titleLimit = Math.max(3, Math.floor((width - 28) / 7.4));
            const label = node.name.length > titleLimit ? node.name.slice(0, titleLimit - 1) + '…' : node.name;
            const hint = free ? 'Available on this drive' : rest ? 'Items folded into this block' : node.kind === 'folder' ? 'Open folder →' : 'View file details →';
            const opacity = (matches(node) ? 1 : 0.22) * (dimmed(cell) ? 0.35 : 1);
            return <g key={node.id + ':' + cell.depth} transform={'translate(' + cell.x + ',' + cell.y + ')'}
              role={node.synthetic ? 'group' : 'button'} tabIndex={0}
              className={'treemap-cell depth-' + cell.depth + (cell.container ? ' container' : ' leaf')}
              data-node-id={node.id} data-kind={free ? 'free' : node.kind} data-depth={cell.depth}
              data-container={cell.container ? 'true' : 'false'} opacity={opacity}
              aria-label={node.name + ', ' + formatBytes(sizeOf(node), settings.unit) + ', ' + share(node) + ' of displayed space. ' + hint}
              onMouseEnter={() => setActiveId(node.id)} onMouseLeave={() => setActiveId(null)}
              onFocus={() => setActiveId(node.id)} onBlur={() => setActiveId(null)}
              onClick={() => activate(node)}
              onKeyDown={event => {
                if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(node); }
                if (event.key === 'Escape') { setActiveId(null); setSearch(''); }
                if (['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(event.key)) {
                  event.preventDefault();
                  const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1;
                  const cells = svgRef.current?.querySelectorAll<SVGGElement>('.treemap-cell');
                  cells?.[(index + step + cells.length) % cells.length]?.focus();
                }
              }}>
              <title>{node.name + ' — ' + formatBytes(sizeOf(node), settings.unit) + ' (' + share(node) + ')'}</title>
              <defs><clipPath id={clip}><rect x="10" y="8" width={Math.max(0, width - 20)} height={Math.max(0, height - 16)} /></clipPath></defs>
              <rect className="block-outline" x="1.5" y="1.5" width={Math.max(0, width - 3)} height={Math.max(0, height - 3)} rx={cell.container ? 8 : 5}
                fill={fill} stroke={isActive ? frame : background} strokeWidth={isActive ? 3 : (cell.container ? 2 : 1)}
                strokeDasharray={rest ? '6 4' : undefined} />
              {settings.showLabels && cell.container && width > 54 && height > 30 && <g clipPath={'url(#' + clip + ')'} pointerEvents="none" fill={ink} fontFamily="'Segoe UI', system-ui, sans-serif">
                <text x="10" y="15" fontSize="12" fontWeight="700">{label}</text>
                {width > 150 && <text x={Math.min(width - 12, 150)} y="15" fontSize="10.5" opacity=".82">{formatBytes(sizeOf(node), settings.unit)}</text>}
              </g>}
              {settings.showLabels && !cell.container && width > 70 && height > 42 && <g clipPath={'url(#' + clip + ')'} pointerEvents="none" fill={ink} fontFamily="'Segoe UI', system-ui, sans-serif">
                <text x="13" y="26" fontSize="13.5" fontWeight="700">{label}</text>
                <text x="13" y="45" fontSize="11.5">{formatBytes(sizeOf(node), settings.unit) + (width > 165 ? ' · ' + share(node) : '')}</text>
                {width > 165 && height > 110 && <text x="13" y={height - 18} fontSize="10.5" opacity=".9">{hint}</text>}
              </g>}
            </g>;
          })}
        </svg>
        <div className={'treemap-tooltip floating' + (active ? ' visible' : '')} ref={tipRef} role="tooltip">
          {active && <><strong>{active.name}</strong>
            <span>{formatBytes(sizeOf(active), settings.unit)} · {share(active)} of displayed space · {(active.syntheticKind === 'free' ? 'Free space' : active.synthetic ? 'Grouped items' : active.kind === 'folder' ? active.fileCount.toLocaleString() + ' files · ' + active.folderCount.toLocaleString() + ' folders' : active.category)}</span>
            {active.modifiedAt > 0 && <span>Modified {new Date(active.modifiedAt).toLocaleDateString()}</span>}
            {!!active.path && <span className="tip-path">{active.path}</span>}</>}
        </div>
      </div>}
    <div className="map-details" aria-live="polite" aria-atomic="true">
      {active ? <><i style={{ background: treemapFill(active, { colors, mode, maxSize, now, ageSpanMs: span, depth: layeredDepth(active, nodes) }) }} /><strong>{active.name}</strong><span>{formatBytes(sizeOf(active), settings.unit)} · {share(active)} of displayed space</span><span className="map-caption">{active.syntheticKind === 'free' ? 'Free space' : active.synthetic ? 'Grouped items' : active.kind === 'folder' ? active.fileCount.toLocaleString() + ' files · ' + active.folderCount.toLocaleString() + ' folders' : active.category}</span></> :
        <span className="map-caption">Hover or focus a block for details. Use arrow keys to move, Enter to open, Escape to clear. Stripes indicate free space.</span>}
    </div>
    <details className="map-block-list">
      <summary>All blocks ({nodes.length}) <span>Find and open even the smallest items</span></summary>
      <div>{nodes.filter(matches).map(node => <button key={node.id} onClick={() => activate(node)} className="map-list-item" aria-label={'Inspect ' + node.name}>
        <i style={{ background: treemapFill(node, { colors, mode, maxSize, now, ageSpanMs: span, depth: 1 }), border: node.syntheticKind === 'free' ? '1px dashed #8a7443' : undefined }} />
        <strong>{node.name}</strong><span>{formatBytes(sizeOf(node), settings.unit)}</span><small>{share(node)}</small>{!node.synthetic && <ArrowUpRight size={14} />}
      </button>)}</div>
    </details>
  </section>;
});

// Depth of a node inside the visible tree, used only for the details swatch.
function layeredDepth(node: TreemapNode, nodes: TreemapNode[]): number {
  const walk = (list: TreemapNode[], level: number): number => {
    for (const item of list) {
      if (item.id === node.id) return level;
      if (item.children) { const found = walk(item.children, level + 1); if (found) return found; }
    }
    return 0;
  };
  return walk(nodes, 1) || 1;
}
