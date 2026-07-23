import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();
const rulesPath = path.join(repoRoot, 'firestore.rules');
const storageRulesPath = path.join(repoRoot, 'storage.rules');
const missingProfilePath = path.join(repoRoot, 'frontend/pages/MissingProfile.tsx');

const rules = fs.readFileSync(rulesPath, 'utf8');
const storageRules = fs.existsSync(storageRulesPath) ? fs.readFileSync(storageRulesPath, 'utf8') : '';
const missingProfile = fs.existsSync(missingProfilePath) ? fs.readFileSync(missingProfilePath, 'utf8') : '';

const failures = [];

const assert = (condition, message) => {
  if (!condition) failures.push(message);
};

const extractFunction = (source, name) => {
  const needle = `function ${name}(`;
  const start = source.indexOf(needle);
  if (start === -1) return '';
  const braceStart = source.indexOf('{', start);
  if (braceStart === -1) return '';
  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(braceStart + 1, index);
    }
  }
  return '';
};

const extractMatchBlock = (source, matchLine) => {
  const start = source.indexOf(matchLine);
  if (start === -1) return '';
  const lineEnd = source.indexOf('\n', start);
  const braceStart = source.lastIndexOf('{', lineEnd === -1 ? source.length : lineEnd);
  if (braceStart === -1) return '';
  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(braceStart + 1, index);
    }
  }
  return '';
};

const isAdminBody = extractFunction(rules, 'isAdmin');
const hasRoleBody = extractFunction(rules, 'hasRole');
const isActiveUserProfileBody = extractFunction(rules, 'isActiveUserProfile');
const isActiveStaffBody = extractFunction(rules, 'isActiveStaff');
const isFranchiseProfileBody = extractFunction(rules, 'isFranchiseProfile');
const hasStoreAccessBody = extractFunction(rules, 'hasStoreAccess');
const safePublicTrackingBody = extractFunction(rules, 'isSafePublicTrackingDocument');
const orderCreateBody = extractFunction(rules, 'isValidOrderCreate');
const complimentaryOrderCreateBody = extractFunction(rules, 'isValidComplimentaryOrderCreate');
const complimentaryAuthorizationBody = extractFunction(rules, 'hasValidComplimentaryAuthorization');
const complimentaryAuthorizationConsumeBody = extractFunction(rules, 'isValidComplimentaryAuthorizationConsume');
const storedComplimentaryOrderBody = extractFunction(rules, 'isStoredComplimentaryOrder');
const orderSettlementBody = extractFunction(rules, 'isOrderSettlementUpdate');
const orderVoidBody = extractFunction(rules, 'isOrderVoidUpdate');
const orderIdentityBody = extractFunction(rules, 'orderIdentityUnchanged');
const orderTotalsBody = extractFunction(rules, 'orderTotalsUnchanged');
const paymentReversalStatusBody = extractFunction(rules, 'isValidPaymentReversalStatus');
const orderItemCreateBody = extractFunction(rules, 'isValidOrderItemCreate');
const orderItemStatusBody = extractFunction(rules, 'isOrderItemStatusUpdate');
const paymentCreateBody = extractFunction(rules, 'isValidPaymentCreate');
const paymentUpdateBody = extractFunction(rules, 'isPayAtCounterPlaceholderUpdate');
const kotCreateBody = extractFunction(rules, 'isValidKotCreate');
const kotUpdateBody = extractFunction(rules, 'isValidKotUpdate');
const storeStockDeductionBody = extractFunction(rules, 'isCheckoutStoreStockDeduction');
const storeInventoryDeductionBody = extractFunction(rules, 'isCheckoutStoreInventoryDeduction');
const usersBlock = extractMatchBlock(rules, 'match /users/{userId}');
const franchiseAccessAuditBlock = extractMatchBlock(rules, 'match /franchiseAccessAudit/{auditId}');
const onlineOrdersBlock = extractMatchBlock(rules, 'match /onlineOrders/{onlineOrderId}');
const publicTrackingBlock = extractMatchBlock(rules, 'match /publicOrderTracking/{trackingToken}');
const ordersBlock = extractMatchBlock(rules, 'match /orders/{orderId}');
const orderItemsBlock = extractMatchBlock(rules, 'match /items/{itemId}');
const orderPaymentsBlock = extractMatchBlock(rules, 'match /payments/{paymentId}');
const kotItemsBlock = extractMatchBlock(rules, 'match /kotItems/{kotId}');
const stockMovementsBlock = extractMatchBlock(rules, 'match /stockMovements/{movementId}');
const storeStockBlock = extractMatchBlock(rules, 'match /storeStock/{stockId}');
const storeInventoryBlock = extractMatchBlock(rules, 'match /storeInventory/{stockId}');
const pendingConsumptionBlock = extractMatchBlock(rules, 'match /pendingInventoryConsumption/{pendingId}');
const purchaseDraftsBlock = extractMatchBlock(rules, 'match /purchaseDrafts/{draftId}');
const productImageAuditBlock = extractMatchBlock(rules, 'match /productImageAudit/{auditId}');
const complimentaryAuthorizationsBlock = extractMatchBlock(rules, 'match /complimentaryAuthorizations/{authorizationId}');
const invoiceStorageBlock = extractMatchBlock(storageRules, 'match /purchase-invoices/{storeId}/{draftId}/{fileName}');
const menuImageStorageBlock = extractMatchBlock(storageRules, 'match /menu-images/{productCode}/{fileName}');
const legacyRootAdminUid = ['51eEH5q0wVXe5aIPER', 'sqOO8zx8A2'].join('');
const clientBootstrapTerms = [
  ['Initialize Root', ' Admin Profile'].join(''),
  ['VITE_ENABLE_BOOTSTRAP', '_ADMIN'].join('')
];

assert(!rules.includes(legacyRootAdminUid), 'firestore.rules must not contain the legacy hardcoded admin UID.');
assert(!/request\.auth\.uid\s*==\s*['"][A-Za-z0-9_-]{20,}['"]/.test(isAdminBody), 'isAdmin() must not compare request.auth.uid to a hardcoded UID.');
assert(/hasRole\('ADMIN'\)/.test(isAdminBody), 'isAdmin() must be based on the active ADMIN staff profile role.');

assert(/isActiveUserProfile\(\)/.test(hasRoleBody), 'Role checks must require an active users/{uid} profile.');
assert(/userData\(\)\.role\s*==\s*role/.test(hasRoleBody), 'Role checks must compare users/{uid}.role to the expected role.');
assert(/userData\(\)\.isActive\s*==\s*true/.test(isActiveUserProfileBody), 'Active profile checks must require users/{uid}.isActive == true.');

assert(/request\.auth\.uid\s*==\s*userId/.test(usersBlock), 'Users may read their own profile.');
assert(/allow\s+read:\s*if[\s\S]*\|\|\s*isAdmin\(\);/.test(usersBlock), 'Active ADMIN users may read staff profiles.');
assert(/allow\s+create:\s*if\s+isAdmin\(\)\s*&&\s*!isFranchiseProfile\(request\.resource\.data\);/.test(usersBlock), 'Direct client creation of franchise profiles must be denied.');
assert(/allow\s+update:\s*if\s+isAdmin\(\)/.test(usersBlock) && /!isFranchiseProfile\(resource\.data\)/.test(usersBlock), 'Direct client updates to franchise profiles must be denied.');
assert(!/allow write:\s*if\s*isSignedIn\(\) && request\.auth\.uid == userId/.test(usersBlock), 'Users must not be able to update their own staff profile.');
assert(!isActiveStaffBody.includes('FRANCHISE_VIEWER'), 'FRANCHISE_VIEWER must not inherit operational active-staff access.');
assert(/data\.role\s*==\s*'FRANCHISE_VIEWER'/.test(isFranchiseProfileBody), 'Franchise profiles must be identified explicitly.');
assert(/allow\s+read:\s*if\s+isAdmin\(\);/.test(franchiseAccessAuditBlock), 'Only Admin may read franchise access audit records.');
assert(/allow\s+create,\s*update,\s*delete:\s*if\s+false;/.test(franchiseAccessAuditBlock), 'Franchise audit records must be server-written and client-immutable.');

assert(/isAdmin\(\)/.test(hasStoreAccessBody), 'Admins should retain all-store access.');
assert(/isActiveUserProfile\(\)/.test(hasStoreAccessBody), 'Non-admin store access must require an active profile.');
assert(/storeId in userData\(\)\.storeIds/.test(hasStoreAccessBody), 'Non-admin store access must be limited to assigned storeIds.');

assert(!missingProfile.includes(legacyRootAdminUid), 'MissingProfile must not contain the legacy hardcoded admin UID.');
assert(clientBootstrapTerms.every((term) => !missingProfile.includes(term)) && !/setDoc\(doc\(db,\s*['"]users['"]/.test(missingProfile), 'MissingProfile must not expose a client-side admin bootstrap action.');

assert(!/function\s+isValidPublicOnlineOrderCreate\s*\(/.test(rules), 'Unused legacy public online order create helper must stay removed.');
assert(/allow\s+create:\s*if\s+isCheckoutStaff\(\)\s*&&\s*hasStoreAccess\(request\.resource\.data\.storeId\);/.test(onlineOrdersBlock), 'Direct onlineOrders creates must require authenticated checkout staff with store access.');
assert(!/allow\s+create:\s*if\s+true/.test(onlineOrdersBlock), 'Unauthenticated direct onlineOrders creates must remain denied.');
assert(!/isValidPublicOnlineOrderCreate\(\)/.test(onlineOrdersBlock), 'Legacy public onlineOrders create validation must not be reconnected.');

assert(/allow\s+get:\s*if\s+true;/.test(publicTrackingBlock), 'Public order tracking should allow exact-token document reads.');
assert(/allow\s+list:\s*if\s+false;/.test(publicTrackingBlock), 'Public order tracking collection listing must remain denied.');
assert(/isSafePublicTrackingDocument\(request\.resource\.data,\s*trackingToken\)/.test(publicTrackingBlock), 'Public tracking writes must use the sanitized document validator.');

const forbiddenPublicTrackingFields = [
  'customerName',
  'customerPhone',
  'phone',
  'notes',
  'uid',
  'createdBy',
  'acceptedBy',
  'rejectedBy',
  'onlineOrderId',
  'orderId',
  'paymentId',
  'payments',
  'bom',
  'stock',
  'station'
];

for (const field of forbiddenPublicTrackingFields) {
  assert(!safePublicTrackingBody.includes(`'${field}'`) && !safePublicTrackingBody.includes(`"${field}"`), `Public tracking documents must not allow ${field}.`);
}

assert(/allow\s+create:\s*if\s+isValidOrderCreate\(orderId\);/.test(ordersBlock), 'Order creation must use the hardened order create helper with the exact order ID.');
assert(/allow\s+update:\s*if\s+isOrderSettlementUpdate\(\)\s*\|\|\s*isOrderVoidUpdate\(\);/.test(ordersBlock), 'Order updates must be limited to settlement or void helpers.');
assert(/allow\s+delete:\s*if\s+isAdmin\(\);/.test(ordersBlock), 'Only Admin may delete orders.');
assert(/createdByUserId\s*==\s*request\.auth\.uid/.test(orderCreateBody), 'Order creation must bind createdByUserId to the caller.');
assert(/hasStoreAccess\(request\.resource\.data\.storeId\)/.test(orderCreateBody), 'Order creation must require assigned-store access.');
assert(/request\.resource\.data\.status\s*==\s*'COMPLETED'/.test(orderCreateBody), 'Checkout-created orders must use the completed operational status.');
assert(/isValidSaleOrderCreate\(request\.resource\.data\) \|\| isValidComplimentaryOrderCreate\(request\.resource\.data, orderId\)/.test(orderCreateBody), 'Order creation must separate normal sale and order-bound complimentary validation.');
assert(/data\.paymentStatus\s*==\s*'NOT_REQUIRED'/.test(complimentaryOrderCreateBody), 'Complimentary orders must require NOT_REQUIRED payment status.');
assert(/data\.taxableAmount\s*==\s*0/.test(complimentaryOrderCreateBody) && /data\.gstTotal\s*==\s*0/.test(complimentaryOrderCreateBody) && /data\.grandTotal\s*==\s*0/.test(complimentaryOrderCreateBody), 'Complimentary orders must have zero taxable, GST, and payable totals.');
assert(/isValidIndianMobile\(data\.customerPhone\)/.test(complimentaryOrderCreateBody), 'Complimentary orders must require a valid Indian mobile number.');
assert(/hasValidComplimentaryAuthorization\(data, orderId\)/.test(complimentaryOrderCreateBody), 'Complimentary orders must reference a server-side OTP authorization bound to the exact order.');
assert(/status\s*==\s*'VERIFIED'/.test(complimentaryAuthorizationBody) && /expiresAt\s*>\s*request\.time/.test(complimentaryAuthorizationBody), 'Complimentary authorization must be verified and unexpired.');
assert(/getAfter\(complimentaryAuthorizationPath/.test(complimentaryAuthorizationBody), 'Order creation must validate the authorization after its atomic consume update.');
assert(/data\.used\s*==\s*true/.test(complimentaryAuthorizationBody) && /data\.usedByOrderId\s*==\s*orderId/.test(complimentaryAuthorizationBody), 'Complimentary authorization must be consumed once by the exact order ID.');
assert(/data\.staffUid\s*==\s*request\.auth\.uid/.test(complimentaryAuthorizationBody), 'Authorization staff UID must match the checkout staff user.');
assert(/\.data\.storeId\s*==\s*data\.storeId/.test(complimentaryAuthorizationBody), 'Authorization store must match the complimentary order store.');
assert(/customerPhoneE164\s*==\s*'\+91' \+ data\.customerPhone/.test(complimentaryAuthorizationBody), 'Authorization phone must match the order customer phone.');
assert(/data\.keys\(\)\.hasAny\(\['commercialStatus'\]\)/.test(storedComplimentaryOrderBody), 'Complimentary detection must tolerate legacy orders without commercialStatus.');
assert(/data\.keys\(\)\.hasAny\(\['paymentMethod'\]\)/.test(storedComplimentaryOrderBody), 'Legacy complimentary detection must guard optional paymentMethod access.');
assert(/allow\s+create,\s*delete:\s*if\s+false;/.test(complimentaryAuthorizationsBlock), 'Clients must not create or delete complimentary OTP authorizations.');
assert(/allow\s+update:\s*if\s+isValidComplimentaryAuthorizationConsume\(authorizationId\);/.test(complimentaryAuthorizationsBlock), 'Clients may only perform the restricted atomic authorization consume update.');
assert(/resource\.data\.used\s*==\s*false/.test(complimentaryAuthorizationConsumeBody) && /request\.resource\.data\.used\s*==\s*true/.test(complimentaryAuthorizationConsumeBody), 'Used authorizations cannot be reused.');
assert(/resource\.data\.staffUid\s*==\s*request\.auth\.uid/.test(complimentaryAuthorizationConsumeBody), 'Authorization consume must reject staff UID mismatch.');
assert(/hasStoreAccess\(resource\.data\.storeId\)/.test(complimentaryAuthorizationConsumeBody), 'Authorization consume must reject cross-store access.');
assert(/affectedKeys\(\)\.hasOnly\(\[/.test(complimentaryAuthorizationConsumeBody), 'Authorization consume must preserve all verification fields.');
assert(/complimentaryAuthorizationId\s*==\s*authorizationId/.test(complimentaryAuthorizationConsumeBody), 'Consumed authorization must link back from the created complimentary order.');

assert(/resource\.data\.paymentStatus in \['UNPAID', 'PARTIAL'\]/.test(orderSettlementBody), 'Settlement must start only from unpaid or partial orders.');
assert(/request\.resource\.data\.paymentStatus\s*==\s*'PAID'/.test(orderSettlementBody), 'Settlement must only mark an order paid.');
assert(/request\.resource\.data\.settledBy\s*==\s*request\.auth\.uid/.test(orderSettlementBody), 'Settlement must bind settledBy to the caller.');
assert(/affectedKeys\(\)\.hasOnly\(\[/.test(orderSettlementBody) && /paymentBreakdown/.test(orderSettlementBody), 'Settlement updates must be field-limited to payment metadata.');
assert(/orderIdentityUnchanged\(\)/.test(orderSettlementBody) && /orderTotalsUnchanged\(\)/.test(orderSettlementBody), 'Settlement must preserve order identity and totals.');

assert(/\(isAdmin\(\) \|\| isStoreManager\(\)\)/.test(orderVoidBody), 'Void updates must be Admin or Store Manager only.');
assert(/request\.resource\.data\.status\s*==\s*'VOIDED'/.test(orderVoidBody), 'Void helper must only move an order to VOIDED.');
assert(/request\.resource\.data\.voidedBy\s*==\s*request\.auth\.uid/.test(orderVoidBody), 'Void helper must bind voidedBy to the caller.');
assert(/orderIdentityUnchanged\(\)/.test(orderVoidBody) && /orderTotalsUnchanged\(\)/.test(orderVoidBody), 'Void must preserve order identity and totals.');
assert(/request\.resource\.data\.paymentStatus\s*==\s*resource\.data\.paymentStatus/.test(orderVoidBody), 'Void must preserve the original payment status and use separate reversal audit fields.');
assert(/isStoredComplimentaryOrder\(resource\.data\)/.test(orderVoidBody), 'New and legacy complimentary voids must use the no-payment-reversal update branch.');
assert(/isValidPaymentReversalStatus\(request\.resource\.data\.paymentReversalStatus\)/.test(orderVoidBody), 'Void payment reversal status must be restricted to approved values.');
for (const status of ['NOT_REQUIRED', 'REFUNDED', 'REVERSED', 'REFUND_PENDING', 'MANUAL_REFUND_REQUIRED']) {
  assert(paymentReversalStatusBody.includes(`'${status}'`), `Payment reversal status ${status} must be allowed explicitly.`);
}
for (const reversalField of ['paymentReversalStatus', 'paymentReversalBreakdown', 'paymentReversalTotal', 'refundedAmount', 'reversedAmount', 'refundPendingAmount', 'manualRefundRequiredAmount', 'netCollectionAmount']) {
  assert(orderVoidBody.includes(`'${reversalField}'`), `Void helper must field-limit ${reversalField}.`);
}
for (const reversalNumber of ['paymentReversalTotal', 'refundedAmount', 'reversedAmount', 'refundPendingAmount', 'manualRefundRequiredAmount', 'netCollectionAmount']) {
  assert(orderVoidBody.includes(`request.resource.data.${reversalNumber} is number`), `Void helper must require numeric ${reversalNumber}.`);
}
for (const immutableField of ['storeId', 'createdByUserId', 'createdAt', 'orderNumber']) {
  assert(orderIdentityBody.includes(`request.resource.data.${immutableField} == resource.data.${immutableField}`), `Order updates must preserve ${immutableField}.`);
}
for (const totalField of ['subtotal', 'taxTotal', 'gstTotal', 'taxableAmount', 'discountAmount', 'grandTotal', 'cogsTotal']) {
  assert(orderTotalsBody.includes(`request.resource.data.${totalField} == resource.data.${totalField}`), `Order updates must preserve ${totalField}.`);
}

assert(/allow\s+create:\s*if\s+isValidOrderItemCreate\(orderId\);/.test(orderItemsBlock), 'Order item creation must use the order item create helper.');
assert(/allow\s+update:\s*if\s+isOrderItemStatusUpdate\(orderId\);/.test(orderItemsBlock), 'Order item updates must be status-only.');
assert(/allow\s+delete:\s*if\s+isAdmin\(\);/.test(orderItemsBlock), 'Only Admin may delete order items.');
assert(/hasStoreAccess\(orderAfter\(orderId\)\.storeId\)/.test(orderItemCreateBody), 'Order item create must use the parent order store.');
assert(/affectedKeys\(\)\.hasOnly\(\['status'\]\)/.test(orderItemStatusBody), 'Order item updates must only affect status.');

assert(/allow\s+create:\s*if\s+isValidPaymentCreate\(orderId\);/.test(orderPaymentsBlock), 'Payment creation must use the payment create helper.');
assert(/allow\s+update:\s*if\s+isPayAtCounterPlaceholderUpdate\(orderId\);/.test(orderPaymentsBlock), 'Payment updates must be limited to PAY_AT_COUNTER placeholder settlement cleanup.');
assert(/allow\s+delete:\s*if\s+isAdmin\(\);/.test(orderPaymentsBlock), 'Only Admin may delete payment records.');
assert(/hasStoreAccess\(orderAfter\(orderId\)\.storeId\)/.test(paymentCreateBody), 'Payment creation must use parent order store access.');
assert(/isValidPaymentMethod\(request\.resource\.data\.method\)/.test(paymentCreateBody), 'Payment creation must validate payment methods.');
assert(/orderAfter\(orderId\)\.paymentStatus\s*!=\s*'NOT_REQUIRED'/.test(paymentCreateBody), 'Payment rows must be denied for NOT_REQUIRED orders.');
assert(/!isStoredComplimentaryOrder\(orderAfter\(orderId\)\)/.test(paymentCreateBody), 'Payment rows must be denied for new and legacy complimentary orders without blocking legacy normal orders.');
assert(/request\.resource\.data\.settledBy\s*==\s*request\.auth\.uid/.test(paymentCreateBody), 'Settlement payment rows must bind settledBy to the caller when present.');
assert(/resource\.data\.method\s*==\s*'PAY_AT_COUNTER'/.test(paymentUpdateBody), 'Payment updates must only touch PAY_AT_COUNTER placeholders.');
assert(/affectedKeys\(\)\.hasOnly\(\['amount', 'reference'\]\)/.test(paymentUpdateBody), 'Payment placeholder updates must only affect amount/reference.');

assert(/allow\s+create:\s*if\s+isValidKotCreate\(\);/.test(kotItemsBlock), 'KOT creation must use the KOT create helper.');
assert(/allow\s+update:\s*if\s+isValidKotUpdate\(\);/.test(kotItemsBlock), 'KOT updates must use the KOT update helper.');
assert(/request\.resource\.data\.status\s*==\s*'PENDING'/.test(kotCreateBody), 'KOT creation must start as PENDING.');
assert(/request\.resource\.data\.createdByUserId\s*==\s*request\.auth\.uid/.test(kotCreateBody), 'KOT creation must bind createdByUserId to the caller.');
assert(/canReadKot\(resource\.data\)/.test(kotUpdateBody), 'KOT updates must respect station/store role access.');
assert(/request\.resource\.data\.storeId\s*==\s*resource\.data\.storeId/.test(kotUpdateBody), 'KOT updates must preserve storeId.');
assert(/request\.resource\.data\.createdAt\s*==\s*resource\.data\.createdAt/.test(kotUpdateBody), 'KOT updates must preserve createdAt.');

assert(/allow\s+delete:\s*if\s+false;/.test(stockMovementsBlock), 'Stock movements must not be deletable.');
assert(/allow\s+update:\s*if\s+false;/.test(stockMovementsBlock), 'Stock movements must not be mutable.');
assert(/isSaleDeductionMovement\(\)/.test(stockMovementsBlock), 'Checkout stock movements must use the sale deduction helper.');
assert(/createdByUserId\s*==\s*request\.auth\.uid/.test(extractFunction(rules, 'isSaleDeductionMovement')), 'Sale deduction movements must bind createdByUserId to the caller.');

assert(/isCheckoutStoreStockDeduction\(\)/.test(storeStockBlock), 'Checkout storeStock updates must use the narrowed deduction helper.');
assert(/affectedKeys\(\)\.hasOnly\(\['currentStock', 'updatedAt'\]\)/.test(storeStockDeductionBody), 'Checkout storeStock updates must only affect currentStock and updatedAt.');
assert(/request\.resource\.data\.storeId\s*==\s*resource\.data\.storeId/.test(storeStockDeductionBody), 'Checkout storeStock updates must preserve storeId.');
assert(/request\.resource\.data\.currentStock\s*<=\s*resource\.data\.currentStock/.test(storeStockDeductionBody), 'Checkout storeStock updates must only deduct or keep stock level.');
assert(/isCheckoutStoreInventoryDeduction\(\)/.test(storeInventoryBlock), 'Checkout storeInventory updates must use the narrowed legacy deduction helper.');
assert(/affectedKeys\(\)\.hasOnly\(\['currentStock', 'updatedAt'\]\)/.test(storeInventoryDeductionBody), 'Checkout storeInventory updates must only affect currentStock and updatedAt.');
assert(/request\.resource\.data\.storeId\s*==\s*resource\.data\.storeId/.test(storeInventoryDeductionBody), 'Checkout storeInventory updates must preserve storeId.');

assert(/allow\s+update:\s*if\s+\(isAdmin\(\) \|\| isStoreManager\(\)\)/.test(pendingConsumptionBlock), 'Pending BOM client updates must be Admin or Store Manager only.');
assert(/request\.resource\.data\.status\s*==\s*'CANCELLED'/.test(pendingConsumptionBlock), 'Pending BOM client updates must only cancel records.');
assert(!/request\.resource\.data\.status\s*==\s*'APPLIED'/.test(pendingConsumptionBlock), 'Client rules must not allow marking pending BOM records APPLIED.');

assert(/allow\s+read:\s*if\s+isActiveStaff\(\)\s*&&\s*\(isAdmin\(\)\s*\|\|\s*hasStoreAccess\(resource\.data\.storeId\)\);/.test(purchaseDraftsBlock), 'Purchase drafts must be readable only by active staff with store access.');
assert(/allow\s+create,\s*update,\s*delete:\s*if\s+false;/.test(purchaseDraftsBlock), 'Purchase drafts must be server-created only.');
assert(/allow\s+read,\s*create:\s*if\s+isAdmin\(\);/.test(productImageAuditBlock), 'Product image audit must be admin readable and writable.');
assert(/allow\s+update,\s*delete:\s*if\s+false;/.test(productImageAuditBlock), 'Product image audit must remain append-only.');
assert(storageRules.includes('match /purchase-invoices/{storeId}/{draftId}/{fileName}'), 'Storage rules must protect purchase invoice uploads.');
assert(/allow\s+read:\s*if\s+isActiveStaff\(\)\s*&&\s*hasStoreAccess\(storeId\);/.test(invoiceStorageBlock), 'Invoice files must be readable only by assigned active staff.');
assert(/allow\s+create,\s*update:\s*if\s+\(isAdmin\(\) \|\| isStoreManager\(\)\)/.test(invoiceStorageBlock), 'Only Admin or Store Manager may upload invoice files.');
assert(/hasStoreAccess\(storeId\)/.test(invoiceStorageBlock), 'Invoice uploads must require access to the selected store.');
assert(/isAllowedInvoiceContent\(\)/.test(invoiceStorageBlock), 'Invoice uploads must validate file content.');
assert(/allow\s+delete:\s*if\s+\(isAdmin\(\) \|\| isStoreManager\(\)\)\s*&&\s*hasStoreAccess\(storeId\);/.test(invoiceStorageBlock), 'Invoice delete must be limited to Admin or assigned Store Manager.');
assert(/request\.resource\.size\s*<=\s*10\s*\*\s*1024\s*\*\s*1024/.test(storageRules), 'Invoice uploads must be capped at 10 MB.');
assert(storageRules.includes('application/pdf') && storageRules.includes('image/jpeg') && storageRules.includes('image/jpg') && storageRules.includes('image/png'), 'Invoice uploads must be limited to PDF/JPG/PNG MIME types.');
assert(/match \/menu-images\/\{productCode\}\/\{fileName\}/.test(storageRules), 'Menu image uploads must have a dedicated storage path.');
assert(/allow\s+read:\s*if\s+true;/.test(menuImageStorageBlock), 'Menu image files must be publicly readable by the customer ordering app.');
assert(/allow\s+create,\s*update:\s*if\s+isAdmin\(\)/.test(menuImageStorageBlock), 'Only active Admin may create or replace menu images.');
assert(/allow\s+delete:\s*if\s+isAdmin\(\);/.test(menuImageStorageBlock), 'Only active Admin may delete menu images.');
assert(/isAllowedMenuImageContent\(\)/.test(menuImageStorageBlock), 'Menu image uploads must validate image file content.');
assert(/request\.resource\.contentType\s*==\s*'image\/webp'/.test(storageRules), 'Menu image writes must use WebP content type.');
assert(/fileName\.matches\('\^card-\[0-9\]\{8\}T\[0-9\]\{6\}\\\\\.webp\$'\)/.test(menuImageStorageBlock), 'Menu image filenames must follow the card timestamp pattern.');
assert(!/STORE_MANAGER|CASHIER/.test(menuImageStorageBlock), 'Store Manager and Cashier must not write menu images.');
assert(!storageRules.includes(['finished', 'good', 'images'].join('-')), 'Duplicate finished-good image path must be removed.');
assert(/match \/\{allPaths=\*\*\}/.test(storageRules) && /allow\s+read,\s*write:\s*if\s+false;/.test(storageRules), 'Storage rules must deny all other paths by default.');

const cases = [
  'active ADMIN allowed: isAdmin() is based on active users/{uid}.role == ADMIN',
  'inactive ADMIN denied: hasRole() requires isActive == true',
  'CASHIER denied from admin writes: users/{uid} write is guarded by isAdmin()',
  'user cannot promote themselves: self-profile rule is read-only',
  'cross-store access denied: non-admin store access requires storeId in users/{uid}.storeIds',
  'FRANCHISE_VIEWER is excluded from operational active-staff permissions',
  'franchise profiles are managed through Admin SDK callables, not direct client writes',
  'unauthenticated direct onlineOrders creation denied: create requires isCheckoutStaff()',
  'authenticated CASHIER cannot create another-store online order: create requires hasStoreAccess(storeId)',
  'customer tracking reads are exact-token only: get allowed, list denied',
  'customer tracking writes remain sanitized: public fields exclude PII and internal IDs',
  'Cashier creates orders only for assigned stores and as themselves',
  'Cashier cannot edit PAID orders or change totals after creation',
  'Settlement and void are the only order update paths',
  'Voided paid orders keep original payment records and add restricted reversal audit fields',
  'Order item updates are status-only for KOT sync',
  'Payment records require parent-order store access and valid methods',
  'Complimentary checkout requires zero taxable/GST/payable and a server-side verified OTP authorization',
  'Complimentary authorizations are server-created and only atomically consumed by their exact order',
  'Complimentary orders cannot create payment rows or settlement writes',
  'KOT creates and status updates preserve immutable ticket fields',
  'Stock movements cannot be updated or deleted',
  'Checkout storeStock updates can only reduce currentStock',
  'Checkout storeInventory updates can only reduce currentStock',
  'Pending BOM client updates can only cancel, never apply',
  'purchaseDrafts are server-created only and readable only by assigned staff',
  'supplier invoices are private Storage files with Admin/Manager-only upload',
  'invoice uploads are capped at 10 MB and limited to PDF/JPG/PNG'
];

if (failures.length > 0) {
  console.error('Firestore security rule checks failed:');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log('Firestore security rule checks passed:');
for (const testCase of cases) {
  console.log(`- ${testCase}`);
}
