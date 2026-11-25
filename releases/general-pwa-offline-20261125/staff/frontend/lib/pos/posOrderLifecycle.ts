import type { GstTreatment } from '../storeGstTreatment';
import type { AddOnSelection, Store, MenuItem, CartItem, OrderType, PaymentMethod, Order, OrderItem, OrderPayment, ReceiptLegalDetails } from '../../types';
import { toFiniteNumber } from './posTax';
import { normalizePaymentAmount } from './posPayments';
import { unitPriceWithAddOns } from '../addOns';
import { receiptLegalDetailsFromStore } from '../complimentaryOrders';

// Draft and snapshot preparation only. Persistence and effects stay with the caller.
export type ReceiptLineSnapshot = {
  itemName: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  addOns?: AddOnSelection[];
};

export type ReceiptOrderSnapshot = {
  gstTreatmentSnapshot?: GstTreatment;
  sourceOrderId?: string;
  savedStatus?: Order['status'];
  orderNumber: string;
  storeName: string;
  createdAtIso: string;
  createdByName: string;
  customerName: string | null;
  customerPhone: string | null;
  orderType: OrderType;
  tableNumber: string | null;
  subtotal: number;
  discountPercent: number;
  discountAmount: number;
  taxableAmount: number;
  gstTotal: number;
  grandTotal: number;
  paymentMethod: PaymentMethod;
  isSplitPayment: boolean;
  paymentStatus?: string | null;
  commercialStatus?: Order['commercialStatus'];
  menuValue?: number;
  complimentaryDiscount?: number;
  receiptLegalDetails?: ReceiptLegalDetails;
};

export type ReceiptPaymentSnapshot = {
  method: PaymentMethod;
  amount: number;
};

export type ReceiptSnapshot = {
  savedDataLoaded?: boolean;
  order: ReceiptOrderSnapshot;
  items: ReceiptLineSnapshot[];
  payments: ReceiptPaymentSnapshot[];
};

export type SplitPaymentRow = {
  id: string;
  method: PaymentMethod;
  amountStr: string;
};

export type HeldBill = {
  id: string;
  heldByUid?: string;
  storeId: string;
  storeName: string;
  orderType: OrderType;
  tableNumber: string;
  customerName: string;
  customerPhone: string;
  cart: CartItem[];
  discountPercentStr: string;
  isSplitPayment?: boolean;
  splitPayments?: SplitPaymentRow[];
  heldAtIso: string;
  itemCount: number;
  total: number;
};

export function sanitizeFirestoreId(value: unknown, maxLength = 480): string {
  const normalized = String(value || '')
    .trim()
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return (normalized || 'ID').slice(0, maxLength);
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function shortHash(value: unknown): string {
  const input = stableJson(value);
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).toUpperCase().padStart(7, '0');
}

export function cartLineIdentity(
  cartItem: CartItem,
  liveItem: MenuItem,
  addOns: AddOnSelection[],
): Record<string, unknown> {
  return {
    productId: liveItem.id,
    productCode: liveItem.code,
    quantity: cartItem.quantity,
    addOns: addOns.map((addOn) => ({
      groupId: addOn.groupId,
      optionId: addOn.optionId,
      quantity: addOn.quantity,
    })).sort((left, right) => (
      `${left.groupId}:${left.optionId}`.localeCompare(`${right.groupId}:${right.optionId}`)
    )),
  };
}

export function deterministicOrderItemId(
  orderId: string,
  identity: Record<string, unknown>,
  occurrence: number,
): string {
  const productCode = sanitizeFirestoreId(identity.productCode || identity.productId || 'ITEM', 80);
  return sanitizeFirestoreId(`${orderId}_ITEM_${productCode}_${occurrence}_${shortHash(identity)}`, 180);
}

export function deterministicPaymentId(orderId: string, payment: ReceiptPaymentSnapshot, index: number): string {
  return sanitizeFirestoreId(`${orderId}_PAY_${String(index + 1).padStart(2, '0')}_${payment.method}`, 220);
}

export function checkoutPayloadHash(value: unknown): string {
  return shortHash(value);
}

export function buildReceiptSnapshot(
  order: Order,
  items: OrderItem[],
  payments: OrderPayment[],
  store: Store,
  savedDataLoaded = false,
): ReceiptSnapshot {
  const isComplimentary = order.commercialStatus === 'COMPLIMENTARY';
  const discountAmount =
    toFiniteNumber(order.discountAmount) ??
    toFiniteNumber(order.discountTotal) ??
    toFiniteNumber(order.discount) ??
    0;
  const taxableAmount = toFiniteNumber(order.taxableAmount) ?? Math.max(0, (toFiniteNumber(order.subtotal) || 0) - discountAmount);
  const gstTotal = toFiniteNumber(order.gstTotal) ?? toFiniteNumber(order.taxTotal) ?? 0;
  const receiptPayments = payments
    .map(payment => ({
      method: payment.method,
      amount: normalizePaymentAmount(payment.amount),
    }))
    .filter(payment => payment.amount > 0 || payments.length === 1);

  const savedTime = order.createdAt && typeof order.createdAt.toDate === 'function' ? order.createdAt.toDate() : order.createdAt ? new Date(order.createdAt as unknown as string) : null;
  return {
    savedDataLoaded,
    order: {
      sourceOrderId: order.id,
      savedStatus: order.status,
      orderNumber: order.orderNumber,
      storeName: order.storeName || store.name,
      createdAtIso: savedTime && Number.isFinite(savedTime.getTime()) ? savedTime.toISOString() : savedDataLoaded ? '' : new Date().toISOString(),
      createdByName: order.createdByName,
      customerName: order.customerName || null,
      customerPhone: order.customerPhone || null,
      orderType: order.orderType,
      tableNumber: order.tableNumber || null,
      subtotal: toFiniteNumber(order.subtotal) || 0,
      discountPercent: toFiniteNumber(order.discountPercent) || 0,
      discountAmount,
      taxableAmount,
      gstTotal,
      grandTotal: toFiniteNumber(order.grandTotal) || 0,
      paymentMethod: order.paymentMethod || receiptPayments[0]?.method || 'CASH',
      isSplitPayment: order.isSplitPayment === true || receiptPayments.length > 1,
      paymentStatus: order.paymentStatus || null,
      commercialStatus: order.commercialStatus,
      menuValue: toFiniteNumber(order.menuValue) ?? toFiniteNumber(order.subtotal) ?? 0,
      complimentaryDiscount: toFiniteNumber(order.complimentaryDiscount) ?? discountAmount,
      gstTreatmentSnapshot: order.gstTreatmentSnapshot,
      receiptLegalDetails: order.receiptLegalDetails || receiptLegalDetailsFromStore(store),
    },
    items: items.map(item => {
      const quantity = toFiniteNumber(item.quantity) || 0;
      const unitPrice = toFiniteNumber(item.unitPrice) || 0;
      return {
        itemName: item.itemName,
        quantity,
        unitPrice: toFiniteNumber(item.baseUnitPrice) ?? unitPrice,
        lineTotal: isComplimentary
          ? quantity * unitPriceWithAddOns(toFiniteNumber(item.baseUnitPrice) ?? unitPrice, item.addOns)
          : toFiniteNumber(item.lineTotal) ?? quantity * unitPriceWithAddOns(unitPrice, item.addOns),
        addOns: item.addOns || [],
      };
    }),
    payments: isComplimentary
      ? []
      : receiptPayments.length > 0
      ? receiptPayments
      : [{ method: order.paymentMethod || 'CASH', amount: order.paymentStatus === 'PAID' ? toFiniteNumber(order.grandTotal) || 0 : 0 }],
  };
}

export function heldBillValidationError(cartLength: number, hasStore: boolean, paymentLocked: boolean): string | null {
  if (paymentLocked) return 'Cancel the active Razorpay payment request before holding this bill.';
  if (cartLength === 0) return 'Cart is empty';
  if (!hasStore) return 'Please select a store before holding this bill.';
  return null;
}

export function createHeldBillSnapshot(draft: Omit<HeldBill, 'itemCount' | 'total'>, total: number): HeldBill {
  return {
    ...draft,
    cart: draft.cart.map(item => ({ ...item })),
    splitPayments: draft.splitPayments?.map(payment => ({ ...payment })),
    itemCount: draft.cart.reduce((sum, item) => sum + item.quantity, 0),
    total,
  };
}

export function recallHeldBillDraft(bill: HeldBill) {
  return {
    cart: bill.cart.map(item => ({ ...item })),
    discountPercentStr: bill.discountPercentStr,
    isSplitPayment: bill.isSplitPayment === true,
    splitPayments: (bill.splitPayments || []).map(payment => ({ ...payment })),
    tableNumberError: bill.orderType === 'DINE_IN' && !bill.tableNumber.trim() ? 'Table number is required for dine in orders.' : null,
  };
}

export function withoutHeldBill(heldBills: HeldBill[], billId: string): HeldBill[] {
  return heldBills.filter(held => held.id !== billId);
}

export function heldBillDeleteLabel(bill: HeldBill): string {
  return bill.customerName || bill.tableNumber || bill.storeName;
}

export function checkoutPreconditionMessage(cartLength: number, storeId: string, isSplitPayment: boolean, paymentMethod: PaymentMethod | '', splitRowCount: number): string | null {
  if (cartLength === 0) return 'Cart is empty';
  if (!storeId) return 'Please select a store';
  if (!isSplitPayment && !paymentMethod) return 'Please select a payment method';
  if (isSplitPayment && splitRowCount === 0) return 'Please add at least one payment row';
  return null;
}
