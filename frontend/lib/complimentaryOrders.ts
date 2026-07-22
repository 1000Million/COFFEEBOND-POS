import type { Order, ReceiptLegalDetails, Store } from '../types';

export const COMPLIMENTARY_OTP_BLOCKER = 'BLOCKED_OTP_PROVIDER_NOT_CONFIGURED';

export type ComplimentaryOtpVerification = {
  authorizationId: string;
  provider: string;
  verifiedPhone: string;
  verifiedAtIso: string;
};

export type ComplimentaryCheckoutInput = {
  customerName: string;
  customerPhone: string;
  reason: string;
  verification: ComplimentaryOtpVerification | null;
  otpProviderConfigured: boolean;
};

export type ComplimentaryTotals = {
  subtotal: number;
  discountPercent: number;
  discountAmount: number;
  taxableAmount: number;
  taxTotal: number;
  grandTotal: number;
};

export type ComplimentaryMetrics = {
  orderCount: number;
  menuValue: number;
  cogs: number;
};

function finiteMoney(value: unknown): number {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : 0;
}

export function isValidIndianMobile(value: string): boolean {
  return /^[6-9][0-9]{9}$/.test(value.trim());
}

export function validateComplimentaryCheckout(input: ComplimentaryCheckoutInput): string[] {
  const errors: string[] = [];
  const name = input.customerName.trim();
  const phone = input.customerPhone.trim();
  const reason = input.reason.trim();

  if (!name) errors.push('Customer name is required for a complimentary order.');
  if (!isValidIndianMobile(phone)) errors.push('Enter a valid Indian 10-digit mobile number.');
  if (!reason) errors.push('Complimentary reason is required.');
  if (!input.otpProviderConfigured) {
    errors.push(COMPLIMENTARY_OTP_BLOCKER);
  } else if (!input.verification) {
    errors.push('Successful OTP verification is required.');
  } else if (input.verification.verifiedPhone !== phone) {
    errors.push('The phone number changed after verification. Verify the new number.');
  } else if (!input.verification.authorizationId.trim() || !input.verification.provider.trim()) {
    errors.push('OTP verification authorization is incomplete.');
  } else if (Number.isNaN(Date.parse(input.verification.verifiedAtIso))) {
    errors.push('OTP verification timestamp is invalid.');
  }

  return errors;
}

export function retainVerificationForPhone(
  verification: ComplimentaryOtpVerification | null,
  nextPhone: string,
): ComplimentaryOtpVerification | null {
  if (!verification) return null;
  return verification.verifiedPhone === nextPhone.trim() ? verification : null;
}

export function buildComplimentaryTotals(menuValueInput: unknown): ComplimentaryTotals {
  const menuValue = Math.max(0, finiteMoney(menuValueInput));
  return {
    subtotal: menuValue,
    discountPercent: menuValue > 0 ? 100 : 0,
    discountAmount: menuValue,
    taxableAmount: 0,
    taxTotal: 0,
    grandTotal: 0,
  };
}

export function isComplimentaryOrder(order: Partial<Order>): boolean {
  if (order.commercialStatus === 'COMPLIMENTARY') return true;
  if (order.paymentMethod === 'COMPLIMENTARY') return true;
  return Array.isArray(order.paymentBreakdown)
    && order.paymentBreakdown.some((payment) => payment?.method === 'COMPLIMENTARY');
}

export function complimentaryOrderMenuValue(order: Partial<Order>): number {
  const explicitMenuValue = finiteMoney(order.menuValue);
  if (explicitMenuValue > 0) return explicitMenuValue;
  return finiteMoney(order.subtotal);
}

export function summarizeComplimentaryOrders(orders: Order[]): ComplimentaryMetrics {
  return orders.filter(isComplimentaryOrder).reduce<ComplimentaryMetrics>((summary, order) => {
    summary.orderCount += 1;
    summary.menuValue += complimentaryOrderMenuValue(order);
    summary.cogs += finiteMoney(order.cogsTotal);
    return summary;
  }, { orderCount: 0, menuValue: 0, cogs: 0 });
}

export function receiptLegalDetailsFromStore(store: Store): ReceiptLegalDetails {
  const clean = (value: unknown) => {
    const text = String(value || '').trim();
    return text || null;
  };

  return {
    legalName: clean(store.legalName),
    tradeName: clean(store.tradeName),
    legalAddress: clean(store.legalAddress),
    gstin: clean(store.gstin),
    stateName: clean(store.stateName),
    stateCode: clean(store.stateCode),
    gstRegistered: store.gstRegistered === true,
  };
}
