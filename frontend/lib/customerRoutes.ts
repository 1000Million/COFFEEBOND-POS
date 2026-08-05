/**
 * Centralised customer route and tracking-URL construction.
 *
 * The same customer pages are served from two origins with different path shapes:
 *
 *   staff origin    pos.coffeebond.in   /order, /order/my-orders, /order/status/:token
 *   customer origin order.coffeebond.in /,      /my-orders,       /status/:token
 *
 * Which shape applies is decided at BUILD time by VITE_CUSTOMER_ORIGIN_BUILD, not by
 * sniffing the hostname, so preview channels and the eventual custom domain behave
 * identically without hardcoding any origin. Absolute URLs are always composed from
 * window.location.origin, so a preview build produces preview URLs on its own.
 *
 * The customer origin also serves the /order* paths as compatibility aliases, so a
 * server-supplied trackingPath such as "/order/status/<token>" still resolves there.
 */

export const IS_CUSTOMER_ORIGIN_BUILD = import.meta.env.VITE_CUSTOMER_ORIGIN_BUILD === 'true';

export const CUSTOMER_HOME_PATH = IS_CUSTOMER_ORIGIN_BUILD ? '/' : '/order';
export const CUSTOMER_MY_ORDERS_PATH = IS_CUSTOMER_ORIGIN_BUILD ? '/my-orders' : '/order/my-orders';

/** Canonical in-app path for an order status screen. Tokens are passed through verbatim. */
export function customerStatusPath(trackingToken: string): string {
  return IS_CUSTOMER_ORIGIN_BUILD ? `/status/${trackingToken}` : `/order/status/${trackingToken}`;
}

/**
 * Absolute, shareable tracking URL for the current origin.
 *
 * Only the opaque tracking token is included — never a customer name, phone number,
 * order id or any other private identifier.
 */
export function customerTrackingUrl(trackingToken: string): string {
  return `${window.location.origin}${customerStatusPath(trackingToken)}`;
}

/**
 * Normalises a server-supplied tracking path for the current build.
 *
 * Callables may return "/order/status/<token>". On the customer origin that alias
 * still resolves, but the canonical path is preferred so the address bar and any
 * copied link match the origin the customer is actually using.
 */
export function normalizeTrackingPath(trackingPath: string | null | undefined, trackingToken: string): string {
  if (!trackingPath) return customerStatusPath(trackingToken);
  const match = /\/(?:order\/)?status\/(.+)$/.exec(trackingPath);
  if (!match) return customerStatusPath(trackingToken);
  return customerStatusPath(match[1]);
}
