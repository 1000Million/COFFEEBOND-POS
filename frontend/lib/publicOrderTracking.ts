import { doc, serverTimestamp, updateDoc } from 'firebase/firestore';
import { db } from './firebase';
import { OnlineOrder, PublicOrderStatus, PublicOrderTracking } from '../types';

export const PUBLIC_ORDER_TRACKING_COLLECTION = 'publicOrderTracking';

export function generateTrackingToken(): string {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error('Secure browser crypto is unavailable. Please reload in a modern browser.');
  }
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

export function buildPublicOrderReference(trackingToken: string): string {
  return `CBWEB-${trackingToken.slice(0, 10).toUpperCase()}`;
}

export function publicTrackingDocRef(trackingToken: string) {
  return doc(db, PUBLIC_ORDER_TRACKING_COLLECTION, trackingToken);
}

export function publicStatusMessage(status: PublicOrderStatus): string {
  if (status === 'PENDING') return 'Your order request has been received. The store will confirm shortly.';
  if (status === 'ACCEPTED_AWAITING_PAYMENT') return 'Your order is accepted. Complete payment to begin preparation.';
  if (status === 'PAYMENT_PROCESSING') return 'We are confirming your payment securely.';
  if (status === 'PAID_PENDING_ACCEPTANCE') return 'Payment received. Your order has been sent to the store for confirmation. If the store cannot fulfil it, a full refund will be initiated.';
  if (status === 'PAYMENT_REVIEW_REQUIRED') return 'Payment was received, but the store must review fulfilment before preparation.';
  if (status === 'ACCEPTED' || status === 'CONVERTED') return 'Your order has been accepted and is being prepared.';
  if (status === 'PREPARING') return 'Your order is being prepared.';
  if (status === 'READY') return 'Your order is ready for pickup.';
  if (status === 'SERVED') return 'Your order has been completed.';
  if (status === 'REJECTED') return 'Sorry, the store could not accept this order.';
  if (status === 'CANCELLED') return 'Sorry, this order could not be completed.';
  if (status === 'REFUND_PENDING') return 'Your full refund has been initiated and is awaiting provider confirmation.';
  if (status === 'REFUNDED' || status === 'CANCELLED_REFUNDED') return 'Your full refund has been processed.';
  if (status === 'REFUND_FAILED') return 'Your refund needs store attention. Please contact the store.';
  if (status === 'NEEDS_ATTENTION') return 'The store is reviewing your order.';
  return 'We are checking your order status.';
}

export function buildInitialPublicTrackingDoc(args: {
  onlineOrder: Omit<OnlineOrder, 'id'>;
  trackingToken: string;
  publicOrderReference: string;
}): Omit<PublicOrderTracking, 'id'> {
  const { onlineOrder, trackingToken, publicOrderReference } = args;
  return {
    trackingToken,
    publicOrderReference,
    storeName: onlineOrder.storeName,
    orderType: onlineOrder.orderType,
    ...(onlineOrder.orderType === 'DINE_IN' && onlineOrder.tableNumber ? { tableNumber: onlineOrder.tableNumber } : {}),
    items: onlineOrder.items.map(item => ({
      itemName: item.itemName,
      quantity: item.quantity,
      lineTotal: item.lineTotal,
    })),
    subtotal: onlineOrder.subtotal,
    gstTotal: onlineOrder.gstTotal,
    total: onlineOrder.grandTotal,
    ...(Number(onlineOrder.bondRedemptionPoints || 0) > 0 ? {
      bondRedemptionPoints: Number(onlineOrder.bondRedemptionPoints),
      bondRedemptionDiscount: Number(onlineOrder.bondRedemptionDiscount || 0),
      discountLabel: onlineOrder.discountLabel || 'BOND Points Redemption',
    } : {}),
    publicStatus: 'PENDING',
    submittedAt: serverTimestamp(),
    customerStatusMessage: publicStatusMessage('PENDING'),
  };
}

export async function updatePublicOrderTracking(
  trackingToken: string | null | undefined,
  update: Partial<Omit<PublicOrderTracking, 'id' | 'trackingToken' | 'publicOrderReference' | 'storeName' | 'orderType' | 'tableNumber' | 'items' | 'subtotal' | 'gstTotal' | 'total' | 'bondRedemptionPoints' | 'bondRedemptionDiscount' | 'discountLabel' | 'submittedAt'>>,
) {
  if (!trackingToken) return;
  await updateDoc(publicTrackingDocRef(trackingToken), update);
}
