import { categoryColors } from './categories';
import type { TreemapNode } from './types';

// Strong enough for white text; colours identify items without implying a file type.
export const blockPalette = [
  '#2563eb', '#0f766e', '#b45309', '#7c3aed', '#be185d',
  '#047857', '#c2410c', '#4338ca', '#0e7490', '#a21caf',
];

export function blockColors(nodes: TreemapNode[]): Map<number, string> {
  const ordered = nodes.filter(node => !node.synthetic).slice()
    .sort((a, b) => a.path.localeCompare(b.path) || a.id - b.id);
  return new Map(ordered.map((node, index) => [node.id, blockPalette[index % blockPalette.length]]));
}

export function blockColor(node: TreemapNode, colors: Map<number,string>, mode: 'item' | 'type'): string {
  if (node.synthetic) return node.syntheticKind === 'free' ? '#dbe7de' : '#64748b';
  if (mode === 'type' && node.kind === 'file') return categoryColors[node.category];
  return colors.get(node.id) || blockPalette[0];
}

export function readableText(hex: string): string {
  const rgb = [1,3,5].map(offset => {
    const channel = parseInt(hex.slice(offset,offset+2),16)/255;
    return channel <= .04045 ? channel/12.92 : ((channel+.055)/1.055)**2.4;
  });
  const luminance = rgb[0]*.2126 + rgb[1]*.7152 + rgb[2]*.0722;
  return luminance > .179 ? '#14231c' : '#ffffff';
}
export type ColorMode = 'item' | 'type' | 'size' | 'age' | 'level';
export const sizeColors = ['#0f766e', '#2563eb', '#7c3aed', '#b45309'];
export const ageColors = ['#047857', '#0e7490', '#b45309', '#be185d', '#64748b'];
export const levelColors = ['#0f766e', '#7c3aed', '#b45309'];
export function metricColor(node: TreemapNode, mode: ColorMode, bytes: number, level: number, now = Date.now()): string | undefined {
  if (mode === 'size') return sizeColors[bytes < 1024**2 ? 0 : bytes < 1024**3 ? 1 : bytes < 1024**4 ? 2 : 3];
  if (mode === 'level') return levelColors[Math.min(2, Math.max(0, level - 1))];
  if (mode === 'age') {
    if (!Number.isFinite(node.modifiedAt) || node.modifiedAt <= 0) return ageColors[4];
    const days = Math.max(0, now - node.modifiedAt) / 86400000;
    return ageColors[days < 30 ? 0 : days < 180 ? 1 : days < 365 ? 2 : 3];
  }
}
export function flattenNodes(nodes: TreemapNode[]): TreemapNode[] {
  return nodes.flatMap(node => [node, ...flattenNodes(node.children || [])]);
}
export interface ColorRect { node: TreemapNode; x0: number; x1: number; y0: number; y1: number; depth: number; }
// Colour the actual neighbouring rectangles, rather than cycling by file name.
export function adjacentColors(rects: ColorRect[]): Map<number, string> {
  const colors = new Map<number, string>();
  rects.forEach((rect, index) => {
    if (rect.node.synthetic) return;
    const used = new Set<string>();
    for (let j = 0; j < index; j++) {
      const other = rects[j];
      if (other.depth !== rect.depth) continue;
      const vertical = Math.min(rect.y1, other.y1) > Math.max(rect.y0, other.y0);
      const horizontal = Math.min(rect.x1, other.x1) > Math.max(rect.x0, other.x0);
      if ((vertical && Math.min(Math.abs(rect.x1-other.x0), Math.abs(other.x1-rect.x0)) <= 8) ||
          (horizontal && Math.min(Math.abs(rect.y1-other.y0), Math.abs(other.y1-rect.y0)) <= 8)) {
        const color = colors.get(other.node.id); if (color) used.add(color);
      }
    }
    const ordered = blockPalette.map((_, offset) => blockPalette[(index + offset) % blockPalette.length]);
    colors.set(rect.node.id, ordered.find(color => !used.has(color)) || ordered[0]);
  });
  return colors;
}
