import { OrderType } from '../types';
import { BOMComponent, PackagingApplicability } from '../types/menu-management';

const TAKEAWAY_PACKAGING_PATTERNS = [
  /\bbox(es)?\b/i,
  /\bcontainer(s)?\b/i,
  /\bcup(s)?\b/i,
  /\blid(s)?\b/i,
  /\bbag(s)?\b/i,
  /\bcarry\b/i,
  /\btake[\s_-]?away\b/i,
  /\bparcel\b/i,
  /\bcutlery\b/i,
  /\bspoon(s)?\b/i,
  /\bfork(s)?\b/i,
  /\bknife\b/i,
  /\bstraw(s)?\b/i,
];

function normalizePackagingApplicabilityValue(value: unknown): PackagingApplicability | null {
  const normalized = String(value || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (normalized === 'DINE_IN' || normalized === 'DINEIN') return 'DINE_IN';
  if (normalized === 'TAKEAWAY' || normalized === 'PICKUP' || normalized === 'TAKE_OUT' || normalized === 'TAKEOUT') return 'TAKEAWAY';
  if (normalized === 'DELIVERY') return 'DELIVERY';
  if (normalized === 'ALL' || normalized === 'ANY') return 'ALL';
  return null;
}

function readPackagingApplicabilityList(line: BOMComponent): PackagingApplicability[] {
  const record = line as BOMComponent & Record<string, unknown>;
  const rawValue = record.applicableOrderTypes
    ?? record.packagingApplicability
    ?? record.orderTypes
    ?? record.serviceTypes
    ?? record.serviceType
    ?? record.applicability;
  const values = Array.isArray(rawValue) ? rawValue : (rawValue ? [rawValue] : []);
  const parsed = values
    .map(normalizePackagingApplicabilityValue)
    .filter((value): value is PackagingApplicability => Boolean(value));
  return Array.from(new Set(parsed));
}

export function inferPackagingApplicability(line: Pick<BOMComponent, 'componentCode' | 'componentName'>): PackagingApplicability[] {
  const label = `${line.componentCode || ''} ${line.componentName || ''}`.replace(/_/g, ' ');
  if (TAKEAWAY_PACKAGING_PATTERNS.some((pattern) => pattern.test(label))) {
    return ['TAKEAWAY', 'DELIVERY'];
  }
  return ['ALL'];
}

export function resolvePackagingApplicability(line: BOMComponent): PackagingApplicability[] {
  const explicit = readPackagingApplicabilityList(line);
  return explicit.length > 0 ? explicit : inferPackagingApplicability(line);
}

export function isPackagingComponentApplicable(line: BOMComponent, orderType: OrderType): boolean {
  const applicability = resolvePackagingApplicability(line);
  return applicability.includes('ALL') || applicability.includes(orderType);
}
