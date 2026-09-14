import { categoryColors } from './categories';
import type { TreemapNode } from './types';

// Cartographic block palette (preset 02 Stamen Design): ochre, sage, clay,
// slate, moss, russet, dusk, pine, brass, pewter. Every tone stays dark enough
// that white label text passes WCAG AA (contrast >= 4.5:1) on the block.
export const blockPalette = [
  '#9c5a1e', '#4f6f4a', '#7d4a2f', '#3f5c6b', '#5f7229',
  '#8f4534', '#5a4f78', '#33685c', '#7f6420', '#4b5a6b',
];

// Free space and unclassified remainder keep their own cartographic tones.
export const freeSpaceColor = '#e8dfc6';
export const remainderColor = '#8a8577';

export type TreemapColorMode = 'item' | 'type' | 'size' | 'age' | 'depth';

export const colorModeLabels: Record<TreemapColorMode, string> = {
  item: 'Distinct',
  type: 'Types',
  size: 'Size',
  age: 'Age',
  depth: 'Levels',
};

// Colours are assigned per sibling group, so adjacent blocks never share a
// colour while a nested child can reuse a colour from another branch.
export function blockColors(nodes: TreemapNode[]): Map<number, string> {
  const colors = new Map<number, string>();
  const walk = (list: TreemapNode[]) => {
    const ordered = list.filter(node => !node.synthetic).slice()
      .sort((a, b) => a.path.localeCompare(b.path) || a.id - b.id);
    ordered.forEach((node, index) => {
      colors.set(node.id, blockPalette[index % blockPalette.length]);
      if (node.children?.length) walk(node.children);
    });
  };
  walk(nodes);
  return colors;
}

export function blockColor(node: TreemapNode, colors: Map<number,string>, mode: 'item' | 'type'): string {
  if (node.synthetic) return node.syntheticKind === 'free' ? freeSpaceColor : remainderColor;
  if (mode === 'type' && node.kind === 'file') return categoryColors[node.category];
  return colors.get(node.id) || blockPalette[0];
}

function channel(hex: string, offset: number): number {
  const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

export function luminance(hex: string): number {
  return channel(hex, 1) * 0.2126 + channel(hex, 3) * 0.7152 + channel(hex, 5) * 0.0722;
}

export function readableText(hex: string): string {
  return luminance(hex) > 0.179 ? '#14231c' : '#ffffff';
}

function toRgb(hex: string): [number, number, number] {
  return [parseInt(hex.slice(1,3),16), parseInt(hex.slice(3,5),16), parseInt(hex.slice(5,7),16)];
}
function toHex(rgb: [number, number, number]): string {
  return '#' + rgb.map(value => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0')).join('');
}
// Sequential ramp: interpolate through the stops so size and age blocks read as
// a continuous choropleth rather than a set of unrelated colours.
export function ramp(stops: string[], t: number): string {
  const clamped = Math.max(0, Math.min(1, t));
  const scaled = clamped * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.floor(scaled));
  const local = scaled - index;
  const a = toRgb(stops[index]);
  const b = toRgb(stops[index + 1]);
  return toHex([a[0] + (b[0] - a[0]) * local, a[1] + (b[1] - a[1]) * local, a[2] + (b[2] - a[2]) * local]);
}

// Size uses a log scale so mid-sized blocks stay distinguishable next to a
// dominant one; the ramp runs pale sand -> ochre -> deep umber.
export const sizeRamp = ['#f1e8d5', '#d8b483', '#bd8340', '#9c5a1e', '#6d3a12'];
export const ageRamp = ['#8a5136', '#9a7439', '#8f8a3f', '#67804a', '#3f685c'];
export const depthRamp = ['#e6dcc7', '#c9b489', '#a78d55', '#836b3c', '#5f4c26'];

export function sizeColor(value: number, max: number): string {
  if (max <= 0 || value <= 0) return sizeRamp[0];
  return ramp(sizeRamp, Math.log10(1 + value) / Math.log10(1 + max));
}
export function ageColor(modifiedAt: number, now: number, spanMs: number): string {
  if (!modifiedAt) return ageRamp[0];
  const age = Math.max(0, Math.min(1, spanMs > 0 ? (now - modifiedAt) / spanMs : 0));
  return ramp(ageRamp, 1 - age);
}
export function depthColor(depth: number): string {
  return depthRamp[Math.max(0, Math.min(depthRamp.length - 1, depth - 1))];
}

interface ColorContext {
  colors: Map<number, string>;
  mode: TreemapColorMode;
  maxSize: number;
  now: number;
  ageSpanMs: number;
  depth: number;
}

export function treemapFill(node: TreemapNode, context: ColorContext): string {
  if (node.synthetic) return node.syntheticKind === 'free' ? freeSpaceColor : remainderColor;
  switch (context.mode) {
    case 'type': return node.kind === 'file' ? categoryColors[node.category] : blockColor(node, context.colors, 'item');
    case 'size': return sizeColor(Math.max(node.size, node.allocatedSize), context.maxSize);
    case 'age': return ageColor(node.modifiedAt, context.now, context.ageSpanMs);
    case 'depth': return depthColor(context.depth);
    default: return blockColor(node, context.colors, 'item');
  }
}

export interface LegendEntry { label: string; color: string }
export function legendFor(mode: TreemapColorMode): { kind: 'swatch' | 'ramp'; entries: LegendEntry[]; caption: string } {
  if (mode === 'type') {
    return { kind: 'swatch', caption: 'Files share their category colour', entries: (Object.keys(categoryColors) as Array<keyof typeof categoryColors>).map(name => ({ label: name, color: categoryColors[name] })) };
  }
  if (mode === 'size') {
    return { kind: 'ramp', caption: 'Larger blocks are darker', entries: [{ label: 'small', color: sizeRamp[0] }, { label: 'large', color: sizeRamp[sizeRamp.length - 1] }] };
  }
  if (mode === 'age') {
    return { kind: 'ramp', caption: 'Newer files lean green, older files lean clay', entries: [{ label: 'older', color: ageRamp[0] }, { label: 'recent', color: ageRamp[ageRamp.length - 1] }] };
  }
  if (mode === 'depth') {
    return { kind: 'swatch', caption: 'Each nesting level steps one shade deeper', entries: depthRamp.slice(0, 4).map((color, index) => ({ label: 'level ' + (index + 1), color })) };
  }
  return { kind: 'swatch', caption: 'Adjacent folders never share a colour', entries: blockPalette.slice(0, 6).map((color, index) => ({ label: 'block ' + (index + 1), color })) };
}

// Relative age span used by the age ramp: from the oldest item in view to now.
export function ageSpan(nodes: Array<{ modifiedAt: number }>, now: number): number {
  let oldest = now;
  for (const node of nodes) if (node.modifiedAt > 0) oldest = Math.min(oldest, node.modifiedAt);
  return Math.max(1, now - oldest);
}
