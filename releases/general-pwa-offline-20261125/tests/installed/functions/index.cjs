'use strict';
// Only this emulator adapter changes transport. Handler source is loaded unchanged.
const path = require('node:path');
const fs = require('node:fs');
const configured = JSON.parse(fs.readFileSync(path.join(__dirname, 'runtime-sources.json'), 'utf8'));
process.env.NODE_PATH = configured.dependencies;
require('node:module').Module._initPaths();
const admin = require(path.join(path.dirname(require.resolve('firebase-admin')), 'default-namespace.js'));
if (typeof admin.firestore.Timestamp?.now !== 'function') throw Error('Real Admin SDK Timestamp unavailable');
admin.initializeApp();
const db = admin.firestore();
const source = configured.commit;
if (!path.isAbsolute(source || '') || configured.project !== 'demo-coffee-bond-offline') {
  throw Error('An explicit local backend and emulator are required');
}
if (fs.existsSync(path.join(source, 'checkoutDiagnostics.js'))) {
  const diagnostic = require(path.join(source, 'checkoutDiagnostics.js'));
  const originalDiagnostic = diagnostic.withCheckoutDiagnostics;
  diagnostic.withCheckoutDiagnostics = (stage, operation) => originalDiagnostic(stage, async () => {
    try { return await operation(); }
    catch (error) { console.error('SYNTHETIC_QUALIFICATION_INTERNAL_ERROR', error.stack); throw error; }
  });
}
const authorizationSource = configured.authorization;
if (!path.isAbsolute(authorizationSource)) throw Error('An explicit local authorizer source is required');
exports.authorizePosAddOns = require(path.join(authorizationSource, 'posAddOnAuthorization.js')).createPosAddOnAuthorizationFunction({ admin, db, region: 'us-central1' });
exports.commitPosCheckout = require(path.join(source, 'posCheckoutCommit.js')).createPosCheckoutCommitFunction({ admin, db, region: 'us-central1' });

if (!process.env.FIREBASE_AUTH_EMULATOR_HOST?.startsWith('127.0.0.1:') ||
    !process.env.FIRESTORE_EMULATOR_HOST?.startsWith('127.0.0.1:')) {
  throw Error('Loopback emulators required for preview.');
}
const {onCall} = require('firebase-functions/v2/https');
exports.offlineCash = require(configured.offline).createOfflineCashFunction({admin, db, region:'us-central1'});
exports.tableService = onCall({region:'us-central1'},require(configured.table).createTableService({admin,db}).run);
