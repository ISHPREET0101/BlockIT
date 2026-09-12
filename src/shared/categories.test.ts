import { describe, expect, it } from 'vitest';
import { categorize, extensionOf } from './categories';
import { estimatedAllocatedSize, formatBytes } from './format';

describe('file metadata helpers', () => {
  it('extracts and classifies extensions case-insensitively', () => {
    expect(extensionOf('Holiday.MP4')).toBe('mp4');
    expect(categorize('MP4')).toBe('Videos');
    expect(categorize('unknown-format')).toBe('Other');
  });

  it('formats and estimates allocated sizes', () => {
    expect(formatBytes(1536)).toBe('1.50 KB');
    expect(estimatedAllocatedSize(1, 4096)).toBe(4096);
    expect(estimatedAllocatedSize(4097, 4096)).toBe(8192);
  });
});
