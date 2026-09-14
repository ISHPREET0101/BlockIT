import { describe, expect, it } from 'vitest';
import { categoryColors } from './categories';
import { ageColor, blockColor, blockColors, blockPalette, depthColor, freeSpaceColor, legendFor, ramp, readableText, remainderColor, sizeColor } from './treemap';
import type { TreemapNode } from './types';

const node = (id: number, changes: Partial<TreemapNode> = {}): TreemapNode => ({
  id, parentId: null, name: 'Folder '+id, path: 'C:/Folder '+id,
  kind: 'folder', extension: '', category: 'Other', size: 100,
  allocatedSize: 4096, modifiedAt: 0, attributes: '', itemCount: 1,
  fileCount: 1, folderCount: 0, ...changes,
});

describe('treemap colours', () => {
  it('distinguishes the first palette of items and ignores input sort order', () => {
    const nodes = blockPalette.map((_, index) => node(index));
    const colours = blockColors(nodes);
    expect(new Set(colours.values()).size).toBe(blockPalette.length);
    expect(blockColors([...nodes].reverse())).toEqual(colours);
  });

  it('does not let synthetic free space change folder colours', () => {
    const folder = node(1);
    const free = node(-1, { synthetic: true, syntheticKind: 'free' });
    expect(blockColors([folder, free])).toEqual(blockColors([folder]));
    expect(blockColor(free, new Map(), 'item')).toBe(freeSpaceColor);
    expect(blockColor(node(-2, { synthetic: true }), new Map(), 'item')).toBe(remainderColor);
  });

  it('uses category colours only for files in file-type mode', () => {
    const file = node(1, { kind: 'file', category: 'Videos' });
    const folder = node(2);
    const colours = blockColors([file, folder]);
    expect(blockColor(file, colours, 'type')).toBe(categoryColors.Videos);
    expect(blockColor(file, colours, 'item')).toBe(colours.get(file.id));
    expect(blockColor(folder, colours, 'type')).toBe(colours.get(folder.id));
  });

  it('uses light text on block colours and dark text on free space', () => {
    for (const colour of blockPalette) expect(readableText(colour)).toBe('#ffffff');
    expect(readableText(freeSpaceColor)).toBe('#14231c');
  });

  it('keeps every block colour at WCAG AA contrast for white text', () => {
    const channel = (hex: string, offset: number) => {
      const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    };
    const relative = (hex: string) => channel(hex, 1) * 0.2126 + channel(hex, 3) * 0.7152 + channel(hex, 5) * 0.0722;
    for (const colour of blockPalette) expect(1.05 / (relative(colour) + 0.05)).toBeGreaterThanOrEqual(4.5);
  });

  it('ramps size and age and keeps them inside the stops', () => {
    const sizeStops = ['#f1e8d5', '#d8b483', '#bd8340', '#9c5a1e', '#6d3a12'];
    expect(sizeColor(0, 100)).toBe(ramp(sizeStops, 0));
    expect(sizeColor(100, 100)).toBe(ramp(sizeStops, 1));
    expect(sizeColor(10_000, 10)).toBe(sizeColor(10, 10));
    const now = 1_000_000_000;
    expect(ageColor(now, now, 1000)).not.toBe(ageColor(now - 1000, now, 1000));
    expect(depthColor(1)).not.toBe(depthColor(3));
  });

  it('describes the active colour scale for the legend', () => {
    expect(legendFor('type').entries.some(entry => entry.label === 'Videos')).toBe(true);
    expect(legendFor('size').kind).toBe('ramp');
    expect(legendFor('depth').entries.length).toBeGreaterThanOrEqual(4);
    expect(legendFor('item').entries.length).toBe(6);
  });
});
