/**
 * Route-aware PWA identity.
 *
 * HOTFIX — same-origin customer install is withdrawn.
 *
 * Real-device acceptance failed: installing from pos.coffeebond.in/order produced a
 * "CB POS" app that resolved to /pos, and Android treated it as an update to the
 * existing staff POS app rather than a second app. Same-origin manifest swapping
 * cannot express two separate installable identities reliably — Chromium keeps the
 * identity it resolved for the document, and iOS ignores the manifest for
 * "Add to Home Screen" altogether.
 *
 * Until the customer app moves to its own origin (order.coffeebond.in), customer
 * routes advertise NO manifest at all. That makes /order deliberately non-installable
 * instead of installable-and-wrong, while leaving customer ordering fully usable in
 * the browser.
 *
 * The staff app is untouched: every non-customer route keeps /manifest.webmanifest,
 * "CB POS" and start_url /pos exactly as shipped, so installed staff apps continue
 * to work.
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

/** Removes any advertised manifest, making the current document non-installable. */
function removeManifestLink(): void {
  document.head.querySelectorAll('link[rel="manifest"]').forEach((link) => link.remove());
}

/** Restores the staff manifest exactly as index.html ships it. */
function ensureStaffManifestLink(): void {
  const existing = document.head.querySelector<HTMLLinkElement>('link[rel="manifest"]');
  if (existing?.getAttribute('href') === STAFF_MANIFEST_HREF) return;

  const link = document.createElement('link');
  link.rel = 'manifest';
  link.href = STAFF_MANIFEST_HREF;
  if (existing) existing.remove();
  document.head.appendChild(link);
}

export function applyPwaIdentityForPath(pathname: string): 'CUSTOMER' | 'STAFF' {
  const customer = isCustomerPath(pathname);

  if (customer) {
    // No manifest is advertised on customer routes: the page must not be installable
    // until the customer app has its own origin. The customer-facing Apple title and
    // document title are kept because they only affect labelling, never install
    // eligibility, and a customer who bookmarks the page should not see "CB POS".
    removeManifestLink();
    setMetaContent('apple-mobile-web-app-title', CUSTOMER_APPLE_TITLE);
    setMetaContent('theme-color', CUSTOMER_THEME_COLOR);
    document.title = 'Coffee Bond — Order ahead';
    return 'CUSTOMER';
  }

  ensureStaffManifestLink();
  setMetaContent('apple-mobile-web-app-title', STAFF_APPLE_TITLE);
  setMetaContent('theme-color', STAFF_THEME_COLOR);
  document.title = 'Coffee Bond POS';
  return 'STAFF';
}
