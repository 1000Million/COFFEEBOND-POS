/**
 * Route-aware PWA identity.
 *
 * Coffee Bond ships two independent installable apps from one origin:
 *   - staff  : /manifest.webmanifest      (name "Coffee Bond POS", start_url /pos)
 *   - customer: /manifest-customer.webmanifest (name "Coffee Bond", start_url /order)
 *
 * A document can only advertise one manifest at a time, so the <link rel="manifest">
 * and the Apple meta tags are pointed at whichever app the current route belongs to.
 * The staff manifest remains the default for every non-customer route, exactly as
 * shipped, and is never repointed.
 *
 * BROWSER LIMITATION (documented, not worked around):
 * Chromium reads the manifest when it evaluates install eligibility and generally
 * keeps the identity it already resolved for an open document. Swapping the link
 * inside a single already-open tab is therefore best-effort: it reliably gives the
 * correct identity on a fresh navigation/reload to a customer URL, but a soft
 * client-side route change from a staff screen into /order within the same tab may
 * still be evaluated against the previously resolved manifest until the next full
 * load. Customers should enter at https://pos.coffeebond.in/order directly, which
 * is the normal path from a link, QR code or bookmark. iOS Safari ignores the
 * manifest for "Add to Home Screen" entirely and uses the Apple meta tags plus the
 * apple-touch-icon, which are swapped here for the same reason.
 */

export const STAFF_MANIFEST_HREF = '/manifest.webmanifest';
export const CUSTOMER_MANIFEST_HREF = '/manifest-customer.webmanifest';

export const STAFF_APPLE_TITLE = 'CB POS';
export const CUSTOMER_APPLE_TITLE = 'Coffee Bond';

export const STAFF_THEME_COLOR = '#5c4033';
export const CUSTOMER_THEME_COLOR = '#5c4033';

export function isCustomerPath(pathname: string): boolean {
  return pathname === '/order' || pathname.startsWith('/order/');
}

function setMetaContent(name: string, content: string): void {
  const meta = document.head.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
  if (meta) meta.content = content;
}

/**
 * Replaces the manifest link element rather than mutating href. Chromium is more
 * likely to re-read a newly inserted link than an href mutation on the existing one.
 */
function setManifestHref(href: string): void {
  const existing = document.head.querySelector<HTMLLinkElement>('link[rel="manifest"]');
  if (existing?.getAttribute('href') === href) return;

  const link = document.createElement('link');
  link.rel = 'manifest';
  link.href = href;
  if (existing) existing.remove();
  document.head.appendChild(link);
}

export function applyPwaIdentityForPath(pathname: string): 'CUSTOMER' | 'STAFF' {
  const customer = isCustomerPath(pathname);

  setManifestHref(customer ? CUSTOMER_MANIFEST_HREF : STAFF_MANIFEST_HREF);
  setMetaContent('apple-mobile-web-app-title', customer ? CUSTOMER_APPLE_TITLE : STAFF_APPLE_TITLE);
  setMetaContent('theme-color', customer ? CUSTOMER_THEME_COLOR : STAFF_THEME_COLOR);
  document.title = customer ? 'Coffee Bond — Order ahead' : 'Coffee Bond POS';

  return customer ? 'CUSTOMER' : 'STAFF';
}
