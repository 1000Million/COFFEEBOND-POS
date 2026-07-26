import type { OnlineOrderType, PaymentProvider } from '../types';

export const CUSTOMER_CHECKOUT_DRAFT_KEY = 'coffeeBondCustomerCheckoutDraft:v1';
export const CUSTOMER_CHECKOUT_DRAFT_VERSION = 1 as const;
export const CUSTOMER_CHECKOUT_DRAFT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type CheckoutHydrationState = 'NOT_STARTED' | 'RESTORING' | 'RESTORED';

export type PersistedCheckoutAddOn = {
  groupId: string;
  optionId: string;
  quantity: number;
};

export type PersistedCheckoutLine = {
  lineId: string;
  productId: string;
  productCode: string;
  quantity: number;
  addOns: PersistedCheckoutAddOn[];
  catalogMarker?: string;
};

export type CustomerCheckoutDraft = {
  schemaVersion: typeof CUSTOMER_CHECKOUT_DRAFT_VERSION;
  updatedAt: number;
  selectedStoreId: string;
  paymentProvider: PaymentProvider;
  orderType: OnlineOrderType;
  customerName: string;
  notes: string;
  lines: PersistedCheckoutLine[];
};

export type CustomerCheckoutDraftInput = Omit<CustomerCheckoutDraft, 'schemaVersion' | 'updatedAt'>;

export type CheckoutDraftReadResult = {
  draft: CustomerCheckoutDraft | null;
  status: 'VALID' | 'MISSING' | 'EXPIRED' | 'CORRUPT' | 'UNAVAILABLE';
};

export type CheckoutRestoreNoticeCode = 'ITEM_REMOVED' | 'ADD_ON_REMOVED' | 'PRICE_CHANGED';

export type CheckoutRestoreNotice = {
  code: CheckoutRestoreNoticeCode;
  productCode: string;
};

export type RestoredCheckoutLine<TItem, TAddOn> = {
  id: string;
  item: TItem;
  quantity: number;
  addOns: TAddOn[];
};

export type RestoredAddOns<TAddOn> = {
  addOns: TAddOn[];
  removedCount: number;
  lineValid: boolean;
};

export type CheckoutRestoreResult<TItem, TAddOn> = {
  lines: RestoredCheckoutLine<TItem, TAddOn>[];
  notices: CheckoutRestoreNotice[];
};

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

type RestoreOptions<TItem, TAddOn> = {
  items: TItem[];
  itemId: (item: TItem) => string;
  itemCode: (item: TItem) => string;
  isItemAvailable: (item: TItem) => boolean;
  restoreAddOns: (item: TItem, addOns: PersistedCheckoutAddOn[]) => RestoredAddOns<TAddOn>;
  catalogMarker: (item: TItem, addOns: TAddOn[]) => string;
};

function cleanText(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function positiveInteger(value: unknown, maximum = 99): number | null {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 && number <= maximum ? number : null;
}

function persistedAddOns(value: unknown): PersistedCheckoutAddOn[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).flatMap(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    const groupId = cleanText(record.groupId, 120);
    const optionId = cleanText(record.optionId, 120);
    const quantity = positiveInteger(record.quantity);
    return groupId && optionId && quantity ? [{ groupId, optionId, quantity }] : [];
  });
}

function persistedLines(value: unknown): PersistedCheckoutLine[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).flatMap((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    const productId = cleanText(record.productId, 160);
    const productCode = cleanText(record.productCode, 160);
    const quantity = positiveInteger(record.quantity);
    if ((!productId && !productCode) || !quantity) return [];
    return [{
      lineId: cleanText(record.lineId, 160) || `restored-${index}-${productCode || productId}`,
      productId,
      productCode,
      quantity,
      addOns: persistedAddOns(record.addOns),
      ...(cleanText(record.catalogMarker, 40) ? { catalogMarker: cleanText(record.catalogMarker, 40) } : {}),
    }];
  });
}

function parsedDraft(value: unknown, now: number): CheckoutDraftReadResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { draft: null, status: 'CORRUPT' };
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== CUSTOMER_CHECKOUT_DRAFT_VERSION) {
    return { draft: null, status: 'CORRUPT' };
  }
  const updatedAt = Number(record.updatedAt);
  if (!Number.isFinite(updatedAt) || updatedAt <= 0 || updatedAt > now + 5 * 60 * 1000) {
    return { draft: null, status: 'CORRUPT' };
  }
  if (now - updatedAt > CUSTOMER_CHECKOUT_DRAFT_MAX_AGE_MS) {
    return { draft: null, status: 'EXPIRED' };
  }
  const selectedStoreId = cleanText(record.selectedStoreId, 160);
  const paymentProvider = record.paymentProvider;
  const orderType = record.orderType;
  if (
    !selectedStoreId
    || !['RAZORPAY', 'PAY_AT_COUNTER'].includes(String(paymentProvider))
    || !['PICKUP', 'DINE_IN'].includes(String(orderType))
  ) {
    return { draft: null, status: 'CORRUPT' };
  }
  return {
    status: 'VALID',
    draft: {
      schemaVersion: CUSTOMER_CHECKOUT_DRAFT_VERSION,
      updatedAt,
      selectedStoreId,
      paymentProvider: paymentProvider as PaymentProvider,
      orderType: orderType as OnlineOrderType,
      customerName: cleanText(record.customerName, 120),
      notes: cleanText(record.notes, 200),
      lines: persistedLines(record.lines),
    },
  };
}

export function readCustomerCheckoutDraft(
  storage: StorageLike,
  now = Date.now(),
): CheckoutDraftReadResult {
  try {
    const raw = storage.getItem(CUSTOMER_CHECKOUT_DRAFT_KEY);
    if (!raw) return { draft: null, status: 'MISSING' };
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      storage.removeItem(CUSTOMER_CHECKOUT_DRAFT_KEY);
      return { draft: null, status: 'CORRUPT' };
    }
    const result = parsedDraft(value, now);
    if (!result.draft) storage.removeItem(CUSTOMER_CHECKOUT_DRAFT_KEY);
    return result;
  } catch {
    return { draft: null, status: 'UNAVAILABLE' };
  }
}

export function buildCustomerCheckoutDraft(
  input: CustomerCheckoutDraftInput,
  now = Date.now(),
): CustomerCheckoutDraft {
  return {
    schemaVersion: CUSTOMER_CHECKOUT_DRAFT_VERSION,
    updatedAt: now,
    selectedStoreId: cleanText(input.selectedStoreId, 160),
    paymentProvider: input.paymentProvider === 'RAZORPAY' ? 'RAZORPAY' : 'PAY_AT_COUNTER',
    orderType: input.orderType === 'DINE_IN' ? 'DINE_IN' : 'PICKUP',
    customerName: cleanText(input.customerName, 120),
    notes: cleanText(input.notes, 200),
    lines: persistedLines(input.lines),
  };
}

export function writeCustomerCheckoutDraft(
  storage: StorageLike,
  input: CustomerCheckoutDraftInput,
  now = Date.now(),
): boolean {
  try {
    storage.setItem(CUSTOMER_CHECKOUT_DRAFT_KEY, JSON.stringify(buildCustomerCheckoutDraft(input, now)));
    return true;
  } catch {
    return false;
  }
}

export function clearCustomerCheckoutDraft(storage: StorageLike): boolean {
  try {
    storage.removeItem(CUSTOMER_CHECKOUT_DRAFT_KEY);
    return true;
  } catch {
    return false;
  }
}

export function checkoutCatalogMarker(values: unknown[]): string {
  const text = JSON.stringify(values);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function restoreCustomerCheckoutDraft<TItem, TAddOn>(
  draft: CustomerCheckoutDraft,
  options: RestoreOptions<TItem, TAddOn>,
): CheckoutRestoreResult<TItem, TAddOn> {
  const itemsById = new Map(options.items.map(item => [options.itemId(item), item]));
  const itemsByCode = new Map(options.items.map(item => [options.itemCode(item), item]));
  const notices: CheckoutRestoreNotice[] = [];
  const lines = draft.lines.flatMap(savedLine => {
    const item = itemsById.get(savedLine.productId) || itemsByCode.get(savedLine.productCode);
    if (!item || !options.isItemAvailable(item)) {
      notices.push({ code: 'ITEM_REMOVED', productCode: savedLine.productCode });
      return [];
    }
    const restoredAddOns = options.restoreAddOns(item, savedLine.addOns);
    if (!restoredAddOns.lineValid) {
      notices.push({ code: 'ITEM_REMOVED', productCode: savedLine.productCode });
      return [];
    }
    if (restoredAddOns.removedCount > 0) {
      notices.push({ code: 'ADD_ON_REMOVED', productCode: savedLine.productCode });
    }
    const currentMarker = options.catalogMarker(item, restoredAddOns.addOns);
    if (savedLine.catalogMarker && savedLine.catalogMarker !== currentMarker) {
      notices.push({ code: 'PRICE_CHANGED', productCode: savedLine.productCode });
    }
    return [{
      id: savedLine.lineId,
      item,
      quantity: savedLine.quantity,
      addOns: restoredAddOns.addOns,
    }];
  });
  return { lines, notices };
}
