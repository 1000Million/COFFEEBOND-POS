import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  canReadMissingCheckoutOrder,
  canTreatCheckoutOrderReadAsMissing,
  isCheckoutPermissionError,
} from '../frontend/lib/posCheckoutAccess';

const posSource = readFileSync(resolve('frontend/pages/pos/POSHome.tsx'), 'utf8');
const runningOrdersSource = readFileSync(resolve('frontend/pages/pos/RunningOrders.tsx'), 'utf8');
const rulesSource = readFileSync(resolve('firestore.rules'), 'utf8');

assert.equal(canReadMissingCheckoutOrder('ADMIN'), true, 'Admin may retain the missing-order idempotency probe.');
assert.equal(canReadMissingCheckoutOrder('STORE_MANAGER'), false, 'Store Manager must not probe an unreadable missing order.');
assert.equal(canReadMissingCheckoutOrder('CASHIER'), false, 'Cashier must not probe an unreadable missing order.');
assert.equal(isCheckoutPermissionError({ code: 'permission-denied' }), true);
assert.equal(isCheckoutPermissionError({ code: 'firestore/permission-denied' }), true);
assert.equal(isCheckoutPermissionError(new Error('Missing menu item')), false);
assert.equal(canTreatCheckoutOrderReadAsMissing({ code: 'permission-denied' }, 'CASHIER'), true);
assert.equal(canTreatCheckoutOrderReadAsMissing({ code: 'permission-denied' }, 'STORE_MANAGER'), true);
assert.equal(canTreatCheckoutOrderReadAsMissing({ code: 'permission-denied' }, 'ADMIN'), false);
assert.equal(canTreatCheckoutOrderReadAsMissing(new Error('Network unavailable'), 'CASHIER'), false);

assert.match(
  runningOrdersSource,
  /staffProfile\.role === 'ADMIN'[\s\S]*?getDocs\(query\(collection\(db, 'stores'\), where\('isActive', '==', true\)\)\)[\s\S]*?: \(await Promise\.all\(/,
  'Running Orders must reserve the all-active-stores query for Admin and directly load assignments for staff.',
);
assert.match(
  runningOrdersSource,
  /assignedStoreIdentifiers\(staffProfile\)[\s\S]*?getDoc\(doc\(db, 'stores', storeId\)\)/,
  'Cashier and Store Manager must load only assigned store documents.',
);
assert.match(
  runningOrdersSource,
  /filterAccessiblePosStores\(loaded, staffProfile\)/,
  'Running Orders must apply the shared assigned-store access filter.',
);

assert.match(
  posSource,
  /existingBeforeTransaction = await loadExistingCheckoutResult\([\s\S]*?canTreatCheckoutOrderReadAsMissing\(existingOrderError, staffProfile\.role\)/,
  'Checkout preflight must preserve deterministic-order recovery while treating a staff missing-doc denial as not created.',
);
assert.match(
  posSource,
  /if \(canReadMissingCheckoutOrder\(staffProfile\.role\)\) \{[\s\S]*?transaction\.get\(newOrderRef\)/,
  'The transaction missing-order probe must remain Admin-only.',
);
assert.match(
  posSource,
  /checkoutRecoveryContext && isCheckoutPermissionError\(err\)[\s\S]*?loadExistingCheckoutResult/,
  'A denied retry must recover an already-created order by its deterministic checkout ID.',
);

assert.match(
  posSource,
  /const PAYMENT_METHODS: PaymentMethod\[\] = \['CASH', 'UPI', 'CARD', 'RAZORPAY', 'SWIGGY', 'ZOMATO', 'CREDIT', 'COMPLIMENTARY'\]/,
  'Existing allowed Cashier tenders must remain visible.',
);
assert.doesNotMatch(
  posSource,
  /const PAYMENT_METHODS[^\n]*'PAY_AT_COUNTER'/,
  'Customer-only Pay at Counter must not appear as a staff POS tender.',
);
assert.match(
  rulesSource,
  /function isCheckoutStaff\(\)[\s\S]*?'STORE_MANAGER', 'CASHIER'/,
  'The unchanged rules must continue treating Cashier as checkout staff.',
);
assert.match(
  rulesSource,
  /function isValidPaymentMethod\(method\)[\s\S]*?'CREDIT'/,
  'CREDIT remains an intentionally permitted checkout-staff tender.',
);

const holdBody = posSource.match(/const holdCurrentBill = \(\) => \{([\s\S]*?)\n  \};/)?.[1] || '';
assert.match(holdBody, /persistHeldBills\(/, 'Hold must remain local to the approved held-bill workflow.');
assert.doesNotMatch(holdBody, /addDoc|setDoc|updateDoc|runTransaction/, 'Hold must not introduce an Admin-only Firestore payload.');

console.log('Cashier checkout and Running Orders access tests passed.');
