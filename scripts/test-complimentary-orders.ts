import fs from 'node:fs';
import path from 'node:path';
import {
  buildComplimentaryTotals,
  COMPLIMENTARY_OTP_BLOCKER,
  complimentaryOrderMenuValue,
  isComplimentaryOrder,
  isValidIndianMobile,
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
  otpProviderConfigured: false,
});
assert(missingFields.some(error => error.includes('Customer name')), 'Customer name must be mandatory.');
assert(missingFields.some(error => error.includes('10-digit')), 'Valid phone must be mandatory.');
assert(missingFields.some(error => error.includes('reason')), 'Reason must be mandatory.');
assert(missingFields.includes(COMPLIMENTARY_OTP_BLOCKER), 'Missing OTP provider must block complimentary checkout.');

const verification = {
  authorizationId: 'server-issued-authorization',
  provider: 'TEST_REAL_PROVIDER_ADAPTER',
  verifiedPhone: '9999999999',
  verifiedAtIso: '2026-07-22T10:00:00.000Z',
};
assert(retainVerificationForPhone(verification, '9999999999') === verification, 'Unchanged phone should retain verification.');
assert(retainVerificationForPhone(verification, '9888888888') === null, 'Changing phone must invalidate OTP verification.');

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

assert(/const paymentsToWrite:[\s\S]{0,120}= isComplimentaryCheckout\s*\? \[\]/.test(posSource), 'Complimentary checkout must create no payment rows.');
assert(posSource.includes('planInventoryDeductionForSale'), 'Complimentary checkout must retain the standard inventory deduction path.');
assert(posSource.includes('createKotItem("BARISTA")') && posSource.includes('createKotItem("KITCHEN")'), 'Complimentary checkout must retain KOT creation.');
assert(posSource.includes('COMPLIMENTARY — NO PAYMENT REQUIRED'), 'Receipt must state that no payment is required.');
assert(posSource.includes('receiptLegalDetailsFromStore(selectedStore)'), 'Receipt GST/legal details must be sourced from store configuration.');
assert(posSource.includes('setComplimentaryVerification(current => retainVerificationForPhone(current, nextPhone))'), 'Phone changes must invalidate verification.');
assert(!posSource.includes('otpCode') && !posSource.includes('oneTimePassword'), 'POS must not store an OTP value.');
assert(reportsSource.includes('commercialCompletedOrders'), 'Reports must separate commercial and complimentary orders.');
assert(reportsSource.includes('Complimentary COGS'), 'Reports must expose complimentary COGS separately.');
assert(reversalSource.includes('if (isComplimentaryOrder(order))'), 'Void reversal must recognize complimentary orders.');

console.log('Complimentary order checks passed:');
console.log('- mandatory customer, phone, reason, and OTP-provider validation');
console.log('- phone-change verification invalidation');
console.log('- zero taxable, GST, payable, and payment rows');
console.log('- KOT and inventory paths retained');
console.log('- no payment reversal for complimentary void');
console.log('- store-configured legal GST receipt fields');
console.log('- separate complimentary count, menu value, and COGS');
console.log('- legacy complimentary detection remains readable');
