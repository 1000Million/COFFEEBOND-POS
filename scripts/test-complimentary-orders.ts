import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  buildComplimentaryTotals,
  COMPLIMENTARY_PHONE_PROVIDER,
  complimentaryOrderMenuValue,
  isComplimentaryOrder,
  isComplimentaryVerificationExpired,
  isValidIndianMobile,
  normalizeIndianPhoneE164,
  receiptLegalDetailsFromStore,
  retainVerificationForPhone,
  summarizeComplimentaryOrders,
  validateComplimentaryCheckout,
} from '../frontend/lib/complimentaryOrders';
import type { Order, Store } from '../frontend/types';

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

const totals = buildComplimentaryTotals(225);
assert(totals.subtotal === 225, 'Menu value must remain available for audit.');
assert(totals.discountPercent === 100 && totals.discountAmount === 225, 'Complimentary discount must equal menu value.');
assert(totals.taxableAmount === 0 && totals.taxTotal === 0 && totals.grandTotal === 0, 'Complimentary taxable, GST, and payable values must be zero.');

assert(isValidIndianMobile('9999999999'), 'Valid Indian mobile should pass.');
assert(!isValidIndianMobile('1234567890'), 'Mobile numbers must start with 6-9.');
assert(!isValidIndianMobile('99999'), 'Short mobile must fail.');

const missingFields = validateComplimentaryCheckout({
  customerName: '',
  customerPhone: '123',
  reason: '',
  verification: null,
});
assert(missingFields.some(error => error.includes('Customer name')), 'Customer name must be mandatory.');
assert(missingFields.some(error => error.includes('10-digit')), 'Valid phone must be mandatory.');
assert(missingFields.some(error => error.includes('reason')), 'Reason must be mandatory.');
assert(missingFields.some(error => error.includes('OTP verification')), 'Missing server authorization must block complimentary checkout.');

const verification = {
  authorizationId: 'server-issued-authorization',
  provider: COMPLIMENTARY_PHONE_PROVIDER,
  verifiedPhone: '9999999999',
  expiresAtIso: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
};
assert(retainVerificationForPhone(verification, '9999999999') === verification, 'Unchanged phone should retain verification.');
assert(retainVerificationForPhone(verification, '9888888888') === null, 'Changing phone must invalidate OTP verification.');
assert(normalizeIndianPhoneE164('9999999999') === '+919999999999', 'Indian mobile must normalize to E.164.');
assert(normalizeIndianPhoneE164('+91 99999 99999') === '+919999999999', 'Existing +91 prefix must normalize safely.');
assert(normalizeIndianPhoneE164('123') === null, 'Invalid phone must not normalize.');
assert(!isComplimentaryVerificationExpired(verification), 'Fresh server authorization must be accepted.');
assert(validateComplimentaryCheckout({
  customerName: 'Test Customer',
  customerPhone: '9999999999',
  reason: 'Owner approved',
  verification,
}).length === 0, 'Fresh matching server authorization must permit the zero-value complimentary flow.');
const expiredVerification = { ...verification, expiresAtIso: new Date(Date.now() - 1_000).toISOString() };
assert(isComplimentaryVerificationExpired(expiredVerification), 'Expired server authorization must be rejected.');
assert(validateComplimentaryCheckout({
  customerName: 'Test Customer',
  customerPhone: '9999999999',
  reason: 'Owner approved',
  verification: expiredVerification,
}).some(error => error.includes('expired')), 'Expired authorization must block checkout.');

const complimentaryOrder = {
  commercialStatus: 'COMPLIMENTARY',
  paymentMethod: 'COMPLIMENTARY',
  subtotal: 225,
  menuValue: 225,
  cogsTotal: 70,
} as Order;
assert(isComplimentaryOrder(complimentaryOrder), 'New complimentary order must be detected.');
assert(isComplimentaryOrder({ paymentMethod: 'COMPLIMENTARY' } as Order), 'Legacy complimentary order must remain readable.');
assert(complimentaryOrderMenuValue(complimentaryOrder) === 225, 'Complimentary menu value must be preserved.');
const metrics = summarizeComplimentaryOrders([complimentaryOrder]);
assert(metrics.orderCount === 1 && metrics.menuValue === 225 && metrics.cogs === 70, 'Complimentary metrics must report count, menu value, and COGS separately.');

const store = {
  id: 'GOLDEN_I',
  name: 'Golden I',
  code: 'GOLDEN_I',
  address: 'Store address',
  isActive: true,
  legalName: 'Legal Coffee Entity',
  tradeName: 'Coffee Bond',
  legalAddress: 'Legal address',
  gstin: '09ABCDE1234F1Z5',
  stateName: 'Uttar Pradesh',
  stateCode: '09',
  gstRegistered: true,
  createdAt: null,
  updatedAt: null,
} as Store;
const legal = receiptLegalDetailsFromStore(store);
assert(legal.gstin === store.gstin && legal.legalName === store.legalName, 'Receipt legal details must come from store configuration.');

const repoRoot = process.cwd();
const posSource = fs.readFileSync(path.join(repoRoot, 'frontend/pages/pos/POSHome.tsx'), 'utf8');
const reportsSource = fs.readFileSync(path.join(repoRoot, 'frontend/pages/reports/ReportsHome.tsx'), 'utf8');
const reversalSource = fs.readFileSync(path.join(repoRoot, 'frontend/lib/paymentReversal.ts'), 'utf8');
const phoneVerificationSource = fs.readFileSync(path.join(repoRoot, 'frontend/lib/complimentaryPhoneVerification.ts'), 'utf8');
const functionsIndexSource = fs.readFileSync(path.join(repoRoot, 'functions/index.js'), 'utf8');
const authorizationFunctionSource = fs.readFileSync(path.join(repoRoot, 'functions/complimentaryAuthorization.js'), 'utf8');
const rulesSource = fs.readFileSync(path.join(repoRoot, 'firestore.rules'), 'utf8');

const require = createRequire(import.meta.url);
const authorizationModule = require(path.join(repoRoot, 'functions/complimentaryAuthorizationPolicy.js')) as {
  isAuthorizedStaffProfile: (profile: Record<string, unknown>, storeId: string) => boolean;
  isVerifiedPhoneToken: (token: Record<string, unknown>, phone: string) => boolean;
};
assert(authorizationModule.isAuthorizedStaffProfile({ isActive: true, role: 'ADMIN' }, 'GOLDEN_I'), 'Active Admin must be authorized.');
assert(authorizationModule.isAuthorizedStaffProfile({ isActive: true, role: 'CASHIER', storeIds: ['GOLDEN_I'] }, 'GOLDEN_I'), 'Assigned Cashier must be authorized.');
assert(!authorizationModule.isAuthorizedStaffProfile({ isActive: false, role: 'ADMIN' }, 'GOLDEN_I'), 'Inactive Admin must be denied.');
assert(!authorizationModule.isAuthorizedStaffProfile({ isActive: true, role: 'BARISTA', storeIds: ['GOLDEN_I'] }, 'GOLDEN_I'), 'KOT-only staff must be denied.');
assert(!authorizationModule.isAuthorizedStaffProfile({ isActive: true, role: 'CASHIER', storeIds: ['UDAY_PARK'] }, 'GOLDEN_I'), 'Cross-store Cashier must be denied.');
assert(authorizationModule.isVerifiedPhoneToken({ phone_number: '+919999999999', firebase: { sign_in_provider: 'phone' } }, '+919999999999'), 'Verified phone token must match the expected phone.');
assert(!authorizationModule.isVerifiedPhoneToken({ phone_number: '+919888888888', firebase: { sign_in_provider: 'phone' } }, '+919999999999'), 'Phone mismatch must be rejected.');
assert(!authorizationModule.isVerifiedPhoneToken({ phone_number: '+919999999999', firebase: { sign_in_provider: 'password' } }, '+919999999999'), 'Non-phone token must be rejected.');

assert(/const paymentsToWrite:[\s\S]{0,120}= isComplimentaryCheckout\s*\? \[\]/.test(posSource), 'Complimentary checkout must create no payment rows.');
assert(posSource.includes('planInventoryDeductionForSale'), 'Complimentary checkout must retain the standard inventory deduction path.');
assert(posSource.includes('createKotItem("BARISTA")') && posSource.includes('createKotItem("KITCHEN")'), 'Complimentary checkout must retain KOT creation.');
assert(posSource.includes('COMPLIMENTARY — NO PAYMENT REQUIRED'), 'Receipt must state that no payment is required.');
assert(posSource.includes('receiptLegalDetailsFromStore(selectedStore)'), 'Receipt GST/legal details must be sourced from store configuration.');
assert(posSource.includes('setComplimentaryVerification(current => retainVerificationForPhone(current, normalized))'), 'Phone changes must invalidate verification.');
assert(!posSource.includes('otpCode') && !posSource.includes('oneTimePassword'), 'POS must not store an OTP value.');
assert(posSource.includes("transaction.get(complimentaryAuthorizationRef)"), 'Checkout must read the server authorization inside the sale transaction.');
assert(posSource.includes("transaction.update(complimentaryAuthorizationRef"), 'Checkout must consume the authorization atomically with the order.');
assert(phoneVerificationSource.includes("'complimentary-phone-verification'"), 'Phone verification must use the named secondary Firebase app.');
assert(phoneVerificationSource.includes('getAuth(getSecondaryApp())'), 'Phone verification must use secondary Auth.');
assert(phoneVerificationSource.includes('inMemoryPersistence'), 'Temporary customer Auth must use memory-only persistence.');
assert(phoneVerificationSource.includes('signInWithPhoneNumber'), 'Real Firebase Phone Authentication must send OTP.');
assert(phoneVerificationSource.includes('confirmationResult.confirm(code)'), 'OTP verification must be delegated to Firebase Phone Authentication.');
assert(phoneVerificationSource.includes("'auth/invalid-verification-code'"), 'Incorrect OTP must produce a safe customer-facing error.');
assert(phoneVerificationSource.includes("'createComplimentaryAuthorization'"), 'Verified phone token must be exchanged through the server callable.');
assert(phoneVerificationSource.includes('auth.currentUser?.uid !== staffUidBefore'), 'Secondary verification must prove the staff session remains unchanged.');
assert(!/localStorage|sessionStorage|indexedDB/i.test(phoneVerificationSource), 'OTP, confirmation result, and token must never be persisted by the phone helper.');
assert(functionsIndexSource.includes('exports.createComplimentaryAuthorization'), 'Cloud Function must be exported.');
assert(authorizationFunctionSource.includes("provider: PROVIDER") && authorizationFunctionSource.includes("used: false"), 'Server authorization must identify Firebase Phone Auth and start unused.');
assert(!/console\.(log|error)|customerIdToken\s*:/.test(authorizationFunctionSource.replace('customerIdToken,', '')), 'Authorization function must not log or store the customer ID token.');
assert(rulesSource.includes('resource.data.used == false') && rulesSource.includes('request.resource.data.used == true'), 'Rules must enforce a single unused-to-used transition.');
assert(rulesSource.includes('data.usedByOrderId == orderId'), 'Order creation must bind authorization use to the exact order ID.');
assert(rulesSource.includes("data.staffUid == request.auth.uid"), 'Rules must reject staff UID mismatch.');
assert(rulesSource.includes(".data.storeId == data.storeId"), 'Rules must reject authorization store mismatch.');
assert(rulesSource.includes("customerPhoneE164 == '+91' + data.customerPhone"), 'Rules must reject customer phone mismatch.');
assert(!phoneVerificationSource.includes('BLOCKED_OTP_PROVIDER_NOT_CONFIGURED') && !posSource.includes('BLOCKED_OTP_PROVIDER_NOT_CONFIGURED'), 'The old provider blocker must be removed.');
assert(reportsSource.includes('commercialCompletedOrders'), 'Reports must separate commercial and complimentary orders.');
assert(reportsSource.includes('Complimentary COGS'), 'Reports must expose complimentary COGS separately.');
assert(reversalSource.includes('if (isComplimentaryOrder(order))'), 'Void reversal must recognize complimentary orders.');

console.log('Complimentary order checks passed:');
console.log('- mandatory customer, phone, reason, and OTP-provider validation');
console.log('- phone-change verification invalidation');
console.log('- isolated Firebase Phone Auth session and unchanged staff session');
console.log('- server-issued, five-minute, single-use authorization enforcement');
console.log('- staff role/store and verified-phone claim validation');
console.log('- no OTP, ID token, or confirmation-result persistence');
console.log('- zero taxable, GST, payable, and payment rows');
console.log('- KOT and inventory paths retained');
console.log('- no payment reversal for complimentary void');
console.log('- store-configured legal GST receipt fields');
console.log('- separate complimentary count, menu value, and COGS');
console.log('- legacy complimentary detection remains readable');
