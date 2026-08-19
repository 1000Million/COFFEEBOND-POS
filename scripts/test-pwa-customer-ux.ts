import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  customerMenuCategory,
  trustedDietaryClassification,
} from '../frontend/lib/customerMenuPresentation';
import { deriveCustomerOrderingState } from '../frontend/lib/customerOrderingState';
import { isCustomerPath } from '../frontend/lib/customerPwaIdentity';

const root = process.cwd();
const source = (path: string) => readFileSync(resolve(root, path), 'utf8');
const customerOrder = source('frontend/pages/customer/CustomerOrder.tsx');
const customerHeader = source('frontend/components/customer/CustomerHeader.tsx');
const customerImage = source('frontend/components/customer/CustomerProductImage.tsx');
const addOnSelector = source('frontend/components/add-ons/AddOnSelector.tsx');
const serviceWorker = source('public/sw.js');
const manifest = JSON.parse(source('public/manifest.webmanifest')) as Record<string, unknown>;
const connectivity = source('frontend/lib/connectivity.ts');
const pwaUi = source('frontend/components/PwaStatusUI.tsx');
const pwaRegistration = source('frontend/lib/pwa.ts');
const appEntry = source('frontend/main.tsx');
const protectedStaffActions = [
  'frontend/pages/pos/POSHome.tsx',
  'frontend/pages/pos/IncomingOnlineOrders.tsx',
  'frontend/pages/pos/RunningOrders.tsx',
  'frontend/pages/kot/KOTScreen.tsx',
  'frontend/pages/kot/ReadyToServe.tsx',
  'frontend/pages/inventory/StockCorrection.tsx',
  'frontend/pages/inventory/PurchaseEntry.tsx',
  'frontend/pages/reports/DayClose.tsx',
  'frontend/pages/admin/LocationManagement.tsx',
  'frontend/pages/admin/MenuItems.tsx',
  'frontend/pages/admin/POSReadiness.tsx',
];

assert.equal(manifest.name, 'Coffee Bond POS');
assert.equal(manifest.short_name, 'CB POS');
assert.equal(manifest.start_url, '/pos');
assert.equal(manifest.scope, '/');
assert.equal(manifest.display, 'standalone');
assert.equal(manifest.orientation, 'any');

for (const icon of ['icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png']) {
  assert.ok(statSync(resolve(root, 'public/pwa', icon)).size > 0, `${icon} must exist and be non-empty`);
}

assert.match(serviceWorker, /request\.method !== 'GET'/);
assert.match(serviceWorker, /url\.origin !== self\.location\.origin/);
assert.match(serviceWorker, /STATIC_EXTENSION/);
assert.match(serviceWorker, /if \(cached\) return cached;/);
assert.doesNotMatch(serviceWorker, /BackgroundSync|SyncManager|addEventListener\(['"]sync/);
assert.doesNotMatch(serviceWorker, /razorpay|firestore|onlineOrders|stockMovements|payments/i);

assert.match(pwaRegistration, /navigator\.serviceWorker\.register\('\/sw\.js', \{ scope: '\/' \}\)/);
assert.match(pwaRegistration, /refreshRequested = true/);
assert.match(pwaRegistration, /if \(!refreshRequested\) return/);
assert.match(appEntry, /registerCoffeeBondServiceWorker/);

assert.match(pwaUi, /beforeinstallprompt/);
assert.match(pwaUi, /14 \* 24 \* 60 \* 60 \* 1000/);
assert.match(pwaUi, /criticalOperationActive/);
assert.match(pwaUi, /!isCustomerRoute/);
assert.match(pwaUi, /A new version is available/);

assert.equal(customerMenuCategory({ posCategoryCode: 'JUI', posCategoryName: 'Fresh Juices' } as never), 'Cold Drinks');
assert.equal(customerMenuCategory({ posCategoryCode: 'MIS', posCategoryName: 'Misc' } as never), 'Other');
assert.equal(customerMenuCategory({ posCategoryCode: 'ESP', posCategoryName: 'Espresso Bar' } as never), 'Coffee');
assert.equal(customerMenuCategory({ posCategoryCode: '', posCategoryName: 'Unknown menu' } as never), 'Other');
assert.equal(trustedDietaryClassification({ dietaryClassification: 'VEG' }), 'VEGETARIAN');
assert.equal(trustedDietaryClassification({ dietaryType: 'NON_VEG' }), 'NON_VEGETARIAN');
assert.equal(trustedDietaryClassification({ foodType: 'EGG' }), 'EGG');
assert.equal(trustedDietaryClassification({ name: 'Veg sandwich', category: 'Food' }), null);

assert.doesNotMatch(customerOrder, /categoryGroupName/);
assert.doesNotMatch(customerOrder, />Quick add</);
assert.match(customerOrder, /activeAddOnGroupsForProduct/);
assert.match(customerOrder, /groups\.length > 0/);
assert.match(customerOrder, /setPendingAddOnItem\(item\)/);
assert.match(customerOrder, /commitCartItem\(item, \[\]\)/);
assert.match(customerOrder, /requireOnline\(\)/);
assert.match(customerOrder, /data-requires-online="true"/);
assert.match(
  customerOrder,
  /if \(draftResult\.draft && draftStore\) \{\s+triedAutoLocationRef\.current = true;/,
  'a valid saved basket must suppress automatic nearest-store selection during hydration',
);

// Customer links now resolve through the shared route helper so the same components
// serve both the staff origin (/order/my-orders) and the customer origin (/my-orders).
// Two source-level links, but only ever one visible at a time:
//   1. the lg-only link shown when the screen supplies onSignedOutAccountPress
//      (the mobile bottom bar owns the destination below lg),
//   2. the default link for screens without a bottom bar.
// Stage 5 removed the third — the entry inside the account menu — because the Orders
// tab is permanent and Orders now surfaces the live order itself.
// Simultaneous visibility is what matters, and that is measured per breakpoint in
// scripts/test-customer-home-ui.mjs.
const headerMyOrderLinks = customerHeader.match(/to=\{CUSTOMER_MY_ORDERS_PATH\}/g) || [];
assert.equal(headerMyOrderLinks.length, 2, 'exactly the lg-only entry and the default entry are expected');
// Measured against executable code: the sheet's doc comment names the rows Stage 5
// removed, and a comment explaining a removal must not read as the removal failing.
const accountSheetCode = source('frontend/components/customer/CustomerAccountSheet.tsx')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');
assert.doesNotMatch(accountSheetCode, /CUSTOMER_MY_ORDERS_PATH|My Orders|Current Order/,
  'the account surface must not duplicate the Orders tab');
assert.match(customerHeader, /onSignedOutAccountPress/, 'the header must be able to yield the destination to the bottom bar');
assert.match(customerHeader, /from '\.\.\/\.\.\/lib\/customerRoutes'/, 'header links must come from the route helper');
assert.doesNotMatch(customerHeader, /to="\/order/, 'no customer link may hardcode the staff-origin path');
assert.doesNotMatch(customerHeader, /Order[\s\S]{0,80}My Orders[\s\S]{0,80}Sign in \/ My Orders/);
assert.match(customerHeader, /h-11 w-11/);
assert.match(customerHeader, /hidden[\s\S]{0,30}sm:block/);

assert.match(customerImage, /width="400"/);
assert.match(customerImage, /height="300"/);
assert.match(customerImage, /animate-pulse/);
assert.match(customerImage, /transition-opacity/);
assert.match(customerImage, /loading=\{priority \? 'eager' : 'lazy'\}/);
assert.match(addOnSelector, /DietaryMarker/);
assert.match(customerOrder, /role="status" aria-live="polite"/);
assert.match(customerOrder, /aria-label="Close basket"/);
assert.match(customerOrder, /aria-label="Dismiss basket"/);
assert.match(customerOrder, /aria-label="Dismiss store selector"/);

const closedState = deriveCustomerOrderingState({
  store: {
    id: 'S1', code: 'S1', name: 'Store', address: '', isActive: true,
    onlineOrderingEnabled: true, acceptingOrders: false, isAcceptingOrders: false,
    createdAt: null, updatedAt: null,
  },
  availabilitySnapshot: { menuItems: { A: {} } },
  availabilityLoading: false,
  orderableItemCount: 1,
});
assert.equal(closedState.statusLabel, 'Closed');
assert.equal(closedState.canAcceptOrders, false);

assert.match(connectivity, /This action requires an internet connection and has not been submitted\./);
assert.match(connectivity, /criticalOperationCount/);

for (const path of protectedStaffActions) {
  const protectedSource = source(path);
  assert.match(protectedSource, /requireOnlineAction\(\)/, `${path} must guard its mutation handler`);
  assert.match(protectedSource, /data-requires-online="true"/, `${path} must mark its mutation UI as online-only`);
  assert.match(protectedSource, /beginCriticalOperation\(/, `${path} must defer PWA prompts during mutations`);
}

// ---------------------------------------------------------------------------
// Customer PWA identity: a second installable app served from the same origin.
// The staff manifest assertions above must keep passing unchanged.
// ---------------------------------------------------------------------------
const customerManifest = JSON.parse(source('public/manifest-customer.webmanifest')) as Record<string, unknown>;
const identity = source('frontend/lib/customerPwaIdentity.ts');
const identitySync = source('frontend/components/PwaIdentitySync.tsx');
const appRoot = source('frontend/App.tsx');
const indexHtml = source('index.html');
/* The page shell — safe-area padding, overflow guards, bottom-bar clearance — lives in
   the presentational screen components; the page modules under pages/customer own only
   the data and hand state to them. These assertions follow the markup. */
const orderStatus = source('frontend/components/customer/CustomerTrackingScreen.tsx');
const myOrders = source('frontend/components/customer/CustomerOrdersScreen.tsx');

assert.equal(customerManifest.name, 'Coffee Bond');
assert.equal(customerManifest.short_name, 'Coffee Bond');
assert.equal(customerManifest.start_url, '/order');
assert.equal(customerManifest.scope, '/order');
assert.equal(customerManifest.display, 'standalone');
assert.equal(customerManifest.id, '/order');
assert.equal(customerManifest.background_color, '#fbf7f1');
assert.ok(Array.isArray(customerManifest.icons) && (customerManifest.icons as unknown[]).length >= 3);
assert.ok(
  (customerManifest.icons as { purpose?: string }[]).some((icon) => icon.purpose === 'maskable'),
  'the customer manifest must offer a maskable icon',
);
assert.notEqual(customerManifest.start_url, manifest.start_url, 'the two apps must not share a start URL');
assert.notEqual(customerManifest.id, manifest.id, 'the two apps must be distinct install identities');

// The document default stays on the staff manifest; the customer identity is applied
// per route at runtime, never by repointing the shared manifest.
assert.match(indexHtml, /<link rel="manifest" href="\/manifest\.webmanifest" \/>/);
assert.doesNotMatch(indexHtml, /manifest-customer/);

assert.match(identity, /export const STAFF_MANIFEST_HREF = '\/manifest\.webmanifest'/);
assert.match(identity, /apple-mobile-web-app-title/);
assert.match(identitySync, /applyPwaIdentityForPath/);
assert.match(appRoot, /<PwaIdentitySync \/>/);

// HOTFIX: same-origin customer install is withdrawn. Customer routes must advertise
// no manifest at all, so /order is not installable until the customer app has its
// own origin. Installing from this origin produced a "CB POS" app pointing at /pos.
assert.match(identity, /HOTFIX/, 'the withdrawal and its reason must stay documented in code');
assert.match(identity, /function removeManifestLink/);
assert.match(identity, /removeManifestLink\(\);/, 'customer routes must strip the manifest link');
assert.match(identity, /link\[rel="manifest"\]'\)\.forEach\(\(link\) => link\.remove\(\)\)/);
assert.doesNotMatch(
  identity,
  /setManifestHref\(customer \? CUSTOMER_MANIFEST_HREF/,
  'the customer manifest must no longer be advertised on this origin',
);
// The staff branch must still restore the shipped staff manifest.
assert.match(identity, /function ensureStaffManifestLink/);
assert.match(identity, /link\.href = STAFF_MANIFEST_HREF;/);

// Route classification drives which identity is advertised.
assert.equal(isCustomerPath('/order'), true);
assert.equal(isCustomerPath('/order/my-orders'), true);
assert.equal(isCustomerPath('/order/status/abc123'), true);
assert.equal(isCustomerPath('/pos'), false);
assert.equal(isCustomerPath('/admin/locations'), false);
assert.equal(isCustomerPath('/orders'), false, 'a lookalike staff path must not claim the customer identity');

// HOTFIX: no customer install invitation of any kind on this origin.
assert.doesNotMatch(pwaUi, /CUSTOMER_INSTALL/, 'no customer install prompt may remain');
assert.doesNotMatch(pwaUi, /CUSTOMER_IOS/, 'no customer Add to Home Screen guidance may remain');
assert.doesNotMatch(pwaUi, /coffeeBondCustomerInstallDismissedAt/);
assert.doesNotMatch(pwaUi, /coffeeBondCustomerIosInstallDismissedAt/);
assert.doesNotMatch(pwaUi, /CUSTOMER_ENGAGEMENT_MS/);
assert.doesNotMatch(pwaUi, /Add Coffee Bond to your home screen/);
// The customer update prompt is retained: it only refreshes a waiting service worker
// and is still suppressed while a checkout or payment is in flight.
assert.match(pwaUi, /A new Coffee Bond update is ready/);
assert.match(pwaUi, /if \(criticalOperationActive\) return null;/);
assert.match(pwaUi, /&& !isStandalone\(\)/);
// Staff behaviour must be untouched: still profile-gated and still off customer routes.
assert.match(pwaUi, /canShowStaffInstall = authStatus === 'ready'/);
assert.match(pwaUi, /staffProfile && staffProfile\.role !== 'FRANCHISE_VIEWER'/);
assert.match(pwaUi, /if \(waitingRegistration && !isCustomerRoute\) return 'UPDATE';/);

// A single service worker still serves both apps, with both manifests in the shell
// and no relaxation of the caching exclusions.
assert.match(serviceWorker, /'\/manifest-customer\.webmanifest'/);
assert.match(serviceWorker, /CACHE_VERSION = 'v2'/, 'the shell changed, so the cache version must move');
assert.doesNotMatch(serviceWorker, /idToken|phone|checkoutSession|authorization/i);

// Safe-area coverage on the two customer screens that previously had none.
//
// A screen may reserve the home indicator either with a literal env() or by carrying
// .cb-customer-page-bottom, whose token chain ends in the same inset. The chain itself
// is verified below rather than trusted, so the class cannot silently stop covering it.
const customerTokens = source('frontend/customer.css');
const pageBottomCoversSafeArea =
  /--cb-safe-bottom:\s*env\(safe-area-inset-bottom/.test(customerTokens)
  && /--cb-content-bottom:[\s\S]{0,200}var\(--cb-safe-bottom\)/.test(customerTokens)
  && /\.cb-customer-page-bottom\s*\{\s*padding-bottom:\s*var\(--cb-content-bottom\)/.test(customerTokens);
assert.ok(pageBottomCoversSafeArea, 'the page-bottom token chain must end in the home-indicator inset');

for (const [label, screen] of [['CustomerTrackingScreen', orderStatus], ['CustomerOrdersScreen', myOrders]] as const) {
  assert.ok(
    /env\(safe-area-inset-bottom\)/.test(screen) || /cb-customer-page-bottom/.test(screen),
    `${label} must pad for the home indicator`,
  );
  assert.match(screen, /padding-left:env\(safe-area-inset-left\)/, `${label} must pad for landscape notches`);
  assert.match(screen, /overflow-x-hidden/, `${label} must not overflow horizontally`);
}

console.log('PWA safety and customer ordering UX tests passed.');
