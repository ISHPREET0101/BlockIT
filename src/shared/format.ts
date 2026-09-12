import type { SizeUnit } from './types';

const factors: Record<Exclude<SizeUnit, 'dynamic'>, number> = {
  bytes: 1,
  KB: 1024,
  MB: 1024 ** 2,
  GB: 1024 ** 3,
  TB: 1024 ** 4,
};

export function formatBytes(value: number, unit: SizeUnit = 'dynamic'): string {
  if (!Number.isFinite(value)) return '—';
  if (unit !== 'dynamic') {
    const amount = value / factors[unit];
    return `${unit === 'bytes' ? Math.round(amount).toLocaleString() : amount.toFixed(amount >= 100 ? 0 : amount >= 10 ? 1 : 2)} ${unit}`;
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let amount = Math.max(0, value);
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024;
    index += 1;
  }
  return `${amount.toFixed(index === 0 ? 0 : amount >= 100 ? 0 : amount >= 10 ? 1 : 2)} ${units[index]}`;
}

export function estimatedAllocatedSize(size: number, clusterSize: number): number {
  if (size <= 0) return 0;
  const safeCluster = clusterSize > 0 ? clusterSize : 4096;
  return Math.ceil(size / safeCluster) * safeCluster;
}
