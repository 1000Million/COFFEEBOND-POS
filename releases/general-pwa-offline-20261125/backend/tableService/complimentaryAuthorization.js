'use strict';

const { createHash } = require('node:crypto');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const {
  isAuthorizedStaffProfile,
  isVerifiedPhoneToken,
} = require('./complimentaryAuthorizationPolicy');

const PHONE_PATTERN = /^[6-9][0-9]{9}$/;
const AUTHORIZATION_TTL_MS = 5 * 60 * 1000;
const PROVIDER = 'FIREBASE_PHONE_AUTH';

function fail(code, message) {
  throw new HttpsError(code, message);
}

function cleanText(value, maxLength) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

function normalizeIndianPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1);
  return digits;
}

function maskPhone(phoneE164) {
  return `${phoneE164.slice(0, 3)}******${phoneE164.slice(-4)}`;
}

function hashPhone(phoneE164) {
  return createHash('sha256').update(phoneE164).digest('hex');
}

function createComplimentaryAuthorizationFunction({ admin, db, region }) {
  return onCall({ region }, async (request) => {
    const staffUid = request.auth?.uid;
    if (!staffUid) fail('unauthenticated', 'Staff sign-in is required.');

    const storeId = cleanText(request.data?.storeId, 80);
    const submittedPhone = normalizeIndianPhone(request.data?.customerPhone);
    const customerIdToken = String(request.data?.customerIdToken || '').trim();

    if (!storeId) fail('invalid-argument', 'Store is required.');
    if (!PHONE_PATTERN.test(submittedPhone)) fail('invalid-argument', 'A valid Indian mobile number is required.');
    if (!customerIdToken) fail('invalid-argument', 'Verified customer phone token is required.');

    const staffRef = db.collection('users').doc(staffUid);
    const staffSnapshot = await staffRef.get();
    if (!staffSnapshot.exists) fail('permission-denied', 'Active staff profile is required.');

    const staff = staffSnapshot.data() || {};
    if (!isAuthorizedStaffProfile(staff, storeId)) {
      fail('permission-denied', 'This staff account cannot authorise complimentary orders at the selected store.');
    }

    const storeSnapshot = await db.collection('stores').doc(storeId).get();
    if (!storeSnapshot.exists || storeSnapshot.data()?.isActive !== true) {
      fail('failed-precondition', 'The selected store is not active.');
    }

    let customerToken;
    try {
      customerToken = await admin.auth().verifyIdToken(customerIdToken, true);
    } catch {
      fail('failed-precondition', 'Customer phone verification has expired or is invalid.');
    }

    const verifiedPhoneE164 = String(customerToken.phone_number || '').trim();
    const expectedPhoneE164 = `+91${submittedPhone}`;
    if (!isVerifiedPhoneToken(customerToken, expectedPhoneE164)) {
      fail('failed-precondition', 'Verified phone does not match the submitted customer phone.');
    }

    const verifiedAt = admin.firestore.Timestamp.now();
    const expiresAt = admin.firestore.Timestamp.fromMillis(verifiedAt.toMillis() + AUTHORIZATION_TTL_MS);
    const authorizationRef = db.collection('complimentaryAuthorizations').doc();
    const staffName = cleanText(staff.displayName || staff.name || request.auth.token?.name || 'Staff', 120);

    await authorizationRef.create({
      status: 'VERIFIED',
      staffUid,
      staffName,
      storeId,
      customerPhoneE164: verifiedPhoneE164,
      customerPhoneMasked: maskPhone(verifiedPhoneE164),
      customerPhoneHash: hashPhone(verifiedPhoneE164),
      provider: PROVIDER,
      providerUid: customerToken.uid,
      verifiedAt,
      expiresAt,
      used: false,
      createdAt: verifiedAt,
    });

    return {
      authorizationId: authorizationRef.id,
      verifiedPhone: submittedPhone,
      expiresAt: expiresAt.toDate().toISOString(),
    };
  });
}

module.exports = {
  AUTHORIZATION_TTL_MS,
  PROVIDER,
  createComplimentaryAuthorizationFunction,
  normalizeIndianPhone,
};
