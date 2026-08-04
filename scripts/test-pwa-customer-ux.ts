import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  customerMenuCategory,
  trustedDietaryClassification,
} from '../frontend/lib/customerMenuPresentation';
import { deriveCustomerOrderingState } from '../frontend/lib/customerOrderingState';

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

const headerMyOrderLinks = customerHeader.match(/to="\/order\/my-orders"/g) || [];
assert.equal(headerMyOrderLinks.length, 2, 'one conditional header account entry and one account-menu history entry are expected');
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

console.log('PWA safety and customer ordering UX tests passed.');
