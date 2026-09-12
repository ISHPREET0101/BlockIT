import type { AppSettings, NodeQuery } from './types';
import { categoryColors } from './categories';

export const defaultSettings: AppSettings = {
  theme: 'light', unit: 'dynamic', showHeader: true, showFileTypes: true,
  showTreemap: true, showLabels: true, showFreeSpace: true, useAllocatedSize: false,
  confirmRecycle: true, largeFileThreshold: 500 * 1024 ** 2, oldFileDays: 365,
};

export function scanIdentifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error('Invalid scan identifier.');
  }
  return value;
}
export function nodeIdentifier(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error('Invalid item identifier.');
  return Number(value);
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid request.');
  return value as Record<string, unknown>;
}
function number(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) throw new Error('Invalid numeric option.');
  return value;
}
function text(value: unknown, limit: number): string {
  if (typeof value !== 'string' || value.length > limit || value.includes('\0')) throw new Error('Invalid text option.');
  return value;
}
function choice<const T extends string>(value: unknown, choices: readonly T[]): T {
  if (!choices.includes(value as T)) throw new Error('Invalid option.');
  return value as T;
}
export function validateQuery(input: unknown): NodeQuery {
  const q = record(input);
  const result: NodeQuery = { scanId: scanIdentifier(q.scanId) };
  if (q.parentId != null) result.parentId = nodeIdentifier(q.parentId);
  if (q.view != null) result.view = choice(q.view, ['browse','category','large','old','search']);
  if (q.search != null) result.search = text(q.search, 2048);
  if (q.extension != null) result.extension = text(q.extension, 255).trim().replace(/^\./, '').toLowerCase();
  if (q.category != null) result.category = choice(q.category, ['', ...Object.keys(categoryColors)] as NonNullable<NodeQuery['category']>[]);
  if (q.kind != null) result.kind = choice(q.kind, ['', 'file', 'folder']);
  if (q.minSize != null) result.minSize = number(q.minSize, 0, Number.MAX_SAFE_INTEGER);
  if (q.olderThan != null) result.olderThan = number(q.olderThan, -8.64e15, 8.64e15);
  if (q.sortBy != null) result.sortBy = choice(q.sortBy, ['name','size','allocatedSize','modifiedAt','itemCount']);
  if (q.sortDir != null) result.sortDir = choice(q.sortDir, ['asc','desc']);
  if (q.page != null) result.page = Math.floor(number(q.page, 1, 100_000_000));
  if (q.pageSize != null) result.pageSize = Math.min(500, Math.floor(number(q.pageSize, 1, 100_000_000)));
  return result;
}
export function settingsPatch(input: unknown): Partial<AppSettings> {
  const patch = record(input), result: Partial<AppSettings> = {};
  if (patch.theme != null) result.theme = choice(patch.theme, ['dark','light']);
  if (patch.unit != null) result.unit = choice(patch.unit, ['dynamic','bytes','KB','MB','GB','TB']);
  for (const key of ['showHeader','showFileTypes','showTreemap','showLabels','showFreeSpace','useAllocatedSize'] as const) {
    if (patch[key] != null) {
      if (typeof patch[key] !== 'boolean') throw new Error('Invalid preference.');
      result[key] = patch[key];
    }
  }
  if (patch.largeFileThreshold != null) result.largeFileThreshold = number(patch.largeFileThreshold, 1, Number.MAX_SAFE_INTEGER);
  if (patch.oldFileDays != null) result.oldFileDays = number(patch.oldFileDays, 1, 100_000);
  // Confirmation cannot be disabled by old preferences or renderer input.
  result.confirmRecycle = true;
  return result;
}

export function csvCell(value: unknown): string {
  const raw = String(value ?? '');
  // Spreadsheet apps also accept whitespace before a formula.
  const safe = /^[\s]*[=+\-@]/.test(raw) || /^[\t\r\n]/.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
