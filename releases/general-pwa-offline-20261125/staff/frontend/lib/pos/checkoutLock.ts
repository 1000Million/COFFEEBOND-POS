export const CHECKOUT_ATTEMPT_STORAGE_KEY = 'coffeeBondPos:pendingCheckoutAttempt:v1';

// Counter checkout, table commands and journal capture check their durable
// references in this same origin lock before they can begin a settlement.
export async function withCheckoutMarkerLock<T>(mutation: () => T | Promise<T>): Promise<T> {
  if (typeof navigator === 'undefined' || !navigator.locks?.request) {
    throw new Error('Checkout recovery requires browser coordination. Keep the basket and reference.');
  }
  return navigator.locks.request(CHECKOUT_ATTEMPT_STORAGE_KEY, { mode: 'exclusive' }, mutation);
}
