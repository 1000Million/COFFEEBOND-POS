import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

/**
 * Stage 4a — customer basket surface contract.
 *
 * Stage 4a redesigns the basket SURFACE only: the sheet, header, pickup summary,
 * item cards and empty state. The totals panel, payment selector, OTP block and
 * submit CTA are deliberately untouched and are asserted here to be unchanged, so a
 * later Stage 4b can redesign them against a known-good baseline.
 *
 * Nothing in this suite exercises a network call: it proves the presentation reuses
 * the existing cart, pricing and checkout logic rather than re-implementing it.
 */
const root = process.cwd();
const require = createRequire(import.meta.url);
const read = (p) => readFileSync(resolve(root, p), 'utf8');

const passed = [];
const check = (name, condition) => { assert(condition, name); passed.push(name); };

const home = read('frontend/pages/customer/CustomerOrder.tsx');
const itemCard = read('frontend/components/customer/CustomerBasketItemCard.tsx');
const emptyState = read('frontend/components/customer/CustomerBasketEmptyState.tsx');
const pickup = read('frontend/components/customer/CustomerPickupSummary.tsx');
const stepper = read('frontend/components/customer/CustomerQuantityControl.tsx');
const sheet = read('frontend/components/customer/CustomerProductCustomizationSheet.tsx');
const tokens = read('frontend/customer.css');
const persistence = read('frontend/lib/customerCheckoutPersistence.ts');
const pkg = JSON.parse(read('package.json'));
const provisioning = require(resolve(root, 'functions/storeProvisioning.js'));

const homeCode = home.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const componentCode = [itemCard, emptyState, pickup]
  .map(s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')).join('\n');

// --- 1/2: empty state ------------------------------------------------------
check('1. the empty basket state renders its own component',
  homeCode.includes('<CustomerBasketEmptyState')
  && emptyState.includes('Your basket is empty')
  && emptyState.includes('Add your Coffee Bond favourites to continue.'));
check('2. Browse menu closes the basket and returns to the menu',
  emptyState.includes('Browse menu')
  && /onBrowseMenu=\{\(\) => \{[\s\S]{0,220}setBasketOpen\(false\)[\s\S]{0,220}searchInputRef/.test(homeCode));

// --- 3/4/5: item card ------------------------------------------------------
check('3. the line renders the live image with the existing fallback',
  itemCard.includes('<CustomerProductImage')
  && homeCode.includes('imageUrl={getItemImage(line.item)}')
  && homeCode.includes('fallbackIcon={visualMeta(line.item).icon}')
  && read('frontend/components/customer/CustomerProductImage.tsx').includes('image unavailable'));
check('4. the line renders the current product name',
  homeCode.includes('productName={line.item.displayName || line.item.name}')
  && itemCard.includes('{productName}'));
check('5. selected add-ons render with quantity and price',
  itemCard.includes('{addOn.name}')
  && itemCard.includes("addOn.quantity > 1 ? ` × ${addOn.quantity}` : ''")
  && itemCard.includes('{addOn.priceLabel}')
  && homeCode.includes('priceLabel: formatMoney(addOn.totalPrice)'));
check('the dietary marker stays authoritative',
  homeCode.includes('dietaryClassification={trustedDietaryClassification(line.item'));

// --- 6/7/8/9/10/11/12: cart operations reuse existing callbacks ------------
check('6/7. quantity changes route through the existing setLineQuantity',
  homeCode.includes('onQuantityChange={next => setLineQuantity(line.id, next)}')
  && !/onQuantityChange[\s\S]{0,120}setCart\(/.test(homeCode));
check('quantity is bounded by the existing line maximum',
  homeCode.includes('maxQuantity={CUSTOMER_MAX_LINE_QUANTITY}')
  && stepper.includes('max === undefined || value < max'));
check('8. remove uses the existing zero-quantity path for that line only',
  homeCode.includes('onRemove={() => setLineQuantity(line.id, 0)}'));
check('9. Edit reopens the Stage 3 customization sheet',
  homeCode.includes('onEdit={() => editLineAddOns(line)}')
  && /const editLineAddOns[\s\S]{0,400}setEditingAddOnLine\(line\)/.test(homeCode));
check('9. Edit is only offered when the product has active groups',
  /canEdit=\{activeAddOnGroupsForProduct\([\s\S]{0,180}\)\.length > 0\}/.test(homeCode));
check('10. editing still preloads current selections and quantity',
  homeCode.includes('initialSelections={editingAddOnLine?.addOns}')
  && homeCode.includes('initialQuantity={editingAddOnLine?.quantity || 1}'));
check('11/12. update modifies the same line and never appends',
  /line\.id === editingLineId/.test(homeCode)
  && !/editingLineId[\s\S]{0,200}\[\.\.\.prev,/.test(homeCode));

// --- 13/14/15: My Usual action retained -----------------------------------
check('13. the Save as My Usual action remains in the basket',
  homeCode.includes('onClick={requestSaveMyUsual}') && home.includes('Save as My Usual'));
check('14. a signed-out save still routes to the existing verification flow',
  /if \(!verifiedCustomer\) \{[\s\S]{0,200}setMyUsualDialog\(\{ type: 'SIGN_IN' \}\)/.test(homeCode));
check('15. an authenticated save is still profile-synced',
  homeCode.includes('saveCustomerMyUsualRequest(buildMyUsualPayload({'));

// --- 16-21: totals are untouched and authoritative -------------------------
check('16/17/18/19. the basket still renders the parent totals object',
  homeCode.includes('formatMoney(totals.subtotal)')
  && homeCode.includes('formatMoney(totals.gstTotal)')
  && homeCode.includes('formatMoney(totals.grandTotal)'));
check('totals still come from the single totalsForLines source',
  (homeCode.match(/function totalsForLines/g) || []).length === 1
  && /const totals = useMemo\(\s*\(\) => totalsForLines\(cart\)/.test(homeCode));
check('the redesigned components compute no money at all',
  !/salePrice|taxRate|gstTotal|grandTotal|subtotal|\* *quantity/i.test(componentCode));
check('20/21. no invented fee, delivery or discount line was added',
  !/delivery|shipping|service fee|packaging fee|convenience/i.test(homeCode.slice(
    homeCode.indexOf('const basketPanel'), homeCode.indexOf('const confirmation'))));

// --- 22-26: payment and OTP untouched in Stage 4a -------------------------
check('22/23. both existing payment choices remain',
  homeCode.includes("setPaymentProvider('PAY_AT_COUNTER')")
  && homeCode.includes("setPaymentProvider('RAZORPAY')"));
check('24. no staff payment method leaked into the customer app',
  !/Swiggy|Zomato|'CASH'|'CARD'/.test(homeCode.slice(
    homeCode.indexOf('const basketPanel'), homeCode.indexOf('const confirmation'))));
check('25. selecting a payment method creates no order',
  !/setPaymentProvider\([\s\S]{0,120}(submitOrder|createCustomerCheckoutSession)/.test(homeCode));
check('26. the existing OTP panel is reused, not reimplemented',
  (home.match(/<CustomerOtpPanel/g) || []).length === 2
  && !homeCode.includes('signInWithPhoneNumber')
  && !homeCode.includes('RecaptchaVerifier'));
check('27. the basket survives verification',
  !/onVerified=\{\(profile\) => \{[\s\S]{0,400}setCart\(/.test(homeCode));

// --- 28-36: checkout lifecycle untouched ----------------------------------
check('28/29. checkout still revalidates through the shared restore engine',
  homeCode.includes('restoreCustomerCheckoutDraft<CustomerMenuItem, AddOnSelection>')
  && homeCode.includes('checkoutRestoreOptions()'));
check('30. a changed item is surfaced, not silently dropped',
  homeCode.includes("notice.code === 'ITEM_REMOVED'")
  && home.includes('unavailable item'));
check('31. the submission lock and idempotency key are unchanged',
  homeCode.includes('let clientIdempotencyKey = createClientIdempotencyKey()')
  && homeCode.includes('lock.clientIdempotencyKey')
  && homeCode.includes("status: 'SENDING'"));
check('31. repeated taps are guarded by the submitting ref',
  homeCode.includes('if (saving || submittingRef.current) return'));
check('32/33. Pay at Counter still creates no payment artifact in the client',
  !/PAY_AT_COUNTER[\s\S]{0,300}(createCustomerCheckoutSession|loadRazorpayCheckout)/.test(homeCode));
check('34. Pay Online still uses the canonical server checkout session',
  homeCode.includes('await createCustomerCheckoutSession({'));
check('35. the browser callback is not treated as authoritative',
  homeCode.includes('verifyCustomerRazorpayPayment({'));
check('36. callback-loss recovery is retained',
  homeCode.includes('submissionLockKey') || homeCode.includes('lockKey'));
check('44. the new presentation components add no backend path',
  !/firebase|firestore|httpsCallable|setDoc|addDoc|updateDoc|fetch\(/i.test(componentCode));

// --- 37/38/39: neighbouring stages still verified -------------------------
check('37. My Usual persistence is unchanged',
  homeCode.includes('getCustomerMyUsualRequest()') && homeCode.includes('deleteCustomerMyUsualRequest()'));
check('38. Stage 3 customization is unchanged',
  homeCode.includes('<CustomerProductCustomizationSheet')
  && sheet.includes("{isEditing ? 'Update item' : 'Add item'}"));
check('39. Golden I remains 80 products', provisioning.GOLDEN_I_PUBLIC_MENU_ITEM_COUNT === 80);
check('cart persistence is unchanged',
  persistence.includes("CUSTOMER_CHECKOUT_DRAFT_KEY = 'coffeeBondCustomerCheckoutDraft:v1'")
  && homeCode.includes('writeCustomerCheckoutDraft(window.localStorage, checkoutDraftInput)'));

// --- 40: vertical only -----------------------------------------------------
check('40. the basket sheet scrolls vertically only',
  homeCode.includes('cb-customer-basket-scroll min-h-0 flex-1 overflow-y-auto overflow-x-hidden')
  && !/overflow-x-auto|snap-x|HorizontalScroller/.test(itemCard + emptyState + pickup));
check('40. line text wraps instead of clipping',
  itemCard.includes('break-words') && itemCard.includes('min-w-0')
  && !itemCard.includes('line-clamp'));
check('40. the sheet has a bounded height so it cannot overflow the viewport',
  /\.cb-customer-basket-sheet[\s\S]{0,220}height: 92dvh/.test(tokens));

// --- 41: accessibility -----------------------------------------------------
check('41. the mobile basket is a labelled modal dialog',
  homeCode.includes('aria-labelledby="cb-basket-heading"')
  && homeCode.includes('id="cb-basket-heading"')
  && /role="dialog"[\s\S]{0,120}aria-modal="true"/.test(homeCode));
check('41. the background is scroll-locked and Escape closes the basket',
  /if \(!basketOpen \|\| typeof window === 'undefined'\)/.test(homeCode)
  && homeCode.includes("mobile.matches ? 'hidden' : previousOverflow")
  && /event\.key === 'Escape' && mobile\.matches\) setBasketOpen\(false\)/.test(homeCode));
check('41. the lock follows the breakpoint rather than the open moment',
  homeCode.includes("window.matchMedia('(max-width: 1023px)')")
  && homeCode.includes("mobile.addEventListener('change', applyLock)")
  && homeCode.includes("mobile.removeEventListener('change', applyLock)"));
check('41. line controls carry product-specific accessible names',
  itemCard.includes('aria-label={`Remove ${productName} from basket`}')
  && itemCard.includes('aria-label={`Edit ${productName} options`}')
  && stepper.includes('aria-label={`Add ${label}`}'));
check('41. the close control is labelled', home.includes('aria-label="Close basket"'));
check('41. store status is stated in words, not colour alone',
  pickup.includes('{statusLabel}') && pickup.includes('aria-label={`Change pickup store'));
check('41. touch targets are at least 44px',
  itemCard.includes('h-11 w-11') && itemCard.includes('h-11') && stepper.includes('h-11 w-11'));
check('reduced motion is respected', tokens.includes('prefers-reduced-motion'));

// --- 42/43: isolation ------------------------------------------------------
check('42. basket styles are semantic classes in customer.css',
  ['.cb-customer-basket-sheet', '.cb-customer-basket-line', '.cb-customer-basket-empty',
   '.cb-customer-basket-pickup'].every(cls => tokens.includes(cls))
  && !read('frontend/index.css').includes('cb-customer-basket'));
check('42. no Tailwind arbitrary CSS-variable utilities in the new components',
  !/\[color:var\(--cb-|bg-\[var\(--cb-|shadow-\[var\(--cb-/.test(itemCard + emptyState + pickup));
check('42. no staff screen imports the customer basket components',
  ['frontend/pages/pos/POSHome.tsx', 'frontend/pages/kot/KOTScreen.tsx',
   'frontend/pages/admin/POSReadiness.tsx', 'frontend/pages/reports/DayClose.tsx']
    .every(p => !/CustomerBasketItemCard|CustomerBasketEmptyState|CustomerPickupSummary/.test(read(p))));
check('43. customer and staff PWA identities remain separate', (() => {
  const identity = read('frontend/lib/customerPwaIdentity.ts');
  return identity.includes("CUSTOMER_MANIFEST_HREF = '/manifest-customer.webmanifest'")
    && identity.includes("STAFF_MANIFEST_HREF = '/manifest.webmanifest'");
})());

check('the test script is registered',
  pkg.scripts['test:customer-basket-checkout-ui'] === 'node scripts/test-customer-basket-checkout-ui.mjs');

// Built output, when present
if (existsSync(resolve(root, 'dist/assets')) && existsSync(resolve(root, 'dist-customer/assets'))) {
  const cat = (dir, ext) => readdirSync(resolve(root, dir))
    .filter(f => f.endsWith(ext)).map(f => read(`${dir}/${f}`)).join('\n');
  const staffCss = cat('dist/assets', '.css');
  const customerCss = cat('dist-customer/assets', '.css');
  const customerJs = cat('dist-customer/assets', '.js');
  check('42. staff CSS carries no basket classes', !staffCss.includes('cb-customer-basket'));
  check('42. staff CSS carries no customer CSS variables', !staffCss.includes('var(--cb-'));
  check('42. the customer build carries the basket surface', customerCss.includes('cb-customer-basket-sheet'));
  check('42. the customer build carries no staff operational routes',
    !/POSHome|DayClose|KOTScreen|POSReadiness/.test(customerJs));
}

console.log(`Customer basket/checkout UI tests passed (${passed.length} assertions).`);
