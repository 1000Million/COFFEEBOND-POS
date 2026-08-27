import { PublicOrderTracking } from '../types';

const CHECKOUT_SCRIPT_URL = 'https://checkout.razorpay.com/v1/checkout.js';
let checkoutScriptPromise: Promise<void> | null = null;

export type RazorpayCheckoutSuccess = {
  razorpay_payment_id: string;
  razorpay_order_id: string;
  razorpay_signature: string;
};

export type BondRedemptionPolicy = {
  label: string;
  minimumPoints: number;
  incrementPoints: number;
  pointValuePaise: number;
  maximumPercent: number;
};

/**
 * One server-authored redemption quote. Monetary fields are deliberately returned by
 * the callable together so the customer client never recreates tax or redemption
 * arithmetic from a points balance.
 */
export type BondRedemptionQuote = {
  policy: BondRedemptionPolicy;
  pointsBalance: number;
  reservedPoints: number;
  availablePoints: number;
  maximumUsablePoints: number;
  selectedPoints: number;
  subtotal: number;
  discount: number;
  taxableAmount: number;
  gstTotal: number;
  grandTotal: number;
};

export type RazorpayOrderResponse = {
  sessionId?: string;
  razorpayOrderId?: string;
  amount?: number;
  currency?: 'INR';
  keyId?: string;
  receipt?: string;
  status?: string;
  expiresAt?: string | null;
  prefill?: {
    name?: string;
    contact?: string;
  };
  customerId?: string;
  rememberCustomer?: boolean;
  readonly?: { contact?: boolean };
  magicCheckoutEnabled?: boolean;
  oneClickCheckout?: boolean;
  lineItems?: Array<{
    sku: string;
    name: string;
    quantity: number;
    price: number;
  }>;
  bondRedemption?: BondRedemptionQuote;
  alreadyPaid?: boolean;
  trackingToken?: string | null;
  trackingPath?: string | null;
};

export type RazorpayOptions = {
  key: string;
  order_id: string;
  amount: number;
  currency: 'INR';
  name: string;
  description: string;
  image?: string;
  prefill?: {
    name?: string;
    contact?: string;
  };
  customer_id?: string;
  remember_customer?: boolean;
  readonly?: { contact?: boolean };
  one_click_checkout?: boolean;
  line_items?: Array<{
    sku: string;
    name: string;
    quantity: number;
    price: number;
  }>;
  config?: {
    display?: {
      blocks?: Record<string, {
        name: string;
        instruments: Array<{ method: string }>;
      }>;
      sequence?: string[];
      preferences?: { show_default_blocks?: boolean };
    };
  };
  theme?: { color: string };
  handler: (response: RazorpayCheckoutSuccess) => void;
  modal?: { ondismiss?: () => void };
};

declare global {
  interface Window {
    Razorpay?: new (options: RazorpayOptions) => {
      open: () => void;
      on: (event: 'payment.failed', handler: () => void) => void;
    };
  }
}

export function loadRazorpayCheckout(): Promise<void> {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return Promise.reject(new Error('Online payment requires a browser.'));
  }
  if (window.Razorpay) return Promise.resolve();
  if (checkoutScriptPromise) return checkoutScriptPromise;

  checkoutScriptPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${CHECKOUT_SCRIPT_URL}"]`);
    const script = existing || document.createElement('script');
    const handleLoad = () => {
      if (window.Razorpay) {
        resolve();
      } else {
        checkoutScriptPromise = null;
        reject(new Error('Online payment did not load. Please retry.'));
      }
    };
    const handleError = () => {
      checkoutScriptPromise = null;
      script.remove();
      reject(new Error('Online payment could not load. Check your connection and retry.'));
    };
    script.addEventListener('load', handleLoad, { once: true });
    script.addEventListener('error', handleError, { once: true });
    if (!existing) {
      script.src = CHECKOUT_SCRIPT_URL;
      script.async = true;
      script.dataset.coffeeBondRazorpay = 'checkout';
      document.head.appendChild(script);
    }
  });
  return checkoutScriptPromise;
}

function timestampMillis(value: unknown): number | null {
  if (value && typeof (value as { toMillis?: () => number }).toMillis === 'function') {
    return (value as { toMillis: () => number }).toMillis();
  }
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

export function canPayRazorpayOrder(order: PublicOrderTracking, now = Date.now()): boolean {
  if (order.publicStatus !== 'ACCEPTED_AWAITING_PAYMENT') return false;
  if (order.paymentProvider !== 'RAZORPAY') return false;
  if (!['NOT_STARTED', 'AWAITING_PAYMENT', 'FAILED'].includes(order.paymentStatus || '')) return false;
  const expiry = timestampMillis(order.paymentAvailableUntil);
  return expiry === null || expiry > now;
}

export function isRazorpayPaymentExpired(order: PublicOrderTracking, now = Date.now()): boolean {
  if (order.publicStatus !== 'ACCEPTED_AWAITING_PAYMENT' || order.paymentProvider !== 'RAZORPAY') return false;
  const expiry = timestampMillis(order.paymentAvailableUntil);
  return expiry !== null && expiry <= now;
}

export function validateRazorpayOrderResponse(value: RazorpayOrderResponse): asserts value is Required<
  Pick<RazorpayOrderResponse, 'razorpayOrderId' | 'amount' | 'currency' | 'keyId' | 'receipt'>
> & RazorpayOrderResponse {
  if (
    !value.razorpayOrderId
    || !value.keyId
    || value.currency !== 'INR'
    || !Number.isSafeInteger(value.amount)
    || Number(value.amount) < 100
    || !value.receipt
  ) {
    throw new Error('Online payment returned an invalid order. Please retry.');
  }
}

export function validateBondRedemptionQuote(value: unknown): asserts value is BondRedemptionQuote {
  const quote = value as Partial<BondRedemptionQuote> | null;
  const policy = quote?.policy as Partial<BondRedemptionPolicy> | undefined;
  const nonNegativeNumber = (candidate: unknown) => (
    typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0
  );
  const nonNegativeInteger = (candidate: unknown) => (
    Number.isSafeInteger(candidate) && Number(candidate) >= 0
  );
  if (
    !quote
    || !policy
    || typeof policy.label !== 'string'
    || !policy.label.trim()
    || !Number.isSafeInteger(policy.minimumPoints)
    || Number(policy.minimumPoints) <= 0
    || !Number.isSafeInteger(policy.incrementPoints)
    || Number(policy.incrementPoints) <= 0
    || !Number.isSafeInteger(policy.pointValuePaise)
    || Number(policy.pointValuePaise) <= 0
    || !nonNegativeNumber(policy.maximumPercent)
    || Number(policy.maximumPercent) > 100
    || !nonNegativeInteger(quote.pointsBalance)
    || !nonNegativeInteger(quote.reservedPoints)
    || !nonNegativeInteger(quote.availablePoints)
    || !nonNegativeInteger(quote.maximumUsablePoints)
    || !nonNegativeInteger(quote.selectedPoints)
    || !nonNegativeNumber(quote.subtotal)
    || !nonNegativeNumber(quote.discount)
    || !nonNegativeNumber(quote.taxableAmount)
    || !nonNegativeNumber(quote.gstTotal)
    || !nonNegativeNumber(quote.grandTotal)
    || Number(quote.selectedPoints) > Number(quote.maximumUsablePoints)
    || (
      Number(quote.selectedPoints) > 0
      && (
        Number(quote.selectedPoints) < Number(policy.minimumPoints)
        || (Number(quote.selectedPoints) - Number(policy.minimumPoints)) % Number(policy.incrementPoints) !== 0
      )
    )
  ) {
    throw new Error('BOND redemption returned an invalid quote. Please retry.');
  }
}

export { CHECKOUT_SCRIPT_URL };
