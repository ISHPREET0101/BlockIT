import type { FileCategory } from './types';

const groups: Record<Exclude<FileCategory, 'Other'>, Set<string>> = {
  Documents: new Set(['doc', 'docx', 'odt', 'pdf', 'ppt', 'pptx', 'rtf', 'txt', 'xls', 'xlsx', 'csv', 'md']),
  Images: new Set(['avif', 'bmp', 'gif', 'heic', 'ico', 'jpeg', 'jpg', 'png', 'psd', 'svg', 'tif', 'tiff', 'webp']),
  Videos: new Set(['avi', 'flv', 'm4v', 'mkv', 'mov', 'mp4', 'mpeg', 'mpg', 'webm', 'wmv']),
  Audio: new Set(['aac', 'flac', 'm4a', 'mp3', 'ogg', 'wav', 'wma']),
  Archives: new Set(['7z', 'bz2', 'cab', 'gz', 'iso', 'rar', 'tar', 'tgz', 'zip']),
  Applications: new Set(['appx', 'exe', 'msi', 'msix', 'pak']),
  Code: new Set(['c', 'cpp', 'cs', 'css', 'go', 'h', 'html', 'java', 'js', 'jsx', 'json', 'kt', 'php', 'py', 'rb', 'rs', 'sql', 'swift', 'ts', 'tsx', 'vue', 'xml', 'yaml', 'yml']),
  System: new Set(['bin', 'cat', 'dat', 'dll', 'drv', 'mui', 'sys']),
};

export function extensionOf(name: string): string {
  const index = name.lastIndexOf('.');
  return index > 0 && index < name.length - 1 ? name.slice(index + 1).toLowerCase() : '';
}

const categoryByExtension = new Map<string, FileCategory>(
  Object.entries(groups).flatMap(([category, extensions]) => [...extensions].map(extension => [extension,category as FileCategory] as const)),
);
export function categorize(extension: string): FileCategory {
  const key = extension.charCodeAt(0) === 46 ? extension.slice(1) : extension;
  return categoryByExtension.get(key.toLowerCase()) || 'Other';
}

export const categoryColors: Record<FileCategory, string> = {
  Documents: '#7c5cff',
  Images: '#ef5da8',
  Videos: '#ff8a4c',
  Audio: '#36c5f0',
  Archives: '#f7c948',
  Applications: '#4f8cff',
  Code: '#21d4a7',
  System: '#8b95a7',
  Other: '#596579',
};
