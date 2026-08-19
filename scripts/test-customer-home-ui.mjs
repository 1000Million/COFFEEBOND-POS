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
const tokens = read('frontend/customer.css');
const customerMain = read('frontend/customer-main.tsx');

// --- Wiring -----------------------------------------------------------------
check('home renders the new store card', home.includes('<CustomerStoreCard'));
check('home renders the new category rail', home.includes('<CustomerCategoryRail'));
check('home renders the new product card', home.includes('<CustomerProductCard'));
check('home renders the persistent bottom navigation', home.includes('<CustomerBottomNav'));
check('menu grid is two-column on phones', home.includes('grid grid-cols-2 gap-3'));
check('grid passes an index so only the first cards load eagerly',
  home.includes('renderMenuCard(item, index)') && card.includes('priority'));
check('page reserves space for the fixed bottom navigation',
  home.includes('cb-customer-page-bottom') && tokens.includes('--cb-content-bottom'));

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
check('bottom nav search focuses the existing input, adding no second search',
  home.includes('searchInputRef.current?.focus()')
  && (home.match(/aria-label="Search the menu"/g) || []).length === 1);
check('the old duplicate mobile basket bar is gone', !home.includes('View basket ·'));
check('exactly one basket control remains',
  (nav.match(/aria-label=\{basketLabel\}/g) || []).length === 1);
// The Account entry raises a callback rather than navigating: the customer origin has
// no standalone account route, so no destination is invented.
const navCode = nav.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
check('Account is a callback, not an invented route',
  navCode.includes('onClick={onOpenAccount}') && !/to=\{[^}]*ACCOUNT/i.test(navCode));
check('bottom nav basket is offline-guarded like other mutations',
  nav.includes('data-requires-online="true"'));

// --- Accessibility ----------------------------------------------------------
check('category selection is announced, not colour-only', rail.includes('aria-pressed={isActive}'));
check('store status is announced with its label', store.includes('aria-label={`${contextLabel} ${storeName}. ${statusLabel}'));
check('quantity controls have accessible names',
  card.includes('aria-label={`Decrease ${name}`}') && card.includes('aria-label={`Increase ${name}`}'));
check('add control names the product and its behaviour',
  card.includes('opensCustomization ? `Choose options for ${name}` : `Add ${name}`'));
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
check('phones get a horizontal chip row, 640px+ gets the vertical rail',
  /\.cb-customer-rail\s*\{[^}]*flex-direction:\s*row/.test(tokens)
  && /@media \(min-width: 640px\) \{\s*\.cb-customer-rail \{[^}]*flex-direction: column/.test(tokens));
// The chip row is the only horizontal scroller in the app. If its overscroll ever
// chains, a swipe past the last chip triggers the browser back gesture.
check('the chip row contains its own horizontal overscroll',
  /\.cb-customer-rail\s*\{[^}]*overscroll-behavior-x:\s*contain/.test(tokens));
// --- Category navigation stays quieter than the products ------------------------
// Nine white pills with a ring each, above a grid of photographs, read as a second
// toolbar. Unselected categories are now labels on the page; exactly one filled object
// answers "which filter am I on".
check('unselected chips carry no fill and no border',
  /\.cb-customer-rail-tab \{[^}]*background: transparent/.test(tokens)
  && /\.cb-customer-rail-tab \{[^}]*box-shadow: none/.test(tokens));
check('the selected chip is the only filled object, and casts no shadow',
  /\.cb-customer-rail-tab-active \{[^}]*background: var\(--cb-gold\)/.test(tokens)
  && /\.cb-customer-rail-tab-active \{[^}]*box-shadow: none/.test(tokens));
check('weight separates selected from unselected, and lives in CSS',
  /\.cb-customer-rail-tab \{[^}]*font-weight: 600/.test(tokens)
  && /\.cb-customer-rail-tab-active \{[^}]*font-weight: 800/.test(tokens)
  // railCode has comments stripped: the comment above the className explains why
  // font-black was removed, and naming it there must not fail the check.
  && !/font-black/.test(railCode));
check('the 44px floor survives the tighter padding',
  rail.includes('min-h-[44px]')
  && /\.cb-customer-rail-item \{[^}]*min-width: 44px/.test(tokens));
check('the tablet rail softens its accent for the larger block it fills',
  /@media \(min-width: 640px\)[\s\S]*?\.cb-customer-rail-tab-active \{[^}]*background: var\(--cb-gold-soft\)/.test(tokens));

check('the chip row keeps its gutter when snapped',
  /\.cb-customer-rail\s*\{[^}]*scroll-padding-inline:\s*var\(--cb-page-gutter\)/.test(tokens));
check('the page reserves room for the raised basket button, not just the bar',
  tokens.includes('--cb-fab-overhang')
  && /--cb-content-bottom:\s*calc\(\s*var\(--cb-bottom-nav-h\) \+ var\(--cb-fab-overhang\)/.test(tokens));
check('product card controls meet the 44px touch target',
  // The stepper's two buttons are 44x44; Add is 44 tall and full width, which is why
  // this counts the height utility rather than the old 44x44 square three times.
  !/h-9 w-9/.test(card)
  && (card.match(/h-11 w-11/g) || []).length === 2
  && /className="cb-customer-add-button flex h-11 w-full/.test(card)
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
check('the picture stays dominant and square',
  card.includes('aspect-square w-full')
  && card.includes('cb-customer-product-media'));
check('one price, once',
  // Rendered exactly once — the other two mentions are the prop type and its destructure.
  (card.match(/\{priceLabel\}/g) || []).length === 1
  && (card.match(/cb-customer-product-price/g) || []).length === 1);
check('the authoritative dietary marker is kept and stays small',
  card.includes('<DietaryMarker')
  && card.includes('compact')
  && !/VEGETARIAN|NON_VEG/.test(card.replace(/import[^;]+;/g, '')));
check('both action states occupy the same 44px row, so a card never re-flows on add',
  /cb-customer-stepper flex h-11 w-full/.test(card)
  && /cb-customer-add-button flex h-11 w-full/.test(card)
  && card.includes('mt-auto'));
check('gold marks basket state, not every card',
  // The stepper keeps the gold treatment; the resting Add is a quiet surface.
  /\.cb-customer-add-button \{[^}]*background: var\(--cb-surface-muted\)/.test(tokens)
  && /\.cb-customer-stepper \{[^}]*background: var\(--cb-gold-soft\)/.test(tokens));
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
check('the strip above the products is built from compact rows, not cards',
  store.includes('cb-customer-menu-row')
  && !store.includes('cb-customer-store-card')
  && /\.cb-customer-menu-row \{[^}]*min-height: 56px/.test(tokens));
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

// Filter branches: All shows Popular + every grouped section; a specific category
// shows exactly one grid built from the existing visibleItems filter.
check('All renders Popular then the grouped full menu',
  home.includes("category === 'ALL' ?") && home.includes('menuSections.map(section =>'));
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
check('the menu strip, its notices and the category rail stand down while searching',
  home.includes('{!searchOpen && (\n          <div className="cb-customer-menu-strip">')
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
check('search adds no second query, index or filter',
  (home.match(/const visibleItems = useMemo/g) || []).length === 1
  && home.includes('!searchText || name.includes(searchText)')
  && !/algolia|typesense|searchIndex|fuzzy/i.test(home));
check('Menu action clears the filter and returns to the top',
  home.includes("setCategory('ALL');") && home.includes("setSearch('');"));

// --- Five functional bottom-nav actions --------------------------------------
check('bottom nav exposes exactly five actions',
  ['Menu', 'Orders', 'Search', 'Account'].every(label => new RegExp(`^\\s*${label}\\s*$`, 'm').test(nav))
  && nav.includes('aria-label={basketLabel}'));
check('Account raises the existing account affordance, not a new route',
  nav.includes('onOpenAccount') && !/to=\{[^}]*ACCOUNT/.test(nav));
check('home wires Account to the existing header account control',
  home.includes('onOpenAccount={') && home.includes('Open customer account'));

// --- Style isolation --------------------------------------------------------
check('customer tokens are imported only by the customer entry',
  customerMain.includes("import './customer.css'"));
for (const [label, source] of [['card', card], ['rail', rail], ['store', store], ['nav', nav]]) {
  check(`${label} uses no Tailwind arbitrary CSS-variable utility`,
    !/\[color:var\(--cb-|shadow-\[var\(--cb-|rounded-\[var\(--cb-|bg-\[var\(--cb-/.test(source));
}
check('semantic customer classes are declared in customer.css',
  ['.cb-customer-card', '.cb-customer-accent-button', '.cb-customer-chip-active',
   '.cb-customer-bottom-nav', '.cb-customer-menu-row', '.cb-customer-stepper']
    .every((cls) => tokens.includes(cls)));
check('shared stylesheet was not modified for the customer app',
  !read('frontend/index.css').includes('cb-customer'));

// --- Single My Orders destination on the home screen ------------------------
// The bottom navigation owns the My Orders link on screens that show it. The header
// must not present a second adjacent one, but must keep it where there is no bottom
// navigation, so account access is never lost.
const header = read('frontend/components/customer/CustomerHeader.tsx');
check('bottom navigation renders exactly one My Orders link',
  (nav.match(/to=\{CUSTOMER_MY_ORDERS_PATH\}/g) || []).length === 1);
check('header exposes an opt-out for its My Orders link',
  header.includes('onSignedOutAccountPress'));
check('signed-out header control is a button when the opt-out is supplied',
  /onSignedOutAccountPress \?[\s\S]{0,400}<button/.test(header));
check('home screen passes the opt-out so no second My Orders link renders',
  home.includes('onSignedOutAccountPress={() => setBasketOpen(true)}'));
check('mobile header no longer shows "Sign in / My Orders" wording',
  !header.includes('Sign in or view My Orders') && !header.includes('>Sign in<'));
check('header keeps a compact accessible account control',
  header.includes('aria-label="Customer account"') && header.includes('h-11 w-11'));
check('My Orders remains reachable from screens without the bottom navigation',
  header.includes('to={CUSTOMER_MY_ORDERS_PATH}'));
// The bottom bar is lg:hidden, so the header must take the link back at lg — otherwise
// a signed-out desktop visitor would have no My Orders entry at all.
check('desktop keeps a My Orders entry when the bottom bar is hidden',
  /lg:hidden[\s\S]{0,600}to=\{CUSTOMER_MY_ORDERS_PATH\}[\s\S]{0,300}lg:inline-flex/.test(header));
check('signed-in account menu still contains My Orders',
  /accountOpen[\s\S]*to=\{CUSTOMER_MY_ORDERS_PATH\}/.test(header));
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
