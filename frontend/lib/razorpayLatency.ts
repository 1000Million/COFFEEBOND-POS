import type { OnlineOrder } from '../types';

export type RazorpayPaymentStage =
  | 'PREPARING'
  | 'PREPARING_SLOW'
  | 'CHECKOUT_OPEN'
  | 'VERIFYING'
  | 'VERIFYING_SLOW'
  | 'SENDING'
  | 'SENT';

export const RAZORPAY_PROGRESS_MESSAGES: Record<RazorpayPaymentStage, string> = {
  PREPARING: 'Preparing secure payment...',
  PREPARING_SLOW: 'Secure payment is still being prepared. Please keep this page open...',
  CHECKOUT_OPEN: 'Complete payment in the Razorpay window.',
  VERIFYING: 'Payment received. Verifying securely...',
  VERIFYING_SLOW: 'Payment is still being confirmed. Please do not pay again or close this page.',
  SENDING: 'Payment confirmed. Sending your order to the store...',
  SENT: 'Order sent. Waiting for store confirmation...',
};

export type PaidOrderEscalation = 'NORMAL' | 'ATTENTION' | 'URGENT';

function timestampMillis(value: unknown): number {
  if (value && typeof (value as { toMillis?: () => number }).toMillis === 'function') {
    return (value as { toMillis: () => number }).toMillis();
  }
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function isPaidIncomingOrder(order: Pick<OnlineOrder, 'paymentProvider' | 'paymentStatus'>): boolean {
  return order.paymentProvider === 'RAZORPAY' && order.paymentStatus === 'PAID';
}

export function paidOrderWaitingMillis(order: OnlineOrder, now = Date.now()): number {
  const startedAt = timestampMillis(order.paymentCapturedAt) || timestampMillis(order.createdAt);
  return startedAt > 0 ? Math.max(0, now - startedAt) : 0;
}

export function paidOrderEscalation(waitingMillis: number): PaidOrderEscalation {
  if (waitingMillis > 120_000) return 'URGENT';
  if (waitingMillis >= 60_000) return 'ATTENTION';
  return 'NORMAL';
}

export function compareIncomingOrders(a: OnlineOrder, b: OnlineOrder): number {
  const paidDifference = Number(isPaidIncomingOrder(b)) - Number(isPaidIncomingOrder(a));
  if (paidDifference !== 0) return paidDifference;
  const aTime = timestampMillis(a.paymentCapturedAt) || timestampMillis(a.createdAt);
  const bTime = timestampMillis(b.paymentCapturedAt) || timestampMillis(b.createdAt);
  return bTime - aTime;
}

