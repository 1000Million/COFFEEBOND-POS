#!/usr/bin/env node

import process from 'node:process';
import { execFileSync } from 'node:child_process';
import {
  TASTING_ROOM_INVENTORY_STORE_ID,
  TASTING_ROOM_STORE_ID,
  buildTastingRoomPublicPreviewSnapshot,
  tastingRoomAddOnGroups,
  tastingRoomCategories,
  tastingRoomFinishedGoods,
  tastingRoomPhase1Catalog,
  tastingRoomPreviewStore,
} from './tasting-room-phase-1-catalog.mjs';

const PREVIEW_PROJECT_ID = 'coffee-bond-pos-preview';
const PRODUCTION_PROJECT_ID = 'coffee-bond-pos';
const APPLY = process.argv.includes('--apply-preview');
const projectArg = process.argv.find((value) => value.startsWith('--project='))?.slice('--project='.length) || PREVIEW_PROJECT_ID;
const staffUidArg = process.argv.find((value) => value.startsWith('--staff-uid='))?.slice('--staff-uid='.length) || '';
const FIRESTORE_ROOT = `https://firestore.googleapis.com/v1/projects/${PREVIEW_PROJECT_ID}/databases/(default)/documents`;

const LEGAL_AND_GST_FIELDS = [
  'legalEntityName',
  'legalName',
  'tradeName',
  'legalAddress',
  'gstin',
  'stateName',
  'stateCode',
  'gstRegistered',
  'gstRate',
  'taxRate',
  'defaultGstRate',
  'defaultTaxRate',
  'gstPercent',
  'taxPercent',
  'receiptName',
  'receiptFooter',
];

function fail(message) {
  throw new Error(message);
}

function assertSafeProject() {
  if (projectArg === PRODUCTION_PROJECT_ID) fail('Production project is forbidden for Tasting Room Phase 1 preview preparation.');
  if (projectArg !== PREVIEW_PROJECT_ID) fail(`Unexpected project ${projectArg}; only ${PREVIEW_PROJECT_ID} is allowed.`);
}

function copyDefined(source, fields) {
  return Object.fromEntries(fields
    .filter((field) => source[field] !== undefined)
    .map((field) => [field, source[field]]));
}

async function findSourceStore(firestore) {
  const direct = firestoreGet(`stores/${TASTING_ROOM_INVENTORY_STORE_ID}`);
  if (direct?.error?.code === 404) return null;
  if (direct?.error) fail(`Could not read preview source store: ${direct.error.message || direct.error.code}`);
  return { id: TASTING_ROOM_INVENTORY_STORE_ID, ...decodeMap(direct.fields || {}) };
}

function accessToken() {
  return execFileSync('gcloud', ['auth', 'application-default', 'print-access-token'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function curlJson(url, { method = 'GET', body } = {}) {
  const args = [
    '--silent',
    '--show-error',
    '--max-time', '60',
    '--request', method,
    '--header', `Authorization: Bearer ${accessToken()}`,
    '--header', 'Content-Type: application/json',
  ];
  if (body !== undefined) args.push('--data-binary', JSON.stringify(body));
  args.push(url);
  const output = execFileSync('curl', args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  return JSON.parse(output);
}

function firestoreGet(path) {
  return curlJson(`${FIRESTORE_ROOT}/${path}`);
}

function decodeValue(value = {}) {
  if (Object.hasOwn(value, 'nullValue')) return null;
  if (Object.hasOwn(value, 'booleanValue')) return value.booleanValue;
  if (Object.hasOwn(value, 'integerValue')) return Number(value.integerValue);
  if (Object.hasOwn(value, 'doubleValue')) return Number(value.doubleValue);
  if (Object.hasOwn(value, 'timestampValue')) return value.timestampValue;
  if (Object.hasOwn(value, 'stringValue')) return value.stringValue;
  if (Object.hasOwn(value, 'arrayValue')) return (value.arrayValue.values || []).map(decodeValue);
  if (Object.hasOwn(value, 'mapValue')) return decodeMap(value.mapValue.fields || {});
  return undefined;
}

function decodeMap(fields) {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, decodeValue(value)]));
}

function encodeValue(value) {
  if (value === null) return { nullValue: null };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (typeof value === 'string') return { stringValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encodeValue) } };
  if (value && typeof value === 'object') return { mapValue: { fields: encodeMap(value) } };
  fail(`Unsupported Firestore value type: ${typeof value}`);
}

function encodeMap(value) {
  return Object.fromEntries(Object.entries(value)
    .filter(([, fieldValue]) => fieldValue !== undefined)
    .map(([key, fieldValue]) => [key, encodeValue(fieldValue)]));
}

function documentName(collection, id) {
  return `projects/${PREVIEW_PROJECT_ID}/databases/(default)/documents/${collection}/${id}`;
}

function createWrite(collection, id, data) {
  return {
    update: { name: documentName(collection, id), fields: encodeMap(data) },
    currentDocument: { exists: false },
    updateTransforms: [
      { fieldPath: 'createdAt', setToServerValue: 'REQUEST_TIME' },
      { fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' },
    ],
  };
}

function staffAssignmentWrite(staffDoc) {
  return {
    update: {
      name: staffDoc.name,
      fields: encodeMap({
        storeIds: [TASTING_ROOM_INVENTORY_STORE_ID, TASTING_ROOM_STORE_ID],
        assignedStoreIds: [TASTING_ROOM_INVENTORY_STORE_ID, TASTING_ROOM_STORE_ID],
      }),
    },
    updateMask: { fieldPaths: ['storeIds', 'assignedStoreIds'] },
    currentDocument: { updateTime: staffDoc.updateTime },
    updateTransforms: [{ fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' }],
  };
}

function verifiedStaffAssignment() {
  if (!staffUidArg) return null;
  if (!/^qa-preview-[a-z0-9-]+$/.test(staffUidArg)) {
    fail('Only a dedicated qa-preview-* staff profile may be assigned by this preview script.');
  }
  const staffDoc = firestoreGet(`users/${staffUidArg}`);
  if (staffDoc?.error?.code === 404) fail(`Preview staff profile ${staffUidArg} does not exist.`);
  if (staffDoc?.error) fail(`Could not read preview staff profile: ${staffDoc.error.message || staffDoc.error.code}`);
  const staff = decodeMap(staffDoc.fields || {});
  if (staff.role !== 'STORE_MANAGER' || staff.isActive !== true) {
    fail(`Preview staff profile ${staffUidArg} must be an active STORE_MANAGER.`);
  }
  return { staffDoc, staff };
}

async function applyPreview() {
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim()) {
    fail('GOOGLE_APPLICATION_CREDENTIALS is required for --apply-preview. No writes were made.');
  }
  const sourceStore = await findSourceStore();
  if (!sourceStore) fail(`Preview source store ${TASTING_ROOM_INVENTORY_STORE_ID} is missing; legal/GST inheritance cannot be proven.`);
  const inheritedLegalAndGst = copyDefined(sourceStore, LEGAL_AND_GST_FIELDS);
  const staffAssignment = verifiedStaffAssignment();
  const writes = [createWrite('stores', TASTING_ROOM_STORE_ID, {
    ...tastingRoomPreviewStore,
    ...inheritedLegalAndGst,
  })];
  tastingRoomCategories.forEach((category) => writes.push(createWrite('categories', category.id, category)));
  tastingRoomFinishedGoods.forEach((item) => writes.push(createWrite('finishedGoods', item.id, item)));
  tastingRoomAddOnGroups.forEach((group) => writes.push(createWrite('addOnGroups', group.id, group)));
  writes.push(createWrite('publicMenuAvailability', TASTING_ROOM_STORE_ID, buildTastingRoomPublicPreviewSnapshot()));
  if (staffAssignment) writes.push(staffAssignmentWrite(staffAssignment.staffDoc));
  const commit = curlJson(`${FIRESTORE_ROOT}:commit`, { method: 'POST', body: { writes } });
  if (commit?.error) fail(`Preview Firestore commit failed: ${commit.error.message || commit.error.code}`);
  return {
    projectId: PREVIEW_PROJECT_ID,
    sourceStoreId: sourceStore.id,
    gstSourceComplete: LEGAL_AND_GST_FIELDS.every((field) => sourceStore[field] !== undefined),
    inheritedLegalAndGstFields: Object.keys(inheritedLegalAndGst),
    storeWrites: 1,
    categoryWrites: tastingRoomCategories.length,
    finishedGoodWrites: tastingRoomFinishedGoods.length,
    addOnGroupWrites: tastingRoomAddOnGroups.length,
    publicSnapshotWrites: 1,
    staffAssignmentWrites: staffAssignment ? 1 : 0,
    staffUid: staffAssignment ? staffUidArg : null,
    staffStoreIds: staffAssignment ? [TASTING_ROOM_INVENTORY_STORE_ID, TASTING_ROOM_STORE_ID] : [],
    availableItems: 0,
    committedWrites: commit.writeResults?.length || 0,
  };
}

async function main() {
  assertSafeProject();
  const snapshot = buildTastingRoomPublicPreviewSnapshot();
  const plan = {
    projectId: projectArg,
    mode: APPLY ? 'APPLY_PREVIEW' : 'DRY_RUN',
    productionProjectForbidden: PRODUCTION_PROJECT_ID,
    storeId: TASTING_ROOM_STORE_ID,
    inventoryStoreId: TASTING_ROOM_INVENTORY_STORE_ID,
    categories: tastingRoomCategories.length,
    finishedGoods: tastingRoomFinishedGoods.length,
    addOnGroups: tastingRoomAddOnGroups.length,
    publicMenuItems: snapshot.itemCount,
    availableItems: snapshot.availableCount,
    bomGapRows: tastingRoomPhase1Catalog.bomGapReport.length,
  };
  if (!APPLY) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return;
  }
  const result = await applyPreview();
  process.stdout.write(`${JSON.stringify({ ...plan, result }, null, 2)}\n`);
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
