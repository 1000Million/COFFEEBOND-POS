import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Separate customer origin contract.
 *
 * The customer ordering PWA is served from its own Firebase Hosting site so that it
 * installs as its own app. This suite pins the separation: identity, routes, service
 * worker, bundle contents and deploy targets. It also pins that the staff app is
 * unchanged, because the whole point of the split is that pos.coffeebond.in keeps
 * working exactly as shipped.
 */
const root = process.cwd();
const read = (p) => readFileSync(resolve(root, p), 'utf8');
const json = (p) => JSON.parse(read(p));

const passed = [];
const check = (name, condition) => {
  assert(condition, name);
  passed.push(name);
};

const firebaseConfig = json('firebase.json');
const firebaserc = json('.firebaserc');
const pkg = json('package.json');
const customerHtml = read('index-customer.html');
const staffHtml = read('index.html');
const customerApp = read('frontend/CustomerApp.tsx');
const customerMain = read('frontend/customer-main.tsx');
const customerRoutes = read('frontend/lib/customerRoutes.ts');
const customerManifest = json('public-customer/manifest.webmanifest');
const staffManifest = json('public/manifest.webmanifest');
const customerSw = read('public-customer/sw.js');
const staffSw = read('public/sw.js');
const staffApp = read('frontend/App.tsx');
const customerOrder = read('frontend/pages/customer/CustomerOrder.tsx');
const customerViteConfig = read('vite.customer.config.ts');
const staffViteConfig = read('vite.config.ts');

// --- 1. Staff build remains unchanged --------------------------------------
check('1. staff manifest still identifies the POS app',
  staffManifest.name === 'Coffee Bond POS'
  && staffManifest.short_name === 'CB POS'
  && staffManifest.start_url === '/pos'
  && staffManifest.id === '/pos');
check('1. staff HTML still advertises the staff manifest and CB POS title',
  staffHtml.includes('<link rel="manifest" href="/manifest.webmanifest" />')
  && staffHtml.includes('content="CB POS"')
  && staffHtml.includes('<title>Coffee Bond POS</title>'));
check('1. staff service worker keeps its own cache namespace',
  staffSw.includes("const CACHE_PREFIX = 'coffee-bond-pos-static'"));
check('1. staff vite config still builds the staff entry only',
  !staffViteConfig.includes('dist-customer') && !staffViteConfig.includes('index-customer'));
check('1. staff router still mounts the legacy customer routes',
  staffApp.includes('path="/order"')
  && staffApp.includes('path="/order/status/:onlineOrderId"')
  && staffApp.includes('path="/order/my-orders"'));

// --- 2. Customer HTML has static Coffee Bond metadata ----------------------
check('2. customer HTML title is static and customer-facing',
  customerHtml.includes('<title>Coffee Bond — Order ahead</title>'));
check('2. customer Apple web app title is static Coffee Bond',
  customerHtml.includes('<meta name="apple-mobile-web-app-title" content="Coffee Bond" />'));
check('2. customer HTML carries customer theme colour and touch icon',
  customerHtml.includes('name="theme-color" content="#5c4033"')
  && customerHtml.includes('rel="apple-touch-icon"'));
check('2. customer HTML boots the customer entry point',
  customerHtml.includes('/frontend/customer-main.tsx') && customerMain.includes('CustomerApp'));
check('2. customer HTML supports safe areas', customerHtml.includes('viewport-fit=cover'));

// --- 3. Customer build has no staff manifest ------------------------------
check('3. customer HTML never references CB POS or the staff title',
  !customerHtml.includes('CB POS') && !customerHtml.includes('Coffee Bond POS'));
check('3. customer HTML links exactly one manifest, at the site root',
  (customerHtml.match(/rel="manifest"/g) || []).length === 1
  && customerHtml.includes('<link rel="manifest" href="/manifest.webmanifest" />'));
check('3. no runtime manifest swapping on the customer origin',
  !customerApp.includes('PwaIdentitySync')
  && !customerMain.includes('applyPwaIdentityForPath')
  && !customerApp.includes('applyPwaIdentityForPath'));

// --- 4. Customer manifest starts and scopes at / ---------------------------
check('4. customer manifest identity is Coffee Bond at the origin root',
  customerManifest.name === 'Coffee Bond'
  && customerManifest.short_name === 'Coffee Bond'
  && customerManifest.id === '/'
  && customerManifest.start_url === '/'
  && customerManifest.scope === '/'
  && customerManifest.display === 'standalone');
check('4. customer manifest ships 192, 512 and a maskable icon',
  customerManifest.icons.some((i) => i.sizes === '192x192')
  && customerManifest.icons.some((i) => i.sizes === '512x512')
  && customerManifest.icons.some((i) => i.purpose === 'maskable'));
check('4. official vector branding is isolated to customer PWA assets',
  existsSync(resolve(root, 'public-customer/pwa/coffee-bond-mark.svg'))
  && !existsSync(resolve(root, 'public/pwa/coffee-bond-mark.svg'))
  && customerSw.includes("const CACHE_VERSION = 'v2'"));
check('4. the two apps are distinct install identities',
  customerManifest.id !== staffManifest.id
  && customerManifest.start_url !== staffManifest.start_url
  && customerManifest.name !== staffManifest.name);

// --- 5. Customer service worker has a separate cache name -----------------
check('5. customer worker uses its own cache namespace',
  customerSw.includes("const CACHE_PREFIX = 'coffee-bond-order-static'"));
check('5. customer worker never reuses the staff namespace',
  !customerSw.includes('coffee-bond-pos-static'));

// --- 6. Customer bundle defines no Admin/POS routes -----------------------
const forbiddenImports = [
  'pages/pos/', 'pages/admin/', 'pages/reports/', 'pages/inventory/',
  'pages/kot/', 'pages/franchise/', 'components/Layout', 'components/ProtectedRoute',
];
for (const forbidden of forbiddenImports) {
  check(`6. customer router does not import ${forbidden}`, !customerApp.includes(forbidden));
}
/* Integration: five customer screens now — Order, Orders, Tracking, Account (P0) and
   the Codex BOND dashboard. The point is not the number but that EVERY lazily-mounted
   screen is a customer screen. */
check('6. customer router mounts only customer screens',
  (customerApp.match(/lazy\(\(\) => import\(/g) || []).length === 5
  && (customerApp.match(/lazy\(\(\) => import\('\.\/pages\/customer\//g) || []).length === 5);
check('6. customer route fallback is customer-branded, not the staff loader',
  !customerApp.includes("from './components/AppLoading'")
  && customerApp.includes('Loading Coffee Bond...'));

// --- 7/8/9. Route coverage on the customer origin -------------------------
check('7. canonical customer routes are mounted',
  customerApp.includes('path="/"')
  && customerApp.includes('path="/my-orders"')
  && customerApp.includes('path="/status/:onlineOrderId"')
  && customerApp.includes('path="/account"')
  && customerApp.includes('path="/bond"'));
check('7a. the Bond route resolves to the Codex BOND dashboard, not a placeholder',
  customerApp.includes("import('./pages/customer/CustomerBondDashboard')")
  && !customerApp.includes('CustomerBondCard')
  && !customerApp.includes('CustomerBondMedallion'));
check('8. /order compatibility aliases are mounted',
  customerApp.includes('path="/order"')
  && customerApp.includes('path="/order/my-orders"')
  && customerApp.includes('path="/order/status/:onlineOrderId"'));
check('9. unknown and staff paths fall through to a customer-only screen',
  customerApp.includes('path="*"') && customerApp.includes('CustomerNotFound'));
check('9. the customer not-found screen renders no staff navigation',
  !/CustomerNotFound[\s\S]*?\/pos/.test(customerApp));

// --- 10. Legacy staff-origin customer routes still supported --------------
check('10. staff origin keeps serving /order, /order/my-orders and /order/status',
  staffApp.includes('element={<CustomerOrder />}')
  && staffApp.includes('element={<CustomerOrderStatus />}')
  && staffApp.includes('element={<CustomerMyOrders />}'));

// --- 11/12/13. Tracking URL construction ---------------------------------
check('11. route shape is chosen at build time, not by hostname sniffing',
  customerRoutes.includes("import.meta.env.VITE_CUSTOMER_ORIGIN_BUILD === 'true'")
  && !customerRoutes.includes('location.hostname'));
check('11. absolute tracking URLs are composed from the live origin',
  customerRoutes.includes('window.location.origin'));
// Comments legitimately name both origins to explain the mapping; the executable
// code must not, so origins are only ever derived at runtime or by build flag.
const customerRoutesCode = customerRoutes
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');
check('11. no origin is hardcoded in the route helper code',
  !customerRoutesCode.includes('coffeebond.in') && !customerRoutesCode.includes('web.app'));
check('11. the customer build sets the customer origin flag',
  customerViteConfig.includes('VITE_CUSTOMER_ORIGIN_BUILD')
  && customerViteConfig.includes("JSON.stringify('true')"));
check('12. tracking tokens are passed through verbatim',
  customerRoutes.includes('`/status/${trackingToken}`')
  && customerRoutes.includes('`/order/status/${trackingToken}`'));
check('12. server-supplied tracking paths are normalised, not discarded',
  customerRoutes.includes('normalizeTrackingPath')
  && customerOrder.includes('normalizeTrackingPath('));
check('13. tracking URLs carry only the opaque token',
  !/customerName|phone|customerPhone|profile/i.test(
    customerRoutes.slice(customerRoutes.indexOf('export function customerTrackingUrl')),
  ));

// --- 14. No sensitive request is cached ----------------------------------
check('14. customer worker only handles same-origin GET requests',
  customerSw.includes("request.method !== 'GET'")
  && customerSw.includes('url.origin !== self.location.origin'));
check('14. customer worker has no background sync or replay',
  !/BackgroundSync|SyncManager|addEventListener\(['"]sync/.test(customerSw));
// The worker's header comment lists exactly what it refuses to cache; strip
// comments so the assertion measures executable code, not the documentation.
const customerSwCode = customerSw
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');
check('14. customer worker code names no payment, auth or order endpoint',
  !/razorpay|firestore|identitytoolkit|onlineOrders|payments|checkout|otp|idToken/i.test(customerSwCode));
check('14. customer worker caches only versioned static assets',
  customerSw.includes("url.pathname.startsWith('/assets/')")
  && customerSw.includes('STATIC_EXTENSION'));

// --- 15. Offline checkout stays blocked ----------------------------------
check('15. checkout still requires connectivity',
  customerOrder.includes('requireOnline()') && customerOrder.includes('data-requires-online="true"'));

// --- 16/17/18. Deploy target safety --------------------------------------
const scripts = pkg.scripts;
const deployScripts = Object.entries(scripts).filter(([, value]) => value.includes('firebase deploy') || value.includes('hosting:channel:deploy'));
check('16. staff deploy scripts name the staff target explicitly',
  scripts['deploy:hosting'].includes('--only hosting:staff')
  && scripts['deploy:hosting:staff'].includes('--only hosting:staff'));
check('17. customer deploy scripts name the customer target explicitly',
  scripts['deploy:hosting:customer'].includes('--only hosting:customer')
  && scripts['deploy:preview:customer'].includes('--only customer'));
check('17. customer deploy scripts build the customer bundle first',
  scripts['deploy:hosting:customer'].startsWith('npm run build:customer')
  && scripts['deploy:preview:customer'].startsWith('npm run build:customer'));
for (const [name, value] of deployScripts) {
  check(`18. ${name} cannot deploy both Hosting sites`,
    !/--only hosting(?!:)/.test(value) && !/--only\s+hosting\s*$/.test(value));
}
check('18. no script performs a bare firebase deploy',
  !Object.values(scripts).some((value) => /firebase deploy(?!\s+--only)/.test(value)));

// --- Hosting configuration ------------------------------------------------
check('hosting is a multi-site array', Array.isArray(firebaseConfig.hosting));
const staffHosting = firebaseConfig.hosting.find((site) => site.target === 'staff');
const customerHosting = firebaseConfig.hosting.find((site) => site.target === 'customer');
check('staff target serves the existing staff build', staffHosting?.public === 'dist');
check('customer target serves the customer build', customerHosting?.public === 'dist-customer');
check('staff target keeps its SPA rewrite',
  staffHosting.rewrites.some((r) => r.source === '**' && r.destination === '/index.html'));
check('customer target rewrites to its own index.html',
  customerHosting.rewrites.some((r) => r.source === '**' && r.destination === '/index.html'));
check('customer target declares no Functions rewrite',
  customerHosting.rewrites.every((r) => !r.function && !r.run));

const NO_STORE = 'no-cache, no-store, must-revalidate';
const cacheFor = (site, source) => (site.headers.find((h) => h.source === source)?.headers || [])
  .find((h) => h.key === 'Cache-Control')?.value ?? null;
for (const source of ['/', '/index.html', '/my-orders', '/status/**', '/order', '/order/**', '/manifest.webmanifest', '/sw.js']) {
  check(`customer ${source} is served no-store`, cacheFor(customerHosting, source) === NO_STORE);
}
check('customer hashed assets stay immutable',
  cacheFor(customerHosting, '/assets/**') === 'public, max-age=31536000, immutable');
check('staff headers are preserved',
  cacheFor(staffHosting, '/order') === NO_STORE
  && cacheFor(staffHosting, '/pos') === NO_STORE
  && cacheFor(staffHosting, '/assets/**') === 'public, max-age=31536000, immutable');

check('deploy targets map one site each',
  JSON.stringify(firebaserc.targets['coffee-bond-pos'].hosting.staff) === JSON.stringify(['coffee-bond-pos'])
  && JSON.stringify(firebaserc.targets['coffee-bond-pos'].hosting.customer) === JSON.stringify(['coffee-bond-order']));

// --- 19/20. Shared behaviour is reused, never forked ---------------------
check('19. the customer app reuses the shared public menu module',
  customerOrder.includes('publicMenuAvailability'));
check('19. the customer app reuses the shared add-on logic',
  customerOrder.includes('activeAddOnGroupsForProduct'));
check('20. payment-first checkout markers are unchanged',
  customerOrder.includes('beginCriticalOperation')
  && customerOrder.includes('loadRazorpayCheckout'));
check('20. no customer page forks payment or BOM logic',
  !existsSync(resolve(root, 'frontend/pages/customer/payments'))
  && !existsSync(resolve(root, 'frontend/lib/customerPayments.ts')));

// --- Built output, when the customer bundle is present -------------------
if (existsSync(resolve(root, 'dist-customer/index.html'))) {
  const builtHtml = read('dist-customer/index.html');
  check('built customer index.html carries the static customer identity',
    builtHtml.includes('<title>Coffee Bond — Order ahead</title>')
    && builtHtml.includes('content="Coffee Bond"')
    && !builtHtml.includes('CB POS'));
  check('built customer site ships its own manifest and worker',
    existsSync(resolve(root, 'dist-customer/manifest.webmanifest'))
    && existsSync(resolve(root, 'dist-customer/sw.js'))
    && existsSync(resolve(root, 'dist-customer/pwa/coffee-bond-mark.svg')));
  check('built customer manifest is the Coffee Bond identity',
    json('dist-customer/manifest.webmanifest').start_url === '/');
  check('built customer worker keeps the order cache namespace',
    read('dist-customer/sw.js').includes('coffee-bond-order-static'));
}

console.log(`Customer separate-origin tests passed (${passed.length} assertions).`);
