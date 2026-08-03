import { httpsCallable } from 'firebase/functions';
import { functions } from './firebase';
import type { OrderType } from '../types';

export type PosRazorpayStatus =
  | 'CREATING'
  | 'WAITING_FOR_PAYMENT'
  | 'PAYMENT_CAPTURED'
  | 'PAYMENT_REVIEW_REQUIRED'
  | 'EXPIRED'
  | 'CANCELLED'
  | 'FAILED'
  | 'RECOVERING';

export type PosRazorpaySession = {
  sessionId: string;
  status: PosRazorpayStatus;
  amount: number;
  amountPaise: number;
  currency: 'INR';
  providerRequestType: 'DYNAMIC_QR' | 'PAYMENT_LINK' | null;
  providerPaymentLinkId: string | null;
  providerQrCodeId: string | null;
  paymentUrl: string | null;
  qrImageUrl: string | null;
  expiresAt: string | null;
  checkoutPayloadHash: string;
  orderId: string;
  orderNumber: string | null;
  providerMethod: string | null;
  failureCode: string | null;
  failureMessage: string | null;
};

export type PosRazorpayCartItem = {
  orderItemId: string;
  parentProductId: string;
  parentProductCode: string;
  quantity: number;
  selectedAddOns: {
    groupId: string;
    optionId: string;
    quantity: number;
  }[];
};

export type CreatePosRazorpaySessionInput = {
  storeId: string;
  checkoutIdempotencyKey: string;
  paymentMethod: 'RAZORPAY';
  isSplitPayment: false;
  orderType: OrderType;
  tableNumber: string | null;
  customerName: string;
  customerPhone: string;
  notes?: string;
  discountPercent: number;
  items: PosRazorpayCartItem[];
};

export type PosRazorpayRefundResult = {
  alreadyRequested: boolean;
  status: 'REFUND_PENDING' | 'REFUNDED';
  refundId: string | null;
  refundRequestId: string;
};

const createSessionCallable = httpsCallable<CreatePosRazorpaySessionInput, PosRazorpaySession>(
  functions,
  'createPosRazorpaySession',
);
const getStatusCallable = httpsCallable<{ sessionId: string }, PosRazorpaySession>(
  functions,
  'getPosRazorpayStatus',
);
const cancelSessionCallable = httpsCallable<{ sessionId: string }, PosRazorpaySession>(
  functions,
  'cancelPosRazorpaySession',
);
const requestRefundCallable = httpsCallable<{
  orderId: string;
  reason: string;
  confirmation: string;
}, PosRazorpayRefundResult>(functions, 'requestPosRazorpayRefund');

export async function createPosRazorpaySession(
  input: CreatePosRazorpaySessionInput,
): Promise<PosRazorpaySession> {
  const result = await createSessionCallable(input);
  return result.data;
}

export async function getPosRazorpayStatus(sessionId: string): Promise<PosRazorpaySession> {
  const result = await getStatusCallable({ sessionId });
  return result.data;
}

export async function cancelPosRazorpaySession(sessionId: string): Promise<PosRazorpaySession> {
  const result = await cancelSessionCallable({ sessionId });
  return result.data;
}

export async function requestPosRazorpayRefund(input: {
  orderId: string;
  reason: string;
  confirmation: string;
}): Promise<PosRazorpayRefundResult> {
  const result = await requestRefundCallable(input);
  return result.data;
}

export function isPosRazorpaySessionLocked(session: PosRazorpaySession | null): boolean {
  return session !== null && ['CREATING', 'WAITING_FOR_PAYMENT', 'RECOVERING', 'PAYMENT_REVIEW_REQUIRED'].includes(session.status);
}

export function posRazorpayStatusLabel(status: PosRazorpayStatus): string {
  if (status === 'CREATING') return 'Creating secure payment request';
  if (status === 'WAITING_FOR_PAYMENT') return 'Waiting for payment';
  if (status === 'PAYMENT_CAPTURED') return 'Payment captured';
  if (status === 'PAYMENT_REVIEW_REQUIRED') return 'Payment needs Admin review';
  if (status === 'EXPIRED') return 'Payment request expired';
  if (status === 'CANCELLED') return 'Payment request cancelled';
  if (status === 'RECOVERING') return 'Recovering provider status';
  return 'Payment request failed';
}
