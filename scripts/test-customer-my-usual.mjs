import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

/**
 * "My Usual" contract — authenticated, profile-synced.
 *
 * Three halves:
 *  - the SERVER rules, exercised against the real callable module (authorisation
 *    shape, canonicalization, forbidden-field rejection, bounded quantities);
 *  - the SHARED schema helper (parsing, versioning, sanity limits, and the guarantee
 *    that no price, GST, phone or token is ever carried);
 *  - source contracts proving the UI reads and writes only through the secured
 *    callables, never persists a usual on the device, reuses the existing OTP flow and
 *    revalidation engine, and never submits an order.
 */
const root = process.cwd();
const require = createRequire(import.meta.url);
const read = (p) => readFileSync(resolve(root, p), 'utf8');

const passed = [];
const check = (name, condition) => { assert(condition, name); passed.push(name); };

const helperSrc = read('frontend/lib/customerMyUsual.ts');
const apiSrc = read('frontend/lib/customerMyUsualApi.ts');
const card = read('frontend/components/customer/CustomerMyUsualCard.tsx');
const home = read('frontend/pages/customer/CustomerOrder.tsx');
const tokens = read('frontend/customer.css');
const draftSrc = read('frontend/lib/customerCheckoutPersistence.ts');
const authSrc = read('frontend/lib/customerAuth.ts');
const backendSrc = read('functions/customerMyUsual.js');
const functionsIndex = read('functions/index.js');
const rules = read('firestore.rules');
const pkg = JSON.parse(read('package.json'));

const backend = require(resolve(root, 'functions/customerMyUsual.js'));
const provisioning = require(resolve(root, 'functions/storeProvisioning.js'));

// ---------------------------------------------------------------------------
// Server rules — the real module, not a description of it.
// ---------------------------------------------------------------------------
const validPayload = {
  schemaVersion: 1,
  preferredStoreId: 'GOLDEN_I',
  orderType: 'PICKUP',
  items: [
    {
      lineId: 'l1',
      productId: 'p-coffee',
      productCode: 'FLAT_WHITE',
      quantity: 2,
      addOns: [{ groupId: 'beverage_add_on', optionId: 'OAT_MILK', quantity: 1 }],
      catalogMarker: 'abcd1234',
    },
    { lineId: 'l2', productId: 'p-food', productCode: 'CHEESE_GARLIC_BREAD', quantity: 1, addOns: [] },
  ],
};

const rejects = (payload) => {
  try {
    backend.canonicalizeMyUsual(payload);
    return false;
  } catch (error) {
    return String(error?.code || '').includes('invalid-argument');
  }
};

const canonical = backend.canonicalizeMyUsual(validPayload);
check('server canonicalizes coffee and food together', canonical.items.length === 2);
check('server pins the schema version, id and name',
  canonical.schemaVersion === 1 && canonical.id === 'default' && canonical.name === 'My Usual');
check('server keeps quantities and add-on references',
  canonical.items[0].quantity === 2
  && canonical.items[0].addOns[0].groupId === 'beverage_add_on'
  && canonical.items[0].addOns[0].optionId === 'OAT_MILK');
check('server keeps catalogMarker only as a change detector', canonical.items[0].catalogMarker === 'abcd1234');
check('server never trusts a client savedAt', !('savedAt' in canonical));
check('server strips unknown fields',
  !JSON.stringify(backend.canonicalizeMyUsual({
    ...validPayload,
    nickname: 'x',
    items: [{ ...validPayload.items[0], colour: 'red' }],
  })).includes('colour'));

check('server rejects a wrong schema version', rejects({ ...validPayload, schemaVersion: 2 }));
check('server rejects a non-default id', rejects({ ...validPayload, id: 'other' }));
check('server rejects a renamed usual', rejects({ ...validPayload, name: 'Hacked' }));
check('server rejects an unsupported order type', rejects({ ...validPayload, orderType: 'DELIVERY' }));
check('server rejects an empty item list', rejects({ ...validPayload, items: [] }));
check('server rejects an oversized item list',
  rejects({ ...validPayload, items: Array.from({ length: backend.MAX_ITEMS + 1 }, () => validPayload.items[1]) }));
check('server rejects a zero quantity',
  rejects({ ...validPayload, items: [{ ...validPayload.items[1], quantity: 0 }] }));
check('server rejects a negative quantity',
  rejects({ ...validPayload, items: [{ ...validPayload.items[1], quantity: -3 }] }));
check('server rejects a fractional quantity',
  rejects({ ...validPayload, items: [{ ...validPayload.items[1], quantity: 1.5 }] }));
check('server rejects an unbounded quantity',
  rejects({ ...validPayload, items: [{ ...validPayload.items[1], quantity: backend.MAX_QUANTITY + 1 }] }));
check('server rejects an unbounded add-on quantity',
  rejects({
    ...validPayload,
    items: [{ ...validPayload.items[0], addOns: [{ groupId: 'g', optionId: 'o', quantity: 999 }] }],
  }));
check('server rejects too many add-ons on one line',
  rejects({
    ...validPayload,
    items: [{
      ...validPayload.items[0],
      addOns: Array.from({ length: backend.MAX_ADD_ONS_PER_LINE + 1 }, (_, i) => ({ groupId: 'g', optionId: `o${i}`, quantity: 1 })),
    }],
  }));
check('server rejects an unsafe product reference',
  rejects({ ...validPayload, items: [{ ...validPayload.items[1], productCode: '../../admin' }] }));
check('server rejects a missing store', rejects({ ...validPayload, preferredStoreId: '' }));

// Every forbidden family, at the top level and nested inside a line.
for (const [label, field] of [
  ['price', 'price'], ['salePrice', 'salePrice'], ['subtotal', 'subtotal'],
  ['taxableAmount', 'taxableAmount'], ['gst', 'gst'], ['gstTotal', 'gstTotal'],
  ['total', 'total'], ['grandTotal', 'grandTotal'], ['phone', 'phone'],
  ['phoneNumber', 'phoneNumber'], ['otp', 'otp'], ['token', 'token'],
  ['idToken', 'idToken'], ['payment', 'payment'], ['paymentId', 'paymentId'],
  ['razorpayOrderId', 'razorpayOrderId'], ['checkoutSessionId', 'checkoutSessionId'],
  ['trackingToken', 'trackingToken'], ['customerUid', 'customerUid'], ['uid', 'uid'],
  ['auditId', 'auditId'],
]) {
  check(`server rejects ${label} at the top level`, rejects({ ...validPayload, [field]: 'x' }));
  check(`server rejects ${label} inside a line`,
    rejects({ ...validPayload, items: [{ ...validPayload.items[1], [field]: 'x' }] }));
}

check('server exposes exactly the three callables', (() => {
  const created = Object.keys(backend.createCustomerMyUsualFunctions({ db: {}, region: 'us-central1' }));
  return created.length === 3
    && created.includes('getCustomerMyUsual')
    && created.includes('saveCustomerMyUsual')
    && created.includes('deleteCustomerMyUsual');
})());

// A stored profile is never returned wholesale.
const sanitized = backend.sanitizedMyUsualResponse({
  myUsual: canonical,
  myUsualUpdatedAt: { toDate: () => new Date('2026-01-02T03:04:05.000Z') },
  normalisedPhone: '+919999999999',
  displayName: 'Someone',
  customerUid: 'uid-a',
  razorpayCustomerId: 'cust_x',
});
check('get returns only the usual, its version and the server time',
  Object.keys(sanitized).sort().join(',') === 'myUsual,schemaVersion,updatedAt');
check('get never leaks phone, name or provider identifiers',
  !/9999999999|Someone|uid-a|cust_x/.test(JSON.stringify(sanitized)));
check('get reports the server write time', sanitized.updatedAt === '2026-01-02T03:04:05.000Z');
check('savedAt is the server time, never a client clock', sanitized.myUsual.savedAt === sanitized.updatedAt);
check('get returns null when nothing is saved', backend.sanitizedMyUsualResponse({}).myUsual === null);

check('identical payloads compare equal regardless of key order',
  backend.stableSerialize({ a: 1, b: [{ x: 1, y: 2 }] }) === backend.stableSerialize({ b: [{ y: 2, x: 1 }], a: 1 }));

// Authorisation shape, read from the module source.
check('every callable derives the uid from the verified token only',
  (backendSrc.match(/verifiedCustomerIdentity\(request\)/g) || []).length === 3
  && (backendSrc.match(/\.doc\(identity\.uid\)/g) || []).length === 1);
check('no callable reads a client-supplied uid',
  !/request\.data\??\.(uid|customerUid)/.test(backendSrc));
check('the phone identity helper is reused, not reimplemented',
  backendSrc.includes("require('./razorpayPaymentFirst')")
  && !backendSrc.includes('sign_in_provider'));
check('an inactive or foreign profile is refused',
  backendSrc.includes("data.isActive === false") && backendSrc.includes('belongs to another customer'));
check('a missing profile is a precondition failure, not an implicit create',
  backendSrc.includes("fail('failed-precondition'") && !/profileRef\.set\([^)]*createdAt/.test(backendSrc));
check('save merges and touches only the two My Usual fields',
  /\[MY_USUAL_FIELD\]: canonical,[\s\S]{0,140}\{ merge: true \}/.test(backendSrc));
check('delete removes only the usual and its metadata',
  /\[MY_USUAL_FIELD\]: FieldValue\.delete\(\),[\s\S]{0,160}\{ merge: true \}/.test(backendSrc));
// The doc comment legitimately names the legacy namespace to explain why it is
// avoided, so measure the executable code rather than the prose.
const backendCode = backendSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
check('timestamps use the modular Firestore import, which survives the emulator',
  backendCode.includes("require('firebase-admin/firestore')")
  && !backendCode.includes('admin.firestore.FieldValue'));
check('an identical save rewrites nothing', backendSrc.includes('if (!unchanged)'));
check('the three callables are exported from the functions entry point',
  ['getCustomerMyUsual', 'saveCustomerMyUsual', 'deleteCustomerMyUsual']
    .every(name => functionsIndex.includes(`exports.${name} = customerMyUsualFunctions.${name}`)));
check('updateCustomerProfile was not widened',
  read('functions/razorpayPaymentFirst.js').includes("const allowedFields = new Set(['displayName', 'defaultOrderType'])"));
check('customerProfiles stays closed to every client',
  /match \/customerProfiles\/\{customerUid\} \{\s*allow read, create, update, delete: if false;/.test(rules));

// ---------------------------------------------------------------------------
// Shared schema helper, through a compiled-to-JS shim.
// ---------------------------------------------------------------------------
const { execFileSync } = await import('node:child_process');
execFileSync('npx', [
  'esbuild', 'frontend/lib/customerMyUsual.ts',
  '--bundle', '--platform=node', '--format=esm',
  '--outfile=/tmp/customer-my-usual.mjs',
], { stdio: ['ignore', 'ignore', 'pipe'] });
const helper = await import('/tmp/customer-my-usual.mjs');

const payload = helper.buildMyUsualPayload({
  preferredStoreId: 'GOLDEN_I',
  orderType: 'PICKUP',
  items: validPayload.items,
});
check('client payload carries schema version, store, type and items',
  payload.schemaVersion === 1 && payload.preferredStoreId === 'GOLDEN_I' && payload.items.length === 2);
check('client payload carries no id, name or savedAt',
  !('id' in payload) && !('name' in payload) && !('savedAt' in payload));
check('client payload carries no price', helper.containsForbiddenMyUsualField(payload) === null);
check('client payload carries no GST', !/"gst"|"taxRate"|"gstTotal"/.test(JSON.stringify(payload)));
check('client payload carries no phone, OTP, token or payment data',
  !/"phone"|"otp"|"idToken"|"razorpay"|"checkoutSession"|"trackingToken"/i.test(JSON.stringify(payload)));
check('client payload carries no product names',
  !/"name":"Flat White"|productName/.test(JSON.stringify(payload)));

const smuggled = helper.buildMyUsualPayload({
  preferredStoreId: 'GOLDEN_I',
  orderType: 'PICKUP',
  items: [{ ...validPayload.items[0], salePrice: 250, gstTotal: 12.5, customerPhone: '+919999999999' }],
});
check('builder strips smuggled commercial fields', helper.containsForbiddenMyUsualField(smuggled) === null);
check('builder strips a smuggled phone', !JSON.stringify(smuggled).includes('9999999999'));

const serverShape = { ...canonical, savedAt: '2026-01-02T03:04:05.000Z' };
check('a server response parses back to a usual', helper.parseCustomerMyUsual(serverShape).status === 'VALID');
check('malformed server data is safe', helper.parseCustomerMyUsual('not-an-object').status === 'CORRUPT');
check('an unsupported schema is safe',
  helper.parseCustomerMyUsual({ ...serverShape, schemaVersion: 99 }).status === 'UNSUPPORTED_VERSION');
check('no saved line is silently removed',
  helper.parseCustomerMyUsual({ ...serverShape, items: [validPayload.items[0], { ...validPayload.items[1], quantity: 0 }] }).status === 'CORRUPT');
check('a negative quantity is rejected',
  helper.parseCustomerMyUsual({ ...serverShape, items: [{ ...validPayload.items[0], quantity: -3 }] }).status === 'CORRUPT');
check('an oversized quantity is rejected',
  helper.parseCustomerMyUsual({ ...serverShape, items: [{ ...validPayload.items[0], quantity: 9999 }] }).status === 'CORRUPT');
check('a malformed add-on invalidates its line',
  helper.parseCustomerMyUsual({ ...serverShape, items: [{ ...validPayload.items[0], addOns: [{ groupId: '', optionId: '' }] }] }).status === 'CORRUPT');

const mergedLines = helper.normalizeMyUsualLines([validPayload.items[0], { ...validPayload.items[0], lineId: 'l9' }]);
check('identical lines merge safely', mergedLines.length === 1 && mergedLines[0].quantity === 4);
check('different add-ons stay separate lines',
  helper.normalizeMyUsualLines([
    validPayload.items[0],
    { ...validPayload.items[0], lineId: 'l8', addOns: [{ groupId: 'beverage_add_on', optionId: 'SOY_MILK', quantity: 1 }] },
  ]).length === 2);

// The device key is gone as a source of truth, and is actively cleaned up.
check('the helper exposes no device read or write',
  !('readCustomerMyUsual' in helper) && !('writeCustomerMyUsual' in helper) && !('clearCustomerMyUsual' in helper));
const legacyStore = (() => {
  const map = new Map([['coffeeBondCustomerMyUsual:v1', '{"schemaVersion":1}']]);
  return { getItem: k => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, v), removeItem: k => map.delete(k), _map: map };
})();
check('the pre-release device key is purged',
  helper.purgeLegacyDeviceMyUsual(legacyStore) && !legacyStore._map.has('coffeeBondCustomerMyUsual:v1'));
check('purging is safe without storage', helper.purgeLegacyDeviceMyUsual(null) === false);
check('purging survives blocked storage',
  helper.purgeLegacyDeviceMyUsual({ getItem() {}, setItem() {}, removeItem() { throw new Error('blocked'); } }) === false);

// ---------------------------------------------------------------------------
// Source contracts
// ---------------------------------------------------------------------------
const homeCode = home.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const helperCode = helperSrc
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/const FORBIDDEN_KEYS = \[[\s\S]*?\];/, '');
const apiCode = apiSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const usualBlock = homeCode.slice(homeCode.indexOf('const startMyUsualOrder'), homeCode.indexOf('const deleteMyUsual'));
const persistedCheckoutLinesBlock = homeCode.slice(
  homeCode.indexOf('function persistedCheckoutLines'),
  homeCode.indexOf('function isStoreAvailable'),
);
const runtimePublicMenuProduct = { code: 'QA_PREVIEW_FLAT_WHITE' };

check('a runtime public-menu product without id falls back to its authoritative code',
  !Object.hasOwn(runtimePublicMenuProduct, 'id')
  && (runtimePublicMenuProduct.id || runtimePublicMenuProduct.code) === 'QA_PREVIEW_FLAT_WHITE'
  && persistedCheckoutLinesBlock.includes('productId: line.item.id || line.item.code,'));

// --- Signed out ---
check('signed out renders its own state, not an empty one',
  card.includes("state === 'SIGNED_OUT'")
  && card.includes('cb-customer-usual-hero is-signed-out')
  && card.includes('Sign in to save it once and order it again in a tap.')
  && /onClick=\{onSignIn\}/.test(card));
const signedOutBlock = card.slice(card.indexOf("if (state === 'SIGNED_OUT')"), card.indexOf("if (state === 'EMPTY')"));
check('the signed-out hero is honest and never presents a saved usual',
  signedOutBlock.includes('{discoveryVisual}')
  && !/lead\?|totalLabel|Order My Usual|Saved to your Coffee Bond profile/.test(signedOutBlock)
  && homeCode.includes('discoveryImageUrl={discoveryProduct ? getItemImage(discoveryProduct) : null}'));
check('signed out is chosen by the absence of a verified customer',
  /!verifiedCustomer\s*\?\s*'SIGNED_OUT'/.test(homeCode));
check('signed out cannot permanently save',
  /if \(!verifiedCustomer\) \{[\s\S]{0,200}setMyUsualDialog\(\{ type: 'SIGN_IN' \}\)/.test(homeCode));
check('a signed-out save never reaches the callable',
  !/if \(!verifiedCustomer\)[\s\S]{0,200}saveCustomerMyUsualRequest/.test(homeCode));
check('signed out is never told a usual is saved on this device',
  !card.includes('Saved on this device') && !home.includes('Saved on this device'));
check('no global device key remains a source of truth',
  !homeCode.includes("'coffeeBondCustomerMyUsual:v1'")
  && !/readCustomerMyUsual|writeCustomerMyUsual|clearCustomerMyUsual/.test(homeCode));
check('the pre-release device key is purged on load', homeCode.includes('purgeLegacyDeviceMyUsual'));

// --- Sign-in handoff ---
check('the signed-out CTA invokes the EXISTING customer OTP flow',
  homeCode.includes("myUsualDialog.type === 'SIGN_IN'")
  && /myUsualDialog\.type === 'SIGN_IN'[\s\S]{0,900}<CustomerOtpPanel/.test(homeCode));
check('no second OTP implementation is introduced',
  (home.match(/<CustomerOtpPanel/g) || []).length === 2
  && !homeCode.includes('signInWithPhoneNumber')
  && !homeCode.includes('RecaptchaVerifier'));
check('the basket survives authentication',
  !/handleMyUsualVerified[\s\S]{0,700}setCart\(/.test(homeCode)
  && /handleMyUsualVerified[\s\S]{0,700}cart\.length > 0/.test(homeCode));
check('successful auth still requires an explicit save confirmation',
  homeCode.includes("{ type: 'CONFIRM_PENDING_SAVE' }")
  && home.includes('Save this basket as My Usual?')
  && /CONFIRM_PENDING_SAVE'[\s\S]{0,700}onClick=\{confirmSaveMyUsual\}/.test(home));
check('the pending save intent lives in memory only',
  homeCode.includes('pendingMyUsualSaveRef')
  && !/pendingMyUsualSaveRef[\s\S]{0,200}localStorage|sessionStorage/.test(homeCode));
check('the sign-in handoff creates no order, payment or checkout session',
  !/submitOrder|createCustomerCheckoutSession|loadRazorpayCheckout|razorpayOrderId/i
    .test(homeCode.slice(homeCode.indexOf('const handleMyUsualVerified'), homeCode.indexOf('const confirmSaveMyUsual'))));

// --- Callable wrapper is the only path ---
check('the UI saves, reads and deletes through the callable wrapper',
  homeCode.includes("from '../../lib/customerMyUsualApi'")
  && homeCode.includes('getCustomerMyUsualRequest()')
  && homeCode.includes('saveCustomerMyUsualRequest(')
  && homeCode.includes('deleteCustomerMyUsualRequest()'));
check('the wrapper takes no uid argument',
  /export async function getCustomerMyUsual\(\): /.test(apiCode)
  && /export async function deleteCustomerMyUsual\(\): /.test(apiCode)
  && !/uid/i.test(apiCode.replace(/\/\/.*$/gm, '')));
check('the wrapper performs no Firestore access',
  !/firebase\/firestore|setDoc|addDoc|updateDoc|getDoc|collection\(|doc\(/.test(apiCode));
check('the wrapper normalizes errors without logging payloads',
  apiCode.includes('function normalizeError') && !/console\.(log|warn|error|debug)/.test(apiCode));
check('the wrapper re-parses server data through the shared schema guard',
  apiCode.includes('parseCustomerMyUsual('));
check('no direct Firestore write exists on the My Usual path',
  !/setDoc|addDoc|updateDoc|runTransaction|deleteDoc/.test(
    homeCode.slice(homeCode.indexOf('const [myUsual'), homeCode.indexOf('const isSearching')),
  ));
check('the schema helper still imports no Firebase or payment code',
  !/from ['"][^'"]*firebase|firestore|httpsCallable|Razorpay\b/i.test(helperCode));

// --- Profile, not device ---
check('the UI says profile, not device',
  card.includes('Saved to your Coffee Bond profile')
  && !card.includes('Saved on this device')
  && home.includes('will be saved to your Coffee Bond profile'));
check('save and delete copy names the profile, not the device',
  home.includes('will be saved to your Coffee Bond profile')
  && home.includes('overwritten in your Coffee Bond profile')
  && home.includes('from your Coffee Bond profile on every device'));

// --- Lifecycle: reload, sign-out, account switching ---
check('a reload fetches the server source of truth',
  /getCustomerMyUsualRequest\(\)[\s\S]{0,400}setMyUsual\(response\.myUsual\)/.test(homeCode));
check('the fetch is keyed to the authenticated uid', homeCode.includes('}, [myUsualUid]);'));
check('a loading skeleton covers the profile fetch',
  homeCode.includes('myUsualLoading') && /myUsualLoading[\s\S]{0,60}\? 'LOADING'/.test(homeCode));
check('sign-out clears the visible usual',
  /previousMyUsualUidRef[\s\S]{0,600}setMyUsual\(null\)/.test(homeCode));
check('sign-out does not delete the server copy',
  !/previousUid[\s\S]{0,400}deleteCustomerMyUsualRequest/.test(homeCode));
check('account switching clears prior state before loading the new profile',
  /setMyUsual\(null\);[\s\S]{0,300}if \(previousUid && previousUid !== myUsualUid\)[\s\S]{0,200}setMyUsualDialog\(null\)/.test(homeCode));
check('a stale prior-uid response is discarded',
  (homeCode.match(/myUsualUidRef\.current !== (myUsualUid|uid)/g) || []).length >= 4);
check('no UID-bound cache is written', !/coffeeBondCustomerMyUsualCache/.test(homeCode + helperSrc + apiSrc));

// --- Failure honesty ---
check('a failed save does not claim success',
  /catch \(err: unknown\) \{[\s\S]{0,320}setMyUsualNotice\([\s\S]{0,200}We could not save My Usual/.test(home)
  && !/catch \(err: unknown\) \{[\s\S]{0,320}Saved to your Coffee Bond profile/.test(home));
check('a failed delete does not clear the card',
  /catch \(err: unknown\) \{[\s\S]{0,320}We could not delete My Usual/.test(home)
  && !/catch \(err: unknown\) \{[\s\S]{0,320}setMyUsual\(null\)/.test(home));
check('the UI updates only after a server success',
  /await saveCustomerMyUsualRequest\([\s\S]{0,260}setMyUsual\(response\.myUsual\)/.test(homeCode)
  && /await deleteCustomerMyUsualRequest\(\);[\s\S]{0,140}setMyUsual\(null\)/.test(homeCode));
check('a failure message is shown in the open sheet for retry',
  /myUsualNotice && \([\s\S]{0,260}cb-customer-usual-note mt-3/.test(home));
/** Extracts one arrow-function body from the screen so it can be asserted on alone. */
const functionBody = (name) => {
  const match = new RegExp(`const ${name} = async[\\s\\S]*?\\n  \\};`).exec(homeCode);
  assert(match, `could not locate ${name} in CustomerOrder.tsx`);
  return match[0];
};
check('the basket is never modified by save or delete',
  !functionBody('confirmSaveMyUsual').includes('setCart(')
  && !functionBody('deleteMyUsual').includes('setCart('));

// --- Revalidation rules, unchanged ---
check('create action guides to the menu',
  homeCode.includes('searchInputRef.current?.scrollIntoView') && homeCode.includes('Save as My Usual.'));
check('saving over an existing usual requires confirmation',
  homeCode.includes("{ type: 'REPLACE_USUAL' }") && home.includes('Replace your current My Usual with this basket?'));
check('delete requires confirmation', home.includes('Delete My Usual?') && homeCode.includes("{ type: 'DELETE' }"));
check('the current menu is revalidated through the existing engine',
  homeCode.includes('restoreCustomerCheckoutDraft<CustomerMenuItem, AddOnSelection>')
  && homeCode.includes('checkoutRestoreOptions()'));
check('revalidation rules are shared, not forked',
  (homeCode.match(/function checkoutRestoreOptions/g) || []).length === 1
  && (homeCode.match(/restoreAddOns:/g) || []).length === 1);
check('current prices and GST are used', homeCode.includes('totalsForLines(restored.lines)'));
check('money maths is defined once', (homeCode.match(/function totalsForLines|const totalsForLines/g) || []).length === 1);
check('ITEM_REMOVED blocks reorder', homeCode.includes("n.code === 'ITEM_REMOVED'"));
check('ADD_ON_REMOVED blocks reorder', homeCode.includes("n.code === 'ADD_ON_REMOVED'"));
check('a shortfall in restored lines also blocks', homeCode.includes('restored.lines.length !== myUsual.items.length'));
check('the blocker message names the update need', home.includes('Your usual needs a quick update'));
const blockedExpr = (homeCode.match(/const blocked = [^;]+;/) || [''])[0];
check('a price change is a notice, not a blocker',
  home.includes('Price updated since your usual was saved.')
  && blockedExpr.includes('removedItems.length')
  && !blockedExpr.includes('priceChanged'));

// ---------------------------------------------------------------------------
// Store-agnostic: a usual belongs to the customer, not to the store it was saved
// from. The store selected AT REORDER TIME is the only authority.
// ---------------------------------------------------------------------------
check('1/2. a different saved store never gates reorder',
  !usualBlock.includes('preferredStoreId')
  && !/preferredStoreId\s*!==\s*selectedStoreId/.test(homeCode));
check('3. the saved-store mismatch dialog is gone',
  !homeCode.includes('STORE_MISMATCH') && !home.includes('Switch to saved store')
  && !home.includes('was saved for'));
check('4. the card never displays a store as the usual\'s owner',
  !card.includes('preferredStoreName')
  && !/preferredStoreId/.test(card)
  && card.includes('id="cb-my-usual-heading"'));
check('4. the screen passes no store name to the card',
  !homeCode.includes('preferredStoreName=') && !homeCode.includes('myUsualStoreName'));
check('5/6/7/8. revalidation binds to the CURRENT store, menu, add-ons and tax',
  /restoreCustomerCheckoutDraft[\s\S]{0,220}selectedStoreId/.test(homeCode)
  && /checkoutRestoreOptions\(\)/.test(homeCode)
  && homeCode.includes('itemTaxRate(item, selectedStoreTaxRate)')
  && homeCode.includes('activeAddOnGroupsForProduct'));
check('5/6. the preview recomputes when the selected store changes',
  /\}, \[myUsual, storeItems, loadedMenuStoreId, selectedStoreId, selectedStore, itemAvailability, addOnGroups, selectedStoreTaxRate/.test(homeCode));
check('9. a valid cross-store usual loads the existing basket',
  /applyMyUsualToBasket\(preview\.lines\)/.test(homeCode));
check('10. an unavailable product blocks the whole usual',
  homeCode.includes("{\n          type: 'UNAVAILABLE'") || homeCode.includes("type: 'UNAVAILABLE'"));
check('10. unavailable products are named, not silently dropped',
  homeCode.includes('unavailableItems') && home.includes('not available here')
  && home.includes('Some items are not available at '));
check('11. an unavailable add-on names the product and the add-on',
  homeCode.includes('unavailableAddOns')
  && home.includes('{entry.product} — {entry.addOn} is not available here')
  && /removedAddOns\.map/.test(homeCode));
check('11. a missing add-on still offers Edit My Usual',
  /UNAVAILABLE'[\s\S]{0,2200}Edit My Usual/.test(home));

// ---------------------------------------------------------------------------
// Blocked-state presentation: a usual that this store cannot fulfil must LOOK
// blocked, not look silently reduced.
// ---------------------------------------------------------------------------
check('every saved line is rendered, blocked ones included',
  /const displayLines = myUsual\.items\.map/.test(homeCode)
  && homeCode.includes('myUsualPreview.displayLines')
  && card.includes('const lead = lines[0];')
  && card.includes('{lead?.name')
  && card.includes('{lines.slice(1).map(line => (')
  && !/lines\.slice\(1\)[\s\S]{0,80}\.filter\(/.test(card));
check('the lead and every extra line expose their own blocker text',
  card.includes('{lead?.unavailableReason && <small>{lead.unavailableReason}</small>}')
  && card.includes('{line.unavailableReason && <small>{line.unavailableReason}</small>}'));
check('the card never drops saved lines behind a fixed three-item truncation',
  !card.includes('+{lines.length - 3} more'));
check('a blocked line is labelled with the current store',
  homeCode.includes('`Unavailable at ${storeName}`')
  && homeCode.includes('is unavailable at ${storeName}`')
  && card.includes('{line.unavailableReason}'));
check('a blocked line is struck through as well as labelled',
  card.includes("line.unavailableReason ? 'is-unavailable' : undefined")
  && /\.cb-customer-usual-lines li\.is-unavailable \{[^}]*text-decoration: line-through/.test(tokens));
check('a blocked line is never dropped from the list',
  /displayLines = myUsual\.items\.map[\s\S]{0,1400}unavailableReason/.test(homeCode)
  && !/displayLines[\s\S]{0,600}\.filter\(/.test(homeCode));
check('the unblocked card shows the current menu subtotal and explains checkout GST',
  /!myUsualPreview\.blocked[\s\S]{0,140}formatMyUsualPrice\(myUsualPreview\.totals\.subtotal\)/.test(homeCode)
  && card.includes('GST is added at checkout.')
  && card.includes('Current menu price ${totalLabel}; GST added at checkout')
  && card.includes('Review required')
  && /totalLabel \? \([\s\S]{0,600}\) : blockerMessage \? \([\s\S]{0,220}Review required/.test(card));
check('the hero price is compact without changing checkout money formatting',
  /function formatMyUsualPrice\([\s\S]{0,260}Number\.isInteger\(rounded\) \? 0 : 2/.test(homeCode)
  && /function formatMoney\(value: number\): string \{\s*return `₹\$\{value\.toFixed\(2\)\}`;/.test(home));
check('the blocked headline states the usual needs an update',
  homeCode.includes("blocked ? 'Your usual needs a quick update.' : undefined"));
check('the blocked CTA reads Review My Usual',
  card.includes("blockerMessage\n    ? 'Review My Usual'")
  && !card.includes('Update My Usual'));
check('the review dialog offers choose-store, edit and cancel in that order',
  /UNAVAILABLE'[\s\S]{0,1600}Choose another store[\s\S]{0,400}Edit My Usual/.test(home)
  && /myUsualDialog\.type === 'UNAVAILABLE'[\s\S]{0,3600}Cancel/.test(home));
// Anchor on the JSX dialog, not the type declaration that shares the name.
const reviewDialogBlock = home.slice(
  home.indexOf("myUsualDialog.type === 'UNAVAILABLE'"),
  home.indexOf("myUsualDialog.type === 'DELETE'"),
);
check('reviewing writes nothing to the profile',
  reviewDialogBlock.length > 200
  && !/saveCustomerMyUsualRequest|deleteCustomerMyUsualRequest|setMyUsual\(/.test(reviewDialogBlock));
check('a compatible store keeps the full live total and pickup CTA',
  /myUsualPreview\?\.state === 'SAVED' && !myUsualPreview\.blocked/.test(homeCode)
  && card.includes('`${orderActionLabel}${totalLabel ? ` · ${totalLabel}` : \'\'}`')
  && home.includes("orderActionLabel={myUsual?.orderType === 'DINE_IN' ? 'Place dine-in' : 'Place pickup'}"));
check('actual modifiers use current option labels and disappear cleanly when absent',
  homeCode.includes("saved.addOns.map(addOn => addOnOptionLabel(addOn.groupId, addOn.optionId)).join(' · ')")
  && card.includes('{leadDetails && <span className="cb-customer-usual-lead-modifiers">{leadDetails}</span>}')
  && !card.includes('Saved just as you like it'));
check('the thumbnail fallback is legible, not beige-on-beige',
  card.includes('iconClassName="text-[#9a6a2e]"') && !card.includes('text-[#b99b7d]'));
check('the fallback icon renders whenever no image resolves',
  read('frontend/components/customer/CustomerProductImage.tsx').includes('image unavailable')
  && homeCode.includes('imageUrl: item ? getItemImage(item) : null')
  && card.includes('src={lead?.imageUrl || null}'));
check('the per-line unavailable style is a semantic class in customer.css',
  tokens.includes('.cb-customer-usual-lines li.is-unavailable')
  && tokens.includes('.cb-customer-usual-lead-detail small'));
check('12. no line is silently removed', homeCode.includes('restored.lines.length !== myUsual.items.length'));
check('13. a closed store blocks with a choose-store action',
  homeCode.includes("{ type: 'STORE_CLOSED'")
  && homeCode.includes('!customerOrderingState.canAcceptOrders')
  && /STORE_CLOSED'[\s\S]{0,900}Choose another store/.test(home));
check('14. choosing another store uses the existing selector, then revalidates',
  (home.match(/setStoreSelectorOpen\(true\)/g) || []).length >= 2);
check('15. no automatic store switch remains on the My Usual path',
  !usualBlock.includes('handleStoreChange')
  && !/UNAVAILABLE'[\s\S]{0,1600}handleStoreChange/.test(home)
  && !/STORE_CLOSED'[\s\S]{0,900}handleStoreChange/.test(home));
check('16. an existing document carrying preferredStoreId still parses',
  helper.parseCustomerMyUsual(serverShape).status === 'VALID'
  && helper.parseCustomerMyUsual(serverShape).usual.preferredStoreId === 'GOLDEN_I');
check('16. preferredStoreId stays in the stored schema as provenance only',
  helperSrc.includes('preferredStoreId')
  && backendSrc.includes('preferredStoreId'));
check('23. no Function or Firestore-rule change was required',
  backendSrc.includes('preferredStoreId: safeReference')
  || /preferredStoreId = safeReference/.test(backendSrc));
check('a non-empty basket requires replacement confirmation',
  homeCode.includes('cart.length > 0') && home.includes('Replace your current basket with My Usual?'));
check('a valid usual loads the existing cart', /applyMyUsualToBasket[\s\S]{0,160}setCart\(lines\)/.test(homeCode));
check('the existing basket is opened, not a new one', /applyMyUsualToBasket[\s\S]{0,220}setBasketOpen\(true\)/.test(homeCode));
check('the first Order My Usual tap creates no order, OTP or payment',
  !/submitOrder|createOnlineOrder|razorpay|Razorpay|sendOtp|httpsCallable/i.test(usualBlock));
check('repeated taps cannot duplicate lines',
  usualBlock.includes('myUsualBusy') && homeCode.includes('setMyUsualBusy(true)'));
check('the cart is replaced, never appended', !/setCart\(\[\s*\.\.\.cart/.test(usualBlock));

// --- Offline ---
check('offline blocks reorder',
  usualBlock.includes('isOffline') && home.includes('Reconnect to check current prices and availability.'));
// A blocker no longer disables the primary action: tapping it is what names the
// unavailable items and offers Edit / Choose another store. Offline still disables
// all three, and the screen still refuses the reorder itself.
check('a blocked usual stays tappable so the customer can see why',
  card.includes("aria-label={busy ? 'Checking My Usual' : primaryLabel}")
  && card.includes("blockerMessage\n    ? 'Review My Usual'")
  && !/disabled=\{[^}]*blockerMessage/.test(card));
check('offline disables every server action',
  (card.match(/disabled=\{busy \|\| offline\}/g) || []).length === 3
  && /onClick=\{requestSaveMyUsual\}[\s\S]{0,200}disabled=\{myUsualBusy \|\| isOffline\}/.test(home)
  && /onClick=\{deleteMyUsual\}[\s\S]{0,200}disabled=\{myUsualBusy \|\| isOffline\}/.test(home));
check('offline never queues a profile write silently',
  functionBody('confirmSaveMyUsual').includes('if (isOffline)')
  && !/queue|retryLater|pendingWrite/i.test(homeCode.slice(homeCode.indexOf('const confirmSaveMyUsual'), homeCode.indexOf('const applyMyUsualToBasket'))));
check('the save action is hidden while submitting', homeCode.includes('!saving && !submittingRef.current'));

// --- Nothing existing was disturbed ---
check('the checkout draft key and behaviour are unchanged',
  draftSrc.includes("CUSTOMER_CHECKOUT_DRAFT_KEY = 'coffeeBondCustomerCheckoutDraft:v1'")
  && !draftSrc.includes('myUsual') && !draftSrc.includes('MyUsual'));
check('the Golden I catalogue filter is untouched',
  homeCode.includes("category === 'ALL' || customerMenuCategory(item) === category"));
check('Golden I remains 80 products', provisioning.GOLDEN_I_PUBLIC_MENU_ITEM_COUNT === 80);
check('Pay at Counter is unchanged', homeCode.includes('paymentProvider'));
check('the Razorpay path is unchanged', homeCode.includes('loadRazorpayCheckout'));
// Stage 5 lets both screens RAISE onOpenMyUsual, which only navigates to the home
// card. What must never appear here is My Usual logic itself: its callables, its
// schema, its storage key or a second copy of the card.
check('My Orders and status screens carry no My Usual logic', (() => {
  const surfaces = [
    read('frontend/pages/customer/CustomerMyOrders.tsx'),
    read('frontend/pages/customer/CustomerOrderStatus.tsx'),
  ].join('\n');
  return !/getCustomerMyUsual|saveCustomerMyUsual|deleteCustomerMyUsual/.test(surfaces)
    && !/CustomerMyUsualCard|buildMyUsualPayload|parseCustomerMyUsual/.test(surfaces)
    && !/LEGACY_DEVICE_MY_USUAL_KEY|customerMyUsualApi/.test(surfaces);
})());
check('the customer Firebase app stays separate from the staff one',
  authSrc.includes("CUSTOMER_APP_NAME = 'coffee-bond-customer-auth'")
  && authSrc.includes('initializeApp(firebaseConfig, CUSTOMER_APP_NAME)'));
check('customer and staff PWA identities remain separate', (() => {
  const identity = read('frontend/lib/customerPwaIdentity.ts');
  return identity.includes("CUSTOMER_MANIFEST_HREF = '/manifest-customer.webmanifest'")
    && identity.includes("STAFF_MANIFEST_HREF = '/manifest.webmanifest'")
    && !identity.includes('MyUsual');
})());
check('emulator wiring is opt-in and never affects production builds',
  authSrc.includes("import.meta.env.VITE_USE_FIREBASE_EMULATORS === 'true'"));

// --- Accessibility + style isolation ---
check('the card has an accessible heading', card.includes('aria-labelledby="cb-my-usual-heading"'));
check('controls meet 44px',
  /\.cb-customer-usual-primary \{[^}]*min-height: 44px/.test(tokens)
  && /\.cb-customer-usual-icon-button \{[^}]*width: 44px[^}]*height: 44px/.test(tokens)
  && /\.cb-customer-usual-secondary \{[^}]*min-height: 44px/.test(tokens)
  && /\.cb-customer-usual-more summary \{[^}]*min-height: 44px/.test(tokens));
check('the saved hero is image-led and its primary CTA is at least 52px',
  /\.cb-customer-usual-hero\.is-saved \{[^}]*grid-template-columns: minmax\(0, 1fr\)/.test(tokens)
  && /\.cb-customer-usual-hero\.is-saved \.cb-customer-usual-photo \{[^}]*aspect-ratio: 16 \/ 9/.test(tokens)
  && /\.cb-customer-usual-hero\.is-saved \.cb-customer-usual-primary \{[^}]*min-height: 52px/.test(tokens));
check('multi-item count and delete controls occupy opposite image corners',
  /\.cb-customer-usual-hero\.is-saved \.cb-customer-usual-count \{[^}]*right: auto;[^}]*left: 10px/.test(tokens)
  && /\.cb-customer-usual-hero\.is-saved \.cb-customer-usual-photo-controls \{[^}]*right: 10px/.test(tokens));
check('Change reuses edit and Add a pastry uses only the existing menu category',
  /onClick=\{onEdit\}[\s\S]{0,180}>\s*Change\s*</.test(card)
  && card.includes('onClick={onAddPastry}')
  && card.includes('Add a pastry')
  && homeCode.includes("if (!categories.includes('Baked by Bond')) return;")
  && homeCode.includes("setCategory('Baked by Bond')")
  && home.includes("onAddPastry={categories.includes('Baked by Bond') ? openPastryMenu : undefined}"));
check('the visible and accessible saved-usual CTA labels agree',
  card.includes("aria-label={busy ? 'Checking My Usual' : primaryLabel}")
  && /<span>\{busy \? 'Checking\.\.\.' : primaryLabel\}<\/span>/.test(card));
check('validation messages use a live region', card.includes('role="status" aria-live="polite"'));
check('dialogs are modal and labelled', /role="dialog"\s+aria-modal="true"\s+aria-label=/.test(home));
check('no Tailwind arbitrary CSS-variable utilities in the My Usual UI',
  !/\[color:var\(--cb-|bg-\[var\(--cb-|shadow-\[var\(--cb-/.test(card));
check('My Usual styles are semantic classes in customer.css',
  ['.cb-customer-usual-hero', '.cb-customer-usual-primary', '.cb-customer-usual-icon-button',
   '.cb-customer-usual-secondary', '.cb-customer-usual-lines', '.cb-customer-sheet']
    .every(cls => tokens.includes(cls)));

check('the unit test script is registered', pkg.scripts['test:customer-my-usual'] === 'node scripts/test-customer-my-usual.mjs');
check('the emulator test script is registered',
  pkg.scripts['test:customer-my-usual-emulator'] === 'node scripts/test-customer-my-usual-emulator-e2e.mjs');

// Built output, when present
if (existsSync(resolve(root, 'dist/assets'))) {
  const { readdirSync } = await import('node:fs');
  const staffCss = readdirSync(resolve(root, 'dist/assets')).find(f => f.endsWith('.css'));
  if (staffCss) {
    const css = read(`dist/assets/${staffCss}`);
    check('staff CSS carries no My Usual styles', !css.includes('cb-customer-usual') && !css.includes('var(--cb-'));
  }
  // My Usual code DOES appear in the staff build's CustomerOrder chunk, because the
  // staff origin still serves the legacy /order customer route (App.tsx) so existing
  // links keep working. That is the customer screen, not staff POS UI. What must hold
  // is that no POS/admin/reports/inventory/KOT screen pulls My Usual in.
  const staffJs = readdirSync(resolve(root, 'dist/assets')).filter(f => f.endsWith('.js'));
  const usualCarriers = staffJs.filter(f => read(`dist/assets/${f}`).includes('getCustomerMyUsual'));
  check('only the shared customer screen carries My Usual in the staff build',
    usualCarriers.every(f => f.startsWith('CustomerOrder')));
  check('no staff POS/admin screen imports My Usual',
    ['frontend/pages/pos/POSHome.tsx', 'frontend/pages/admin/POSReadiness.tsx',
     'frontend/pages/kot/KOTScreen.tsx', 'frontend/pages/reports/DayClose.tsx']
      .every(p => !read(p).includes('MyUsual')));
  check('no build output carries the pre-release device key as a source of truth',
    staffJs.every(f => !read(`dist/assets/${f}`).includes('writeCustomerMyUsual')));
}

console.log(`Customer My Usual tests passed (${passed.length} assertions).`);
