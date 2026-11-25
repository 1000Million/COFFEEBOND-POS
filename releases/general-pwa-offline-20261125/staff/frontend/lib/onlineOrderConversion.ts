import { httpsCallable } from 'firebase/functions';
import { functions } from './firebase';
import type { OnlineOrder, StaffProfile } from '../types';
import type { InventoryDeductionBlocker } from './inventoryDeduction';

type AcceptResult = {
  orderId: string;
  orderNumber: string;
  stockMovementCount: number;
  kotCount: number;
};

export type OnlineOrderAcceptBlocker = InventoryDeductionBlocker;

type CouponOnlineOrder = Omit<OnlineOrder, 'items'> & {
  pricingVersion?: string;
  couponCode?: string;
  couponUsageStatus?: string;
  discount?: number;
  discountPercent?: number;
  items: Array<OnlineOrder['items'][number] & { lineDiscount?: number }>;
};

// Read only the server-created incoming-order snapshot. This checks consistency;
// it never calculates or authorizes a new discount in the staff browser.
export function couponSnapshotForAcceptance(order: CouponOnlineOrder) {
  if (!order.couponCode) return null;
  const paise = (value: unknown) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0
      || !Number.isSafeInteger(Math.round(value * 100))
      || Math.abs(value * 100 - Math.round(value * 100)) > 1e-7) {
      throw new Error('The server coupon pricing snapshot needs review.');
    }
    return Math.round(value * 100);
  };
  if (order.pricingVersion !== 'COUPON_V1' || order.couponUsageStatus !== 'COMMITTED'
    || !/^[A-Z0-9_-]{1,40}$/.test(order.couponCode)
    || (order.discountPercent !== undefined && (!Number.isFinite(order.discountPercent) || order.discountPercent < 0 || order.discountPercent > 100))) {
    throw new Error('The server coupon authorization needs review.');
  }
  const fields = ['subtotal', 'discount', 'taxableAmount', 'gstTotal', 'grandTotal'] as const;
  const lineFields = ['lineSubtotal', 'lineDiscount', 'lineTaxable', 'lineTax', 'lineTotal'] as const;
  fields.forEach((field, index) => {
    if (paise(order[field]) !== order.items.reduce((total, item) => total + paise(item[lineFields[index]]), 0)) {
      throw new Error('The server coupon totals do not match the submitted lines.');
    }
  });
  order.items.forEach(item => {
    if (paise(item.lineSubtotal) !== paise(item.lineDiscount) + paise(item.lineTaxable)
      || paise(item.lineTotal) !== paise(item.lineTaxable) + paise(item.lineTax)) {
      throw new Error('The server coupon line totals need review.');
    }
  });
  return {
    couponCode: order.couponCode,
    subtotal: order.subtotal,
    discount: order.discount!,
    discountPercent: order.discountPercent,
    taxableAmount: order.taxableAmount,
    gstTotal: order.gstTotal,
    grandTotal: order.grandTotal,
  };
}

export class OnlineOrderAcceptError extends Error {
  blockers: OnlineOrderAcceptBlocker[];

  constructor(blockers: OnlineOrderAcceptBlocker[]) {
    super('Online order cannot be accepted because stock/BOM readiness is incomplete.');
    this.name = 'OnlineOrderAcceptError';
    this.blockers = blockers;
  }
}

export function isOnlineOrderAcceptError(error: unknown): error is OnlineOrderAcceptError {
  return error instanceof OnlineOrderAcceptError
    || (typeof error === 'object' && error !== null && Array.isArray((error as OnlineOrderAcceptError).blockers));
}


export async function acceptOnlineOrder(onlineOrderId: string, _staffProfile: StaffProfile): Promise<AcceptResult> {
  const accept = httpsCallable<{ onlineOrderId: string }, AcceptResult>(functions, 'acceptPayAtCounterOrder');
  const result = await accept({ onlineOrderId });
  return result.data;
}
