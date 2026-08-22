'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const {
  FRANCHISE_ROLE,
  FRANCHISE_TIME_ZONE,
  assignedStoreIds,
  canAccessRequestedStores,
  franchiseAuthEmail,
  validateFranchisePassword,
  validateFranchiseUsername,
} = require('./franchiseSalesPolicy');

const FRANCHISE_ACCESS_PROJECTS = new Set(['coffee-bond-pos', 'coffee-bond-pos-preview']);
const FRANCHISE_MANAGER_ROLE = 'FRANCHISE_MANAGER';
const FRANCHISE_ACCOUNT_ROLES = new Set([FRANCHISE_ROLE, FRANCHISE_MANAGER_ROLE]);
const USERNAME_MAX = 40;
const DISPLAY_NAME_MAX = 80;
const MAX_STORES_PER_VIEWER = 10;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function fail(code, message) {
  throw new HttpsError(code, message);
}

function cleanText(value, maxLength) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

function uniqueStrings(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean))];
}

function normalizeAccountRole(value) {
  const role = cleanText(value || FRANCHISE_ROLE, 40).toUpperCase();
  if (!FRANCHISE_ACCOUNT_ROLES.has(role)) {
    fail('invalid-argument', 'Choose Franchise Viewer or Franchise Manager access.');
  }
  return role;
}

function permissionsFrom(value, role = FRANCHISE_ROLE) {
  if (role === FRANCHISE_MANAGER_ROLE) {
    return {
      viewDailySales: false,
      exportSales: false,
      manageBondCampaigns: true,
      pauseBondCampaigns: true,
    };
  }
  return {
    viewDailySales: true,
    exportSales: value?.exportSales !== false,
    manageBondCampaigns: false,
    pauseBondCampaigns: false,
  };
}

function isActiveProfile(profile) {
  return profile?.isActive === true;
}

function validatePassword(password) {
  const result = validateFranchisePassword(password);
  if (!result.valid) fail('invalid-argument', result.reason);
}

function timeZoneOffsetMs(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
    Number(values.second),
  ) - date.getTime();
}

function zonedMidnight(year, month, day, timeZone) {
  const utcGuess = Date.UTC(year, month - 1, day);
  let result = new Date(utcGuess - timeZoneOffsetMs(new Date(utcGuess), timeZone));
  result = new Date(utcGuess - timeZoneOffsetMs(result, timeZone));
  return result;
}

function dateBounds(date, timeZone) {
  if (!DATE_PATTERN.test(date)) fail('invalid-argument', 'Business date must use YYYY-MM-DD.');
  const validationDate = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(validationDate.getTime()) || validationDate.toISOString().slice(0, 10) !== date) {
    fail('invalid-argument', 'Business date is invalid.');
  }
  try {
    const [year, month, day] = date.split('-').map(Number);
    const start = zonedMidnight(year, month, day, timeZone);
    const nextDate = new Date(Date.UTC(year, month - 1, day + 1));
    const end = zonedMidnight(
      nextDate.getUTCFullYear(),
      nextDate.getUTCMonth() + 1,
      nextDate.getUTCDate(),
      timeZone,
    );
    return { start, end };
  } catch {
    fail('failed-precondition', 'The assigned store timezone is invalid.');
  }
}

async function loadProfile(db, uid) {
  if (!uid) fail('unauthenticated', 'Sign in is required.');
  const snapshot = await db.collection('users').doc(uid).get();
  if (!snapshot.exists) fail('permission-denied', 'An active user profile is required.');
  return { uid: snapshot.id, ...snapshot.data() };
}

async function requireActiveAdmin(db, request) {
  const profile = await loadProfile(db, request.auth?.uid);
  if (!isActiveProfile(profile) || profile.role !== 'ADMIN') {
    fail('permission-denied', 'Only an active Admin can manage franchise access.');
  }
  return profile;
}

async function requireActiveViewer(db, request) {
  const profile = await loadProfile(db, request.auth?.uid);
  if (!isActiveProfile(profile) || profile.role !== FRANCHISE_ROLE) {
    fail('permission-denied', 'An active Franchise Viewer profile is required.');
  }
  return profile;
}

async function requireActiveFranchiseAccount(db, request) {
  const profile = await loadProfile(db, request.auth?.uid);
  if (!isActiveProfile(profile) || !FRANCHISE_ACCOUNT_ROLES.has(profile.role)) {
    fail('permission-denied', 'An active franchise profile is required.');
  }
  return profile;
}

async function validateStores(db, storeIds, { requireActive = false } = {}) {
  const ids = uniqueStrings(storeIds);
  if (ids.length === 0) fail('invalid-argument', 'Assign at least one store.');
  if (ids.length > MAX_STORES_PER_VIEWER) fail('invalid-argument', 'Too many stores were selected.');
  const refs = ids.map((storeId) => db.collection('stores').doc(storeId));
  const snapshots = await db.getAll(...refs);
  const missing = snapshots.filter((snapshot) => !snapshot.exists).map((snapshot) => snapshot.id);
  if (missing.length > 0) fail('failed-precondition', `Unknown store assignment: ${missing.join(', ')}`);
  const inactive = requireActive
    ? snapshots.filter((snapshot) => snapshot.data()?.isActive !== true).map((snapshot) => snapshot.id)
    : [];
  if (inactive.length > 0) {
    fail('failed-precondition', `Franchise Managers can only be assigned active stores: ${inactive.join(', ')}`);
  }
  return snapshots.map((snapshot) => ({
    id: snapshot.id,
    name: cleanText(snapshot.data()?.name || snapshot.id, DISPLAY_NAME_MAX),
    code: cleanText(snapshot.data()?.code || snapshot.id, USERNAME_MAX),
    isActive: snapshot.data()?.isActive === true,
  }));
}

async function setFranchiseClaims(auth, userRecord, role, storeIds, isActive) {
  const existing = userRecord.customClaims || {};
  await auth.setCustomUserClaims(userRecord.uid, {
    ...existing,
    role,
    storeIds,
    assignedStoreIds: storeIds,
    franchiseViewer: role === FRANCHISE_ROLE,
    franchiseManager: role === FRANCHISE_MANAGER_ROLE,
    active: isActive,
  });
}

async function appendAudit(db, admin, actorUid, action, target) {
  await db.collection('franchiseAccessAudit').add({
    action,
    actorUid,
    targetUid: target.uid,
    role: target.role,
    username: target.username,
    storeIds: target.storeIds,
    isActive: target.isActive,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

async function listFranchiseAccounts(db, auth) {
  const snapshot = await db.collection('users')
    .where('role', 'in', [...FRANCHISE_ACCOUNT_ROLES])
    .get();
  const rows = await Promise.all(snapshot.docs.map(async (viewerDoc) => {
    const data = viewerDoc.data();
    let authRecord = null;
    try {
      authRecord = await auth.getUser(viewerDoc.id);
    } catch (error) {
      if (error?.code !== 'auth/user-not-found') throw error;
    }
    return {
      uid: viewerDoc.id,
      role: data.role,
      username: cleanText(data.usernameNormalized || data.username, USERNAME_MAX),
      displayName: cleanText(data.displayName || data.name, DISPLAY_NAME_MAX),
      storeIds: assignedStoreIds(data),
      isActive: data.isActive === true,
      permissions: permissionsFrom(data.permissions, data.role),
      mustChangePassword: data.mustChangePassword === true,
      lastLoginAt: authRecord?.metadata?.lastSignInTime || null,
      authAccountPresent: Boolean(authRecord),
      updatedAt: data.updatedAt?.toDate?.().toISOString?.() || null,
    };
  }));
  return rows.sort((left, right) => left.username.localeCompare(right.username));
}

function safeViewerTarget(profile) {
  return {
    uid: profile.uid,
    role: profile.role,
    username: cleanText(profile.usernameNormalized || profile.username, USERNAME_MAX),
    storeIds: assignedStoreIds(profile),
    isActive: profile.isActive === true,
  };
}

function createManageFranchiseViewer({ admin, db, region }) {
  return onCall({ region, timeoutSeconds: 60, memory: '256MiB' }, async (request) => {
    if (admin.app().options.projectId && !FRANCHISE_ACCESS_PROJECTS.has(admin.app().options.projectId)) {
      fail('failed-precondition', 'Franchise access is configured only for approved Coffee Bond production and preview projects.');
    }

    const action = String(request.data?.action || '').trim().toUpperCase();

    if (action === 'SELF_PASSWORD_CHANGED') {
      const viewer = await requireActiveFranchiseAccount(db, request);
      if (request.auth?.token?.firebase?.sign_in_provider !== 'password') {
        fail('failed-precondition', 'Password sign-in is required.');
      }
      if (viewer.mustChangePassword !== true) {
        fail('failed-precondition', 'No temporary password change is pending.');
      }
      const newPassword = request.data?.newPassword;
      validatePassword(newPassword);
      await admin.auth().updateUser(viewer.uid, { password: newPassword });
      await db.collection('users').doc(viewer.uid).set({
        mustChangePassword: false,
        passwordChangedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      return { ok: true };
    }

    const adminProfile = await requireActiveAdmin(db, request);
    const auth = admin.auth();

    if (action === 'LIST') {
      return { viewers: await listFranchiseAccounts(db, auth) };
    }

    if (action === 'CREATE') {
      const role = normalizeAccountRole(request.data?.role);
      const usernameValidation = validateFranchiseUsername(request.data?.username);
      if (!usernameValidation.valid) fail('invalid-argument', usernameValidation.reason);
      const username = usernameValidation.username;
      const displayName = cleanText(request.data?.displayName, DISPLAY_NAME_MAX);
      if (!displayName) fail('invalid-argument', 'Display name is required.');
      validatePassword(request.data?.temporaryPassword);
      const stores = await validateStores(db, request.data?.storeIds, {
        requireActive: role === FRANCHISE_MANAGER_ROLE,
      });
      const storeIds = stores.map((store) => store.id);
      const duplicate = await db.collection('users').where('usernameNormalized', '==', username).limit(1).get();
      if (!duplicate.empty) fail('already-exists', 'This franchise username already exists.');

      const email = franchiseAuthEmail(username);
      try {
        await auth.getUserByEmail(email);
        fail('already-exists', 'This franchise username already exists.');
      } catch (error) {
        if (error instanceof HttpsError) throw error;
        if (error?.code !== 'auth/user-not-found') throw error;
      }

      let authUser = null;
      let profileCreated = false;
      try {
        authUser = await auth.createUser({
          email,
          password: request.data.temporaryPassword,
          displayName,
          disabled: false,
        });
        await setFranchiseClaims(auth, authUser, role, storeIds, true);
        const permissions = permissionsFrom(request.data?.permissions, role);
        const profile = {
          uid: authUser.uid,
          username,
          usernameNormalized: username,
          authEmail: email,
          email,
          displayName,
          name: displayName,
          role,
          userCategory: 'FRANCHISE',
          isActive: true,
          active: true,
          assignedStoreIds: storeIds,
          storeIds,
          permissions,
          mustChangePassword: true,
          createdBy: adminProfile.uid,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        };
        await db.collection('users').doc(authUser.uid).create(profile);
        profileCreated = true;
        await appendAudit(db, admin, adminProfile.uid, 'CREATE', safeViewerTarget(profile));
        return { ok: true, uid: authUser.uid, username, role, storeIds };
      } catch (error) {
        if (authUser && !profileCreated) {
          try {
            await auth.deleteUser(authUser.uid);
          } catch (rollbackError) {
            console.error('franchise-viewer-auth-rollback-failed', {
              uid: authUser.uid,
              code: rollbackError?.code || 'unknown',
            });
          }
        }
        throw error;
      }
    }

    const uid = cleanText(request.data?.uid, 128);
    if (!uid) fail('invalid-argument', 'Franchise account UID is required.');
    const viewerSnapshot = await db.collection('users').doc(uid).get();
    if (!viewerSnapshot.exists || !FRANCHISE_ACCOUNT_ROLES.has(viewerSnapshot.data()?.role)) {
      fail('not-found', 'Franchise profile not found.');
    }
    const viewer = { uid, ...viewerSnapshot.data() };
    const userRecord = await auth.getUser(uid);

    if (action === 'UPDATE') {
      const displayName = cleanText(request.data?.displayName, DISPLAY_NAME_MAX);
      if (!displayName) fail('invalid-argument', 'Display name is required.');
      const stores = await validateStores(db, request.data?.storeIds, {
        requireActive: viewer.role === FRANCHISE_MANAGER_ROLE,
      });
      const storeIds = stores.map((store) => store.id);
      const isActive = request.data?.isActive !== false;
      const permissions = permissionsFrom(request.data?.permissions, viewer.role);
      await auth.updateUser(uid, { displayName, disabled: !isActive });
      await setFranchiseClaims(auth, userRecord, viewer.role, storeIds, isActive);
      await db.collection('users').doc(uid).set({
        displayName,
        name: displayName,
        isActive,
        active: isActive,
        assignedStoreIds: storeIds,
        storeIds,
        permissions,
        updatedBy: adminProfile.uid,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      await appendAudit(db, admin, adminProfile.uid, 'UPDATE', {
        ...safeViewerTarget(viewer),
        storeIds,
        isActive,
      });
      return { ok: true };
    }

    if (action === 'RESET_PASSWORD') {
      validatePassword(request.data?.temporaryPassword);
      await auth.updateUser(uid, { password: request.data.temporaryPassword });
      await db.collection('users').doc(uid).set({
        mustChangePassword: true,
        passwordResetBy: adminProfile.uid,
        passwordResetAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      await appendAudit(db, admin, adminProfile.uid, 'RESET_PASSWORD', safeViewerTarget(viewer));
      return { ok: true };
    }

    if (action === 'REVOKE') {
      await auth.updateUser(uid, { disabled: true });
      await setFranchiseClaims(auth, userRecord, viewer.role, assignedStoreIds(viewer), false);
      await db.collection('users').doc(uid).set({
        isActive: false,
        active: false,
        revokedBy: adminProfile.uid,
        revokedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      await appendAudit(db, admin, adminProfile.uid, 'REVOKE', {
        ...safeViewerTarget(viewer),
        isActive: false,
      });
      return { ok: true };
    }

    fail('invalid-argument', 'Unsupported franchise access action.');
  });
}

async function loadOrderRecords(db, orders) {
  return Promise.all(orders.map(async (order) => {
    const orderRef = db.collection('orders').doc(order.id);
    const [itemsSnapshot, paymentsSnapshot] = await Promise.all([
      orderRef.collection('items').get(),
      orderRef.collection('payments').get(),
    ]);
    return {
      order,
      items: itemsSnapshot.docs.map((itemDoc) => itemDoc.data()),
      payments: paymentsSnapshot.docs.map((paymentDoc) => paymentDoc.data()),
    };
  }));
}

function createGetFranchiseDailySales({ admin, db, region }) {
  return onCall({ region, timeoutSeconds: 90, memory: '512MiB' }, async (request) => {
    const profile = await requireActiveViewer(db, request);
    const requestedStoreIds = uniqueStrings(request.data?.storeIds);
    if (!canAccessRequestedStores(profile, requestedStoreIds)) {
      fail('permission-denied', 'Daily sales are limited to your assigned stores.');
    }
    if (requestedStoreIds.length > MAX_STORES_PER_VIEWER) {
      fail('invalid-argument', 'Too many stores were selected.');
    }
    const date = cleanText(request.data?.date, 10);
    const storeSnapshots = await db.getAll(...requestedStoreIds.map((storeId) => db.collection('stores').doc(storeId)));
    if (storeSnapshots.some((snapshot) => !snapshot.exists)) {
      fail('failed-precondition', 'One or more assigned stores no longer exist.');
    }
    const configuredTimeZones = [...new Set(storeSnapshots.map((snapshot) => (
      cleanText(snapshot.data()?.timezone || FRANCHISE_TIME_ZONE, 80)
    )))];
    if (configuredTimeZones.length !== 1) {
      fail('failed-precondition', 'Select stores with the same configured timezone.');
    }
    const timeZone = configuredTimeZones[0];
    const { start, end } = dateBounds(date, timeZone);
    const stores = storeSnapshots.map((snapshot) => ({
      id: snapshot.id,
      code: cleanText(snapshot.data()?.code || snapshot.id, USERNAME_MAX),
      name: cleanText(snapshot.data()?.name || snapshot.id, DISPLAY_NAME_MAX),
    }));

    try {
      const orderSnapshots = await Promise.all(requestedStoreIds.map((storeId) => (
        db.collection('orders')
          .where('storeId', '==', storeId)
          .where('createdAt', '>=', admin.firestore.Timestamp.fromDate(start))
          .where('createdAt', '<', admin.firestore.Timestamp.fromDate(end))
          .get()
      )));
      const onlineOrderSnapshots = await Promise.all(requestedStoreIds.map((storeId) => (
        db.collection('onlineOrders')
          .where('storeId', '==', storeId)
          .where('createdAt', '>=', admin.firestore.Timestamp.fromDate(start))
          .where('createdAt', '<', admin.firestore.Timestamp.fromDate(end))
          .orderBy('createdAt', 'asc')
          .get()
      )));
      const orders = orderSnapshots.flatMap((snapshot) => snapshot.docs.map((orderDoc) => ({
        id: orderDoc.id,
        ...orderDoc.data(),
      })));
      const onlineOrders = onlineOrderSnapshots.flatMap((snapshot) => snapshot.docs.map((orderDoc) => ({
        id: orderDoc.id,
        ...orderDoc.data(),
      })));
      const { buildFranchiseDailyDataset } = await import('./reportingCore.mjs');
      const summary = buildFranchiseDailyDataset(
        await loadOrderRecords(db, orders),
        timeZone,
        onlineOrders,
      );

      console.info('franchise-daily-sales-access', {
        viewerUid: profile.uid,
        storeIds: requestedStoreIds,
        businessDate: date,
        orderCount: orders.length,
        onlineOrderCount: onlineOrders.length,
      });

      return {
        date,
        timeZone,
        stores,
        generatedAt: new Date().toISOString(),
        permissions: {
          viewDailySales: true,
          exportSales: profile.permissions?.exportSales === true,
        },
        ...summary,
      };
    } catch (error) {
      console.error('franchise-daily-sales-failed', {
        viewerUid: profile.uid,
        storeIds: requestedStoreIds,
        businessDate: date,
        code: error?.code || 'unknown',
        message: cleanText(error?.message, 180),
      });
      if (error instanceof HttpsError) throw error;
      fail('internal', 'Daily sales could not be loaded. Please retry.');
    }
  });
}

function createFranchiseSalesFunctions(dependencies) {
  return {
    manageFranchiseViewer: createManageFranchiseViewer(dependencies),
    getFranchiseDailySales: createGetFranchiseDailySales(dependencies),
  };
}

module.exports = {
  createFranchiseSalesFunctions,
};
