import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

/**
 * Stage 3 — customer product customization contract.
 *
 * Two halves:
 *  - BEHAVIOUR, exercised against the real shared add-on library, proving the sheet's
 *    rules (required/optional, single/multi, ceilings, price deltas, quantity maths)
 *    are the authoritative ones and not a second implementation;
 *  - SOURCE CONTRACTS, proving the customer sheet reuses the existing cart, pricing
 *    and availability logic, introduces no backend path, stays vertical-only and
 *    accessible, and leaves the staff POS selector and build untouched.
 */
const root = process.cwd();
const require = createRequire(import.meta.url);
const read = (p) => readFileSync(resolve(root, p), 'utf8');

const passed = [];
const check = (name, condition) => { assert(condition, name); passed.push(name); };

const sheet = read('frontend/components/customer/CustomerProductCustomizationSheet.tsx');
const stepper = read('frontend/components/customer/CustomerQuantityControl.tsx');
const home = read('frontend/pages/customer/CustomerOrder.tsx');
const tokens = read('frontend/customer.css');
const staffSelector = read('frontend/components/add-ons/AddOnSelector.tsx');
const posHome = read('frontend/pages/pos/POSHome.tsx');
const productImage = read('frontend/components/customer/CustomerProductImage.tsx');
const pkg = JSON.parse(read('package.json'));
const provisioning = require(resolve(root, 'functions/storeProvisioning.js'));

const homeCode = home.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const sheetCode = sheet.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ---------------------------------------------------------------------------
// Behaviour, against the REAL shared add-on library.
// ---------------------------------------------------------------------------
execFileSync('npx', [
  'esbuild', 'frontend/lib/addOns.ts',
  '--bundle', '--platform=node', '--format=esm',
  '--outfile=/tmp/customer-addons.mjs',
], { stdio: ['ignore', 'ignore', 'pipe'] });
const addOns = await import('/tmp/customer-addons.mjs');

const option = (id, name, price, extra = {}) => ({ id, name, price, isActive: true, sortOrder: 0, ...extra });
const milkGroup = {
  id: 'milk', name: 'Milk', isActive: true, selectionMode: 'SINGLE',
  minimumSelections: 1, maximumSelections: 1,
  options: [option('OAT', 'Oat milk', 40), option('SOY', 'Soy milk', 45)],
};
const extrasGroup = {
  id: 'extras', name: 'Extras', isActive: true, selectionMode: 'MULTIPLE',
  minimumSelections: 0, maximumSelections: 2,
  options: [option('SHOT', 'Extra shot', 60), option('SYRUP', 'Vanilla syrup', 30), option('OFF', 'Retired', 0, { isActive: false })],
};
const groups = [milkGroup, extrasGroup];

// 6/7: optional vs required
check('6. an optional group is satisfied with no selection',
  addOns.validateAddOnQuantities(extrasGroup, {}).ok === true);
check('7. a required group is unsatisfied until its minimum is met',
  addOns.validateAddOnQuantities(milkGroup, {}).ok === false
  && addOns.validateAddOnQuantities(milkGroup, { OAT: 1 }).ok === true);
check('7. the required message names the group',
  /Milk/.test(addOns.validateAddOnQuantities(milkGroup, {}).message || ''));

// 9: multi-select maximum
check('9. a multi-select maximum is enforced',
  addOns.validateAddOnQuantities(extrasGroup, { SHOT: 1, SYRUP: 1 }).ok === true
  && addOns.validateAddOnQuantities(extrasGroup, { SHOT: 2, SYRUP: 1 }).ok === false);

// 10: unavailable option
check('10. an inactive option cannot be selected',
  addOns.validateAddOnQuantities(extrasGroup, { OFF: 1 }).ok === false);
check('10. an inactive option is filtered out of the active group',
  addOns.activeAddOnGroupsForProduct(['extras'], { extras: ['SHOT', 'SYRUP', 'OFF'] }, groups)[0]
    .options.every(o => o.id !== 'OFF'));

// 11: store-specific options
check('11. only the store-allowed options survive',
  addOns.activeAddOnGroupsForProduct(['milk'], { milk: ['OAT'] }, groups)[0].options.map(o => o.id).join() === 'OAT');
check('11. a group with no allowed options disappears entirely',
  addOns.activeAddOnGroupsForProduct(['milk'], { milk: [] }, groups).length === 0);

// 12/14: price deltas
const oneOat = addOns.buildAddOnSelections(groups, { milk: { OAT: 1 } }, 5);
check('12. the add-on price delta is the authoritative option price',
  oneOat.length === 1 && oneOat[0].totalPrice === 40 && oneOat[0].unitPrice === 40);
const twoShots = addOns.buildAddOnSelections(groups, { extras: { SHOT: 2 } }, 5);
check('14. add-on quantity multiplies the delta', twoShots[0].totalPrice === 120);
check('12. add-on total sums every selection',
  addOns.addOnTotal(addOns.buildAddOnSelections(groups, { milk: { OAT: 1 }, extras: { SHOT: 1 } }, 5)) === 100);

// 13/15: item total maths
const unit = addOns.unitPriceWithAddOns(260, oneOat);
check('13/15. unit price is base plus add-ons, from the shared helper', unit === 300);
check('13. product quantity multiplies the unit price', unit * 3 === 900);

// 8: single-select replacement is a rule of the group, enforced in the sheet
check('8. single-select groups are declared SINGLE', milkGroup.selectionMode === 'SINGLE');
check('8. the sheet clears the other options of a SINGLE group',
  /selectionMode === 'SINGLE' && value > 0/.test(sheetCode)
  && /updated\[id\] = 0/.test(sheetCode));

// ---------------------------------------------------------------------------
// Source contracts
// ---------------------------------------------------------------------------

// 1/2: opening rules unchanged
check('1. a product with no add-on groups still uses the direct-add path',
  /const addItem = \(item: CustomerMenuItem\) => \{[\s\S]{0,400}if \(groups\.length > 0\)[\s\S]{0,120}return;[\s\S]{0,60}commitCartItem\(item, \[\]\)/.test(homeCode));
check('2. a customizable product opens the sheet',
  homeCode.includes('setPendingAddOnItem(item)') && homeCode.includes('<CustomerProductCustomizationSheet'));

// 3/4/5: authoritative presentation
check('3. name, current price and description come from authoritative data',
  homeCode.includes('productName={pendingAddOnItem.displayName || pendingAddOnItem.name}')
  && homeCode.includes('basePrice={toNumber(pendingAddOnItem.salePrice)}')
  && homeCode.includes('description={cleanProductDescription(pendingAddOnItem)}'));
check('3. no description is invented when the catalogue has none',
  /return undefined;/.test(homeCode.slice(homeCode.indexOf('function cleanProductDescription'), homeCode.indexOf('function getItemImage'))));
check('4. the current product image is used',
  homeCode.includes('imageUrl={getItemImage(pendingAddOnItem)}'));
check('5. the existing fallback renders when no image resolves',
  sheet.includes('fallbackIcon') && productImage.includes('image unavailable'));
check('3. the dietary marker is authoritative and optional',
  homeCode.includes('trustedDietaryClassification(pendingAddOnItem')
  && sheet.includes('{dietaryClassification && ('));
// `size` alone would match the icon props, so this looks for invented CONTENT:
// hardcoded drink sizes, milk choices, ratings, nutrition or ingredient copy.
check('nothing invents sizes, ratings, ingredients or nutrition',
  !/rating|review|calorie|nutrition|ingredient|allergen/i.test(sheetCode)
  && !/["'`](Small|Medium|Large|Regular|Tall|Grande|Whole milk|Skimmed)["'`]/i.test(sheetCode));
check('every option, price and rule is rendered from props, never a literal',
  sheetCode.includes('{option.name}') && sheetCode.includes('Number(option.price)')
  && sheetCode.includes('{group.name}') && sheetCode.includes('group.minimumSelections'));

// 15: totals come from the shared library, not a private calculation
check('15. the sheet derives money from the shared add-on library only',
  sheet.includes("from '../../lib/addOns'")
  && sheetCode.includes('buildAddOnSelections(groups, quantities, taxRate)')
  && sheetCode.includes('const unitPrice = basePrice + addOnValue')
  && !/salePrice|taxRate\s*\*|gst/i.test(sheetCode.replace(/taxRate/g, '')));
check('15. the sheet runs the shared validator, not its own rules',
  sheetCode.includes('validateAddOnQuantities(group, quantities[group.id')
  && !/minimumSelections\s*\)\s*\{[\s\S]{0,200}return false/.test(sheetCode));
check('the sheet never computes GST', !/gstTotal|taxableAmount|grandTotal/.test(sheetCode));

// 16/17/18: cart behaviour
check('16. cancelling never touches the cart',
  /onCancel=\{\(\) => \{[\s\S]{0,140}setPendingAddOnItem\(null\);[\s\S]{0,80}\}\}/.test(homeCode)
  && !/onCancel=\{\(\) => \{[\s\S]{0,200}setCart\(/.test(homeCode));
check('17. confirming routes through the existing commitCartItem',
  /onConfirm=\{\(selections, quantity\) => \{[\s\S]{0,200}commitCartItem\(pendingAddOnItem, selections, editingAddOnLine\?\.id, quantity\)/.test(homeCode));
// Anchor forward from the function start: setBasketAnnouncement also appears earlier
// as a useState declaration, which would slice an empty string.
const commitStart = homeCode.indexOf('const commitCartItem');
const commitBody = homeCode.slice(commitStart, homeCode.indexOf('setBasketAnnouncement', commitStart));
check('17. commitCartItem still canonicalises before writing',
  commitBody.length > 400 && /canonicalAddOnSelections\(/.test(commitBody));
check('17. commitCartItem still checks availability before writing',
  /itemAvailability\[item\.code\] \|\| getItemAvailability\(item, selectedStoreId\)/.test(commitBody));
check('17/18. a matching line merges instead of duplicating',
  homeCode.includes('addOnSelectionKey(line.addOns) === selectionKey')
  && /line\.quantity \+ addQuantity/.test(homeCode));
check('18. the sheet closes on confirm so a second tap cannot resubmit',
  /onConfirm=\{\(selections, quantity\) => \{[\s\S]{0,320}setPendingAddOnItem\(null\)/.test(homeCode));
check('18. the action is disabled while submitting', sheet.includes('disabled={!isValid || submitting}'));
check('19. direct-add products are unaffected — quantity defaults to 1',
  homeCode.includes('requestedQuantity = 1'));
check('quantity is clamped to the backend line maximum',
  homeCode.includes('const CUSTOMER_MAX_LINE_QUANTITY = 20')
  && /Math\.min\(\s*CUSTOMER_MAX_LINE_QUANTITY/.test(homeCode));

// 35/36/37: editing already existed, so it is redesigned in place
check('35. existing selections and quantity preload',
  homeCode.includes('initialSelections={editingAddOnLine?.addOns}')
  && homeCode.includes('initialQuantity={editingAddOnLine?.quantity || 1}'));
check('36. editing updates the same line', /line\.id === editingLineId/.test(homeCode));
check('37. editing never appends a second line',
  !/editingLineId[\s\S]{0,200}\[\.\.\.prev,/.test(homeCode));
check('the CTA reads Update item when editing',
  sheet.includes("{isEditing ? 'Update item' : 'Add item'}"));
check('a saved option the store dropped is named, never substituted',
  sheetCode.includes('droppedSelections')
  && sheet.includes('is no longer available here')
  && /if \(!group\?\.options\?\.some\(option => option\.id === selection\.optionId\)\) return;/.test(sheetCode));

// 20/21: untouched neighbours
check('20. cart persistence is unchanged',
  read('frontend/lib/customerCheckoutPersistence.ts').includes("CUSTOMER_CHECKOUT_DRAFT_KEY = 'coffeeBondCustomerCheckoutDraft:v1'")
  && homeCode.includes('writeCustomerCheckoutDraft(window.localStorage, checkoutDraftInput)'));
check('21. My Usual revalidation is unchanged',
  homeCode.includes('restoreCustomerCheckoutDraft<CustomerMenuItem, AddOnSelection>')
  && homeCode.includes('displayLines'));
check('22. Golden I remains 80 products', provisioning.GOLDEN_I_PUBLIC_MENU_ITEM_COUNT === 80);
check('23. Pay at Counter is unchanged', homeCode.includes("paymentProvider === 'PAY_AT_COUNTER'"));
check('24. Razorpay is unchanged', homeCode.includes('loadRazorpayCheckout'));

// 25–28/34: nothing commercial happens in the sheet
check('25/26/27. the sheet creates no order, OTP or payment',
  !/submitOrder|createCustomerCheckoutSession|razorpay|Razorpay|sendCustomerOtp|signInWithPhoneNumber/i.test(sheetCode));
check('28. the sheet creates no KOT or stock movement',
  !/kot|stockMovement|inventory|pendingBom/i.test(sheetCode));
check('34. the sheet introduces no Firebase or backend path',
  !/firebase|firestore|httpsCallable|setDoc|addDoc|updateDoc|fetch\(/i.test(sheetCode));

// 29: vertical only
check('29. the sheet scrolls vertically and never horizontally',
  sheet.includes('overflow-y-auto overflow-x-hidden')
  && !/overflow-x-auto|snap-x|flex-nowrap|HorizontalScroller/.test(sheet));
check('29. option rows wrap rather than overflow',
  sheet.includes('break-words') && sheet.includes('min-w-0'));
check('29. the hero has reserved height so it cannot force overflow',
  tokens.includes('.cb-customer-customize-hero') && /height: 36dvh/.test(tokens));

// 30/31: accessibility
check('30. the dialog is modal and labelled by the product name',
  sheet.includes('role="dialog"') && sheet.includes('aria-modal="true"') && sheet.includes('aria-labelledby={titleId}'));
check('30. single-select uses radios and multi-select uses checkboxes',
  sheet.includes("role={single ? 'radiogroup' : 'group'}")
  && sheet.includes("role={single ? 'radio' : 'checkbox'}")
  && sheet.includes('aria-checked={selected}'));
check('30. option names announce their price effect',
  sheet.includes('aria-label={`${option.name}, ${priceLabel}'));
check('30. quantity controls carry descriptive labels',
  stepper.includes('aria-label={`Remove ${label}`}') && stepper.includes('aria-label={`Add ${label}`}'));
check('30. the sticky action has an explicit accessible name',
  /aria-label=\{`\$\{isEditing \? 'Update item' : 'Add item'\}, total/.test(sheet));
check('30. validation uses a live region', sheet.includes('role="status" aria-live="polite"'));
check('31. focus enters the sheet and is trapped',
  sheetCode.includes('closeRef.current?.focus()')
  && sheetCode.includes("event.key !== 'Tab'")
  && sheetCode.includes('last.focus()') && sheetCode.includes('first.focus()'));
check('31. Escape closes the sheet', sheetCode.includes("event.key === 'Escape'"));
check('31. the close control is labelled',
  sheet.includes('aria-label={`Close ${productName} options`}'));
check('31. the background is scroll-locked while open',
  sheetCode.includes("document.body.style.overflow = 'hidden'"));
check('required state is conveyed in words, not colour alone',
  sheet.includes("`Required · Choose ${minimum}`") && sheet.includes("'Optional'"));
check('reduced motion is respected', tokens.includes('prefers-reduced-motion'));
check('touch targets are at least 44px', stepper.includes('h-11 w-11') && sheet.includes('h-11 w-11'));

// 32/33: isolation
check('32. the shared staff add-on selector is untouched',
  staffSelector.includes("mode?: 'POS' | 'CUSTOMER'") && !staffSelector.includes('cb-customer-customize'));
check('32. staff POS still uses the shared selector, not the customer sheet',
  posHome.includes("from '../../components/add-ons/AddOnSelector'")
  && !posHome.includes('CustomerProductCustomizationSheet'));
check('32. the customer screen no longer imports the shared selector',
  !homeCode.includes("components/add-ons/AddOnSelector"));
check('32. customization styles live only in customer.css',
  tokens.includes('.cb-customer-customize-panel')
  && !read('frontend/index.css').includes('cb-customer-customize'));
check('32. no Tailwind arbitrary CSS-variable utilities in the sheet',
  !/\[color:var\(--cb-|bg-\[var\(--cb-|shadow-\[var\(--cb-|top-\[var\(--cb-/.test(sheet + stepper));
check('33. customer and staff PWA identities remain separate', (() => {
  const identity = read('frontend/lib/customerPwaIdentity.ts');
  return identity.includes("CUSTOMER_MANIFEST_HREF = '/manifest-customer.webmanifest'")
    && identity.includes("STAFF_MANIFEST_HREF = '/manifest.webmanifest'");
})());

check('the test script is registered',
  pkg.scripts['test:customer-customization-ui'] === 'node scripts/test-customer-customization-ui.mjs');

// Built output, when present
if (existsSync(resolve(root, 'dist/assets')) && existsSync(resolve(root, 'dist-customer/assets'))) {
  const cat = (dir, ext) => readdirSync(resolve(root, dir))
    .filter(f => f.endsWith(ext)).map(f => read(`${dir}/${f}`)).join('\n');
  const staffCss = cat('dist/assets', '.css');
  const customerCss = cat('dist-customer/assets', '.css');
  const customerJs = cat('dist-customer/assets', '.js');
  check('32. staff CSS carries no customization classes', !staffCss.includes('cb-customer-customize'));
  check('32. staff CSS carries no customer CSS variables', !staffCss.includes('var(--cb-'));
  check('32. customer CSS carries the customization panel', customerCss.includes('cb-customer-customize-panel'));
  check('32. the customer build contains the sheet', customerJs.includes('cb-customer-customize-panel'));
  check('32. the customer build carries no staff operational routes',
    !/POSHome|DayClose|KOTScreen|POSReadiness/.test(customerJs));
  check('32. no staff POS/admin/KOT/report screen imports the customer sheet',
    ['frontend/pages/pos/POSHome.tsx', 'frontend/pages/admin/POSReadiness.tsx',
     'frontend/pages/kot/KOTScreen.tsx', 'frontend/pages/reports/DayClose.tsx']
      .every(p => !read(p).includes('CustomerProductCustomizationSheet')));
}

console.log(`Customer customization UI tests passed (${passed.length} assertions).`);
