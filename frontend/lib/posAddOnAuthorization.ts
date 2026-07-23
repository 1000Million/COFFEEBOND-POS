import { httpsCallable } from 'firebase/functions';
import type { AddOnSelection } from '../types';
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
};

export type PosAddOnAuthorization = {
  authorizationId: string;
  canonicalItems: Record<string, PosAddOnCanonicalItem>;
  canonicalAddOnTotal: number;
  expiresAt: string;
};

type AuthorizePosAddOnsRequest = {
  storeId: string;
  orderId: string;
  orderNumber: string | null;
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
  return result.data;
}

export function selectedAddOnIds(addOns: AddOnSelection[] | undefined) {
  return (addOns || []).map(addOn => ({
    groupId: addOn.groupId,
    optionId: addOn.optionId,
    quantity: addOn.quantity,
  }));
}
