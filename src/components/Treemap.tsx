import { memo, useEffect, useId, useMemo, useRef, useState } from 'react';
import { hierarchy, treemap } from 'd3-hierarchy';
import { Download, Focus, RotateCcw, Search, ArrowUpRight, Layers, SlidersHorizontal, Copy, Maximize2, Minimize2 } from 'lucide-react';
import { formatBytes } from '../shared/format';
import { blockColor, readableText, adjacentColors, flattenNodes, metricColor, sizeColors, ageColors, levelColors, blockPalette, type ColorMode } from '../shared/treemap';
import { categoryColors } from '../shared/categories';
import type { AppSettings, TreemapNode } from '../shared/types';

interface TreemapProps {
  fullscreen: boolean;
  onToggleFullscreen(): void;
  loading?: boolean;
  depth: number;
  onDepthChange(depth: number): void;
  nodes: TreemapNode[];
  title: string;
  settings: AppSettings;
  canReset: boolean;
  onOpen(node: TreemapNode): void;
  onCopyPath(node: TreemapNode): Promise<void>;
  onReset(): void;
  onExport(dataUrl: string): Promise<void>;
}
interface LayoutDatum { node?: TreemapNode; children?: LayoutDatum[]; }

export const TreemapView = memo(function TreemapView({ fullscreen, onToggleFullscreen, loading, depth, onDepthChange, nodes, title, settings, canReset, onOpen, onReset, onExport, onCopyPath }: TreemapProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [mapSize, setMapSize] = useState({width:1200,height:560});
  const [minimum, setMinimum] = useState(0);
  useEffect(() => {
    if (!fullscreen) {setMapSize({width:1200,height:560});return;}
    const wrap=wrapRef.current;
    if (!wrap) return;
    const observer=new ResizeObserver(() => {
      const width=Math.max(1,wrap.clientWidth-16)*zoom;
      const height=Math.max(1,wrap.clientHeight-16)*zoom;
      setMapSize(previous=>previous.width===width && previous.height===height ? previous : {width,height});
    });
    observer.observe(wrap);
    return ()=>observer.disconnect();
  },[fullscreen,loading,nodes.length===0,zoom,minimum]);
  const instance = useId().replace(/:/g,'');
  const [activeId, setActiveId] = useState<number | null>(null);
  const [mode, setMode] = useState<ColorMode>('item');
  const [search, setSearch] = useState('');
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  useEffect(()=>{setActiveId(null);setSearch('');setZoom(1);},[nodes[0]?.parentId,fullscreen]);
  const allNodes = useMemo(() => flattenNodes(nodes), [nodes]);
  const sizeOf = (node: TreemapNode) => settings.useAllocatedSize ? node.allocatedSize : node.size;
  const total = nodes.reduce((sum,node) => sum+sizeOf(node),0);
  const share = (node:TreemapNode) => total > 0 ? (sizeOf(node)/total*100).toFixed(1)+'%' : '0%';
  const active = allNodes.find(node => node.id===activeId);
  const matches = (node:TreemapNode) => (node.name+' '+node.path).toLowerCase().includes(search.trim().toLowerCase());
  const matched = allNodes.filter(matches).length;
  const leaves = useMemo(() => {
    const build = (items: TreemapNode[], level: number): LayoutDatum[] => items
      .filter(node => sizeOf(node) > 0)
      .map(node => {
        const children = level < depth ? build(node.children || [], level + 1) : [];
        return children.length ? { node, children } : { node };
      });
    const root = hierarchy<LayoutDatum>({ children: build(nodes, 1) })
      .sum(datum => datum.children ? 0 : datum.node ? sizeOf(datum.node) : 0)
      .sort((a,b) => (b.value||0)-(a.value||0));
    return treemap<LayoutDatum>().size([mapSize.width,mapSize.height]).paddingInner(6).paddingOuter(6)
      .paddingTop(node => node.depth > 0 ? 32 : 6).round(true)(root)
      .descendants().filter(leaf => leaf.data.node && (leaf.data.node.synthetic || sizeOf(leaf.data.node) >= minimum));
  }, [nodes,settings.useAllocatedSize,depth,minimum,mapSize]);
  const colors = useMemo(() => adjacentColors(leaves.map(leaf => ({ ...leaf, node: leaf.data.node! }))), [leaves]);
  const colorOf = (node: TreemapNode, level = leaves.find(leaf => leaf.data.node?.id === node.id)?.depth || 1) =>
    (!node.synthetic && metricColor(node, mode, sizeOf(node), level)) || blockColor(node, colors, mode === 'type' ? 'type' : 'item');
  const legend = mode === 'type' ? Object.entries(categoryColors).map(([label,color])=>({label,color})) :
    (mode === 'size' ? sizeColors : mode === 'age' ? ageColors : mode === 'level' ? levelColors : blockPalette.slice(0,6))
      .map((color,index)=>({color,label: mode === 'size' ? ['< 1 MB','1 MB–1 GB','1 GB–1 TB','≥ 1 TB'][index] :
        mode === 'age' ? ['< 30 days','30–180 days','180–365 days','≥ 1 year','Unknown'][index] :
        mode === 'level' ? 'Level '+(index+1) : 'block '+(index+1)}));
  const background = settings.theme==='dark' ? '#1b2322' : '#f3f5ef';
  const activate = (node:TreemapNode) => {
    setActiveId(node.id);
    if(!node.synthetic) { setSearch(''); onOpen(node); }
  };
  const savePng = async () => {
    if(!svgRef.current || exporting) return;
    setExporting(true);setExportError('');
    let url='';
    try {
      const clone=svgRef.current.cloneNode(true) as SVGSVGElement;
      clone.setAttribute('xmlns','http://www.w3.org/2000/svg');
      // Export the complete map, independent of transient hover/search highlighting.
      clone.querySelectorAll('.treemap-cell').forEach(cell=>cell.setAttribute('opacity','1'));
      clone.querySelectorAll('.block-outline').forEach(outline=>{outline.setAttribute('stroke',background);outline.setAttribute('stroke-width','1');});
      url=URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)],{type:'image/svg+xml;charset=utf-8'}));
      const picture=new Image();
      await new Promise<void>((resolve,reject)=>{picture.onload=()=>resolve();picture.onerror=()=>reject(new Error('Image rendering failed'));picture.src=url;});
      const scale=Math.min(2,4096/Math.max(mapSize.width,mapSize.height));
      const canvas=document.createElement('canvas');canvas.width=Math.round(mapSize.width*scale);canvas.height=Math.round(mapSize.height*scale);
      const context=canvas.getContext('2d');
      if(!context) throw new Error('Image export is unavailable');
      context.drawImage(picture,0,0,canvas.width,canvas.height);
      await onExport(canvas.toDataURL('image/png'));
    } catch { setExportError('Could not save the image. Please try again.'); }
    finally { if(url) URL.revokeObjectURL(url);setExporting(false); }
  };

  return <section className="panel treemap-panel">
    <div className="panel-heading">
      <div><h2>{title}</h2><p className="map-hint">Bigger blocks use more space. Nested blocks show what is inside each folder.</p></div>
      <div className="toolbar compact">
        <button className="ghost-button map-fullscreen-toggle" aria-pressed={fullscreen} onClick={onToggleFullscreen} title={fullscreen ? 'Exit fullscreen (Esc)' : 'Expand treemap to fullscreen'}>{fullscreen ? <Minimize2 size={16}/> : <Maximize2 size={16}/>} {fullscreen ? 'Exit fullscreen' : 'Fullscreen'}</button>
        {canReset && <button className="ghost-button" onClick={onReset}><RotateCcw size={16}/> Back to root</button>}
        <button className="ghost-button" disabled={exporting || !leaves.length} onClick={()=>void savePng()}><Download size={16}/> {exporting?'Saving…':'Save image'}</button>
      </div>
    </div>
    <div className="map-controls">
      <div className="map-segments" role="group" aria-label="Colour blocks by">
        {([['item','Distinct'],['type','Types'],['size','Size'],['age','Age'],['level','Levels']] as const).map(([value,label]) =>
          <button key={value} aria-pressed={mode===value} onClick={()=>setMode(value)}>{label}</button>)}
      </div>
      <div className="map-segments" role="group" aria-label="Nesting depth">
        {[1,2,3].map(value=><button key={value} aria-label={'Show '+value+' levels'} aria-pressed={depth===value} onClick={()=>onDepthChange(value)}><Layers size={15}/> {value}</button>)}
      </div>
      <label className="map-search"><Search size={15}/><input aria-label="Find a block" value={search} onChange={event=>setSearch(event.target.value)} onKeyDown={event=>{if(event.key==='Escape')setSearch('');}} placeholder="Find a block…"/></label>
      <label className="map-size-filter"><SlidersHorizontal size={16}/><input type="range" aria-label="Minimum block size" min="0" max="6" step="1" value={[0,1024,1024**2,10*1024**2,100*1024**2,1024**3,10*1024**3].indexOf(minimum)} onChange={event=>setMinimum([0,1024,1024**2,10*1024**2,100*1024**2,1024**3,10*1024**3][Number(event.target.value)])}/><span>{minimum ? '≥ '+formatBytes(minimum,settings.unit) : 'All'}</span></label>
      {fullscreen && <div className="map-segments map-zoom" role="group" aria-label="Map zoom">
        <button aria-label="Zoom out" disabled={zoom===1} onClick={()=>setZoom(value=>Math.max(1,value-.5))}>-</button>
        <button aria-label="Fit map" title="Fit all blocks on screen" onClick={()=>setZoom(1)}>{Math.round(zoom*100)}% / Fit</button>
        <button aria-label="Zoom in" disabled={zoom===4} onClick={()=>setZoom(value=>Math.min(4,value+.5))}>+</button>
      </div>}
      <span className="map-caption">{search ? matched+' matching blocks' : leaves.length+' blocks · '+formatBytes(total,settings.unit)}</span>
    </div>
    <div className="map-legend" aria-label="Colour legend"><span>{mode==='item' ? 'Adjacent folders use different colours' : mode==='type' ? 'File categories; folders keep distinct colours' : mode==='age' ? 'Time since last modification' : mode==='size' ? 'Block size' : 'Depth below the current folder'}</span>{legend.map(({label,color})=><span key={label}><i style={{background:color}}/>{label}</span>)}</div>
    {exportError && <p role="alert" className="map-mode-note">{exportError}</p>}
    {!leaves.length ? <div className="empty-visual"><Focus size={34}/><span>{minimum ? 'No blocks meet this size. Lower the minimum or use the list below.' : loading ? 'Preparing your storage map…' : 'No sized items yet. Empty items remain available in the list below.'}</span></div> :
      <div className="treemap-wrap" ref={wrapRef}>
        <svg ref={svgRef} style={fullscreen ? {width:mapSize.width,height:mapSize.height} : undefined} viewBox={`0 0 ${mapSize.width} ${mapSize.height}`} role="group" aria-label={'Interactive storage map for '+title}>
          <rect width={mapSize.width} height={mapSize.height} fill={background}/>
          {leaves.map((leaf,index)=>{
            const node=leaf.data.node!, width=leaf.x1-leaf.x0, height=leaf.y1-leaf.y0;
            const color=colorOf(node,leaf.depth), ink=readableText(color);
            const active=node.id===activeId;
            const compact=fullscreen && (width<140 || height<65);
            const inset=compact?5:14, font=compact?10:14;
            const clip=instance+'-clip-'+index;
            const titleLimit=Math.max(3,Math.floor((width-inset*2)/(font*.58)));
            const label=node.name.length>titleLimit?node.name.slice(0,titleLimit-1)+'…':node.name;
            const hint=node.synthetic?'Smaller items grouped together':node.kind==='folder'?'Open folder →':'View file details →';
            return <g key={node.id} transform={'translate('+leaf.x0+','+leaf.y0+')'} role={node.synthetic?'group':'button'}
              aria-label={node.name+', '+formatBytes(sizeOf(node),settings.unit)+', '+share(node)+' of displayed space. '+hint}
              tabIndex={0} data-node-id={node.id} data-kind={node.kind}
              opacity={matches(node)?1:.22} className="treemap-cell"
              onMouseEnter={()=>setActiveId(node.id)}
              onFocus={()=>setActiveId(node.id)}
              onClick={()=>activate(node)}
              onKeyDown={event=>{
                if(event.key==='Enter'||event.key===' ') {event.preventDefault();activate(node);}
                if(event.key==='Escape') {setActiveId(null);setSearch('');}
                if(['ArrowRight','ArrowDown','ArrowLeft','ArrowUp'].includes(event.key)) {
                  event.preventDefault();
                  const step=event.key==='ArrowRight'||event.key==='ArrowDown'?1:-1;
                  const cells=svgRef.current?.querySelectorAll<SVGGElement>('.treemap-cell');
                  cells?.[(index+step+leaves.length)%leaves.length]?.focus();
                }
              }}>
              <title>{node.name+' — '+formatBytes(sizeOf(node),settings.unit)+' ('+share(node)+')'+(!node.synthetic && node.path ? '\n'+node.path : '')}</title>
              <defs><clipPath id={clip}><rect x={compact?4:10} y={compact?3:8} width={Math.max(0,width-(compact?8:20))} height={Math.max(0,height-(compact?6:16))}/></clipPath></defs>
              <rect className="block-outline" x="1.5" y="1.5" width={Math.max(0,width-3)} height={Math.max(0,height-3)} rx="8"
                fill={color} stroke={active?ink:background} strokeWidth={active?3:1}/>
              {settings.showLabels && width>(fullscreen?32:70) && height>(fullscreen?18:42) && <g clipPath={'url(#'+clip+')'} pointerEvents="none" fill={ink} fontFamily="Segoe UI, sans-serif">
                <text x={inset} y={compact?15:27} fontSize={font} fontWeight="700">{label}</text>
                {!leaf.children && height>(compact?33:50) && <text x={inset} y={compact?29:47} fontSize={compact?10:12}>{formatBytes(sizeOf(node),settings.unit)+(width>165?' · '+share(node):'')}</text>}
                {!leaf.children && width>165 && height>110 && <text x="14" y={height-20} fontSize="11" opacity=".9">{hint}</text>}
              </g>}
            </g>;
          })}
        </svg>
      </div>}
    <div className="map-details" data-active={!!active} aria-live="polite" aria-atomic="true">
      {active ? <><i style={{background:colorOf(active)}}/><strong>{active.name}</strong><span>{formatBytes(sizeOf(active),settings.unit)} · {share(active)} of displayed space</span><span className="map-caption">{active.synthetic?'Grouped items':active.kind==='folder'?active.fileCount.toLocaleString()+' files · '+active.folderCount.toLocaleString()+' folders':active.category}</span>{!active.synthetic && active.path && <div className="map-path-row"><span className="map-path" title={active.path}>{active.path}</span><button className="ghost-button map-copy-path" onClick={()=>void onCopyPath(active)} aria-label="Copy displayed path"><Copy size={15}/> Copy path</button></div>}</> :
      <span className="map-caption">Hover or focus a block for details. Use arrow keys to move, Enter to open, Escape to clear. Zoom in or use All blocks for smaller items.</span>}
    </div>
    <details className="map-block-list">
      <summary>All blocks ({allNodes.length}) <span>Find and open even the smallest items</span></summary>
      <div>{allNodes.filter(matches).map(node=><button key={node.id} onClick={()=>activate(node)} onFocus={()=>setActiveId(node.id)} onMouseEnter={()=>setActiveId(node.id)} title={node.path || node.name} className="map-list-item" aria-label={'Inspect '+node.name}>
        <i style={{background:colorOf(node)}}/>
        <strong>{node.name}</strong><span>{formatBytes(sizeOf(node),settings.unit)}</span><small>{share(node)}</small>{!node.synthetic&&<ArrowUpRight size={14}/>}
      </button>)}</div>
    </details>
  </section>;
});
