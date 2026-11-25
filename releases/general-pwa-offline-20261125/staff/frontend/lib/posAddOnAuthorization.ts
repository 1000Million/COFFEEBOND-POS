import { httpsCallable } from 'firebase/functions';
import type { AddOnSelection } from '../types';
import type { CanonicalCompositeComponent } from '../types/menu-management';
import type { CheckoutRecoveryBinding } from './pos/pendingCheckoutRecovery';
import { functions } from './firebase';

export type PosAddOnAuthorizationItemRequest = {
  orderItemId: string;
  parentProductId: string;
  parentProductCode: string;
  quantity: number;
  selectedAddOns: Array<Pick<AddOnSelection, 'groupId' | 'optionId' | 'quantity'>>;
};

export type PosAddOnCanonicalItem = {
  orderItemId: string;
  parentProductId: string;
  parentProductCode: string;
  quantity: number;
  baseUnitPrice: number;
  taxRate: number;
  addOns: AddOnSelection[];
  addOnTotal: number;
  components?: CanonicalCompositeComponent[];
};

export type PosCheckoutContext = {
  version: 1;
  staffUid: string;
  storeId: string;
  originalOrderId: string;
  idempotencyKey: string;
  basketIdentity: string;
};
export const POS_REFRESH_REQUIRED = 'POS updated — refresh required. Keep this basket and any pending checkout reference.';

export type PosAddOnAuthorization = {
  authorizationId: string;
  canonicalItems: Record<string, PosAddOnCanonicalItem>;
  canonicalAddOnTotal: number;
  expiresAt: string;
  financials?: PosCheckoutFinancials;
  checkoutContext?: PosCheckoutContext;
  recoveryBinding?: CheckoutRecoveryBinding;
};

/** Server-approved manual checkout plan; never authorizes browser Firestore writes. */
export type PosCheckoutFinancials = {
  version: 3;
  subtotal: number;
  discountPercent: number;
  discountAmount: number;
  taxableAmount: number;
  taxTotal: number;
  gstTotal: number;
  grandTotal: number;
  itemIds: string[];
  lines: Record<string, { lineSubtotal: number; lineDiscount: number; lineTaxable: number; lineTax: number; lineTotal: number }>;
  payments: Record<string, { method: string; amount: number; paymentIndex: number }>;
  paymentIds: string[];
  paymentStatus: string;
  paymentMethod: string;
  isSplitPayment: boolean;
  commercialStatus: 'SALE' | 'COMPLIMENTARY';
};

type AuthorizePosAddOnsRequest = {
  storeId: string;
  orderId: string;
  orderNumber: string | null;
  /** Server-read source used to bind Customer Web acceptance to its submitted snapshot. */
  sourceOnlineOrderId?: string;
  checkoutMode?: 'STANDARD_POS' | 'SETUP_TEST';
  checkoutSource?: 'POS';
  paymentMethod?: string | null;
  financialVersion?: 3;
  checkoutContext?: PosCheckoutContext;
  discountPercent?: number;
  splitPayments?: Array<{ method: string; amount: number }>;
  items: PosAddOnAuthorizationItemRequest[];
};

const authorizePosAddOnsCallable = httpsCallable<
  AuthorizePosAddOnsRequest,
  PosAddOnAuthorization
>(functions, 'authorizePosAddOns');

export async function authorizePosAddOns(
  request: AuthorizePosAddOnsRequest,
): Promise<PosAddOnAuthorization> {
  const result = await authorizePosAddOnsCallable(request);
  // The old authorizer ignores new request fields. Never interpret its v3 plan
  // (or an older recovery binding) as acknowledgment of the new server barrier.
  if (!request.sourceOnlineOrderId) {
    const expected = request.checkoutContext;
    const context = result.data.checkoutContext;
    const binding = result.data.recoveryBinding;
    const keys: Array<keyof PosCheckoutContext> = ['version', 'staffUid', 'storeId', 'originalOrderId', 'idempotencyKey', 'basketIdentity'];
    if (!expected || !context || Object.keys(context).length !== keys.length || keys.some(key => context[key] !== expected[key])
      || !binding || binding.version !== 1 || binding.authorizationId !== result.data.authorizationId
      || binding.staffUid !== context.staffUid || binding.storeId !== context.storeId || binding.orderId !== context.originalOrderId
      || binding.basketIdentity !== context.basketIdentity) throw new Error(POS_REFRESH_REQUIRED);
  }
  return result.data;
}

export function selectedAddOnIds(addOns: AddOnSelection[] | undefined) {
  return (addOns || []).map(addOn => ({
    groupId: addOn.groupId,
    optionId: addOn.optionId,
    quantity: addOn.quantity,
  }));
}
