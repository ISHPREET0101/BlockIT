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
