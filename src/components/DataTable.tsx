import { ChevronLeft, ChevronRight, Copy, ExternalLink, FolderOpen, Trash2 } from 'lucide-react';
import { formatBytes } from '../shared/format';
import type { AppSettings, FileNode, NodeQuery, QueryResult } from '../shared/types';

interface Props {
  result: QueryResult | null;
  settings: AppSettings;
  selected: FileNode | null;
  query: NodeQuery;
  loading?: boolean;
  error?: string;
  canRecycle?: boolean;
  onSelect(node: FileNode): void;
  onOpen(node: FileNode): void;
  onReveal(node: FileNode): void;
  onCopy(node: FileNode): void;
  onTrash(node: FileNode): void;
  onSort(sortBy: NonNullable<NodeQuery['sortBy']>): void;
  onPage(page: number): void;
}

export function DataTable({ result, settings, selected, query, loading, error, canRecycle, onSelect, onOpen, onReveal, onCopy, onTrash, onSort, onPage }: Props) {
  const sizeField = settings.useAllocatedSize ? 'allocatedSize' : 'size';
  const header = (label: string, key: NonNullable<NodeQuery['sortBy']>) => (
    <button className="table-sort" onClick={() => onSort(key)}>{label}{query.sortBy === key ? (query.sortDir === 'asc' ? ' ↑' : ' ↓') : ''}</button>
  );
  return (
    <section className="panel table-panel">
      {selected && !loading && (
        <div className="selection-bar">
          <div className="selection-copy"><strong>{selected.name}</strong><span>{selected.path}</span></div>
          <div className="toolbar compact">
            <button className="ghost-button" onClick={() => onOpen(selected)}><FolderOpen size={15} /> Open</button>
            <button className="ghost-button" onClick={() => onReveal(selected)}><ExternalLink size={15} /> Explorer</button>
            <button className="ghost-button" onClick={() => onCopy(selected)}><Copy size={15} /> Path</button>
            <button className="danger-button" disabled={!canRecycle || selected.parentId==null} onClick={() => onTrash(selected)}><Trash2 size={15} /> Recycle</button>
          </div>
        </div>
      )}
      <div className="table-scroll">
        <table>
          <thead><tr>
            <th>{header('Name', 'name')}</th>
            <th>Kind</th>
            <th>Category</th>
            <th>{header(settings.useAllocatedSize ? 'Est. disk use' : 'Size', sizeField)}</th>
            <th>{header('Items', 'itemCount')}</th>
            <th>{header('Modified', 'modifiedAt')}</th>
          </tr></thead>
          <tbody>
            {result?.items.map((node) => (
              <tr key={node.id} className={selected?.id === node.id ? 'selected-row' : ''}
                onClick={() => onSelect(node)} onDoubleClick={() => onOpen(node)} onFocus={() => onSelect(node)} tabIndex={0}
                onKeyDown={(event) => { if (event.key === 'Enter') onOpen(node); }}>
                <td><div className="name-cell"><span className={`kind-dot ${node.kind}`} /> <span title={node.path}>{node.name}</span></div></td>
                <td>{node.kind}</td>
                <td>{node.kind === 'file' ? node.category : '—'}</td>
                <td>{formatBytes(node[sizeField], settings.unit)}</td>
                <td>{node.kind === 'folder' ? node.itemCount.toLocaleString() : '—'}</td>
                <td>{node.modifiedAt ? new Date(node.modifiedAt).toLocaleString() : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {(!result || result.items.length === 0) && <div className="empty-table" role="status">{error || (loading?'Loading items…':'No items match this view.')}</div>}
      </div>
      {result && (
        <div className="pagination">
          <span>{result.total.toLocaleString()} items</span>
          <div className="toolbar compact">
            <button className="icon-button" disabled={result.page <= 1} onClick={() => onPage(result.page - 1)}><ChevronLeft size={18} /></button>
            <span>Page {result.page} of {Math.max(1,Math.ceil(result.total / result.pageSize))}</span>
            <button className="icon-button" disabled={result.page >= Math.ceil(result.total / result.pageSize)} onClick={() => onPage(result.page + 1)}><ChevronRight size={18} /></button>
          </div>
        </div>
      )}
    </section>
  );
}
