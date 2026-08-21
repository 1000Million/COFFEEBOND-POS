import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Stage 1 customer home/menu redesign contract.
 *
 * Pins the visual wiring AND that no ordering behaviour moved into presentation:
 * pricing, availability, add-on resolution and cart mutation must all stay in
 * CustomerOrder.tsx. Also pins customer/staff style isolation, which is easy to
 * regress by writing a Tailwind arbitrary-value utility in a customer component.
 */
const root = process.cwd();
const read = (p) => readFileSync(resolve(root, p), 'utf8');

const passed = [];
const check = (name, condition) => { assert(condition, name); passed.push(name); };

const home = read('frontend/pages/customer/CustomerOrder.tsx');
const card = read('frontend/components/customer/CustomerProductCard.tsx');
const rail = read('frontend/components/customer/CustomerCategoryRail.tsx');
const store = read('frontend/components/customer/CustomerStoreCard.tsx');
const nav = read('frontend/components/customer/CustomerBottomNav.tsx');
const header = read('frontend/components/customer/CustomerHeader.tsx');
const usual = read('frontend/components/customer/CustomerMyUsualCard.tsx');
const bondCard = read('frontend/components/customer/CustomerBondSummaryCard.tsx');
const horizontalScroller = read('frontend/components/customer/HorizontalScroller.tsx');
const tokens = read('frontend/customer.css');
const homeRedesignCss = tokens.slice(tokens.indexOf('Customer home — reference-led composition.'));
const customerMain = read('frontend/customer-main.tsx');

// --- Wiring -----------------------------------------------------------------
check('home renders the new store card', home.includes('<CustomerStoreCard'));
check('home renders the new category rail', home.includes('<CustomerCategoryRail'));
check('home renders the new product card', home.includes('<CustomerProductCard'));
check('home renders the persistent bottom navigation', home.includes('<CustomerBottomNav'));
check('the complete menu remains two-column below the featured rail on phones',
  home.includes('cb-customer-full-menu') && home.includes('grid grid-cols-2 gap-3'));
check('grid passes an index so only the first cards load eagerly',
  home.includes('renderMenuCard(item, index)') && card.includes('priority'));
check('page reserves space for the fixed bottom navigation',
  home.includes('cb-customer-page-bottom') && tokens.includes('--cb-content-bottom'));
const composition = [
  '<CustomerHeader', '<CustomerStoreCard', '<CustomerMyUsualCard',
  '<CustomerBondSummaryCard', 'aria-label="Search the menu"', '<CustomerCategoryRail',
  'Coffee Bond favourites', '<HorizontalScroller', '<CustomerBottomNav',
].map(anchor => home.indexOf(anchor));
check('the home composition follows the approved reference order',
  composition.every((position, index) => position >= 0 && (index === 0 || position > composition[index - 1])));
check('the compact header uses the botanical wordmark and real profile-derived avatar',
  header.includes('<Wheat')
  && header.includes('cb-customer-wordmark')
  && header.includes('profile?.displayName')
  && header.includes('pointsBalance')
  && !header.includes('coffee-bond-logo.png'));
check('every My Usual state keeps the same hero family and real menu-image wiring',
  ['is-signed-out', 'is-empty', 'is-loading', 'is-saved'].every(state => usual.includes(state))
  && home.includes('lines={myUsualPreview?.state === \'SAVED\' ? myUsualPreview.displayLines : []}')
  && home.includes('discoveryImageUrl={discoveryProduct ? getItemImage(discoveryProduct) : null}')
  && !/https?:\/\//.test(usual));

// --- Behaviour parity: logic stayed in the screen ----------------------------
check('card computes no price', !/toNumber\(|salePrice|grandTotal|taxRate/.test(card));
check('card resolves no availability', !/getItemAvailability|customerOrderingState/.test(card));
check('card resolves no add-on groups', !/activeAddOnGroupsForProduct|addOnGroups/.test(card));
check('card mutates no cart state', !/setCart|commitCartItem|setLineQuantity|useState/.test(card));
check('screen still owns availability and ordering policy',
  home.includes('customerOrderingState.canAcceptOrders && availability.available'));
check('screen still owns add-on customization routing',
  home.includes('activeAddOnGroupsForProduct(') && home.includes('setPendingAddOnItem(item)'));
check('screen still owns direct add', home.includes('commitCartItem(item, [])'));
check('quantity stepper reuses the existing cart helpers',
  home.includes('onIncrement={() => addItem(item)}')
  && home.includes('setLineQuantity(firstLine.id, firstLine.quantity - 1)'));
check('unavailable products keep the authoritative reason',
  home.includes('unavailableReason={availability.reason}'));
check('card disables Add when the caller says it cannot be ordered',
  card.includes('disabled={!canOrder}'));
check('unavailability is stated in words, not colour alone',
  card.includes('{unavailableReason}') && tokens.includes('.cb-customer-unavailable'));
check('dietary marker still comes from authoritative data only',
  home.includes('trustedDietaryClassification(item as unknown as Record<string, unknown>)')
  && !/name|title/.test(card.slice(card.indexOf('dietary &&'), card.indexOf('dietary &&') + 80)));

// --- Navigation -------------------------------------------------------------
check('bottom nav uses the shared customer route helper',
  nav.includes("from '../../lib/customerRoutes'")
  && nav.includes('CUSTOMER_MY_ORDERS_PATH')
  && nav.includes('CUSTOMER_HOME_PATH'));
check('bottom nav hardcodes no customer path', !/["']\/order|["']\/my-orders/.test(nav));
check('bottom nav basket opens the existing basket sheet',
  home.includes('onOpenBasket={() => setBasketOpen(true)}'));
/* Search remains in the page, while the raised Cart is now the sole mobile basket
   doorway. The desktop header button is mutually exclusive at the lg breakpoint. */
check('the menu screen still owns exactly one search field',
  (home.match(/aria-label="Search the menu"/g) || []).length === 1);
check('the raised Cart replaces the contextual mobile basket bar',
  (home.match(/<CustomerBasketBar/g) || []).length === 0
  && nav.includes('cb-customer-nav-cart')
  && nav.includes('aria-label={cartLabel}'));
const navCode = nav.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
check('Account is a real route, not a sheet-only callback',
  /to=\{CUSTOMER_ACCOUNT_PATH\}/.test(navCode) && !navCode.includes('onOpenAccount'));
check('the Cart tab is only a doorway to the existing basket state',
  navCode.includes('onClick={onOpenBasket}')
  && !/setCart|commitCartItem|setLineQuantity|useState/.test(navCode));

/* ===========================================================================
 * Reference navigation — Menu, Orders, raised Cart, real BOND, real Account.
 *
 * Search remains a single field on Menu. Cart is always reachable and delegates to the
 * existing basket sheet; BOND and Account remain route-backed destinations.
 * ======================================================================== */
const tracking = read('frontend/components/customer/CustomerTrackingScreen.tsx');
const customerApp = read('frontend/CustomerApp.tsx');
const staffApp = read('frontend/App.tsx');
const routes = read('frontend/lib/customerRoutes.ts');

check('P0-1. bottom navigation is exactly Menu, Orders, Cart, Bond, Account at runtime',
  ['Menu', 'Orders', 'Cart', 'Bond', 'Account'].every(l => new RegExp(`>\\s*${l}\\s*<`).test(navCode))
  && navCode.includes('onHome && onOpenBasket ? (')
  && (navCode.match(/<button/g) || []).length === 1);
check('P0-2. Search stays in the page and permanent Cart is centred in the bar',
  !/Search/.test(navCode)
  && /ShoppingBag|Cart/.test(navCode)
  && navCode.includes('cb-customer-nav-cart-disc'));
check('P0-3. Menu is active at /',
  navCode.includes('const onHome = pathname === CUSTOMER_HOME_PATH')
  && /to=\{CUSTOMER_HOME_PATH\}[\s\S]{0,160}aria-current=\{onHome \? 'page' : undefined\}/.test(navCode));
check('P0-4. Orders is active at /my-orders',
  /pathname === CUSTOMER_MY_ORDERS_PATH/.test(navCode)
  && /to=\{CUSTOMER_MY_ORDERS_PATH\}[\s\S]{0,160}aria-current=\{onMyOrders \? 'page' : undefined\}/.test(navCode));
check('P0-5. Orders is active at /status/:id',
  /onMyOrders = pathname === CUSTOMER_MY_ORDERS_PATH \|\| \/\(\^\|\\\/\)status\\\/\/\.test\(pathname\)/.test(navCode));
check('P0-6. Account is active at /account',
  /pathname === CUSTOMER_ACCOUNT_PATH/.test(navCode)
  && /to=\{CUSTOMER_ACCOUNT_PATH\}[\s\S]{0,160}aria-current=\{onAccount \? 'page' : undefined\}/.test(navCode));
check('P0-7. /account is a real customer route',
  customerApp.includes('path="/account"')
  && customerApp.includes("import('./pages/customer/CustomerAccount')")
  && routes.includes('CUSTOMER_ACCOUNT_PATH'));
/* Integration: /bond is now the REAL Codex BOND dashboard. What must stay absent is any
   Claude Stage 6 placeholder — the fake points ring, the medallion and the
   "balance unavailable" stand-in. */
check('P0-8. /bond is the real Codex dashboard, not a placeholder',
  customerApp.includes('path="/bond"')
  && customerApp.includes("import('./pages/customer/CustomerBondDashboard')")
  && routes.includes('CUSTOMER_BOND_PATH')
  && !/CustomerBondCard|CustomerBondMedallion/.test(customerApp + routes + navCode + home));
check('P0-8a. no fabricated balance ships in the customer source',
  !/cb-customer-bond-ring|balance unavailable/i.test(home + navCode));
check('P0-8b. the compact BOND strip renders only server-summary balance and visit state',
  bondCard.includes('Number(summary.pointsBalance || 0)')
  && bondCard.includes('Number(summary.qualifyingVisitCount || 0)')
  && bondCard.includes("state === 'SIGNED_OUT'")
  && bondCard.includes("state === 'LOADING'")
  && home.includes('summary={displayedBondSummary}')
  && !/points\s*=\s*[1-9][0-9]*/.test(bondCard));
check('P0-9. staff router mounts neither /order/account nor /order/bond',
  !staffApp.includes('/order/account') && !staffApp.includes('/order/bond'));
check('P0-10. tracking renders the bottom navigation',
  tracking.includes('<CustomerBottomNav />')
  && tracking.includes("import CustomerBottomNav from './CustomerBottomNav'"));
check('P0-11. tracking payment-safety copy is unchanged',
  tracking.includes('Payment confirmation is in progress. Please do not pay again.')
  && tracking.includes('Payment was received. The store is reviewing fulfilment; no further payment is required.'));
check('P0-12. the Order screen keeps the approved real account avatar',
  !home.includes('hideAccountAction')
  && home.includes('pointsBalance={displayedBondSummary?.enabled')
  && header.includes('aria-label={`Open customer account'));
check('P0-13. Cart remains a destination at zero while its badge stays honest',
  navCode.includes("typeof itemCount === 'number' && itemCount > 0")
  && navCode.includes("typeof itemCount === 'number'")
  && navCode.includes('Open cart with ${itemCount} item')
  && navCode.includes("'Open cart'"));
check('P0-14. Cart receives the real basket count and opens the existing sheet',
  /<CustomerBottomNav[\s\S]{0,180}itemCount=\{itemCount\}[\s\S]{0,180}onOpenBasket=\{\(\) => setBasketOpen\(true\)\}/.test(home)
  && navCode.includes('onClick={onOpenBasket}'));
check('P0-15. the basket survives navigation via the existing persisted draft',
  // Cart is written to localStorage and rehydrated (revalidated) on mount, so leaving
  // Order for Orders/Account and returning does not lose it. No new state layer added.
  home.includes('writeCustomerCheckoutDraft(window.localStorage')
  && home.includes('readCustomerCheckoutDraft(window.localStorage)')
  && home.includes('applyRestoredDraft(draft, restored)')
  && home.includes('setCart(restored.lines)'));
check('P0-18. bottom-navigation controls meet the 44px minimum',
  navCode.includes('min-h-[44px] min-w-[44px]')
  && navCode.includes('min-h-[64px] min-w-[58px]'));
check('P0-19. the product CTA meets the 44px minimum',
  card.includes('cb-customer-add-button flex h-11 w-full'));
check('P0-20. the raised Cart and bar clear the safe area without a second basket bar',
  /\.cb-customer-bottom-nav \{[^}]*min-height: calc\(var\(--cb-bottom-nav-h\) \+ var\(--cb-safe-bottom\)\)/.test(homeRedesignCss)
  && /\.cb-customer-nav-cart-disc \{[^}]*margin-top: -17px/.test(homeRedesignCss)
  && tokens.includes('--cb-fab-overhang')
  && !home.includes('<CustomerBasketBar'));

// --- Accessibility ----------------------------------------------------------
check('category selection is announced, not colour-only', rail.includes('aria-pressed={isActive}'));
check('store status is announced with its label', store.includes('aria-label={`${contextLabel} ${storeName}. ${statusLabel}'));
check('quantity controls have accessible names',
  card.includes('aria-label={`Decrease ${name}`}') && card.includes('aria-label={`Increase ${name}`}'));
check('add control names the product and its behaviour',
  card.includes('opensCustomization ? `Choose options for ${name}` : `Add ${name}`'));

/* WCAG 2.5.3 Label in Name. A control's accessible name must contain its visible label,
   so the visible text and the aria-label come from the SAME condition:
     required options -> visible "Choose options", named "Choose options for {name}"
     quick add        -> visible "Add",            named "Add {name}"
   Previously the button always read "Add" while the accessible name could be
   "Choose options for X". That fails 2.5.3 and breaks voice control, because saying
   "tap Add" would not match the control the user can see. It also mis-sold the action:
   a card that opens the customisation sheet adds nothing on its own. */
const visibleCta = card.match(/\{opensCustomization \? '([^']+)' : '([^']+)'\}/);
check('product CTA visible label is conditional, not a hardcoded Add',
  !!visibleCta && visibleCta[1] === 'Choose options' && visibleCta[2] === 'Add');
check('product CTA accessible name contains its visible label (WCAG 2.5.3)',
  !!visibleCta
  && card.includes('opensCustomization ? `Choose options for ${name}` : `Add ${name}`')
  && 'Choose options for ${name}'.startsWith(visibleCta[1])
  && 'Add ${name}'.startsWith(visibleCta[2]));
check('the accessible name identifies the product in both states',
  /`Choose options for \$\{name\}`/.test(card) && /`Add \$\{name\}`/.test(card));
/* The plus is a direct-add affordance. Beside "Choose options" it promised an immediate
   add that the control does not perform — the sheet opens instead. */
check('the + icon appears for direct add only, never with Choose options',
  card.includes('{!opensCustomization && <Plus size={16} aria-hidden="true" />}')
  && card.includes('? <SlidersHorizontal size={17} aria-hidden="true" />')
  && !/<Plus size=\{16\} aria-hidden="true" \/>\n\s*\{opensCustomization/.test(card));
check('touch targets are at least 44px', card.includes('h-11') && nav.includes('min-h-[44px]'));
check('reduced motion is respected', tokens.includes('prefers-reduced-motion'));
check('visible focus styling exists', tokens.includes(':focus-visible'));

// --- Category rail is a FILTER, not an in-page navigator ---------------------
// Tapping a category narrows the grid through the screen's existing category state.
// No scroll-spy, no observer, no scroll maths — so the active state cannot oscillate
// or disagree with what is rendered.
check('rail exposes selected + onSelectCategory',
  rail.includes('selected: string') && rail.includes('onSelectCategory: (category: string) => void'));
check('rail is wired to the existing category state',
  home.includes('selected={category}') && home.includes('onSelectCategory={setCategory}'));
// The rail's doc comment explains why these are absent, so measure the code only.
const railCode = rail.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
// The rail may reveal the SELECTED chip inside its own row — selection decides the
// view. It must never do the reverse, and it must never move the page: no observer, no
// scroll reading, and no scrollIntoView (which is free to scroll ancestors).
check('rail never moves the page and never observes scroll position',
  !/scrollIntoView|window\.scrollTo|document\.documentElement\.scroll|IntersectionObserver|addEventListener\(\s*['"]scroll/.test(railCode));
check('rail reveals the active chip through its own row only',
  railCode.includes('row.scrollTo({') && railCode.includes('rowRef'));
check('revealing the active chip cannot change the selection',
  /useEffect\([\s\S]*?\}, \[selected\]\);/.test(railCode)
  && !/onSelectCategory\(/.test(railCode.split('useEffect')[1]?.split('return (')[0] ?? ''));
const homeCode = home.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
check('home has no scroll-spy machinery left',
  !/IntersectionObserver/.test(homeCode)
  && !/activeCategory/.test(homeCode)
  && !/scrollToCategory/.test(homeCode)
  && !/railScrollLock/.test(homeCode));

// --- Responsive category filter ---------------------------------------------
// One component and one DOM at every width; orientation is decided purely in CSS, so
// there is no viewport state that could render differently on first paint.
// matchMedia('(prefers-reduced-motion: reduce)') is allowed — that is a user
// preference, not a width. Nothing may branch the MARKUP on viewport size.
check('rail renders no viewport-conditional markup',
  !/innerWidth|useState|clientWidth\s*[<>]/.test(railCode)
  && !/matchMedia\(\s*['"`]\(?(min|max)-(width|height)/.test(railCode));
check('the approved category chips stay horizontal at every width',
  /\.cb-customer-rail\s*\{[^}]*flex-direction:\s*row/.test(homeRedesignCss)
  && !/@media \(min-width: 640px\)[\s\S]*?\.cb-customer-rail \{[^}]*flex-direction: column/.test(homeRedesignCss));
// The chip row contains its own overscroll. If it chains, a swipe past the final chip can
// trigger the browser back gesture.
check('the chip row contains its own horizontal overscroll',
  /\.cb-customer-rail\s*\{[^}]*overscroll-behavior-x:\s*contain/.test(tokens));
// --- Category navigation stays quieter than the products ------------------------
// Quiet outlines keep the categories legible as controls; exactly one gold-filled object
// answers "which filter am I on".
check('unselected category chips use the approved quiet outline',
  /\.cb-customer-rail-tab \{[^}]*border: 1px solid #dfd1c1/.test(homeRedesignCss)
  && /\.cb-customer-rail-tab \{[^}]*background: rgba\(255, 253, 249, 0\.72\)/.test(homeRedesignCss)
  && /\.cb-customer-rail-tab \{[^}]*box-shadow: none/.test(homeRedesignCss));
check('the selected chip is the only gold-filled object, and casts no shadow',
  /\.cb-customer-rail-tab-active \{[^}]*background: #c88c2c/.test(homeRedesignCss)
  && /\.cb-customer-rail-tab-active \{[^}]*box-shadow: none/.test(homeRedesignCss));
check('weight separates selected from unselected, and lives in CSS',
  /\.cb-customer-rail-tab \{[^}]*font-weight: 620/.test(homeRedesignCss)
  && /\.cb-customer-rail-tab-active \{[^}]*font-weight: 760/.test(homeRedesignCss)
  // railCode has comments stripped: the comment above the className explains why
  // font-black was removed, and naming it there must not fail the check.
  && !/font-black/.test(railCode));
check('the 44px floor survives the tighter padding',
  rail.includes('min-h-[44px]')
  && /\.cb-customer-rail-item \{[^}]*min-width: 44px/.test(tokens));
check('the gold selected-chip treatment is retained beyond phone width',
  !/@media \(min-width: 640px\)[\s\S]*?\.cb-customer-rail-tab-active \{[^}]*background: var\(--cb-gold-soft\)/.test(homeRedesignCss));

check('the chip row keeps its gutter when snapped',
  /\.cb-customer-rail\s*\{[^}]*scroll-padding-inline:\s*var\(--cb-page-gutter\)/.test(tokens));
check('the page reserves room for the raised basket button, not just the bar',
  tokens.includes('--cb-fab-overhang')
  && /--cb-content-bottom:\s*calc\(\s*var\(--cb-bottom-nav-h\) \+ var\(--cb-fab-overhang\)/.test(tokens));
check('product card controls meet the 44px touch target',
  // The stepper's two controls and the featured circular action are 44x44; the full
  // menu action remains 44px tall and full width.
  !/h-9 w-9/.test(card)
  && (card.match(/h-11 w-11/g) || []).length >= 3
  && /className="cb-customer-add-button flex h-11 w-full/.test(card)
  && /className="cb-customer-featured-add flex h-11 w-11/.test(card)
  && /cb-customer-stepper flex h-11 w-full/.test(card));

// --- The product card -------------------------------------------------------------
// Four things, in this order: picture, name, price, action. The assertions below pin
// what was taken away, because that is where the clutter was.
check('the card no longer repeats the category it is filed under',
  !/metaLabel/.test(card)
  && !/cb-customer-meta/.test(card)
  && !/metaLabel=/.test(home));
check('the card is a grid cell, not a floating panel',
  /\.cb-customer-card \{[^}]*background: transparent/.test(tokens)
  && /\.cb-customer-card \{[^}]*box-shadow: none/.test(tokens));
/* UI-6: the box is now 4:3 to match the intrinsic 400x300 assets, so `object-fit:
   cover` no longer crops a quarter off the sides of every photograph. What matters for
   layout is unchanged — a FIXED aspect box, so the grid reserves space and nothing
   shifts when an image loads. */
check('the picture stays dominant and its box is fixed at the asset ratio',
  card.includes('aspect-[4/3] w-full')
  && !card.includes('aspect-square')
  && card.includes('cb-customer-product-media'));
check('UI-6. the media box matches the intrinsic asset dimensions',
  read('frontend/components/customer/CustomerProductImage.tsx').includes('width="400"')
  && read('frontend/components/customer/CustomerProductImage.tsx').includes('height="300"'));
check('one price is visible at runtime in menu, empty-featured and populated-featured states',
  (card.match(/\{priceLabel\}/g) || []).length === 1
  && card.includes('<p className="cb-customer-product-price mt-1.5">{priceLabel}</p>'));
check('the authoritative dietary marker is kept and stays small',
  card.includes('<DietaryMarker')
  && card.includes('compact')
  && !/VEGETARIAN|NON_VEG/.test(card.replace(/import[^;]+;/g, '')));
check('both action states occupy the same 44px row, so a card never re-flows on add',
  /cb-customer-stepper flex h-11 w-full/.test(card)
  && /cb-customer-add-button flex h-11 w-full/.test(card)
  && card.includes('mt-auto'));
check('gold marks basket state and the compact featured action, not full-menu Add',
  // The stepper and compact rail action keep gold; the resting full-menu Add is quiet.
  /\.cb-customer-add-button \{[^}]*background: var\(--cb-surface-muted\)/.test(tokens)
  && /\.cb-customer-stepper \{[^}]*background: var\(--cb-gold-soft\)/.test(tokens)
  && /\.cb-customer-featured-add \{[^}]*background: #c78b2a/.test(homeRedesignCss));
check('an unavailable item dims its picture, never the reason it gives',
  card.includes('cb-customer-product-unavailable')
  && /\.cb-customer-unavailable \.cb-customer-product-media \{[^}]*opacity: 0\.45/.test(tokens)
  && !/^\.cb-customer-unavailable \{ opacity/m.test(tokens));
check('long compound names break instead of forcing an overflow',
  /\.cb-customer-product-name \{[^}]*overflow-wrap: anywhere/.test(tokens)
  && card.includes('cb-clamp-2'));
// The store block used to be a 76 px card whose third line was the pickup estimate,
// and it sat directly between the customer and the menu. It is now a two-line row and
// the estimate is gone from this surface — but NOT from the product: the basket's
// pickup summary still shows the same authoritative prep window at the point where the
// customer is choosing a collection time.
check('the compact store row carries no pickup estimate and the basket still does',
  !/\{message\}/.test(store)
  && !store.includes('flex-wrap')
  && read('frontend/components/customer/CustomerPickupSummary.tsx').includes('{prepLabel}'));
const storeCode = store.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
check('the pickup block is one compact rounded card, not a tall panel',
  store.includes('cb-customer-store-card')
  && /\.cb-customer-store-card \{[^}]*min-height: 66px/.test(homeRedesignCss)
  && (store.match(/<ChevronRight/g) || []).length === 1);
check('the pickup card never fabricates live capacity',
  !/capacity/i.test(storeCode) && !/capacity/i.test(homeCode));
check('store status is still stated in words, not by colour alone',
  /statusLabel\}/.test(store) && /cb-customer-tone-(green|amber|red)/.test(store));
// Landscape phones matched only the min-width rule, which reserved 200px of a 360px
// screen for the hero and left a 56px window to choose options in.
check('short viewports shrink the customization hero',
  /@media \(max-height: 560px\)[\s\S]{0,400}\.cb-customer-customize-hero \{[\s\S]{0,160}max-height: 132px/.test(tokens));
check('taps are immediate and get a press state that replaces the tap highlight',
  tokens.includes('touch-action: manipulation')
  && tokens.includes('-webkit-tap-highlight-color: transparent')
  && /:active[\s\S]{0,600}transform: scale\(0\.97\)/.test(tokens));
check('the press state degrades without motion',
  /@media \(prefers-reduced-motion: reduce\)[\s\S]{0,900}filter: brightness\(0\.95\)/.test(tokens));
check('no customer text is smaller than 11px',
  !/text-\[10px\]/.test([card, rail, store, nav, read('frontend/components/customer/CustomerMyUsualCard.tsx')].join('\n')));

// Filter branches: All shows honest favourites + every grouped section; a category
// shows exactly one grid built from the existing visibleItems filter.
check('All renders honest favourites in a compact rail, then the grouped full menu',
  home.includes("category === 'ALL' ?")
  && home.includes('Coffee Bond favourites')
  && !home.includes('Popular today')
  && home.includes("renderMenuCard(item, index, 'featured')")
  && home.includes('menuSections.map(section =>'));
check('the favourites rail uses the same product callbacks and real live values',
  /const renderMenuCard = \(item:[\s\S]{0,1800}variant=\{variant\}[\s\S]{0,800}onAdd=\{\(\) => addItem\(item\)\}/.test(home)
  && home.includes('priceLabel={formatMoney(toNumber(item.salePrice))}')
  && home.includes('imageUrl={getItemImage(item)}')
  && card.includes("variant?: 'menu' | 'featured'"));
check('the favourites rail shows roughly three compact cards and contains horizontal overscroll',
  /\.cb-customer-card\.is-featured \{[^}]*width: 132px[^}]*min-width: 132px[^}]*flex: 0 0 132px/.test(homeRedesignCss)
  && /\.cb-customer-featured-track \{[^}]*overscroll-behavior-x: contain/.test(homeRedesignCss)
  && horizontalScroller.includes('overflow-x-auto'));
check('a populated featured card keeps equal height while preserving 44px quantity controls',
  /\.cb-customer-featured-footer\.has-stepper \{[^}]*position: absolute[^}]*min-height: 44px/.test(homeRedesignCss)
  && /\.cb-customer-featured-footer\.has-stepper \.cb-customer-stepper \{/.test(homeRedesignCss));
check('a specific category renders one filtered vertical grid',
  home.includes('<section data-customer-category={category}>')
  && home.includes('{visibleItems.map((item, index) => renderMenuCard(item, index))}'));
check('category filtering still uses the authoritative existing filter',
  home.includes("category === 'ALL' || customerMenuCategory(item) === category"));
check('search renders one flat vertical result list with a no-results state',
  home.includes('Search results') && home.includes('No matches found'));

// --- The search surface ---------------------------------------------------------
// Activating search used to leave the whole menu underneath it, so the first result sat
// 445 px down a screen that still read as the menu. While search is open the surface
// carries the field and the matches and nothing else. These assertions pin that the
// hiding is presentational and that the filter itself was not touched.
check('search is a surface state, opened by focusing the existing field',
  home.includes("useState(false)")
  && home.includes('onFocus={() => setSearchActive(true)}')
  && home.includes('const searchOpen = searchActive || isSearching;'));
check('the compact home overview, its notices and category rail stand down while searching',
  home.includes('{!searchOpen && (\n            <div className="cb-customer-home-overview">')
  && home.includes('{!searchOpen && myUsualNotice &&')
  && home.includes('{!searchOpen && checkoutDraftNotice &&')
  && /\{!searchOpen && \(\s*<CustomerCategoryRail/.test(home));
check('the store-not-accepting warning is NOT hidden by search',
  /\{!customerOrderingState\.canAcceptOrders && !availabilityLoading && \(/.test(home));
check('search offers Cancel and a clear, both real touch targets',
  home.includes('aria-label="Cancel search"')
  && home.includes('aria-label="Clear search"')
  && home.includes('min-h-11')
  && home.includes('h-11 w-11'));
check('Cancel leaves search without disturbing the menu it returns to',
  /onClick=\{\(\) => \{\s*setSearch\(''\);\s*setSearchActive\(false\);\s*searchInputRef\.current\?\.blur\(\);\s*\}\}/.test(home)
  // Category is menu state, not search state, so Cancel must not reset it.
  && !/setSearchActive\(false\);[\s\S]{0,80}setCategory/.test(home));
check('both quiet search states are two lines, not cards',
  home.includes('Search Coffee Bond')
  && home.includes('Coffee, food, smoothies and more.')
  && home.includes('Try another search.')
  && home.includes('cb-customer-search-void')
  && !/cb-customer-search-void[\s\S]{0,200}(ring-1|rounded-3xl|shadow)/.test(home));
/* UI-3. Search matched inside words, so "latte" returned "Mediterranean Mezze Platter"
   ("platter" contains "latte"). Matching is now word-PREFIX over normalised tokens. */
const menuSearch = read('frontend/lib/customerMenuSearch.ts');
check('UI-3. the substring matcher is gone from the screen',
  !home.includes('name.includes(searchText)')
  && home.includes('matchesCustomerSearch('));
check('UI-3. search normalises case, diacritics and punctuation',
  menuSearch.includes("normalize('NFD')")
  && /\[\\u0300-\\u036f\]/.test(menuSearch)
  && menuSearch.includes('toLowerCase()')
  && /\[\^\\p\{L\}\\p\{N\}\]\+/.test(menuSearch));
check('UI-3. every query word must match, by word prefix',
  menuSearch.includes('queryWords.every(')
  && menuSearch.includes('productWord.startsWith(queryWord)'));
check('UI-3. search covers name, code and description only',
  home.includes('[item.displayName || item.name, item.code, item.description]'));
/* Intent unchanged: still ONE client-side filter over the already-loaded menu. UI-3
   swapped the matcher itself from substring to word-prefix; it added no query, no
   index and no service. */
check('search adds no second query, index or filter',
  (home.match(/const visibleItems = useMemo/g) || []).length === 1
  && home.includes('matchesCustomerSearch(')
  && !/algolia|typesense|searchIndex|fuzzy/i.test(home)
  && !/getDocs|onSnapshot|httpsCallable/.test(menuSearch));
check('Menu action clears the filter and returns to the top',
  home.includes("setCategory('ALL');") && home.includes("setSearch('');"));

// --- Five bottom-nav entries -------------------------------------------------
// Four entries are routes; the raised centre Cart is an action on home and a route-state
// handoff elsewhere. In either branch the customer sees the same five labels.
check('bottom nav exposes Menu, Orders, Cart, Bond and Account exactly once at runtime',
  ['Menu', 'Orders', 'Cart', 'Bond', 'Account']
    .every(label => new RegExp(`>\\s*${label}\\s*<`).test(navCode))
  && (navCode.match(/<span className="cb-customer-nav-cart-label">Cart<\/span>/g) || []).length === 1);

// --- Style isolation --------------------------------------------------------
check('customer tokens are imported only by the customer entry',
  customerMain.includes("import './customer.css'"));
for (const [label, source] of [['card', card], ['rail', rail], ['store', store], ['nav', nav]]) {
  check(`${label} uses no Tailwind arbitrary CSS-variable utility`,
    !/\[color:var\(--cb-|shadow-\[var\(--cb-|rounded-\[var\(--cb-|bg-\[var\(--cb-/.test(source));
}
check('semantic customer classes are declared in customer.css',
  ['.cb-customer-card', '.cb-customer-accent-button', '.cb-customer-chip-active',
   '.cb-customer-bottom-nav', '.cb-customer-store-card', '.cb-customer-usual-hero',
   '.cb-customer-featured-track', '.cb-customer-nav-cart', '.cb-customer-stepper']
    .every((cls) => tokens.includes(cls)));
check('shared stylesheet was not modified for the customer app',
  !read('frontend/index.css').includes('cb-customer'));

// --- Single My Orders destination on the home screen ------------------------
// The bottom navigation owns the My Orders link on screens that show it. The header
// must not present a second adjacent one, but must keep it where there is no bottom
// navigation, so account access is never lost.
check('bottom navigation renders exactly one My Orders link',
  (nav.match(/to=\{CUSTOMER_MY_ORDERS_PATH\}/g) || []).length === 1);
check('header exposes an opt-out for its My Orders link',
  header.includes('onSignedOutAccountPress'));
check('signed-out header control is a button when the opt-out is supplied',
  /onSignedOutAccountPress \?[\s\S]{0,400}<button/.test(header));
check('home screen routes the header avatar to Account without duplicating My Orders',
  home.includes('onSignedOutAccountPress={() => navigate(CUSTOMER_ACCOUNT_PATH)}')
  && !home.includes('hideAccountAction'));
check('mobile header no longer shows "Sign in / My Orders" wording',
  !header.includes('Sign in or view My Orders') && !header.includes('>Sign in<'));
check('header keeps a compact accessible account control',
  header.includes('aria-label="Customer account"') && header.includes('h-11 w-11'));
check('My Orders remains reachable from screens without the bottom navigation',
  header.includes('to={CUSTOMER_MY_ORDERS_PATH}'));
// The mobile bar is lg:hidden. Desktop home therefore carries one explicit Orders link,
// while the signed-out avatar remains the Account destination rather than masquerading
// as Orders.
check('desktop keeps Orders when the mobile bottom bar is hidden',
  /rightSlot=\{\([\s\S]{0,450}to=\{CUSTOMER_MY_ORDERS_PATH\}[\s\S]{0,200}lg:inline-flex/.test(home));
check('signed-out desktop header routes honestly to Account',
  /onSignedOutAccountPress \?[\s\S]{0,700}to=\{CUSTOMER_ACCOUNT_PATH\}[\s\S]{0,220}lg:inline-flex/.test(header));
check('screens without the bottom bar retain the My Orders fallback',
  header.includes('to={CUSTOMER_MY_ORDERS_PATH}'));
check('sign-out behaviour is untouched', header.includes('onSignedOut'));

// --- Exactly one basket control per breakpoint ------------------------------
check('bottom navigation is mobile-only', nav.includes('lg:hidden'));
check('header basket entry is desktop-only',
  /rightSlot=\{\([\s\S]{0,600}lg:inline-flex/.test(home));
check('page reserves space for the bottom bar and releases it on desktop',
  tokens.includes('.cb-customer-page-bottom') && /min-width:\s*1024px/.test(tokens));

// --- Built output, when both bundles are present ----------------------------
import { readdirSync } from 'node:fs';
const staffCss = existsSync(resolve(root, 'dist/assets')) &&
  readdirSync(resolve(root, 'dist/assets')).find((f) => f.endsWith('.css'));
if (staffCss) {
  const css = read(`dist/assets/${staffCss}`);
  check('built staff CSS contains no customer semantic class', !css.includes('cb-customer-'));
  check('built staff CSS contains no customer variable reference', !css.includes('var(--cb-'));
}

console.log(`Customer home UI tests passed (${passed.length} assertions).`);
