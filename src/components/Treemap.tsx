import { memo, useEffect, useId, useMemo, useRef, useState } from 'react';
import { hierarchy, treemap } from 'd3-hierarchy';
import { Download, Focus, RotateCcw, Search, ArrowUpRight } from 'lucide-react';
import { formatBytes } from '../shared/format';
import { blockColor, blockColors, readableText } from '../shared/treemap';
import type { AppSettings, TreemapNode } from '../shared/types';

interface TreemapProps {
  nodes: TreemapNode[];
  title: string;
  settings: AppSettings;
  canReset: boolean;
  onOpen(node: TreemapNode): void;
  onReset(): void;
  onExport(dataUrl: string): Promise<void>;
}
interface LayoutDatum { node?: TreemapNode; children?: LayoutDatum[]; }

export const TreemapView = memo(function TreemapView({ nodes, title, settings, canReset, onOpen, onReset, onExport }: TreemapProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const instance = useId().replace(/:/g,'');
  const [activeId, setActiveId] = useState<number | null>(null);
  const [mode, setMode] = useState<'item' | 'type'>('item');
  const [search, setSearch] = useState('');
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  useEffect(()=>{setActiveId(null);setSearch('');},[nodes[0]?.parentId]);
  const colors = useMemo(() => blockColors(nodes), [nodes]);
  const sizeOf = (node: TreemapNode) => settings.useAllocatedSize ? node.allocatedSize : node.size;
  const total = nodes.reduce((sum,node) => sum+sizeOf(node),0);
  const share = (node:TreemapNode) => total > 0 ? (sizeOf(node)/total*100).toFixed(1)+'%' : '0%';
  const active = nodes.find(node => node.id===activeId);
  const matches = (node:TreemapNode) => node.name.toLowerCase().includes(search.trim().toLowerCase());
  const matched = nodes.filter(matches).length;
  const leaves = useMemo(() => {
    const root = hierarchy<LayoutDatum>({ children: nodes.filter(node => (settings.useAllocatedSize ? node.allocatedSize : node.size)>0).map(node => ({node})) })
      .sum(datum => datum.node ? (settings.useAllocatedSize ? datum.node.allocatedSize : datum.node.size) : 0)
      .sort((a,b) => (b.value||0)-(a.value||0));
    return treemap<LayoutDatum>().size([1200,560]).paddingInner(6).paddingOuter(6).round(true)(root).leaves().filter(leaf=>leaf.data.node);
  }, [nodes,settings.useAllocatedSize]);
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
      const canvas=document.createElement('canvas');canvas.width=2400;canvas.height=1120;
      const context=canvas.getContext('2d');
      if(!context) throw new Error('Image export is unavailable');
      context.drawImage(picture,0,0,canvas.width,canvas.height);
      await onExport(canvas.toDataURL('image/png'));
    } catch { setExportError('Could not save the image. Please try again.'); }
    finally { if(url) URL.revokeObjectURL(url);setExporting(false); }
  };

  return <section className="panel treemap-panel">
    <div className="panel-heading">
      <div><h2>{title}</h2><p className="map-hint">Bigger blocks use more space. Select a folder to look inside.</p></div>
      <div className="toolbar compact">
        {canReset && <button className="ghost-button" onClick={onReset}><RotateCcw size={16}/> Back to root</button>}
        <button className="ghost-button" disabled={exporting || !leaves.length} onClick={()=>void savePng()}><Download size={16}/> {exporting?'Saving…':'Save image'}</button>
      </div>
    </div>
    <div className="map-controls">
      <div className="map-segments" role="group" aria-label="Colour blocks by">
        <button aria-pressed={mode==='item'} onClick={()=>setMode('item')}>Distinct blocks</button>
        <button aria-pressed={mode==='type'} onClick={()=>setMode('type')}>File types</button>
      </div>
      <label className="map-search"><Search size={15}/><input aria-label="Find a block" value={search} onChange={event=>setSearch(event.target.value)} onKeyDown={event=>{if(event.key==='Escape')setSearch('');}} placeholder="Find a block…"/></label>
      <span className="map-caption">{search ? matched+' matching blocks' : nodes.length+' blocks · '+formatBytes(total,settings.unit)}</span>
    </div>
    {mode==='type' && <p className="map-mode-note">Files share their category colour. Folders keep distinct colours.</p>}
    {exportError && <p role="alert" className="map-mode-note">{exportError}</p>}
    {!leaves.length ? <div className="empty-visual"><Focus size={34}/><span>No sized items yet. Empty items remain available in the list below.</span></div> :
      <div className="treemap-wrap">
        <svg ref={svgRef} viewBox="0 0 1200 560" role="group" aria-label={'Interactive storage map for '+title}>
          <defs>
            <pattern id={instance+'-free'} width="12" height="12" patternUnits="userSpaceOnUse">
              <rect width="12" height="12" fill="#dbe7de"/>
              <path d="M-3 3L3-3 M0 12L12 0 M9 15L15 9" stroke="#b7cabc" strokeWidth="1.5"/>
            </pattern>
          </defs>
          <rect width="1200" height="560" fill={background}/>
          {leaves.map((leaf,index)=>{
            const node=leaf.data.node!, width=leaf.x1-leaf.x0, height=leaf.y1-leaf.y0;
            const color=blockColor(node,colors,mode), ink=readableText(color);
            const free=node.syntheticKind==='free', active=node.id===activeId;
            const clip=instance+'-clip-'+index;
            const titleLimit=Math.max(3,Math.floor((width-28)/8));
            const label=node.name.length>titleLimit?node.name.slice(0,titleLimit-1)+'…':node.name;
            const hint=free?'Available on this drive':node.synthetic?'Smaller items grouped together':node.kind==='folder'?'Open folder →':'View file details →';
            return <g key={node.id} transform={'translate('+leaf.x0+','+leaf.y0+')'} role={node.synthetic?'group':'button'}
              aria-label={node.name+', '+formatBytes(sizeOf(node),settings.unit)+', '+share(node)+' of displayed space. '+hint}
              tabIndex={0} data-node-id={node.id} data-kind={free?'free':node.kind}
              opacity={matches(node)?1:.22} className="treemap-cell"
              onMouseEnter={()=>setActiveId(node.id)} onMouseLeave={()=>setActiveId(null)}
              onFocus={()=>setActiveId(node.id)} onBlur={()=>setActiveId(null)}
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
              <title>{node.name+' — '+formatBytes(sizeOf(node),settings.unit)+' ('+share(node)+')'}</title>
              <defs><clipPath id={clip}><rect x="10" y="8" width={Math.max(0,width-20)} height={Math.max(0,height-16)}/></clipPath></defs>
              <rect className="block-outline" x="1.5" y="1.5" width={Math.max(0,width-3)} height={Math.max(0,height-3)} rx="8"
                fill={free?'url(#'+instance+'-free)':color} stroke={active?ink:background} strokeWidth={active?3:1}/>
              {settings.showLabels && width>70 && height>42 && <g clipPath={'url(#'+clip+')'} pointerEvents="none" fill={ink} fontFamily="Segoe UI, sans-serif">
                <text x="14" y="27" fontSize="14" fontWeight="700">{label}</text>
                <text x="14" y="47" fontSize="12">{formatBytes(sizeOf(node),settings.unit)+(width>165?' · '+share(node):'')}</text>
                {width>165 && height>110 && <text x="14" y={height-20} fontSize="11" opacity=".9">{hint}</text>}
              </g>}
            </g>;
          })}
        </svg>
      </div>}
    <div className="map-details" aria-live="polite" aria-atomic="true">
      {active ? <><i style={{background:blockColor(active,colors,mode)}}/><strong>{active.name}</strong><span>{formatBytes(sizeOf(active),settings.unit)} · {share(active)} of displayed space</span><span className="map-caption">{active.syntheticKind==='free'?'Free space':active.synthetic?'Grouped items':active.kind==='folder'?active.fileCount.toLocaleString()+' files · '+active.folderCount.toLocaleString()+' folders':active.category}</span></> :
      <span className="map-caption">Hover or focus a block for details. Use arrow keys to move and Enter to open. Stripes indicate free space.</span>}
    </div>
    <details className="map-block-list">
      <summary>All blocks ({nodes.length}) <span>Find and open even the smallest items</span></summary>
      <div>{nodes.filter(matches).map(node=><button key={node.id} onClick={()=>activate(node)} className="map-list-item" aria-label={'Inspect '+node.name}>
        <i style={{background:blockColor(node,colors,mode),border:node.syntheticKind==='free'?'1px dashed #637d68':undefined}}/>
        <strong>{node.name}</strong><span>{formatBytes(sizeOf(node),settings.unit)}</span><small>{share(node)}</small>{!node.synthetic&&<ArrowUpRight size={14}/>}
      </button>)}</div>
    </details>
  </section>;
});
