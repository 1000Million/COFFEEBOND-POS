import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Stage 5 contract — account, orders and order tracking.
 *
 * Two things are pinned here.
 *
 * NAVIGATION: the same destination must not be reachable from two places, and the
 * cleanup must have reused the existing data sources rather than growing a second
 * orders API or a second order-status implementation. Most of these assertions are
 * therefore about what is NOT there.
 *
 * LAYOUT: the visual rules the redesign is built on — one page heading, one filled
 * surface per screen, history as flat rows rather than a stack of cards, and no
 * card nested inside another card. Pixel geometry (overflow, 44 px targets, minimum
 * type size) is not asserted here; that is measured in a real browser across the
 * viewport matrix, which is the only place it can be measured honestly.
 *
 * Each screen is split into a container that owns the data and a presentational screen
 * that owns the markup, so the assertions below name whichever file actually owns the
 * behaviour being pinned.
 */
const root = process.cwd();
const read = (p) => readFileSync(resolve(root, p), 'utf8');

const passed = [];
const check = (name, condition) => { assert(condition, name); passed.push(name); };

const nav = read('frontend/components/customer/CustomerBottomNav.tsx');
const header = read('frontend/components/customer/CustomerHeader.tsx');
const account = read('frontend/components/customer/CustomerAccountSheet.tsx');
const ordersScreen = read('frontend/components/customer/CustomerOrdersScreen.tsx');
const ordersPage = read('frontend/pages/customer/CustomerMyOrders.tsx');
const trackScreen = read('frontend/components/customer/CustomerTrackingScreen.tsx');
const trackPage = read('frontend/pages/customer/CustomerOrderStatus.tsx');
const home = read('frontend/pages/customer/CustomerOrder.tsx');
const activeCard = read('frontend/components/customer/CustomerActiveOrderCard.tsx');
const orderCard = read('frontend/components/customer/CustomerOrderCard.tsx');
const tokens = read('frontend/customer.css');
const staffCss = read('frontend/index.css');
const app = read('frontend/CustomerApp.tsx');

/** Strips comments so a doc comment naming a removed concept cannot pass for code. */
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const accountCode = code(account);
const navCode = code(nav);
const trackScreenCode = code(trackScreen);
const trackPageCode = code(trackPage);
const ordersScreenCode = code(ordersScreen);
const ordersPageCode = code(ordersPage);
const headerCode = code(header);
const orders = ordersScreen + ordersPage;
const ordersCode = ordersScreenCode + ordersPageCode;
const statusCode = trackScreenCode + trackPageCode;

// --- 1-3. The five bottom-navigation entries exist exactly once ---------------
// Count navigation TARGETS, not identifier mentions: the import and the active-state
// comparison are not extra entry points.
check('1. Orders appears exactly once in the bottom navigation',
  (nav.match(/to=\{CUSTOMER_MY_ORDERS_PATH\}/g) || []).length === 1);
/* P0: Account became a route, so it is counted by its navigation target rather than by
   an aria-label on a button. Still exactly one entry point. */
check('2. Account appears exactly once in the bottom navigation',
  (nav.match(/to=\{CUSTOMER_ACCOUNT_PATH\}/g) || []).length === 1);
/* The approved composition restores Cart as the raised centre entry. It is still only a
   doorway: home raises the existing basket sheet callback, while other routes hand the
   intent back through router state. The navigation owns no cart state or mutation. */
check('3. Cart hands off to the existing basket instead of creating another cart',
  navCode.includes('onClick={onOpenBasket}')
  && navCode.includes('state={{ openBasket: true }}')
  && !/setCart|commitCartItem|setLineQuantity|useState/.test(navCode));
check('3a. the bar exposes exactly Menu, Orders, Cart, Bond and Account at runtime',
  ['Menu', 'Orders', 'Cart', 'Bond', 'Account']
    .every(label => new RegExp(`>\\s*${label}\\s*<`).test(navCode))
  && navCode.includes('onHome && onOpenBasket ? (')
  && !/Search/.test(navCode));
check('3b. the centre Cart exposes the real count and an accessible 44px-plus target',
  navCode.includes('Open cart with ${itemCount} item')
  && navCode.includes("typeof itemCount === 'number' && itemCount > 0")
  && navCode.includes("'Open cart'")
  && navCode.includes('min-h-[64px] min-w-[58px]'));

// --- 4-5. The duplicated account destinations are gone ------------------------
check('4. My Orders is removed from the account surface',
  !/My Orders/.test(accountCode)
  && !/CUSTOMER_MY_ORDERS_PATH/.test(accountCode));
check('5. Current Order is removed from the account surface',
  !/Current Order/i.test(accountCode)
  && !/customerStatusPath|lastCustomerOrderTrackingToken/.test(accountCode));
check('5a. the header no longer builds its own account menu',
  headerCode.includes('<CustomerAccountSheet')
  && !/Current Order|My Orders<\/span>/.test(headerCode));

// --- 6-8. Orders owns the active order and the history ------------------------
check('6. Orders renders the active order when a canonical active order exists',
  ordersScreen.includes('<CustomerActiveOrderCard')
  && /state\.active &&/.test(ordersScreenCode)
  && /activeOrder && activeStatus/.test(ordersPageCode));
check('6a. active is decided by canonical status, never by display strings',
  ordersPageCode.includes('function isCurrentOrder')
  && ordersPageCode.includes('.filter(isCurrentOrder)')
  && !/statusLabel\(.*\)\s*===\s*'/.test(ordersCode));
check('6b. the active order is rendered exactly once',
  (ordersScreen.match(/<CustomerActiveOrderCard/g) || []).length === 1);
check('7. Orders omits the active section when nothing is live',
  /const activeOrder = useMemo\([\s\S]{0,320}\|\| null\s*\)/.test(ordersPageCode));
check('8. each historical order renders once and excludes the active one',
  ordersPageCode.includes('order.trackingToken !== activeOrder?.trackingToken')
  && ordersScreenCode.includes('key={order.key}')
  && (ordersScreen.match(/<CustomerOrderCard/g) || []).length === 1);

check('8a. the spacing around Orders row lists is actually applied',
  // customer.css is UNLAYERED and carries `:where(.cb-customer-rows) { margin: 0 }`.
  // Unlayered declarations beat Tailwind's `@layer utilities` at any specificity, so a
  // `mt-*` on a row list is silently dropped — it looked correct in the source and
  // rendered as zero. The gap is therefore carried by the element ABOVE the list.
  !/cb-customer-rows mt-/.test(ordersScreenCode)
  && /cb-customer-skeleton mb-7/.test(ordersScreenCode)
  && /cb-customer-eyebrow mb-2/.test(ordersScreenCode));

// --- 9-10. Existing data sources reused, none added ---------------------------
check('9. the existing authenticated history callable is reused',
  ordersPageCode.includes("'listMyCustomerOrders'")
  && (ordersPageCode.match(/httpsCallable</g) || []).length === 1);
check('9a. Stage 5 adds no second orders query anywhere',
  !/collection\(|query\(|getDocs\(/.test(ordersCode));
check('10. the existing public tracking subscription is reused, not reimplemented',
  ordersPageCode.includes('publicTrackingDocRef')
  && ordersPageCode.includes('onSnapshot')
  && trackPageCode.includes('publicTrackingDocRef')
  && trackPageCode.includes('onSnapshot'));
check('10a. the tracking screen keeps its token-keyed subscription',
  /\}, \[trackingToken\]\);/.test(trackPageCode));

// --- 11-14. Tracking route and its actions ------------------------------------
check('11. the tracking routes still resolve',
  app.includes('path="/status/:onlineOrderId"')
  && app.includes('path="/order/status/:onlineOrderId"'));
check('12. tracking links back to Orders',
  (trackScreenCode.match(/CUSTOMER_MY_ORDERS_PATH/g) || []).length >= 1
  && trackScreenCode.includes('Back to Orders'));
check('12a. tracking offers exactly one primary Back to Orders action',
  (trackScreenCode.match(/cb-customer-accent-button/g) || []).length === 1);
check('13. no redundant My Orders primary button remains on tracking',
  !/>\s*My Orders\s*</.test(statusCode));
check('14. no redundant Place another order button remains on tracking',
  !/Place another order/.test(statusCode));
// The Stage 5 tracking rewrite removed the standalone payment panel. It must NOT have
// removed the two sentences that tell a customer not to pay twice.
check('13a. the payment-safety notices survived the tracking rewrite',
  trackScreenCode.includes('Payment confirmation is in progress. Please do not pay again.')
  && trackScreenCode.includes('Payment was received. The store is reviewing fulfilment; no further payment is required.')
  && trackScreenCode.includes("order.paymentStatus === 'PAYMENT_PROCESSING'")
  && trackScreenCode.includes("order.paymentStatus === 'PAYMENT_REVIEW_REQUIRED'"));
check('13b. the payment-safety notices are given their own emphasis treatment',
  trackScreenCode.includes('cb-customer-payment-notice')
  && tokens.includes('.cb-customer-payment-notice'));

check('14a. tracking shows ONE dominant status, not five equal steps',
  trackScreenCode.includes('cb-customer-hero')
  && !/Ready soon/.test(statusCode)
  && (trackScreenCode.match(/STEPS: Array|const STEPS/g) || []).length === 1);

check('14b. the spacing around the tracking summary list is actually applied',
  // Third instance of the same trap: customer.css is UNLAYERED and carries
  // `:where(.cb-customer-rows) { margin: 0 }`, which beats Tailwind's layered `mt-*`
  // at any specificity. The gap is therefore carried by the heading above the list.
  !/cb-customer-rows mt-/.test(trackScreenCode)
  && /cb-customer-eyebrow mb-2">Order summary/.test(trackScreenCode));
check('14c. no customer row list anywhere still relies on a dead margin utility',
  [accountCode, ordersScreenCode, trackScreenCode].every(src => !/cb-customer-rows mt-/.test(src)));

// --- 15-17. Loading, empty and the menu route ---------------------------------
check('15. Orders renders a skeleton rather than a lone spinner card',
  ordersScreenCode.includes('OrdersSkeleton')
  && ordersScreenCode.includes('cb-customer-skeleton')
  && !/Loading your orders\.\.\./.test(orders));
check('15a. the loading state is announced without being read as content',
  /role="status" aria-live="polite">Loading your orders/.test(ordersScreen)
  && ordersScreenCode.includes('aria-hidden="true"'));
check('15b. the skeleton stands in for rows, not for one large panel',
  ordersScreenCode.includes('cb-customer-rows')
  && (ordersScreenCode.match(/cb-customer-skeleton/g) || []).length >= 3);
check('16. the empty-orders state renders',
  ordersScreen.includes('No orders yet.')
  && ordersScreen.includes('Your next Coffee Bond is waiting.'));
check('16a. the signed-out state renders and does not claim the customer has no orders',
  ordersScreen.includes('Verify your mobile number to see your orders.')
  && ordersScreenCode.includes("state.kind === 'signed-out'"));
check('17. Browse menu uses the existing home route, not a new one',
  ordersScreenCode.includes('CUSTOMER_HOME_PATH')
  && ordersScreen.includes('Browse menu'));

// --- 18-21. Account is identity only ------------------------------------------
check('18. Account shows the customer identity',
  accountCode.includes('profile.displayName')
  && accountCode.includes('maskedPhone(profile.normalisedPhone)')
  && accountCode.includes('Verified'));
check('18a. the full phone number is never rendered',
  !/normalisedPhone\}/.test(accountCode.replace(/maskedPhone\(profile\.normalisedPhone\)/g, '')));
check('19. Account exposes My Usual as a row that opens the existing surface',
  accountCode.includes('onOpenMyUsual')
  && /My Usual/.test(account)
  && !accountCode.includes('CustomerMyUsualCard'));
check('19a. Account uses the compact row, not a second copy of the home My Usual card',
  accountCode.includes('cb-customer-row')
  && !accountCode.includes('cb-customer-usual-card')
  && home.includes('CustomerMyUsualCard'));
check('20. Account exposes the existing profile edit',
  accountCode.includes('updateCustomerProfile')
  && accountCode.includes('defaultOrderType')
  && /Profile/.test(account));
check('20a. Account invents no profile field',
  !/birthday|loyalty|address|payment card|preferences/i.test(accountCode));
check('21. Account exposes Sign out',
  accountCode.includes('signOutCustomer') && /Sign out/.test(account));
check('21a. Sign out is visually secondary — below the rule and unfilled',
  accountCode.includes('cb-customer-rule')
  && accountCode.includes('cb-customer-signout')
  && tokens.includes('.cb-customer-signout { color: var(--cb-danger); }'));

check('21b. the identity block is separated from the list by real space',
  // The name is the sheet's header; with no air under it the phone number sat flush on
  // the first row's hairline and read as a fourth list item.
  accountCode.includes('cb-customer-account-identity')
  && /\.cb-customer-account-identity \{[^}]*padding-bottom: 22px/.test(tokens));
check('21c. that spacing is padding in customer.css, not a Tailwind margin utility',
  // customer.css is UNLAYERED and carries `:where(.cb-customer-rows) { margin: 0 }`;
  // Tailwind's margin utilities live in `@layer utilities`, and unlayered declarations
  // beat layered ones at any specificity. An `mt-*` on the row list is silently dead.
  !/cb-customer-rows mt-/.test(accountCode)
  && /:where\(\.cb-customer-rows\) \{[^}]*margin: 0/.test(tokens));
check('21d. the list state and the profile form open at the same distance',
  // One spacer under the header, so switching to Profile does not jump the layout.
  !/editing \? \(\s*<div className="mt-5/.test(accountCode));

// --- 22-26. Stages 1-4 untouched ----------------------------------------------
check('22. My Usual persistence is unchanged',
  home.includes('saveCustomerMyUsual') || home.includes('customerMyUsualApi')
  ? true
  : read('frontend/lib/customerMyUsualApi.ts').includes('saveCustomerMyUsual'));
check('22a. Stage 5 did not re-implement My Usual',
  !/getCustomerMyUsual|saveCustomerMyUsual|deleteCustomerMyUsual/.test(accountCode + ordersCode + statusCode));
check('23. customer auth is unchanged',
  ordersPageCode.includes('waitForCustomerAuthRestoration')
  && ordersPageCode.includes('onAuthStateChanged')
  && !/signInWith|RecaptchaVerifier/.test(ordersCode + accountCode));
check('24. no order/payment lifecycle logic entered these surfaces',
  !/createCustomerCheckoutSession|verifyCustomerPayment|submitOrder|razorpay/i.test(ordersCode + accountCode + code(activeCard) + code(orderCard)));
check('25. the Stage 4 basket is unchanged',
  home.includes('CustomerCheckoutTotalsPanel')
  && home.includes('CustomerPaymentSelector')
  && home.includes('CustomerCheckoutActionBar')
  && tokens.includes('cb-customer-basket-sheet'));
check('26. Stage 3 customization is unchanged',
  home.includes('CustomerProductCustomizationSheet')
  && tokens.includes('cb-customer-customize-hero'));

// --- 27-29. One bar, one heading, real touch targets --------------------------
/* P0 reverses the tracking exclusion: a live order used to be a dead end with no way
   back into the app but the browser's back button. Tracking now carries the same bar,
   with Orders lit. Still exactly one bar per screen. */
check('27. the bottom navigation is mounted once per screen',
  (ordersScreenCode.match(/<CustomerBottomNav/g) || []).length === 1
  && (code(home).match(/<CustomerBottomNav/g) || []).length === 1
  && (code(trackScreen).match(/<CustomerBottomNav/g) || []).length === 1);
check('27a. exactly one h1 per customer screen',
  (ordersScreen.match(/<h1/g) || []).length === 1
  && (trackScreen.match(/<h1/g) || []).length === 1
  && !headerCode.includes('<h1'));
check('27b. the Orders page heading is not repeated by a section heading',
  (ordersScreen.match(/Your orders/g) || []).length === 1);
check('28. no horizontal overflow is possible at the page root',
  ordersScreenCode.includes('overflow-x-hidden')
  && ordersScreenCode.includes('min-w-0')
  && trackScreenCode.includes('overflow-x-hidden'));
check('28a. content clears the fixed bottom bar',
  ordersScreenCode.includes('cb-customer-page-bottom'));
check('29. account and order controls meet the 44px touch target',
  // Rows carry their height in CSS; the remaining controls carry it as utilities.
  /\.cb-customer-row \{[^}]*min-height: 60px/.test(tokens)
  && (accountCode.match(/min-h-12|h-11 w-11/g) || []).length >= 3
  && orderCard.includes('min-h-[44px]')
  && activeCard.includes('min-h-13')
  && trackScreenCode.includes('min-h-11')
  && /\.cb-customer-field \{[^}]*height: 52px/.test(tokens));

// --- 30-32. Isolation -----------------------------------------------------------
check('30. no staff source or style was touched by these surfaces',
  !/pages\/pos|pages\/admin|pages\/kot|posMenuNavigation|posStoreAccess/.test(
    [nav, header, account, ordersScreen, ordersPage, trackScreen, trackPage, activeCard, orderCard].join('\n'),
  )
  && !staffCss.includes('cb-customer'));
check('30a. Stage 5 styling uses semantic customer classes, not arbitrary utilities',
  [account, ordersScreen, trackScreen, activeCard, orderCard].every(source =>
    !/\[color:var\(--cb-|bg-\[var\(--cb-|shadow-\[var\(--cb-|rounded-\[var\(--cb-/.test(source))
  && ['.cb-customer-hero', '.cb-customer-row', '.cb-customer-rows', '.cb-customer-account-sheet', '.cb-customer-steps']
    .every(cls => tokens.includes(cls)));
check('31. the customer router still mounts only customer screens',
  !/POSHome|KOTScreen|AdminHome|DayClose/.test(app)
  && app.includes('CustomerMyOrders')
  && app.includes('CustomerOrderStatus'));
check('32. Stage 5 adds no backend write path',
  !/setDoc|addDoc|updateDoc|deleteDoc|writeBatch|runTransaction/.test(
    [accountCode, ordersCode, statusCode, code(activeCard), code(orderCard)].join('\n'),
  ));

// --- 33-35. The layout rules the redesign is built on ---------------------------
// "One filled surface per screen" is the rule that keeps a screen from reading as a
// stack of equal boxes, so it is pinned rather than left to review.
check('33. each screen has exactly one filled hero surface',
  (activeCard.match(/cb-customer-hero(?![-\w])/g) || []).length === 1
  && (trackScreenCode.match(/cb-customer-hero(?![-\w])/g) || []).length === 1);
check('33a. the surfaces the redesign removed are gone from the stylesheet too',
  ['.cb-customer-order-card', '.cb-customer-active-order', '.cb-customer-track-hero',
    '.cb-customer-track-panel', '.cb-customer-track-steps', '.cb-customer-account-panel',
    '.cb-customer-orders-empty']
    .every(cls => !tokens.includes(cls)));
check('34. past orders are flat rows, not cards',
  orderCard.includes('cb-customer-row')
  && !/cb-customer-card|cb-customer-store-card|rounded-\[|shadow/.test(code(orderCard)));
check('34a. the order reference is announced but not printed on every row',
  code(orderCard).includes('aria-label')
  && code(orderCard).includes('reference ${reference}')
  && !/>\{reference\}</.test(code(orderCard))
  // It is still shown in full on the order's own screen.
  && trackScreenCode.includes('order.publicOrderReference'));
check('35. the order summary on tracking is flat, with no panel around it',
  trackScreenCode.includes('cb-customer-totals')
  && !/cb-customer-card|cb-customer-track-panel/.test(trackScreenCode));

// --- Duplication audit ---------------------------------------------------------
// A screen that supplies the mobile account callback now routes the desktop avatar to
// the real Account page. Only screens without that callback retain the My Orders
// fallback, so the header can never duplicate the permanent Orders tab.
check('audit: the header exposes at most one My Orders link at a time',
  (headerCode.match(/to=\{CUSTOMER_MY_ORDERS_PATH\}/g) || []).length === 1
  && (headerCode.match(/to=\{CUSTOMER_ACCOUNT_PATH\}/g) || []).length === 1
  && headerCode.includes('onSignedOutAccountPress ? (')
  && headerCode.includes('lg:hidden'));
check('audit: the Orders page does not link to itself from its header',
  ordersScreenCode.includes('onSignedOutAccountPress={onGoToMenu}'));
check('audit: status is never conveyed by colour alone',
  trackScreenCode.includes('current step') && orderCard.includes('statusLabel'));
check('audit: reduced motion is honoured on the new skeletons',
  ordersScreenCode.includes('motion-reduce:animate-none') && trackScreenCode.includes('motion-reduce:animate-none'));
check('audit: the store order number can no longer collide with the store name',
  // They were inline siblings and overlapped on narrow screens. The number is now the
  // hero eyebrow and the store name sits beside the back link.
  trackScreenCode.includes('cb-customer-hero-eyebrow')
  && !/publicOrderNumber[\s\S]{0,200}storeName/.test(trackScreenCode));

console.log(`Customer account/orders UI tests passed (${passed.length} assertions).`);
