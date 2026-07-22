'use strict';

const AUTHORIZED_ROLES = new Set(['ADMIN', 'STORE_MANAGER', 'CASHIER']);

function assignedStoreIds(profile) {
  const values = [
    ...(Array.isArray(profile?.storeIds) ? profile.storeIds : []),
    ...(Array.isArray(profile?.assignedStoreIds) ? profile.assignedStoreIds : []),
  ];
  return new Set(values.map((value) => String(value || '').trim()).filter(Boolean));
}

function isAuthorizedStaffProfile(profile, storeId) {
  if (!profile || profile.isActive !== true || !AUTHORIZED_ROLES.has(profile.role)) return false;
  return profile.role === 'ADMIN' || assignedStoreIds(profile).has(storeId);
}

function isVerifiedPhoneToken(token, expectedPhoneE164) {
  return token?.firebase?.sign_in_provider === 'phone'
    && String(token.phone_number || '').trim() === expectedPhoneE164;
}

module.exports = {
  AUTHORIZED_ROLES,
  assignedStoreIds,
  isAuthorizedStaffProfile,
  isVerifiedPhoneToken,
};
