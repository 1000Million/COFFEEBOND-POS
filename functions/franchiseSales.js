'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const {
  FRANCHISE_ROLE,
  FRANCHISE_TIME_ZONE,
  assignedStoreIds,
  canAccessRequestedStores,
  franchiseAuthEmail,
  summarizeFranchiseDailySales,
  validateFranchiseUsername,
} = require('./franchiseSalesPolicy');

const PROJECT_ID = 'coffee-bond-pos';
const USERNAME_MAX = 40;
const DISPLAY_NAME_MAX = 80;
const PASSWORD_MIN = 12;
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

function permissionsFrom(value) {
  return {
    viewDailySales: true,
    exportSales: value?.exportSales !== false,
  };
}

function isActiveProfile(profile) {
  return profile?.isActive === true;
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN || password.length > 128) {
    fail('invalid-argument', `Temporary password must be ${PASSWORD_MIN}-128 characters.`);
  }
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

async function validateStores(db, storeIds) {
  const ids = uniqueStrings(storeIds);
  if (ids.length === 0) fail('invalid-argument', 'Assign at least one store.');
  if (ids.length > MAX_STORES_PER_VIEWER) fail('invalid-argument', 'Too many stores were selected.');
  const refs = ids.map((storeId) => db.collection('stores').doc(storeId));
  const snapshots = await db.getAll(...refs);
  const missing = snapshots.filter((snapshot) => !snapshot.exists).map((snapshot) => snapshot.id);
  if (missing.length > 0) fail('failed-precondition', `Unknown store assignment: ${missing.join(', ')}`);
  return snapshots.map((snapshot) => ({
    id: snapshot.id,
    name: cleanText(snapshot.data()?.name || snapshot.id, DISPLAY_NAME_MAX),
    code: cleanText(snapshot.data()?.code || snapshot.id, USERNAME_MAX),
    isActive: snapshot.data()?.isActive === true,
  }));
}

async function setViewerClaims(auth, userRecord, storeIds, isActive) {
  const existing = userRecord.customClaims || {};
  await auth.setCustomUserClaims(userRecord.uid, {
    ...existing,
    role: FRANCHISE_ROLE,
    storeIds,
    franchiseViewer: true,
    active: isActive,
  });
}

async function appendAudit(db, admin, actorUid, action, target) {
  await db.collection('franchiseAccessAudit').add({
    action,
    actorUid,
    targetUid: target.uid,
    username: target.username,
    storeIds: target.storeIds,
    isActive: target.isActive,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

async function listViewers(db, auth) {
  const snapshot = await db.collection('users').where('role', '==', FRANCHISE_ROLE).get();
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
      username: cleanText(data.usernameNormalized || data.username, USERNAME_MAX),
      displayName: cleanText(data.displayName || data.name, DISPLAY_NAME_MAX),
      storeIds: assignedStoreIds(data),
      isActive: data.isActive === true,
      permissions: permissionsFrom(data.permissions),
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
    username: cleanText(profile.usernameNormalized || profile.username, USERNAME_MAX),
    storeIds: assignedStoreIds(profile),
    isActive: profile.isActive === true,
  };
}

function createManageFranchiseViewer({ admin, db, region }) {
  return onCall({ region, timeoutSeconds: 60, memory: '256MiB' }, async (request) => {
    if (admin.app().options.projectId && admin.app().options.projectId !== PROJECT_ID) {
      fail('failed-precondition', 'Franchise access is configured for the Coffee Bond production project only.');
    }

    const action = String(request.data?.action || '').trim().toUpperCase();

    if (action === 'SELF_PASSWORD_CHANGED') {
      const viewer = await requireActiveViewer(db, request);
      if (request.auth?.token?.firebase?.sign_in_provider !== 'password') {
        fail('failed-precondition', 'Password sign-in is required.');
      }
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
      return { viewers: await listViewers(db, auth) };
    }

    if (action === 'CREATE') {
      const usernameValidation = validateFranchiseUsername(request.data?.username);
      if (!usernameValidation.valid) fail('invalid-argument', usernameValidation.reason);
      const username = usernameValidation.username;
      const displayName = cleanText(request.data?.displayName, DISPLAY_NAME_MAX);
      if (!displayName) fail('invalid-argument', 'Display name is required.');
      validatePassword(request.data?.temporaryPassword);
      const stores = await validateStores(db, request.data?.storeIds);
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
        await setViewerClaims(auth, authUser, storeIds, true);
        const permissions = permissionsFrom(request.data?.permissions);
        const profile = {
          uid: authUser.uid,
          username,
          usernameNormalized: username,
          authEmail: email,
          email,
          displayName,
          name: displayName,
          role: FRANCHISE_ROLE,
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
        return { ok: true, uid: authUser.uid, username, storeIds };
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
    if (!uid) fail('invalid-argument', 'Viewer UID is required.');
    const viewerSnapshot = await db.collection('users').doc(uid).get();
    if (!viewerSnapshot.exists || viewerSnapshot.data()?.role !== FRANCHISE_ROLE) {
      fail('not-found', 'Franchise Viewer profile not found.');
    }
    const viewer = { uid, ...viewerSnapshot.data() };
    const userRecord = await auth.getUser(uid);

    if (action === 'UPDATE') {
      const displayName = cleanText(request.data?.displayName, DISPLAY_NAME_MAX);
      if (!displayName) fail('invalid-argument', 'Display name is required.');
      const stores = await validateStores(db, request.data?.storeIds);
      const storeIds = stores.map((store) => store.id);
      const isActive = request.data?.isActive !== false;
      const permissions = permissionsFrom(request.data?.permissions);
      await auth.updateUser(uid, { displayName, disabled: !isActive });
      await setViewerClaims(auth, userRecord, storeIds, isActive);
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
      await setViewerClaims(auth, userRecord, assignedStoreIds(viewer), false);
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
      const orders = orderSnapshots.flatMap((snapshot) => snapshot.docs.map((orderDoc) => ({
        id: orderDoc.id,
        ...orderDoc.data(),
      })));
      const summary = summarizeFranchiseDailySales(await loadOrderRecords(db, orders), timeZone);

      console.info('franchise-daily-sales-access', {
        viewerUid: profile.uid,
        storeIds: requestedStoreIds,
        businessDate: date,
        orderCount: orders.length,
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
