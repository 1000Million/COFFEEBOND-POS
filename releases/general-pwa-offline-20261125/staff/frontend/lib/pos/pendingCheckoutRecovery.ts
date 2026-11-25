export type CheckoutRecoveryBinding = {
  version: 1; staffUid: string; storeId: string; orderId: string; authorizationId: string;
  basketIdentity: string; basketFingerprint: string; sourceVersionHash: string;
};
export type PendingCheckoutOwnership = {
  version: 1; staffUid: string; storeId: string; orderId: string; draftKey: string; reference: string;
};

/** Selection references only; server and browser preserve duplicate rows and sort identically. */
export function checkoutBasketIdentity(rows: Array<{ menuItemId: string; quantity: number; addOns?: Array<{ groupId: string; optionId: string; quantity: number }> }>): string {
  const compare = (left: unknown, right: unknown) => { const a = JSON.stringify(left), b = JSON.stringify(right); return a < b ? -1 : a > b ? 1 : 0; };
  return JSON.stringify(rows.map(row => ({ menuItemId: row.menuItemId, quantity: row.quantity,
    addOns: (row.addOns || []).map(option => ({ groupId: option.groupId, optionId: option.optionId, quantity: option.quantity })).sort(compare),
  })).sort(compare));
}
export function validCheckoutRecoveryBinding(value: unknown): value is CheckoutRecoveryBinding {
  if (!value || typeof value !== 'object') return false;
  const binding = value as CheckoutRecoveryBinding;
  return binding.version === 1 && ['staffUid', 'storeId', 'orderId', 'authorizationId', 'basketIdentity'].every(field =>
    typeof binding[field as keyof CheckoutRecoveryBinding] === 'string' && String(binding[field as keyof CheckoutRecoveryBinding]).length > 0)
    && /^[a-f0-9]{64}$/.test(binding.basketFingerprint) && /^[a-f0-9]{64}$/.test(binding.sourceVersionHash);
}
export function sameCheckoutRecoveryBinding(left: unknown, right: unknown): boolean {
  if (!validCheckoutRecoveryBinding(left) || !validCheckoutRecoveryBinding(right)) return false;
  return (['version', 'staffUid', 'storeId', 'orderId', 'authorizationId', 'basketIdentity', 'basketFingerprint', 'sourceVersionHash'] as const)
    .every(field => left[field] === right[field]);
}
export function hasCheckoutOwnership(attempt: PendingCheckoutIdentity): boolean {
  const owner = attempt.ownership;
  if (!owner || owner.version !== 1 || owner.orderId !== attempt.orderId
    || !['staffUid', 'storeId', 'draftKey', 'reference'].every(field => typeof owner[field as keyof PendingCheckoutOwnership] === 'string'
      && String(owner[field as keyof PendingCheckoutOwnership]).length > 0)) return false;
  try { const basket = JSON.parse(owner.reference); return basket.schemaVersion === 2 && Array.isArray(basket.cart); } catch { return false; }
}
export function bindingMatchesCheckout(attempt: PendingCheckoutIdentity, binding: unknown = attempt.recoveryBinding): binding is CheckoutRecoveryBinding {
  if (!hasCheckoutOwnership(attempt) || !validCheckoutRecoveryBinding(binding)) return false;
  const owner = attempt.ownership!;
  try { return binding.staffUid === owner.staffUid && binding.storeId === owner.storeId && binding.orderId === owner.orderId
    && binding.basketIdentity === checkoutBasketIdentity(JSON.parse(owner.reference).cart); } catch { return false; }
}

export type PendingCheckoutIdentity = {
  orderId: string;
  idempotencyKey: string;
  payloadHash?: string;
  previousPayloadHashes?: string[];
  ownership?: PendingCheckoutOwnership;
  recoveryBinding?: CheckoutRecoveryBinding;
};

export type PendingCheckoutResolution =
  | { status: 'COMMITTED'; order: Record<string, unknown>; staffUid?: string; recoveryBinding?: CheckoutRecoveryBinding }
  | { status: 'NOT_SAVED'; staffUid?: string; recoveryBinding?: CheckoutRecoveryBinding }
  | { status: 'DISMISSED'; orderId: string; storeId: string; retirementId: string; staffUid: string; recoveryBinding: CheckoutRecoveryBinding; resolutionKind: 'NO_PAYMENT_REVIEWED' | 'PAID_REPLACEMENT'; replacementOrderId?: string }
  | { status: 'UNCERTAIN'; reason: 'READ_FAILED' | 'ORDER_MISMATCH' };

export function hasBoundCheckoutAttempt(attempt: PendingCheckoutIdentity | null | undefined): boolean {
  return Boolean(attempt?.payloadHash || attempt?.previousPayloadHashes?.length);
}

/** Only a server read may reconcile an old key. Absence is not proof of no payment. */
export async function reconcilePendingCheckout(
  attempt: PendingCheckoutIdentity,
  readServerOrder: (orderId: string) => Promise<Record<string, unknown> | null>,
): Promise<PendingCheckoutResolution> {
  try {
    const order = await readServerOrder(attempt.orderId);
    if (!order) return { status: 'NOT_SAVED' };
    const knownHashes = [attempt.payloadHash, ...(attempt.previousPayloadHashes || [])].filter(Boolean);
    if (order.clientCheckoutIdempotencyKey !== attempt.idempotencyKey
      || !knownHashes.includes(String(order.checkoutPayloadHash || ''))) {
      return { status: 'UNCERTAIN', reason: 'ORDER_MISMATCH' };
    }
    return { status: 'COMMITTED', order };
  } catch {
    return { status: 'UNCERTAIN', reason: 'READ_FAILED' };
  }
}

export type PendingCheckoutReview = {
  reason: 'REVIEWED_NO_PAYMENT' | 'VERIFIED_PAID_REPLACEMENT';
  resolution: { kind: 'NO_PAYMENT_REVIEWED' } | { kind: 'PAID_REPLACEMENT'; replacementOrderId: string };
};

export type PendingCheckoutServerResult =
  | { status: 'COMMITTED'; staffUid: string; recoveryBinding: CheckoutRecoveryBinding; storeId: string; savedOrder: Record<string, unknown>; savedItems: Record<string, unknown>[]; savedPayments: Record<string, unknown>[] }
  | { status: 'REVIEW_REQUIRED'; staffUid: string; recoveryBinding: CheckoutRecoveryBinding; orderId: string; storeId: string }
  | { status: 'UNCERTAIN'; orderId: string; reasonCode: string }
  | Extract<PendingCheckoutResolution, { status: 'DISMISSED' }>;

/** Keep all hashes bound until an authoritative outcome resolves this exact identity. */
export async function resolvePendingCheckoutStatus(
  attempt: PendingCheckoutIdentity,
  result: PendingCheckoutServerResult,
  storeId: string,
): Promise<PendingCheckoutResolution> {
  if (!bindingMatchesCheckout(attempt) || result.status === 'UNCERTAIN'
    || result.staffUid !== attempt.ownership?.staffUid
    || !sameCheckoutRecoveryBinding(result.recoveryBinding, attempt.recoveryBinding)) return { status: 'UNCERTAIN', reason: 'ORDER_MISMATCH' };
  if (result.storeId !== storeId) return { status: 'UNCERTAIN', reason: 'ORDER_MISMATCH' };
  if (result.status === 'COMMITTED') {
    if (result.savedOrder?.id !== attempt.orderId || result.savedOrder.storeId !== storeId
      || result.savedOrder.createdByUserId !== result.staffUid) return { status: 'UNCERTAIN', reason: 'ORDER_MISMATCH' };
    const resolved = await reconcilePendingCheckout(attempt, async () => result.savedOrder);
    return resolved.status === 'COMMITTED' ? { ...resolved, staffUid: result.staffUid, recoveryBinding: result.recoveryBinding } : resolved;
  }
  if (result.orderId !== attempt.orderId) return { status: 'UNCERTAIN', reason: 'ORDER_MISMATCH' };
  if (result.status === 'DISMISSED') {
    if (!/^[A-Za-z0-9_-]{1,180}$/.test(result.retirementId)
      || !['NO_PAYMENT_REVIEWED', 'PAID_REPLACEMENT'].includes(result.resolutionKind)
      || (result.resolutionKind === 'PAID_REPLACEMENT' && !/^POS_[A-Za-z0-9_-]{1,176}$/.test(result.replacementOrderId || ''))) {
      return { status: 'UNCERTAIN', reason: 'ORDER_MISMATCH' };
    }
    return result;
  }
  return result.status === 'REVIEW_REQUIRED' ? { status: 'NOT_SAVED', staffUid: result.staffUid, recoveryBinding: result.recoveryBinding } : { status: 'UNCERTAIN', reason: 'READ_FAILED' };
}

/** Only allow static codes and an opaque correlation ID into UI/logs. */
export function checkoutDiagnostic(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value = error as { code?: unknown; details?: { code?: unknown; reasonCode?: unknown; diagnosticId?: unknown } };
  const safe = (candidate: unknown, pattern: RegExp) => typeof candidate === 'string' && pattern.test(candidate) ? candidate : '';
  const code = safe(value.code, /^(?:functions\/)?[a-z][a-z-]{1,60}$/);
  const reason = safe(value.details?.reasonCode || value.details?.code, /^[A-Z][A-Z0-9_]{1,95}$/);
  const reference = safe(value.details?.diagnosticId, /^[A-Za-z0-9_-]{6,100}$/);
  return [code, reason, reference ? `Reference: ${reference}` : ''].filter(Boolean).join(' · ') || undefined;
}

/** Reviewed server reason codes choose user guidance; raw exception text is never displayed. */
export function checkoutServerMessage(error: unknown): string | undefined {
  const reason = (error as { details?: { reasonCode?: unknown } })?.details?.reasonCode;
  if (typeof reason !== 'string') return undefined;
  const messages: Record<string, string> = {
    COMP_DETAILS_REQUIRED: 'Complete the complimentary customer details, reason and phone verification before billing.',
    COMP_VERIFICATION_UNAVAILABLE: 'The complimentary phone verification is expired, used, or belongs to another sale. Review the previous checkout before requesting fresh verification.',
    COMP_VALUE_REQUIRED: 'A complimentary bill requires items with a positive menu value.',
    CANONICAL_CART_CHANGED: 'Menu prices or selections changed. Keep this checkout reference and ask an Admin to review the basket.',
    PRODUCT_UNAVAILABLE: 'An item is no longer available. Keep this checkout reference and review the current menu.',
    PRODUCT_STORE_UNAVAILABLE: 'An item is no longer available at this store. Keep the reference and review the basket.',
    PRODUCT_REFERENCE_CHANGED: 'An item reference changed. Keep the reference and ask an Admin to review the current menu.',
    STORE_INACTIVE: 'This store is unavailable for POS billing. Keep the basket and ask an Admin to review the store.',
    COUNTER_INVALID: 'The invoice sequence requires Admin review. Keep this checkout reference.',
    AUTHORIZATION_NOT_FOUND: 'The checkout authorization was not found. Check the previous checkout before continuing.',
    AUTHORIZATION_UNAVAILABLE: 'The checkout authorization expired or was used. Check the previous checkout before continuing.',
    AUTHORIZATION_SCOPE_MISMATCH: 'The authorization belongs to a different checkout context. Keep the original reference and ask an Admin.',
    FINANCIAL_SNAPSHOT_MISMATCH: 'The basket totals do not match the server authorization. Keep the original reference and ask an Admin to review.',
    CHECKOUT_RETRY_CONFLICT: 'The original reference already has different saved content. Check the previous checkout and its receipt before continuing.',
    CHECKOUT_RETIRED: 'This checkout reference was retired. Check the previous checkout to finish recovery; do not charge it again.',
    INVENTORY_CONFIG_REVIEW_REQUIRED: 'The inventory configuration requires Admin review. Keep the basket and original reference.',
    DISCOUNT_LIMIT_EXCEEDED: 'The discount exceeds your role limit. Review the discount before billing.',
    SPLIT_TOTAL_MISMATCH: 'Split payment amounts must equal the bill total. Review the allocations.',
    SPLIT_ROWS_REQUIRED: 'Add the required split payment rows and review their amounts.',
    STAFF_STORE_ACCESS_REQUIRED: 'Your staff account does not have access to this store. Keep the basket and ask an Admin.',
    STAFF_SIGN_IN_REQUIRED: 'Sign in to your staff account, then check the previous checkout before continuing.',
    ORIGINAL_STAFF_REQUIRED: 'Sign in as the original staff member to recover this checkout. Its basket and reference remain protected.',
    RECOVERY_OWNER_MISMATCH: 'Sign in as the original staff member to recover this checkout. Its basket and reference remain protected.',
    RECOVERY_BINDING_REQUIRED: 'This reference has no verified recovery ownership. Keep its basket and ask an Admin to reconcile the original sale.',
    RECOVERY_BINDING_MISMATCH: 'The original checkout ownership or basket could not be verified. Keep its basket and reference.',
    ADMIN_REVIEW_REQUIRED: 'Only an active Admin can retire a checkout reference. Ask an Admin to review this bill.',
    STORE_GST_REVIEW_REQUIRED: 'The store GST setup requires Admin review. Keep this checkout reference.',
    STORE_GST_CHANGED: 'The store GST setup changed. Keep the reference and ask an Admin to review the basket.',
    STORE_GST_SOURCE_INVALID: 'The store legal and GST source requires Admin review. Keep this checkout reference.',
    STORE_GST_SOURCE_UNAVAILABLE: 'The store legal and GST source is unavailable. Keep the basket and ask an Admin.',
  };
  return Object.prototype.hasOwnProperty.call(messages, reason) ? messages[reason] : undefined;
}
