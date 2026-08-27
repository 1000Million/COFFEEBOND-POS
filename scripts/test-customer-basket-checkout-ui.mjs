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

// --- 16-21: totals remain parent-authoritative -----------------------------
check('16/17/18/19. the basket renders the current authoritative totals object',
  homeCode.includes('formatMoney(checkoutDisplayTotals.subtotal)')
  && homeCode.includes('formatMoney(checkoutDisplayTotals.gstTotal)')
  && homeCode.includes('formatMoney(checkoutDisplayTotals.grandTotal)'));
check('totals still come from the single totalsForLines source',
  (homeCode.match(/function totalsForLines/g) || []).length === 1
  && /const totals = useMemo\(\s*\(\) => totalsForLines\(cart\)/.test(homeCode));
check('the redesigned components compute no money at all',
  !/salePrice|taxRate|gstTotal|grandTotal|subtotal|\* *quantity/i.test(componentCode));
check('20/21. no invented fee or delivery line was added',
  !/delivery|shipping|service fee|packaging fee|convenience/i.test(homeCode.slice(
    homeCode.indexOf('const basketPanel'), homeCode.indexOf('const confirmation'))));

// --- 22-26: payment and OTP untouched in Stage 4a -------------------------
// Stage 4b moved the two method literals into CustomerPaymentSelector; the parent
// now supplies the setter. The provider set itself is asserted at 4b-8/9 below.
check('22/23. both existing payment choices remain, driven by the same setter',
  homeCode.includes('onChange={setPaymentProvider}')
  && read('frontend/components/customer/CustomerPaymentSelector.tsx').includes("value: 'PAY_AT_COUNTER'")
  && read('frontend/components/customer/CustomerPaymentSelector.tsx').includes("value: 'RAZORPAY'"));
check('24. no staff payment method leaked into the customer app',
  !/Swiggy|Zomato|'CASH'|'CARD'/.test(homeCode.slice(
    homeCode.indexOf('const basketPanel'), homeCode.indexOf('const confirmation')))
  // The doc comment legitimately names the excluded staff tenders to explain their
  // absence, so measure the executable code rather than the prose.
  && !/Swiggy|Zomato|\bUPI\b|'CASH'|'CARD'/i.test(
    read('frontend/components/customer/CustomerPaymentSelector.tsx')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')));
check('25. selecting a payment method creates no order',
  !/setPaymentProvider\([\s\S]{0,120}(submitOrder|createCustomerCheckoutSession)/.test(homeCode)
  && !/(submitOrder|createCustomerCheckoutSession|loadRazorpayCheckout)/
    .test(read('frontend/components/customer/CustomerPaymentSelector.tsx')));
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
  pickup.includes('{statusLabel}')
  // The pickup row now shares its accessible-name shape with the menu's store row:
  // "<context> <store>. <status>. Change store".
  && /aria-label=\{`\$\{contextLabel\} \$\{storeName\}\. \$\{statusLabel\}\. Change store`\}/.test(pickup));

check('41. touch targets are at least 44px',
  itemCard.includes('h-11 w-11') && itemCard.includes('h-11') && stepper.includes('h-11 w-11'));
check('reduced motion is respected', tokens.includes('prefers-reduced-motion'));

// --- 42/43: isolation ------------------------------------------------------
check('42. basket styles are semantic classes in customer.css',
  ['.cb-customer-basket-sheet', '.cb-customer-basket-line', '.cb-customer-basket-empty',
   '.cb-customer-menu-row'].every(cls => tokens.includes(cls))
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

// ===========================================================================
// Stage 4b — totals, payment selector, verification and checkout action.
// ===========================================================================
const totalsPanel = read('frontend/components/customer/CustomerCheckoutTotalsPanel.tsx');
const paymentSelector = read('frontend/components/customer/CustomerPaymentSelector.tsx');
const notice = read('frontend/components/customer/CustomerCheckoutNotice.tsx');
const actionBar = read('frontend/components/customer/CustomerCheckoutActionBar.tsx');
const strip = (x) => x.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const stage4bCode = [totalsPanel, paymentSelector, notice, actionBar].map(strip).join('\n');

// 2-7: totals are parent-authoritative
// "Taxable amount" is no longer displayed: totals.taxableAmount IS totals.subtotal in
// this app, so the row printed the same number twice. The totals OBJECT is unchanged —
// only the row is gone — and the three amounts still come straight from the parent.
check('4b-2/3/4/5. the totals panel is fed from the parent authoritative totals object',
  homeCode.includes('subtotalLabel={formatMoney(checkoutDisplayTotals.subtotal)}')
  && homeCode.includes('gstLabel={formatMoney(checkoutDisplayTotals.gstTotal)}')
  && homeCode.includes('payableLabel={formatMoney(checkoutDisplayTotals.grandTotal)}'));
check('4b-2a. the totals calculation itself was not touched',
  homeCode.includes('taxableAmount: subtotal')
  && homeCode.includes('grandTotal: subtotal + gstTotal'));
check('4b. the totals panel performs no arithmetic of its own',
  !/gstTotal\s*=|subtotal\s*=|grandTotal\s*=|salePrice|taxRate/.test(stage4bCode));
check('4b-6. a discount renders only when the parent supplies one',
  totalsPanel.includes('discountLabel = null') && totalsPanel.includes('{discountLabel && ('));
check('4b-7. no shipping, delivery, service or payment fee is invented',
  !/shipping|delivery|service fee|handling|convenience|payment fee/i.test(stage4bCode));
check('4b. GST is not split into fabricated CGST/SGST', !/CGST|SGST|IGST/i.test(stage4bCode));

// 8-14: payment selector
check('4b-8/9. both payment cards render from a fixed two-method list',
  paymentSelector.includes("value: 'PAY_AT_COUNTER'")
  && paymentSelector.includes("value: 'RAZORPAY'")
  && (paymentSelector.match(/value: '(PAY_AT_COUNTER|RAZORPAY)'/g) || []).length === 2);
check('4b-10. payment choices use radio semantics',
  paymentSelector.includes('role="radiogroup"')
  && paymentSelector.includes('role="radio"')
  && paymentSelector.includes('aria-checked={selected}'));
check('4b-10. selection is stated in words, not colour alone',
  paymentSelector.includes("{selected ? 'Selected' : 'Not selected'}"));
check('4b-10. payment targets are at least 44px', paymentSelector.includes('h-11 w-11'));
check('4b-11/12. changing payment creates no order, session or payment',
  homeCode.includes('onChange={setPaymentProvider}')
  && !/(submitOrder|createCustomerCheckoutSession|loadRazorpayCheckout|httpsCallable)/i.test(stage4bCode));
// The descriptions were shortened so neither payment card runs to two lines. What they
// must never do is imply money has already changed hands, or that paying is the end of
// the story — those are asserted on meaning, not on an exact sentence.
check('4b-13. Pay at Counter copy never implies the order is paid',
  paymentSelector.includes('Pay when you collect your order.')
  && !/already paid|payment complete|paid order/i.test(strip(paymentSelector)));
check('4b-14. Pay Online copy states security AND pending acceptance, never success',
  paymentSelector.includes('Pay securely online before the cafe accepts your order.')
  && !/payment successful|paid successfully|order confirmed/i.test(strip(paymentSelector)));

/* 4b-14a-d. The pre-payment caveat.
   Online payment is captured before the store decides, so the customer must be told
   BEFORE tapping Pay that (1) acceptance is still pending and (2) a refund follows if
   the store cannot fulfil. Everything here is asserted against `homeCode`, which has
   comments stripped, so a caveat that survives only as a code comment fails.
   These checks are deliberately about MEANING, not one exact sentence: substituting an
   unrelated cart/payment reassurance keeps the string present but fails 14b/14c. */
const caveatMatch = homeCode.match(/const RAZORPAY_PRE_PAYMENT_CAVEAT\s*=\s*\n?\s*'([^']+)'/);
const caveat = caveatMatch ? caveatMatch[1] : '';
check('4b-14a. a pre-payment caveat constant exists in rendered code, not in a comment',
  caveat.length > 0);
check('4b-14b. it states that paying does not confirm the order / acceptance is pending',
  /does not confirm your order/i.test(caveat) && /must still accept/i.test(caveat));
check('4b-14c. it states the refund path when the store cannot fulfil',
  /full refund/i.test(caveat) && /cannot/i.test(caveat));
check('4b-14d. it is wired to the sticky action bar for RAZORPAY only, above the CTA',
  homeCode.includes("notice={paymentProvider === 'RAZORPAY' ? RAZORPAY_PRE_PAYMENT_CAVEAT : undefined}")
  && actionBar.includes('{notice}')
  && actionBar.indexOf('{notice}') < actionBar.indexOf('<button')
  && actionBar.includes('{footnote}'));
check('4b-14e. the post-payment surfaces still carry it too',
  homeCode.includes('Your cart clears only after payment is verified and the order is created.')
  && read('frontend/components/customer/CustomerTrackingScreen.tsx').includes("'Paid, awaiting store'")
  && read('frontend/lib/publicOrderTracking.ts').includes('If the store cannot fulfil it, a full refund will be initiated.'));

// 15-17: verification
check('4b-15. the existing OTP panel is still the only OTP implementation',
  (home.match(/<CustomerOtpPanel/g) || []).length === 2
  && !/signInWithPhoneNumber|RecaptchaVerifier|sendCustomerOtp/.test(stage4bCode));
check('4b-16. Stage 4b never touches the cart', !/setCart\(/.test(stage4bCode));
check('4b-17. the verified-customer condition is unchanged',
  homeCode.includes("paymentProvider === 'RAZORPAY' && !verifiedCustomer"));

// 18-21: notices block the action
check('4b-18. offline shows a notice and blocks the action',
  homeCode.includes('<CustomerCheckoutNotice tone="offline"')
  && /if \(isOffline\) return \{ label: payLabel, disabled: true/.test(homeCode));
check('4b-19. a closed store shows a notice and blocks the action',
  homeCode.includes('<CustomerCheckoutNotice tone="warning" message={customerOrderingState.message} />')
  && /if \(!selectedStoreOnline\)/.test(homeCode));
check('4b-20/21. the existing revalidation still blocks and identifies the line',
  /const blockedLine = cart\.find/.test(homeCode)
  && homeCode.includes('is currently unavailable'));
check('4b. notices use live regions',
  notice.includes('aria-live="polite"') && notice.includes('role="status"'));

// 22-25: action bar
check('4b-22. the action shows the authoritative payable',
  /payLabel = paymentProvider === 'RAZORPAY'[\s\S]{0,240}formatMoney\(checkoutDisplayTotals\.grandTotal\)/.test(homeCode));
check('4b-23. the action calls the existing submit handler and no other',
  homeCode.includes('onSubmit={submitOrder}')
  && (homeCode.match(/onClick=\{submitOrder\}|onSubmit=\{submitOrder\}/g) || []).length === 1
  && !/submitOrder/.test(stage4bCode));
check('4b-24. the action disables while a submission is running',
  /if \(saving\) \{[\s\S]{0,240}disabled: true/.test(homeCode)
  && actionBar.includes('disabled={disabled}'));
check('4b-25. repeated taps are still guarded by the existing lock',
  homeCode.includes('if (saving || submittingRef.current) return')
  && homeCode.includes('submissionLockKey(signature)'));
check('4b. the disabled reason is discoverable, not implied',
  actionBar.includes('aria-describedby') && actionBar.includes('cb-checkout-disabled-reason'));
check('4b. no new lifecycle status was invented',
  !/PAID_PENDING|CONVERTED|REFUND|ACCEPTED/.test(stage4bCode));

// 26-30: lifecycle preserved
check('4b-26. Pay at Counter still creates no payment artifact client-side',
  !/PAY_AT_COUNTER[\s\S]{0,300}(createCustomerCheckoutSession|loadRazorpayCheckout)/.test(homeCode));
check('4b-27. Pay Online still uses the canonical server session',
  homeCode.includes('await createCustomerCheckoutSession({'));
check('4b-28. the browser callback is still not authoritative',
  homeCode.includes('verifyCustomerRazorpayPayment({'));
check('4b-29/30. idempotency key and submission lock are unchanged',
  homeCode.includes('let clientIdempotencyKey = createClientIdempotencyKey()')
  && homeCode.includes('lock.clientIdempotencyKey'));

// 34-38: layout, accessibility, isolation
check('4b-34. payment cards stack vertically with no horizontal scroller',
  paymentSelector.includes('space-y-2') && !/overflow-x|snap-x|flex-nowrap/.test(stage4bCode));
check('4b-34. long labels wrap in every Stage 4b surface',
  paymentSelector.includes('break-words') && notice.includes('break-words'));
check('4b-35. the action bar has an explicit accessible label and busy state',
  actionBar.includes('aria-label={label}') && actionBar.includes('animate-spin'));
check('4b-35. the action bar respects the safe area',
  actionBar.includes('env(safe-area-inset-bottom)'));
check('4b-36. Stage 4b styles live only in customer.css',
  // The espresso totals panel is gone; totals now reuse the flat total-row treatment.
  ['.cb-customer-total-row', '.cb-customer-payment-card', '.cb-customer-checkout-notice',
   '.cb-customer-action-bar'].every(cls => tokens.includes(cls))
  && !read('frontend/index.css').includes('cb-customer-total'));
check('4b-36. no Tailwind arbitrary CSS-variable utilities in Stage 4b components',
  !/\[color:var\(--cb-|bg-\[var\(--cb-|shadow-\[var\(--cb-/.test(stage4bCode));
check('4b-38. Stage 4b adds no backend or Firebase write path',
  !/firebase|firestore|httpsCallable|setDoc|addDoc|updateDoc|fetch\(/i.test(stage4bCode));

// --- Stage 4b: the OLD presentation must be gone, not merely bypassed ---------
check('4b. the plain totals markup was replaced, not left behind',
  !homeCode.includes('rounded-2xl bg-[#fbf5ee] p-4 text-sm')
  && homeCode.includes('<CustomerCheckoutTotalsPanel'));
check('4b. the old inline submit button was replaced by the action bar',
  !/className="mt-4 w-full rounded-2xl bg-\[#3b261d\]/.test(homeCode)
  && homeCode.includes('<CustomerCheckoutActionBar'));
check('4b. the old two-column payment grid is gone',
  !homeCode.includes('grid grid-cols-2 gap-2')
  && homeCode.includes('<CustomerPaymentSelector'));
check('4b. totals use description-list semantics so screen readers pair them',
  totalsPanel.includes('<dl') && totalsPanel.includes('<dt') && totalsPanel.includes('<dd')
  && totalsPanel.includes('aria-label="Order totals"'));
check('4b. the payable is distinguishable from GST, not just larger',
  // A hairline above it and a size step, rather than a separate coloured panel.
  totalsPanel.includes('is-grand')
  && totalsPanel.includes('cb-customer-totals')
  && /\.cb-customer-totals \{[^}]*border-top: 1px solid/.test(tokens)
  && /\.cb-customer-total-row\.is-grand[^{]*\{[^}]*font-size: 17px/.test(tokens));
check('4b. the OTP panel still sits inside the basket checkout flow',
  homeCode.indexOf('<CustomerOtpPanel') > homeCode.indexOf('const basketPanel')
  && homeCode.indexOf('<CustomerOtpPanel') < homeCode.indexOf('<CustomerCheckoutActionBar'));
check('4b. every notice tone the checkout can raise is implemented',
  ['info', 'warning', 'error', 'offline'].every(t => notice.includes(`'${t}'`) || notice.includes(`tone-${t}`)));
check('4b. the action bar is sticky within the basket scroll region',
  actionBar.includes('sticky bottom-0'));

// ===========================================================================
// Modal layering — My Usual is raised FROM the basket and must sit ABOVE it.
// Regression for: My Usual (z-70) rendered behind the Stage 4a basket (z-75).
// ===========================================================================
const layerOf = (cls) => {
  const rule = new RegExp('\\.' + cls + '\\s*\\{[^}]*z-index:\\s*(\\d+)').exec(tokens);
  return rule ? Number(rule[1]) : null;
};
check('layer-1/3. My Usual sits on a strictly higher layer than the basket',
  layerOf('cb-customer-layer-modal') !== null
  && layerOf('cb-customer-layer-basket') !== null
  && layerOf('cb-customer-layer-modal') > layerOf('cb-customer-layer-basket'));
check('layer-2. both overlays use the named scale, not inline z-index',
  /aria-label="My Usual"/.test(home)
  && /cb-customer-layer-modal[\s\S]{0,120}aria-label="My Usual"/.test(home)
  && homeCode.includes('cb-customer-layer-basket')
  && !/fixed inset-0 z-\[7[05]\]/.test(homeCode));
check('layer-2. the two overlays remain siblings, so the scale actually decides paint order',
  homeCode.indexOf('cb-customer-layer-modal') !== -1
  && homeCode.indexOf('cb-customer-layer-basket') !== -1);
check('layer-4. the basket goes inert while My Usual is topmost',
  homeCode.includes('aria-hidden={myUsualDialog ? true : undefined}')
  && homeCode.includes('inert={myUsualDialog ? true : undefined}'));
check('layer-5. opening My Usual never closes the basket',
  !/setMyUsualDialog\(\{ type: '(SIGN_IN|SAVE_NEW|REPLACE_USUAL)' \}\)[\s\S]{0,120}setBasketOpen\(false\)/.test(homeCode));
check('layer-6. closing My Usual never mutates the cart',
  !/setMyUsualDialog\(null\)[\s\S]{0,80}setCart\(/.test(homeCode));
// The control is found by a data attribute, not by its text: the label now reads
// "Sign in to save as My Usual" for a signed-out customer, so matching on the string
// would have silently stopped finding it in exactly that case.
check('layer-7. focus returns to the basket Save control',
  homeCode.includes('ref={saveAsMyUsualButtonRef}')
  && homeCode.includes('data-cb-save-usual="true"')
  && homeCode.includes("querySelectorAll<HTMLButtonElement>('button[data-cb-save-usual]')"));
// basketPanel renders twice (mobile sheet + desktop aside), so the ref can hold the
// display:none copy. Focus must target a VISIBLE control or it silently no-ops.
check('layer-7. focus restore prefers a visible control over a hidden duplicate',
  homeCode.includes('el.offsetParent !== null')
  && /const target = visibleSave[\s\S]{0,220}\|\| opener;/.test(homeCode));
check('layer-7. focus enters the dialog when it opens',
  homeCode.includes('myUsualDialogRef.current?.querySelector<HTMLElement>')
  && homeCode.includes('focusable?.focus()'));
// Slice the My Usual focus effect itself rather than searching near the state
// declaration, which sits within a few hundred chars of the basket's lock effect.
const myUsualFocusEffect = (() => {
  const start = homeCode.indexOf('myUsualDialogOpenRef.current = Boolean(myUsualDialog)');
  return start === -1 ? '' : homeCode.slice(start, homeCode.indexOf('}, [myUsualDialog]);', start));
})();
check('layer-8. only the basket owns the body scroll lock',
  myUsualFocusEffect.length > 200
  && !myUsualFocusEffect.includes('document.body.style.overflow')
  && (homeCode.match(/document\.body\.style\.overflow = /g) || []).length === 2);
check('layer-8. Escape closes only the topmost layer',
  homeCode.includes('if (myUsualDialogOpenRef.current) return;')
  && /event\.key === 'Escape'\) \{[\s\S]{0,120}setMyUsualDialog\(null\)/.test(homeCode));
check('layer-9. merely opening the dialog performs no My Usual persistence call',
  !/setMyUsualDialog\(\{[\s\S]{0,160}(saveCustomerMyUsualRequest|deleteCustomerMyUsualRequest)/.test(homeCode));
check('layer-10. the layering fix introduces no order, payment or stock path',
  !/submitOrder|createCustomerCheckoutSession|loadRazorpayCheckout/.test(
    homeCode.slice(homeCode.indexOf('myUsualDialogOpenRef'), homeCode.indexOf('myUsualDialogOpenRef') + 1800)));

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

// --- Touch targets inside the basket ----------------------------------------
// "Change" was 70x34: reachable with a mouse, a miss with a thumb.
check('43. the change-store control meets the 44px touch target',
  // The whole row is the control now, and the row class carries the height.
  pickup.includes('cb-customer-menu-row')
  && /\.cb-customer-menu-row \{[^}]*min-height: 56px/.test(tokens));


// --- The basket step -----------------------------------------------------------
// The basket answers one question: what am I buying. Everything that asks how you are
// paying, who you are, or what the store should know waits behind Continue. This is a
// PRESENTATION split — the assertions below also pin that no second cart, total or
// submission was created to achieve it.
/* The basket branch, from its ternary test up to the Continue label. Anchoring the end
   on a wrapper class proved brittle — the class was later removed and the slice
   silently swallowed the whole checkout branch, which would have let a payment field
   leak into the basket step without failing anything. The Continue label is the last
   thing in this branch and is itself asserted below, so it cannot vanish unnoticed. */
const continueLabel = 'Continue · {formatMoney(checkoutDisplayTotals.grandTotal)}';
assert(homeCode.includes(continueLabel), 'the Continue label anchors the basket-step slice');
const basketStepBlock = homeCode.slice(
  homeCode.indexOf("basketStep === 'BASKET' ?"),
  homeCode.indexOf(continueLabel),
);
check('45. the basket step is a presentation state, not a second checkout',
  homeCode.includes("useState<'BASKET' | 'CHECKOUT'>('BASKET')")
  && homeCode.includes("if (basketOpen) setBasketStep('BASKET');"));
check('45a. Continue only advances the step — it creates no order or payment',
  /onClick=\{\(\) => setBasketStep\('CHECKOUT'\)\}/.test(homeCode)
  && (homeCode.match(/onSubmit=\{submitOrder\}/g) || []).length === 1
  && !/setBasketStep\('CHECKOUT'\)[\s\S]{0,120}(submitOrder|createCustomerCheckoutSession|razorpay)/i.test(homeCode));
check('45b. the basket step asks nothing about payment or identity',
  !/CustomerPaymentSelector|CustomerOtpPanel|customerName|setNotes|handleOrderTypeChange|CustomerCheckoutActionBar/.test(basketStepBlock));
check('45c. the checkout fields still exist, behind Continue',
  homeCode.includes('<CustomerPaymentSelector')
  && homeCode.includes('<CustomerOtpPanel')
  && homeCode.includes('<CustomerCheckoutActionBar'));
check('45d. the customer can always get back out of the checkout step',
  homeCode.includes('aria-label="Back to basket"')
  && /setBasketStep\('BASKET'\)/.test(homeCode));

// --- One total, one CTA ---------------------------------------------------------
// `totals.taxableAmount` IS `totals.subtotal` in this app, so printing both was a
// duplicate rather than a disclosure.
// Measured against CODE, not prose: the component's doc comment explains why the
// duplicate row was removed, and naming it there must not fail the check.
const totalsCode = strip(totalsPanel);
check('46. totals show Subtotal, GST and Total once, with no duplicate of the subtotal',
  totalsCode.includes('Subtotal') && totalsCode.includes('GST') && totalsCode.includes('Total')
  && !/Taxable amount/.test(totalsCode)
  && !/taxableAmountLabel/.test(totalsCode + homeCode));
check('46a. the totals block is flat, not a second coloured panel',
  !totalsCode.includes('cb-customer-totals-panel')
  && !tokens.includes('.cb-customer-totals-panel')
  && totalsCode.includes('cb-customer-total-row'));
check('46b. the basket step carries exactly one primary action',
  (basketStepBlock.match(/cb-customer-accent-button/g) || []).length === 1
  && /Continue · \{formatMoney\(checkoutDisplayTotals\.grandTotal\)\}/.test(homeCode));
check('46c. Save as My Usual is a secondary row, not a panel or a filled button',
  homeCode.includes('data-cb-save-usual="true"')
  && /className="cb-customer-menu-row disabled:opacity-55"/.test(homeCode)
  && homeCode.includes("verifiedCustomer ? 'Save as My Usual' : 'Sign in to save as My Usual'"));

// --- Lines are rows -------------------------------------------------------------
check('47. a basket line is a row on the sheet, not a card inside it',
  /\.cb-customer-basket-line \{[^}]*border-top: 1px solid var\(--cb-border-soft\)/.test(tokens)
  && !/\.cb-customer-basket-line \{[^}]*box-shadow/.test(tokens));
check('47a. a line shows one price, not a unit price beside a line total',
  itemCard.includes('lineTotalLabel')
  && !itemCard.includes('unitPriceLabel')
  && !/each/.test(itemCard));

// --- The checkout step ----------------------------------------------------------
// The checkout answers five questions and nothing else: where am I collecting, who is
// ordering, how am I paying, anything else, what am I paying. These assertions pin the
// SHAPE — every handler, total and lifecycle call underneath is the pre-existing one.
const checkoutStepBlock = homeCode.slice(homeCode.indexOf(continueLabel));
check('48. checkout names the collection point exactly once',
  (checkoutStepBlock.match(/<CustomerPickupSummary/g) || []).length === 1
  && (homeCode.match(/<CustomerPickupSummary/g) || []).length === 2); // basket step + checkout step
check('48a. checkout does not repeat the basket contents',
  !checkoutStepBlock.includes('<CustomerBasketItemCard')
  && !checkoutStepBlock.includes('data-cb-save-usual'));
check('48b. a verified customer is stated, not re-interviewed',
  checkoutStepBlock.includes('maskedPhone(verifiedCustomer.normalisedPhone)')
  && /verifiedCustomer \? \(/.test(checkoutStepBlock)
  // The mobile input belongs to the unverified branch only.
  && !/verifiedCustomer \? \([\s\S]{0,900}placeholder="10-digit mobile number"/.test(checkoutStepBlock));
check('48c. the name stays reachable, and opens itself when it is empty',
  checkoutStepBlock.includes('editIdentity || !customerName.trim()')
  && checkoutStepBlock.includes('setEditIdentity'));
check('48d. order type is the existing handler behind compact controls',
  checkoutStepBlock.includes('handleOrderTypeChange(type)')
  && checkoutStepBlock.includes('cb-customer-choice')
  && checkoutStepBlock.includes('aria-checked={orderType === type}')
  && !checkoutStepBlock.includes('<select'));
check('48e. the note is an offer until it is wanted',
  checkoutStepBlock.includes('noteOpen || notes.trim()')
  && checkoutStepBlock.includes('Add a note (optional)')
  && checkoutStepBlock.includes('MAX_NOTE_LENGTH'));
check('48f. checkout shows one total block, fed by the same authoritative totals',
  (checkoutStepBlock.match(/<CustomerCheckoutTotalsPanel/g) || []).length === 1
  && checkoutStepBlock.includes('payableLabel={formatMoney(checkoutDisplayTotals.grandTotal)}'));
check('48g. the one action is still the existing submit handler',
  (homeCode.match(/onSubmit=\{submitOrder\}/g) || []).length === 1
  && checkoutStepBlock.includes('label={checkoutAction.label}')
  && checkoutStepBlock.includes('disabled={checkoutAction.disabled}'));
check('48h. choosing a payment method still only sets state',
  homeCode.includes('onChange={setPaymentProvider}')
  && !/setPaymentProvider\([\s\S]{0,140}(submitOrder|createCustomerCheckoutSession|openRazorpay)/i.test(homeCode));
check('48i. the OTP surface is reused, not rebuilt, and is not auto-triggered',
  (homeCode.match(/<CustomerOtpPanel/g) || []).length === 2 // checkout + My Usual sign-in
  && !/basketStep === 'CHECKOUT'[\s\S]{0,200}sendCustomerOtp/.test(homeCode));

console.log(`Customer basket/checkout UI tests passed (${passed.length} assertions).`);
