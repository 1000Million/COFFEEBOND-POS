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
  if (status === 'ACCEPTED' || status === 'CONVERTED') return 'Your order has been accepted and is being prepared.';
  if (status === 'PREPARING') return 'Your order is being prepared.';
  if (status === 'READY') return 'Your order is ready for pickup.';
  if (status === 'SERVED') return 'Your order has been completed.';
  if (status === 'REJECTED') return 'Sorry, the store could not accept this order.';
  if (status === 'CANCELLED') return 'Sorry, this order could not be completed.';
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
    publicStatus: 'PENDING',
    submittedAt: serverTimestamp(),
    customerStatusMessage: publicStatusMessage('PENDING'),
  };
}

export async function updatePublicOrderTracking(
  trackingToken: string | null | undefined,
  update: Partial<Omit<PublicOrderTracking, 'id' | 'trackingToken' | 'publicOrderReference' | 'storeName' | 'orderType' | 'tableNumber' | 'items' | 'subtotal' | 'gstTotal' | 'total' | 'submittedAt'>>,
) {
  if (!trackingToken) return;
  await updateDoc(publicTrackingDocRef(trackingToken), update);
}
