import { httpsCallable } from 'firebase/functions';
import { functions } from '../../lib/firebase';
import { assertCommittedFinancialResult } from '../../lib/pos/posFinancialResult';
import { POS_REFRESH_REQUIRED, type PosAddOnAuthorization, type PosCheckoutContext, type PosCheckoutFinancials } from '../../lib/posAddOnAuthorization';
import type { ComplimentaryOtpVerification } from '../../lib/complimentaryOrders';
import type { CheckoutRecoveryBinding, PendingCheckoutIdentity, PendingCheckoutReview, PendingCheckoutServerResult } from '../../lib/pos/pendingCheckoutRecovery';
import type { Order, OrderItem, OrderPayment, OrderType } from '../../types';

type PosOrderWriteContext = {
  newOrderRef: { id: string };
  checkoutAttempt: { idempotencyKey: string };
  requestPayloadHash: string;
  customerNameFinal: string | null;
  phoneToSearch: string;
  trueGrandTotal: number;
  trueSubtotal: number;
  trueTaxTotal: number;
  trueTaxableAmount: number;
  trueDiscountPercent: number;
  trueDiscount: number;
  isComplimentaryCheckout: boolean;
  complimentaryReason: string;
  complimentaryVerification: ComplimentaryOtpVerification | null;
  posAddOnAuthorization: PosAddOnAuthorization;
  tableNumber: string;
  orderType: OrderType;
};

type PosOrderWriteResult = {
  existingOrderId: string;
  savedOrder?: undefined;
  savedItems?: undefined;
  savedPayments?: undefined;
} | {
  existingOrderId?: undefined;
  savedOrder: Order & Record<string, unknown>;
  savedItems: OrderItem[];
  savedPayments: OrderPayment[];
};

const commitPosCheckout = httpsCallable<{
  authorizationId: string; orderId: string; idempotencyKey: string; payloadHash: string;
  checkoutContext: PosCheckoutContext; recoveryBinding: CheckoutRecoveryBinding;
  orderType: OrderType; tableNumber: string | null; customerName: string | null;
  customerPhone: string | null; complimentaryReason: string | null;
  complimentaryAuthorizationId: string | null; expectedFinancials: PosCheckoutFinancials;
}, { existingOrderId?: string; savedOrder?: Order & Record<string, unknown>; savedItems?: OrderItem[]; savedPayments?: OrderPayment[] }>(functions, 'commitPosCheckout');

/** Manual checkout financial and effect writes are performed by one trusted server transaction. */
export async function persistPosOrder(input: PosOrderWriteContext): Promise<PosOrderWriteResult> {
  const plan = input.posAddOnAuthorization.financials;
  if (!plan || plan.version !== 3) throw new Error('A current server financial authorization is required.');
  const checkoutContext = input.posAddOnAuthorization.checkoutContext;
  const recoveryBinding = input.posAddOnAuthorization.recoveryBinding;
  if (!checkoutContext || !recoveryBinding || checkoutContext.version !== 1
    || checkoutContext.originalOrderId !== input.newOrderRef.id || checkoutContext.idempotencyKey !== input.checkoutAttempt.idempotencyKey
    || recoveryBinding.authorizationId !== input.posAddOnAuthorization.authorizationId
    || recoveryBinding.orderId !== checkoutContext.originalOrderId || recoveryBinding.staffUid !== checkoutContext.staffUid
    || recoveryBinding.storeId !== checkoutContext.storeId || recoveryBinding.basketIdentity !== checkoutContext.basketIdentity) throw new Error(POS_REFRESH_REQUIRED);
  const localTotals = {
    subtotal: input.trueSubtotal, discountPercent: input.trueDiscountPercent,
    discountAmount: input.trueDiscount, taxableAmount: input.trueTaxableAmount,
    taxTotal: input.trueTaxTotal, grandTotal: input.trueGrandTotal,
  };
  for (const [field, value] of Object.entries(localTotals)) {
    if (plan[field as keyof typeof localTotals] !== value) throw new Error('Checkout totals do not match the server authorization.');
  }
  const result = await commitPosCheckout({
    authorizationId: input.posAddOnAuthorization.authorizationId,
    checkoutContext, recoveryBinding,
    orderId: input.newOrderRef.id,
    idempotencyKey: input.checkoutAttempt.idempotencyKey,
    payloadHash: input.requestPayloadHash,
    orderType: input.orderType,
    tableNumber: input.tableNumber.trim() || null,
    customerName: input.customerNameFinal,
    customerPhone: input.phoneToSearch || null,
    complimentaryReason: input.isComplimentaryCheckout ? input.complimentaryReason.trim() || null : null,
    complimentaryAuthorizationId: input.isComplimentaryCheckout ? input.complimentaryVerification?.authorizationId || null : null,
    expectedFinancials: plan,
  });
  const saved = result.data;
  if (saved.existingOrderId) return { existingOrderId: saved.existingOrderId };
  // Build the initial receipt from the committed server result, not a speculative browser write.
  if (!saved.savedOrder || !saved.savedItems || !saved.savedPayments
    || saved.savedOrder.id !== input.newOrderRef.id
    || saved.savedOrder.grandTotal !== plan.grandTotal
    || saved.savedOrder.gstTotal !== plan.gstTotal) {
    throw new Error('The saved checkout result could not be verified. Check this checkout before retrying.');
  }
  assertCommittedFinancialResult(plan, saved.savedOrder, saved.savedItems as unknown as Array<Record<string, unknown>>, saved.savedPayments as unknown as Array<Record<string, unknown>>);
  return saved as PosOrderWriteResult;
}

const recoverCheckout = httpsCallable<Record<string, unknown>, PendingCheckoutServerResult>(functions, 'commitPosCheckout');

/** Recovery never submits a checkout, creates a tender, or rotates a sale reference. */
export async function requestPendingCheckoutRecovery(
  attempt: PendingCheckoutIdentity,
  storeId: string,
  review?: PendingCheckoutReview,
): Promise<PendingCheckoutServerResult> {
  const payloadHash = attempt.payloadHash || attempt.previousPayloadHashes?.at(-1);
  if (!payloadHash) throw new Error('The previous checkout has no bound payload. Keep its reference for Admin review.');
  const response = await recoverCheckout({
    operation: review ? 'RETIRE_PENDING' : 'RECOVERY_STATUS',
    orderId: attempt.orderId, idempotencyKey: attempt.idempotencyKey,
    recoveryBinding: attempt.recoveryBinding,
    payloadHash, previousPayloadHashes: attempt.previousPayloadHashes || [], storeId,
    ...(review || {}),
  });
  return response.data;
}
