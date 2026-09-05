import { httpsCallable } from 'firebase/functions';
import { customerFunctions } from './customerAuth';
import { PaymentStatus, PublicOrderStatus, PublicOrderTrackingItem } from '../types';

export type CustomerOrderSummary = {
  trackingToken: string;
  publicOrderReference: string;
  storeName: string;
  orderType: 'PICKUP' | 'DINE_IN';
  total: number;
  status: PublicOrderStatus | 'COMPLETED';
  paymentStatus: PaymentStatus;
  /** Points posted by the server's immutable POINT_EARN ledger entry. Never estimated. */
  pointsEarned?: number | null;
  createdAt: string | null;
};

/* The existing authenticated order-history source. Home and Orders deliberately share
   this wrapper so Bite 4 adds neither a second endpoint nor a direct Firestore query. */
const listMyCustomerOrdersCallable = httpsCallable<void, { orders: CustomerOrderSummary[] }>(
  customerFunctions,
  'listMyCustomerOrders',
);

export async function listMyCustomerOrders(): Promise<CustomerOrderSummary[]> {
  const result = await listMyCustomerOrdersCallable();
  return result.data.orders;
}

export const CUSTOMER_TERMINAL_ORDER_STATUSES = [
  'SERVED',
  'COMPLETED',
  'CANCELLED',
  'CANCELLED_REFUNDED',
  'REFUNDED',
  'REFUND_FAILED',
  'REJECTED',
] as const;

export function isLiveCustomerOrderStatus(
  status: CustomerOrderSummary['status'],
): status is PublicOrderStatus {
  return !(CUSTOMER_TERMINAL_ORDER_STATUSES as readonly string[]).includes(status);
}

export function isCurrentCustomerOrder(order: CustomerOrderSummary): boolean {
  return isLiveCustomerOrderStatus(order.status);
}

export function compareCustomerOrdersNewestFirst(
  left: CustomerOrderSummary,
  right: CustomerOrderSummary,
): number {
  const dateOrder = String(right.createdAt || '').localeCompare(String(left.createdAt || ''));
  return dateOrder || right.trackingToken.localeCompare(left.trackingToken);
}

export function selectMostRecentCurrentCustomerOrder(
  orders: CustomerOrderSummary[],
): CustomerOrderSummary | null {
  return [...orders]
    .filter(isCurrentCustomerOrder)
    .sort(compareCustomerOrdersNewestFirst)[0] || null;
}

export function customerOperationalStatus(status: CustomerOrderSummary['status']): string {
  if (status === 'PAID_PENDING_ACCEPTANCE') return 'Paid — awaiting store confirmation';
  if (status === 'ACCEPTED' || status === 'CONVERTED') return 'Accepted';
  if (status === 'PREPARING') return 'Preparing';
  if (status === 'READY') return 'Ready';
  if (status === 'SERVED' || status === 'COMPLETED') return 'Completed';
  if (status === 'PAYMENT_PROCESSING') return 'Payment processing';
  if (status === 'PAYMENT_REVIEW_REQUIRED') return 'Payment review required';
  if (status === 'REFUND_PENDING') return 'Refund pending';
  if (status === 'REFUNDED' || status === 'CANCELLED_REFUNDED') return 'Refunded';
  if (status === 'REFUND_FAILED') return 'Refund failed';
  if (status === 'CANCELLED') return 'Cancelled';
  if (status === 'NEEDS_ATTENTION') return 'Store reviewing';
  if (status === 'REJECTED') return 'Not accepted';
  if (status === 'ACCEPTED_AWAITING_PAYMENT') return 'Accepted, awaiting payment';
  if (status === 'PENDING') return 'Request sent';
  return String(status).replaceAll('_', ' ').toLowerCase().replace(/^\w/, value => value.toUpperCase());
}

/** Compact Home headline for the same canonical statuses; no lifecycle is added. */
export function customerHomeLiveOrderStatus(status: PublicOrderStatus): string {
  if (status === 'PAID_PENDING_ACCEPTANCE') return 'Paid, awaiting store';
  if (status === 'ACCEPTED' || status === 'CONVERTED') return 'Order confirmed';
  if (status === 'PREPARING') return 'Preparing';
  if (status === 'READY') return 'Ready for pickup';
  if (status === 'PAYMENT_PROCESSING') return 'Confirming payment';
  if (status === 'PAYMENT_REVIEW_REQUIRED') return 'Payment under review';
  if (status === 'REFUND_PENDING') return 'Refund in progress';
  if (status === 'NEEDS_ATTENTION') return 'Store reviewing';
  if (status === 'ACCEPTED_AWAITING_PAYMENT') return 'Accepted, awaiting payment';
  if (status === 'PENDING') return 'Request sent';
  return customerOperationalStatus(status);
}

/** A single customer-safe line for Home — never a mini receipt or an internal id. */
export function compactCustomerOrderItemSummary(items: PublicOrderTrackingItem[]): string {
  const first = items[0];
  if (!first) return '';
  const quantity = first.quantity > 1 ? `${first.quantity}× ` : '';
  const modifier = first.addOns?.[0]?.optionName?.trim();
  const firstLine = `${quantity}${first.itemName}${modifier ? ` · ${modifier}` : ''}`;
  const extraLines = Math.max(0, items.length - 1);
  return extraLines > 0 ? `${firstLine} + ${extraLines} more` : firstLine;
}
