import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const read = path => readFileSync(resolve(root, path), 'utf8');
const code = source => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const home = code(read('frontend/pages/customer/CustomerOrder.tsx'));
const panel = code(read('frontend/components/customer/CustomerBondRedemptionPanel.tsx'));
const totals = code(read('frontend/components/customer/CustomerCheckoutTotalsPanel.tsx'));
const checkoutTypes = code(read('frontend/lib/razorpayCheckout.ts'));
const publicTracking = code(read('frontend/lib/publicOrderTracking.ts'));
const tracking = code(read('frontend/components/customer/CustomerTrackingScreen.tsx'));
const types = code(read('frontend/types.ts'));
const myOrders = code(read('frontend/pages/customer/CustomerMyOrders.tsx'));
const orderScreen = code(read('frontend/components/customer/CustomerOrdersScreen.tsx'));
const orderCard = code(read('frontend/components/customer/CustomerOrderCard.tsx'));

const passed = [];
const check = (name, condition) => { assert(condition, name); passed.push(name); };

check('1. redemption is gated to a real verified Razorpay customer and the server flag',
  home.includes('!demoRequested')
  && home.includes("paymentProvider === 'RAZORPAY'")
  && home.includes('displayedBondSummary.redemptionEnabled')
  && home.includes('&& verifiedCustomer'));
check('2. the panel is absent outside that gate',
  home.includes('{bondRedemptionEligible && (')
  && (home.match(/<CustomerBondRedemptionPanel/g) || []).length === 1);
check('3. the existing authenticated Functions instance owns quote and release',
  home.includes("'quoteCustomerBondRedemption'")
  && home.includes("'releaseCustomerCheckoutSession'"));
check('4. quote input contains product references and requested points, never a client discount',
  home.includes('items: razorpayCheckoutItems')
  && home.includes('bondRedemptionPoints,')
  && !/quoteCustomerBondRedemption\([\s\S]{0,600}(discount|grandTotal|gstTotal|taxableAmount)\s*:/.test(home));
check('5. no client code converts points to money',
  !/pointValuePaise\s*[*\/+-]|bondRedemptionPoints\s*[*\/]/.test(home + panel));
check('6. quote identity includes the authenticated UID and complete checkout request',
  home.includes("customerUid: verifiedCustomer?.customerUid || ''")
  && home.includes('request: bondRedemptionQuoteRequest'));
check('7. cart, store, auth and provider changes invalidate or re-request the quote',
  home.includes('items: razorpayCheckoutItems')
  && home.includes('storeId: selectedStore.id')
  && home.includes('verifiedCustomer?.customerUid')
  && home.includes("paymentProvider === 'RAZORPAY'")
  && home.includes('setBondRedemptionQuoteFingerprint(null)'));
check('8. stale/loading quotes disable checkout',
  home.includes("bondRedemptionQuoteStatus === 'LOADING'")
  && home.includes("reason: 'Updating your BOND redemption quote.'")
  && home.includes('bondRedemptionPoints > 0 && !bondRedemptionQuoteCurrent'));
check('9. point controls expose balance, maximum, minimum and increments',
  panel.includes('quote.availablePoints')
  && panel.includes('quote.maximumUsablePoints')
  && panel.includes('policy.minimumPoints')
  && panel.includes('policy.incrementPoints'));
check('10. controls choose points only; the server quote owns every displayed amount',
  panel.includes('onSelectedPointsChange')
  && !/formatMoney|discount|gstTotal|grandTotal|taxableAmount/.test(panel));
check('11. basket and checkout totals use the current quote as one object',
  home.includes('const checkoutDisplayTotals = bondRedemptionPoints > 0 && bondRedemptionQuoteCurrent')
  && (home.match(/subtotalLabel=\{formatMoney\(checkoutDisplayTotals\.subtotal\)\}/g) || []).length === 2
  && (home.match(/payableLabel=\{formatMoney\(checkoutDisplayTotals\.grandTotal\)\}/g) || []).length === 2);
check('12. the named negative redemption row is explicit and optional',
  home.includes('discountName={checkoutDiscountName}')
  && home.includes('discountLabel={checkoutDiscountLabel}')
  && totals.includes('{discountName}')
  && totals.includes('{discountLabel && ('));
check('13. CTA uses the current quote payable',
  /payLabel = paymentProvider === 'RAZORPAY'[\s\S]{0,240}formatMoney\(checkoutDisplayTotals\.grandTotal\)/.test(home));
check('14. requested points participate in browser idempotency and session creation',
  home.includes('`BOND:${bondRedemptionPoints}`')
  && /createCustomerCheckoutSession\(\{[\s\S]{0,500}bondRedemptionPoints/.test(home));
check('15. the session response must confirm the same selected points',
  checkoutTypes.includes('bondRedemption?: BondRedemptionQuote')
  && home.includes('validateBondRedemptionQuote(checkoutResult.bondRedemption)')
  && home.includes('checkoutResult.bondRedemption.selectedPoints !== bondRedemptionPoints'));
check('16. modal dismiss and payment failure release best-effort with distinct reasons',
  home.includes("'CHECKOUT_DISMISSED'")
  && home.includes("'PAYMENT_FAILED'")
  && home.includes('releaseCheckoutSessionBestEffort(checkoutResult.sessionId!'));
check('17. public order types carry only immutable order-level redemption fields',
  (types.match(/bondRedemptionPoints\?: number/g) || []).length >= 2
  && (types.match(/bondRedemptionDiscount\?: number/g) || []).length >= 2
  && types.includes('discountLabel?: string'));
check('18. public projection copies and protects all redemption fields',
  publicTracking.includes('bondRedemptionPoints: Number(onlineOrder.bondRedemptionPoints)')
  && publicTracking.includes("discountLabel: onlineOrder.discountLabel || 'BOND Points Redemption'")
  && publicTracking.includes("'bondRedemptionPoints' | 'bondRedemptionDiscount' | 'discountLabel'"));
check('19. tracking shows the named negative redemption without changing order status',
  tracking.includes("order.discountLabel || 'BOND Points Redemption'")
  && tracking.includes('−{formatMoney(Number(order.bondRedemptionDiscount || 0))}')
  && !/bondRedemption[\s\S]{0,120}publicStatus\s*=/.test(tracking));
check('20. authenticated history carries the same immutable disclosure',
  myOrders.includes('bondRedemptionPoints')
  && myOrders.includes('bondRedemptionDiscountLabel')
  && orderScreen.includes('bondRedemptionDiscountLabel={order.bondRedemptionDiscountLabel ?? null}')
  && orderCard.includes("bondRedemptionLabel || 'BOND Points Redemption'")
  && orderCard.includes('−{bondRedemptionDiscountLabel}'));

console.log(`Customer BOND redemption UI contract tests passed (${passed.length}/${passed.length}).`);
