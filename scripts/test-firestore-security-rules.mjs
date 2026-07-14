import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();
const rulesPath = path.join(repoRoot, 'firestore.rules');
const missingProfilePath = path.join(repoRoot, 'frontend/pages/MissingProfile.tsx');

const rules = fs.readFileSync(rulesPath, 'utf8');
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
const hasStoreAccessBody = extractFunction(rules, 'hasStoreAccess');
const safePublicTrackingBody = extractFunction(rules, 'isSafePublicTrackingDocument');
const usersBlock = extractMatchBlock(rules, 'match /users/{userId}');
const onlineOrdersBlock = extractMatchBlock(rules, 'match /onlineOrders/{onlineOrderId}');
const publicTrackingBlock = extractMatchBlock(rules, 'match /publicOrderTracking/{trackingToken}');
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

assert(/allow\s+read:\s*if\s+isSignedIn\(\)\s*&&\s*request\.auth\.uid\s*==\s*userId;/.test(usersBlock), 'Users may read their own profile.');
assert(/allow\s+read,\s*write:\s*if\s+isAdmin\(\);/.test(usersBlock), 'Only active ADMIN users may manage staff profiles.');
assert(!/allow write:\s*if\s*isSignedIn\(\) && request\.auth\.uid == userId/.test(usersBlock), 'Users must not be able to update their own staff profile.');

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

const cases = [
  'active ADMIN allowed: isAdmin() is based on active users/{uid}.role == ADMIN',
  'inactive ADMIN denied: hasRole() requires isActive == true',
  'CASHIER denied from admin writes: users/{uid} write is guarded by isAdmin()',
  'user cannot promote themselves: self-profile rule is read-only',
  'cross-store access denied: non-admin store access requires storeId in users/{uid}.storeIds',
  'unauthenticated direct onlineOrders creation denied: create requires isCheckoutStaff()',
  'authenticated CASHIER cannot create another-store online order: create requires hasStoreAccess(storeId)',
  'customer tracking reads are exact-token only: get allowed, list denied',
  'customer tracking writes remain sanitized: public fields exclude PII and internal IDs'
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
