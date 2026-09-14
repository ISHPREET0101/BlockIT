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

import { adjacentColors, metricColor, sizeColors, ageColors, levelColors, flattenNodes } from './treemap';
describe('treemap display modes', () => {
  it('uses byte and age boundaries including missing dates', () => {
    expect(metricColor(node(1), 'size', 1024**2-1, 1)).toBe(sizeColors[0]);
    expect(metricColor(node(1), 'size', 1024**2, 1)).toBe(sizeColors[1]);
    expect(metricColor(node(1), 'size', 1024**3, 1)).toBe(sizeColors[2]);
    expect(metricColor(node(1), 'size', 1024**4, 1)).toBe(sizeColors[3]);
    const now=1800000000000;
    expect(metricColor(node(1,{modifiedAt:now-30*86400000}), 'age', 1, 1, now)).toBe(ageColors[1]);
    expect(metricColor(node(1), 'age', 1, 1, now)).toBe(ageColors[4]);
    expect(metricColor(node(1), 'level', 1, 3)).toBe(levelColors[2]);
  });
  it('keeps neighbours distinct beyond one palette cycle', () => {
    const rectangles=Array.from({length:40},(_,i)=>({node:node(i),depth:1,x0:(i%10)*106,x1:(i%10)*106+100,y0:Math.floor(i/10)*106,y1:Math.floor(i/10)*106+100}));
    const colors=adjacentColors(rectangles);
    for(let i=0;i<40;i++) {
      if(i%10<9) expect(colors.get(i)).not.toBe(colors.get(i+1));
      if(i<30) expect(colors.get(i)).not.toBe(colors.get(i+10));
    }
  });
  it('retains zero-byte descendants for the accessible list', () => {
    expect(flattenNodes([node(1,{children:[node(2,{size:0})]})]).map(n=>n.id)).toEqual([1,2]);
  });
});
