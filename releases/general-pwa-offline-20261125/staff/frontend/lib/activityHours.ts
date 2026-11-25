import type { Activity } from './reportingDashboard';

export const ALL_ACTIVITY_HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const sessionHours = new Map<string, number[]>();
const preferenceKey = (storeId: string) => `coffee-bond-reporting-visible-hours:v1:${encodeURIComponent(storeId)}`;

function validHours(value: unknown): value is number[] {
  return Array.isArray(value) && value.every(hour => Number.isInteger(hour) && hour >= 0 && hour <= 23);
}

export function readActivityHours(storeId: string): number[] {
  const key = preferenceKey(storeId);
  const session = sessionHours.get(key);
  if (session) return [...session];
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(key) || 'null');
    if (validHours(saved)) {
      const hours = [...new Set(saved)].sort((a, b) => a - b);
      sessionHours.set(key, hours);
      return [...hours];
    }
  } catch { /* A blocked store or invalid preference must not block reporting. */ }
  return [...ALL_ACTIVITY_HOURS];
}

export function saveActivityHours(storeId: string, hours: number[]): void {
  const key = preferenceKey(storeId);
  sessionHours.set(key, [...hours]);
  try { localStorage.setItem(key, JSON.stringify(hours)); } catch { /* Keep the session selection when persistence is unavailable. */ }
}

export function activityHourRanges(hours: number[]): string {
  if (!hours.length) return 'None';
  const ranges: string[] = [];
  let start = hours[0], end = start;
  const label = (hour: number) => `${String(hour).padStart(2, '0')}:00`;
  for (const hour of hours.slice(1)) {
    if (hour === end + 1) end = hour;
    else { ranges.push(`${label(start)}–${label(end + 1)}`); start = end = hour; }
  }
  ranges.push(`${label(start)}–${label(end + 1)}`);
  return ranges.join(', ');
}

export function hiddenActivityExists(data: Activity, visibleHours: number[]): boolean {
  const visible = new Set(visibleHours);
  const split = data.split?.status === 'AVAILABLE' || data.split?.status === 'PARTIAL' ? data.split : undefined;
  return !!data.rows?.some((row, r) => ALL_ACTIVITY_HOURS.some(hour => {
    if (visible.has(hour)) return false;
    const cell = split?.cells?.[r]?.[hour];
    return row.counts[hour] > 0 || !!cell && (cell.food > 0 || cell.drinks > 0 || cell.unknown > 0 || cell.missingBills > 0);
  }));
}

export function nextActivityCell(current: number, key: string, hours: number[], rowCount: number): number {
  if (!hours.length || !rowCount) return current;
  const row = Math.min(rowCount - 1, Math.floor(current / 24));
  const column = Math.max(0, hours.indexOf(current % 24));
  if (key === 'ArrowUp') return Math.max(0, row - 1) * 24 + hours[column];
  if (key === 'ArrowDown') return Math.min(rowCount - 1, row + 1) * 24 + hours[column];
  if (key === 'Home') return row * 24 + hours[0];
  if (key === 'End') return row * 24 + hours[hours.length - 1];
  const offset = key === 'ArrowRight' ? 1 : key === 'ArrowLeft' ? -1 : 0;
  const next = Math.max(0, Math.min(rowCount * hours.length - 1, row * hours.length + column + offset));
  return Math.floor(next / hours.length) * 24 + hours[next % hours.length];
}
