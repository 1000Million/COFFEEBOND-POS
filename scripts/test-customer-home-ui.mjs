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
check('the chip row keeps its gutter when snapped',
  /\.cb-customer-rail\s*\{[^}]*scroll-padding-inline:\s*var\(--cb-page-gutter\)/.test(tokens));
check('the page reserves room for the raised basket button, not just the bar',
  tokens.includes('--cb-fab-overhang')
  && /--cb-content-bottom:\s*calc\(\s*var\(--cb-bottom-nav-h\) \+ var\(--cb-fab-overhang\)/.test(tokens));
check('product card steppers meet the 44px touch target',
  !/h-9 w-9/.test(card) && (card.match(/h-11 w-11/g) || []).length >= 3);
check('the store status line wraps instead of clipping the pickup estimate',
  store.includes('flex-wrap') && !/truncate text-\[11px\] font-bold">\{message\}/.test(store));
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
  home.includes('Search results') && home.includes('Nothing found here'));
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
   '.cb-customer-bottom-nav', '.cb-customer-store-card', '.cb-customer-stepper']
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
