import { describe, expect, it } from 'vitest';
import { categoryColors } from './categories';
import { blockColor, blockColors, blockPalette, readableText } from './treemap';
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
    expect(blockColor(free, new Map(), 'item')).toBe('#dbe7de');
    expect(blockColor(node(-2, { synthetic: true }), new Map(), 'item')).toBe('#64748b');
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
    expect(readableText('#dbe7de')).toBe('#14231c');
  });
});
