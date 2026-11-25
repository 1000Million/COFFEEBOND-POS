const LAST_TRACKING_TOKEN_KEY = 'coffeeBondLastOrderTrackingToken';
const PENDING_TRACKING_TOKENS_KEY = 'coffeeBondPendingOrderTokens';

function readPendingTokens(): string[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(PENDING_TRACKING_TOKENS_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter(value => typeof value === 'string') : [];
  } catch {
    return [];
  }
}

export function rememberCustomerOrder(trackingToken: string): void {
  if (!trackingToken || typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LAST_TRACKING_TOKEN_KEY, trackingToken);
    window.localStorage.setItem(
      PENDING_TRACKING_TOKENS_KEY,
      JSON.stringify([...new Set([trackingToken, ...readPendingTokens()])].slice(0, 20)),
    );
  } catch {
    // Tracking still works through the stable URL and authenticated My Orders.
  }
}

export function forgetPendingCustomerOrder(trackingToken: string): void {
  if (!trackingToken || typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      PENDING_TRACKING_TOKENS_KEY,
      JSON.stringify(readPendingTokens().filter(token => token !== trackingToken)),
    );
  } catch {
    // Local persistence is a recovery convenience only.
  }
}

export function lastCustomerOrderTrackingToken(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(LAST_TRACKING_TOKEN_KEY);
  } catch {
    return null;
  }
}

export {
  LAST_TRACKING_TOKEN_KEY,
  PENDING_TRACKING_TOKENS_KEY,
};
