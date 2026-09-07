#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
} from 'firebase/firestore';
import {
  GLOBAL_ITEM_ASSIGNMENT_SOURCE_FIELD,
  GlobalItemPublishError,
  completePublishedProduct,
  globalItemBaseProductToken,
  publishGlobalItemToStores,
} from '../frontend/lib/globalItemPublish.ts';
import {
  FULL_VERSION_MANAGEMENT_MODE,
  GLOBAL_ITEM_VERSION_SCHEMA_VERSION,
  globalItemMasterDraftDocId,
} from '../frontend/types/global-items.ts';
import {
  resolveEffectiveProduct,
  storeItemConfigDocId,
} from '../frontend/lib/storeItemConfig.ts';
import { buildPublicMenuAvailabilitySnapshot } from '../frontend/lib/publicMenuAvailability.ts';
import { canonicalDataToken, snapshotRevisionToken } from '../frontend/lib/storeItemConfigAdmin.ts';

const PROJECT_ID = 'demo-coffee-bond-global-item-publish';
const [host, portText] = String(process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080').split(':');
const port = Number(portText || 8080);
if (!PROJECT_ID.startsWith('demo-')) throw new Error('Refusing to run against a non-demo project.');
if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('FIRESTORE_EMULATOR_HOST is required.');

let checks = 0;
const ok = (condition, message) => {
  assert.ok(condition, message);
  checks += 1;
  console.log(`PASS ${checks}. ${message}`);
};
const eq = (actual, expected, message) => {
  assert.deepEqual(actual, expected, `${message} (actual=${JSON.stringify(actual)})`);
  checks += 1;
  console.log(`PASS ${checks}. ${message}`);
};

const ids = {
  golden: 'golden-doc',
  noida29: 'noida-29-doc',
  noida51: 'noida-51-doc',
  tasting: 'tasting-room-29-doc',
};
const codes = {
  [ids.golden]: 'GOLDEN_I',
  [ids.noida29]: 'NOIDA_29',
  [ids.noida51]: 'NOIDA_51',
  [ids.tasting]: 'TASTING_ROOM_29',
};
const AFFOGATO = 'AFFOGATO';
const LATTE = 'LATTE';
const CHILD = 'COMPOSITE_CHILD';

const store = (id) => ({
  id,
  code: codes[id],
  name: codes[id],
  address: 'Test address',
  isActive: true,
  posEnabled: true,
  customerOrderingEnabled: true,
  onlineOrderingEnabled: true,
  publicOrderingEnabled: true,
  acceptingOrders: true,
  isAcceptingOrders: true,
  estimatedPrepMinutes: 20,
});
const STORES = Object.values(ids).map(store);

const raw = {
  id: 'espresso-doc',
  code: 'ESPRESSO',
  name: 'Espresso',
  category: 'Coffee',
  purchaseUOM: 'ML',
  usageUOM: 'ML',
  conversionFactor: 1,
  purchaseCost: 1,
  costPerUsageUnit: 1,
  isActive: true,
};
const gelato = {
  id: 'gelato-doc',
  code: 'GELATO',
  name: 'Gelato',
  outputUOM: 'PCS',
  defaultBatchSize: 1,
  yieldQuantity: 1,
  yieldUOM: 'PCS',
  costPerUnit: 20,
  isStockTracked: true,
  bom: [],
  bomVersion: 1,
  isActive: true,
};
const TOPPINGS = {
  id: 'TOPPINGS',
  name: 'Toppings',
  code: 'TOPPINGS',
  isActive: true,
  isRequired: false,
  minimumSelections: 0,
  maximumSelections: 1,
  selectionMode: 'SINGLE',
  purpose: 'ADD_ON',
  options: [{ id: 'COCOA', code: 'COCOA', name: 'Cocoa', price: 20, isActive: true, sortOrder: 0 }],
};
const MILK = {
  id: 'MILK',
  name: 'Milk',
  code: 'MILK',
  isActive: true,
  isRequired: false,
  minimumSelections: 0,
  maximumSelections: 1,
  selectionMode: 'SINGLE',
  purpose: 'ADD_ON',
  options: [{ id: 'OAT', code: 'OAT', name: 'Oat', price: 30, isActive: true, sortOrder: 0 }],
};
const ADD_ON_GROUPS = [MILK, TOPPINGS];

const bomLine = (componentType, componentCode, uom = 'ML') => ({
  componentType,
  componentCode,
  componentName: componentCode,
  quantity: 1,
  uom,
  costPerUnit: 1,
  lineCost: 1,
});
const baseProduct = (code, overrides = {}) => ({
  id: `${code.toLowerCase()}-doc`,
  code,
  name: code === AFFOGATO ? 'Affogato' : code,
  displayName: code === AFFOGATO ? 'Affogato' : code,
  description: 'Protected baseline product',
  imageUrl: 'https://storage.googleapis.com/test/menu-v1.webp',
  imageStoragePath: 'menu/menu-v1.webp',
  imageSource: 'ADMIN_UPLOAD',
  imageUpdatedBy: 'admin',
  posCategoryCode: 'SPECIALTY_DRINKS',
  posCategoryName: 'Specialty Drinks',
  categoryCode: 'SPECIALTY_DRINKS',
  categoryName: 'Specialty Drinks',
  salePrice: code === AFFOGATO ? 280 : 220,
  productionMode: code === CHILD || code === LATTE ? 'NO_STOCK' : 'MADE_TO_ORDER',
  itemType: code === CHILD || code === LATTE ? 'NO_STOCK' : 'MADE_TO_ORDER',
  prepStation: 'BARISTA',
  taxRate: 5,
  addOnGroupIds: code === AFFOGATO ? ['MILK'] : [],
  addOnOptionIdsByGroup: code === AFFOGATO ? { MILK: ['OAT'] } : {},
  bom: code === AFFOGATO ? [bomLine('RAW_INGREDIENT', 'ESPRESSO')] : [],
  bomVersion: 1,
  recipeCost: 1,
  grossMargin: 1,
  cogsPercent: 1,
  sortOrder: 40,
  availableStoreIds: [ids.golden, ids.noida29, ids.noida51],
  isSellable: code !== CHILD,
  isAvailable: true,
  isActive: true,
  ...overrides,
});
const BASE_AFFOGATO = baseProduct(AFFOGATO);
const BASE_LATTE = baseProduct(LATTE);
const BASE_CHILD = baseProduct(CHILD);
const CATALOGUE = [BASE_AFFOGATO, BASE_LATTE, BASE_CHILD];

const TAXONOMY = {
  schemaVersion: 1,
  categories: [
    { code: 'SPECIALTY_DRINKS', name: 'Specialty Drinks', sortOrder: 10, isActive: true, subcategories: [] },
    {
      code: 'ONLY_AT_BOND', name: 'Only at Bond', sortOrder: 20, isActive: true,
      subcategories: [{ code: 'NEW_ADDITIONS', name: 'New Additions', sortOrder: 10, isActive: true }],
    },
  ],
};

const testEnv = await initializeTestEnvironment({
  projectId: PROJECT_ID,
  firestore: { rules: fs.readFileSync('firestore.rules', 'utf8'), host, port },
});
const asUser = (uid) => testEnv.authenticatedContext(uid).firestore();
const asPublic = () => testEnv.unauthenticatedContext().firestore();
const adminDb = asUser('admin');

const legacyLatteConfig = {
  storeId: ids.noida29,
  itemCode: LATTE,
  priceOverride: 295,
  isAvailableOverride: false,
  menuVisibilityOverride: false,
  sortOrderOverride: 0,
  createdAt: 'legacy-created',
  updatedAt: 'legacy-updated',
  updatedBy: 'legacy-admin',
};

await testEnv.withSecurityRulesDisabled(async (context) => {
  const db = context.firestore();
  for (const [uid, data] of Object.entries({
    admin: { uid: 'admin', role: 'ADMIN', isActive: true, storeIds: [] },
    manager: { uid: 'manager', role: 'STORE_MANAGER', isActive: true, storeIds: [ids.noida29] },
    cashier: { uid: 'cashier', role: 'CASHIER', isActive: true, storeIds: [ids.noida29] },
    customer: { uid: 'customer' },
  })) await setDoc(doc(db, 'users', uid), data);
  for (const row of STORES) {
    const { id, ...data } = row;
    await setDoc(doc(db, 'stores', id), data);
  }
  for (const row of CATALOGUE) {
    const { id, ...data } = row;
    await setDoc(doc(db, 'finishedGoods', id), data);
  }
  {
    const { id, ...data } = raw;
    await setDoc(doc(db, 'rawIngredients', id), data);
  }
  {
    const { id, ...data } = gelato;
    await setDoc(doc(db, 'prepItems', id), data);
  }
  for (const group of ADD_ON_GROUPS) {
    const { id, ...data } = group;
    await setDoc(doc(db, 'addOnGroups', id), data);
  }
  await setDoc(doc(db, 'appSettings', 'posMenuTaxonomy'), TAXONOMY);
  await setDoc(doc(db, 'storeItemConfig', storeItemConfigDocId(ids.noida29, LATTE)), legacyLatteConfig);

  for (const row of STORES) {
    const initial = buildPublicMenuAvailabilitySnapshot({
      store: row,
      finishedGoods: CATALOGUE,
      storeStock: [],
      rawIngredients: [raw],
      prepItems: [gelato],
      addOnGroups: ADD_ON_GROUPS,
      storeItemConfigs: row.id === ids.noida29 ? [legacyLatteConfig] : [],
    });
    await setDoc(doc(db, 'publicMenuAvailability', row.code), {
      ...initial,
      publicationRevision: `initial-${row.code}`,
      updatedAt: `initial-${row.code}`,
      sentinel: `untouched-${row.code}`,
    });
  }
});

const draft = (base, revision, product) => ({
  schemaVersion: GLOBAL_ITEM_VERSION_SCHEMA_VERSION,
  itemCode: base.code,
  draftRevision: revision,
  baseProductId: base.id,
  baseProductToken: globalItemBaseProductToken(base),
  product: { ...product, menuVisible: product.menuVisible ?? true },
  savedAt: `saved-${revision}`,
  savedBy: 'admin',
  savedByName: 'Admin',
});
const saveDraft = (value) => setDoc(
  doc(adminDb, 'globalItemMasterDrafts', globalItemMasterDraftDocId(value.itemCode)),
  value,
);
const configRef = (storeId, code = AFFOGATO) => doc(adminDb, 'storeItemConfig', storeItemConfigDocId(storeId, code));
const publicRef = (storeId) => doc(adminDb, 'publicMenuAvailability', codes[storeId]);
const dataOrNull = async (reference) => {
  const snapshot = await getDoc(reference);
  return snapshot.exists() ? snapshot.data() : null;
};
const stateToken = async () => {
  const configs = await Promise.all(Object.values(ids).map((storeId) => dataOrNull(configRef(storeId))));
  const snapshots = await Promise.all(Object.values(ids).map((storeId) => dataOrNull(publicRef(storeId))));
  const source = await dataOrNull(doc(adminDb, 'finishedGoods', BASE_AFFOGATO.id));
  return canonicalDataToken({ configs, snapshots, source });
};

eq(GLOBAL_ITEM_ASSIGNMENT_SOURCE_FIELD, 'finishedGoods.availableStoreIds', 'Canonical assignment owner is explicit');

// 1-4, 8-11, 19-20: master-only save, multi-store publication, isolation, metadata, resolver and snapshots.
const priceDraft = draft(BASE_AFFOGATO, 'master-1', { ...BASE_AFFOGATO, salePrice: 300 });
const liveBeforeMasterSave = await stateToken();
await assertSucceeds(saveDraft(priceDraft));
eq(await stateToken(), liveBeforeMasterSave, 'Saving a master draft is non-live');

const goldenSnapshotBefore = await dataOrNull(publicRef(ids.golden));
const tastingSnapshotBefore = await dataOrNull(publicRef(ids.tasting));
const multi = await publishGlobalItemToStores(adminDb, {
  itemCode: AFFOGATO,
  expectedMasterRevision: 'master-1',
  targetStoreIds: [ids.noida29, ids.noida51],
  publishedBy: { uid: 'admin', name: 'Admin' },
});
eq(multi.publishedStoreIds, [ids.noida29, ids.noida51], 'One operation publishes one item to multiple selected stores');
eq(multi.assignmentAddedStoreIds, [], 'Already assigned selected stores need no assignment write');
const n29Config1 = await dataOrNull(configRef(ids.noida29));
const n51Config1 = await dataOrNull(configRef(ids.noida51));
ok(!await dataOrNull(configRef(ids.golden)), 'Unselected Golden I receives no published configuration');
ok(!await dataOrNull(configRef(ids.tasting)), 'Unselected Tasting Room receives no published configuration');
eq(await dataOrNull(publicRef(ids.golden)), goldenSnapshotBefore, 'Unselected Golden I snapshot is byte/logically unchanged');
eq(await dataOrNull(publicRef(ids.tasting)), tastingSnapshotBefore, 'Every other unselected snapshot is untouched');
eq(n29Config1.publishedVersion.product.salePrice, 300, 'Selected Noida 29 receives draft price');
eq(n51Config1.publishedVersion.product.salePrice, 300, 'Selected Noida 51 receives draft price');
eq(n29Config1.publishedVersion.publishedRevision, n51Config1.publishedVersion.publishedRevision, 'All selected stores receive one shared operation revision');
eq(n29Config1.publishedVersion.sourceDraftRevision, 'master-1', 'Published source master revision is recorded');
ok(n29Config1.publishedVersion.publishedAt?.toMillis() > 0, 'Published timestamp is server materialized');
eq(n29Config1.publishedVersion.publishedBy, 'admin', 'Publisher identity is recorded');
eq(n29Config1.managementMode, FULL_VERSION_MANAGEMENT_MODE, 'Selected store is marked FULL_VERSION_MANAGED');
const n29Snapshot1 = await dataOrNull(publicRef(ids.noida29));
const n51Snapshot1 = await dataOrNull(publicRef(ids.noida51));
eq(n29Snapshot1.menuItems[AFFOGATO].salePrice, 300, 'Noida 29 canonical public snapshot resolves published price');
eq(n51Snapshot1.menuItems[AFFOGATO].salePrice, 300, 'Noida 51 canonical public snapshot resolves published price');
eq(n29Snapshot1.publicationRevision, multi.publishedRevision, 'Selected snapshot records the publish revision');
eq(resolveEffectiveProduct(BASE_AFFOGATO, n29Config1).salePrice, 300, 'POS/effective resolver uses complete published version');
assert.strictEqual(resolveEffectiveProduct(BASE_AFFOGATO), BASE_AFFOGATO);
checks += 1;
console.log(`PASS ${checks}. Store without a published version keeps exact original fallback identity`);

// 2, 5-7, example B/C: one store, every complete field, and assignment in the same transaction.
const fullProduct = {
  ...BASE_AFFOGATO,
  name: 'Affogato Nuovo',
  displayName: 'Affogato Nuovo',
  description: 'Espresso over house gelato',
  imageUrl: 'https://storage.googleapis.com/test/menu-v2.webp',
  imageStoragePath: 'menu/menu-v2.webp',
  imageSource: 'ADMIN_UPLOAD',
  imageUpdatedBy: 'admin',
  posCategoryCode: 'ONLY_AT_BOND',
  posCategoryName: 'Only at Bond',
  posSubcategoryCode: 'NEW_ADDITIONS',
  posSubcategoryName: 'New Additions',
  categoryCode: 'ONLY_AT_BOND',
  categoryName: 'Only at Bond',
  salePrice: 330,
  isAvailable: true,
  menuVisible: true,
  sortOrder: 0,
  taxRate: 12,
  prepStation: 'KITCHEN',
  addOnGroupIds: ['TOPPINGS'],
  addOnOptionIdsByGroup: { TOPPINGS: ['COCOA'] },
  bom: [bomLine('PREP_ITEM', 'GELATO', 'PCS')],
  bomVersion: 2,
};
await saveDraft(draft(BASE_AFFOGATO, 'master-2', fullProduct));
const beforeOneStore = {
  golden: await dataOrNull(publicRef(ids.golden)),
  n29: await dataOrNull(publicRef(ids.noida29)),
  n51: await dataOrNull(publicRef(ids.noida51)),
  n29Config: await dataOrNull(configRef(ids.noida29)),
  n51Config: await dataOrNull(configRef(ids.noida51)),
};
const one = await publishGlobalItemToStores(adminDb, {
  itemCode: AFFOGATO,
  expectedMasterRevision: 'master-2',
  targetStoreIds: [ids.tasting],
  publishedBy: { uid: 'admin', name: 'Admin' },
});
eq(one.publishedStoreIds, [ids.tasting], 'One item publishes to exactly one selected store');
eq(one.assignmentAddedStoreIds, [ids.tasting], 'Previously unassigned selected store is assigned during publish');
const sourceAfterAssignment = await dataOrNull(doc(adminDb, 'finishedGoods', BASE_AFFOGATO.id));
eq(sourceAfterAssignment.availableStoreIds, [ids.golden, ids.noida29, ids.noida51, ids.tasting], 'Existing assignments are preserved and selected assignment is appended');
ok(sourceAfterAssignment.availableStoreIds.includes(ids.golden), 'Publish never implicitly removes an existing assignment');
eq(await dataOrNull(publicRef(ids.golden)), beforeOneStore.golden, 'One-store publish leaves Golden snapshot unchanged');
eq(await dataOrNull(publicRef(ids.noida29)), beforeOneStore.n29, 'One-store publish leaves Noida 29 snapshot unchanged');
eq(await dataOrNull(publicRef(ids.noida51)), beforeOneStore.n51, 'One-store publish leaves Noida 51 snapshot unchanged');
eq(await dataOrNull(configRef(ids.noida29)), beforeOneStore.n29Config, 'One-store publish leaves Noida 29 version unchanged');
eq(await dataOrNull(configRef(ids.noida51)), beforeOneStore.n51Config, 'One-store publish leaves Noida 51 version unchanged');
const tastingConfig = await dataOrNull(configRef(ids.tasting));
const tastingProduct = tastingConfig.publishedVersion.product;
for (const [field, expected] of Object.entries({
  name: 'Affogato Nuovo', description: 'Espresso over house gelato', imageUrl: fullProduct.imageUrl,
  imageStoragePath: fullProduct.imageStoragePath, posCategoryCode: 'ONLY_AT_BOND', salePrice: 330,
  isAvailable: true, menuVisible: true, sortOrder: 0, taxRate: 12, prepStation: 'KITCHEN', bomVersion: 2,
})) eq(tastingProduct[field], expected, `Complete version writes ${field}`);
eq(tastingProduct.addOnOptionIdsByGroup, { TOPPINGS: ['COCOA'] }, 'Complete version writes add-on mapping');
eq(tastingProduct.bom[0].componentCode, 'GELATO', 'Complete version writes BOM references');
eq((await dataOrNull(publicRef(ids.tasting))).menuItems[AFFOGATO].name, 'Affogato Nuovo', 'Selected Tasting Room snapshot is canonically rebuilt');

// 14-17: explicit zero/false values survive a subsequent full-version publication.
await saveDraft(draft(BASE_AFFOGATO, 'master-3', {
  ...fullProduct,
  salePrice: 0,
  isAvailable: false,
  menuVisible: false,
  sortOrder: 0,
}));
await publishGlobalItemToStores(adminDb, {
  itemCode: AFFOGATO,
  expectedMasterRevision: 'master-3',
  targetStoreIds: [ids.noida51],
  publishedBy: { uid: 'admin', name: 'Admin' },
});
const zeroFalseProduct = (await dataOrNull(configRef(ids.noida51))).publishedVersion.product;
eq(zeroFalseProduct.salePrice, 0, 'Explicit price zero is preserved');
eq(zeroFalseProduct.isAvailable, false, 'Explicit false availability is preserved');
eq(zeroFalseProduct.menuVisible, false, 'Explicit false visibility is preserved');
eq(zeroFalseProduct.sortOrder, 0, 'Explicit sort order zero is preserved');
ok(!(AFFOGATO in (await dataOrNull(publicRef(ids.noida51))).menuItems), 'False visibility is reflected by canonical snapshot omission');

// G8.3A: publication preserves commercial role and can never expose an internal child.
await saveDraft(draft(BASE_CHILD, 'internal-master-1', {
  ...BASE_CHILD,
  productType: 'INTERNAL_COMPONENT',
  isSellable: false,
  menuVisible: false,
}));
await publishGlobalItemToStores(adminDb, {
  itemCode: CHILD,
  expectedMasterRevision: 'internal-master-1',
  targetStoreIds: [ids.golden],
  publishedBy: { uid: 'admin', name: 'Admin' },
});
const publishedInternal = (await dataOrNull(configRef(ids.golden, CHILD))).publishedVersion.product;
eq(publishedInternal.productType, 'INTERNAL_COMPONENT', 'Published internal component preserves its product type');
eq(publishedInternal.isSellable, false, 'Published internal component remains non-sellable');
eq(publishedInternal.menuVisible, false, 'Published internal component remains customer-hidden');
ok(!(CHILD in (await dataOrNull(publicRef(ids.golden))).menuItems), 'Published internal component is omitted from the customer menu');

const validComposite = {
  ...fullProduct,
  productType: 'COMPOSITE_PARENT',
  itemType: 'NO_STOCK',
  productionMode: 'NO_STOCK',
  prepStation: 'NONE',
  addOnGroupIds: [],
  addOnOptionIdsByGroup: {},
  bom: [],
  composite: {
    schemaVersion: 1,
    staticComponents: [{ finishedGoodId: BASE_CHILD.id, finishedGoodCode: CHILD, quantity: 1 }],
    choiceGroupIds: [],
  },
};
await saveDraft(draft(BASE_AFFOGATO, 'composite-master-1', validComposite));
await publishGlobalItemToStores(adminDb, {
  itemCode: AFFOGATO,
  expectedMasterRevision: 'composite-master-1',
  targetStoreIds: [ids.noida29],
  publishedBy: { uid: 'admin', name: 'Admin' },
});
const publishedComposite = (await dataOrNull(configRef(ids.noida29))).publishedVersion.product;
eq(publishedComposite.productType, 'COMPOSITE_PARENT', 'Published composite parent preserves its product type');
eq(publishedComposite.prepStation, 'NONE', 'Published composite parent may validly own no prep station');
eq(publishedComposite.composite, validComposite.composite, 'Published composite parent retains its child mapping');

// 18: first-version migration folds all four legacy values and leaves fields stored.
const legacyDraftProduct = { ...BASE_LATTE, salePrice: 310, isAvailable: true, menuVisible: true, sortOrder: 9 };
await saveDraft(draft(BASE_LATTE, 'latte-master-1', legacyDraftProduct));
const legacyResult = await publishGlobalItemToStores(adminDb, {
  itemCode: LATTE,
  expectedMasterRevision: 'latte-master-1',
  targetStoreIds: [ids.noida29],
  publishedBy: { uid: 'admin', name: 'Admin' },
});
const migratedLegacy = await dataOrNull(configRef(ids.noida29, LATTE));
eq(migratedLegacy.publishedVersion.product.salePrice, 295, 'First full version folds legacy price');
eq(migratedLegacy.publishedVersion.product.isAvailable, false, 'First full version folds legacy availability');
eq(migratedLegacy.publishedVersion.product.menuVisible, false, 'First full version folds legacy visibility');
eq(migratedLegacy.publishedVersion.product.sortOrder, 0, 'First full version folds legacy sort zero');
eq(migratedLegacy.priceOverride, 295, 'Legacy override data is preserved for audit/migration');
eq(migratedLegacy.managementMode, FULL_VERSION_MANAGEMENT_MODE, 'Legacy store authority transition is explicit');
eq(legacyResult.managementMode, FULL_VERSION_MANAGEMENT_MODE, 'Publish result reports full-version management');
const pureMigration = completePublishedProduct({
  draftProduct: legacyDraftProduct,
  baseProduct: BASE_LATTE,
  storeId: ids.noida29,
  existingConfig: legacyLatteConfig,
});
eq(pureMigration.salePrice, 295, 'Pure migration planner has the same legacy-fold policy');

// 12: a target-specific composite reference failure aborts all selected stores.
const failingComposite = {
  ...fullProduct,
  salePrice: 350,
  itemType: 'NO_STOCK',
  productionMode: 'NO_STOCK',
  addOnGroupIds: [],
  addOnOptionIdsByGroup: {},
  bom: [],
  composite: {
    schemaVersion: 1,
    staticComponents: [{ finishedGoodId: BASE_CHILD.id, finishedGoodCode: CHILD, quantity: 1 }],
    choiceGroupIds: [],
  },
  unresolvedCompositeRequirements: [],
};
await saveDraft(draft(BASE_AFFOGATO, 'master-4', failingComposite));
const beforeValidationFailure = await stateToken();
await assert.rejects(
  () => publishGlobalItemToStores(adminDb, {
    itemCode: AFFOGATO,
    expectedMasterRevision: 'master-4',
    targetStoreIds: [ids.noida29, ids.noida51, ids.tasting],
    publishedBy: { uid: 'admin', name: 'Admin' },
  }),
  (error) => error instanceof GlobalItemPublishError && error.code === 'REJECTED_VALIDATION',
);
checks += 1;
console.log(`PASS ${checks}. One selected-store reference failure rejects the multi-store publish`);
eq(await stateToken(), beforeValidationFailure, 'Validation failure performs zero config, assignment, or snapshot writes');

// 13: stale master revision fails before writes.
await saveDraft(draft(BASE_AFFOGATO, 'master-8', fullProduct));
const beforeStale = await stateToken();
await assert.rejects(
  () => publishGlobalItemToStores(adminDb, {
    itemCode: AFFOGATO,
    expectedMasterRevision: 'master-7',
    targetStoreIds: [ids.noida29, ids.noida51],
    publishedBy: { uid: 'admin', name: 'Admin' },
  }),
  (error) => error instanceof GlobalItemPublishError && error.code === 'REJECTED_STALE_MASTER',
);
checks += 1;
console.log(`PASS ${checks}. Stale expected master revision returns REJECTED_STALE_MASTER`);
eq(await stateToken(), beforeStale, 'Stale master rejection performs zero live writes');

// Dynamic rules: only Admin can create/update drafts and full published versions.
const deniedPayload = {
  storeId: ids.noida29,
  itemCode: 'DENIED',
  managementMode: FULL_VERSION_MANAGEMENT_MODE,
  publishedVersion: migratedLegacy.publishedVersion,
};
await assertFails(setDoc(doc(asUser('manager'), 'storeItemConfig', storeItemConfigDocId(ids.noida29, 'DENIED')), deniedPayload));
checks += 1;
console.log(`PASS ${checks}. Store Manager cannot publish a full store version`);
await assertFails(setDoc(doc(asUser('cashier'), 'storeItemConfig', storeItemConfigDocId(ids.noida29, 'DENIED')), deniedPayload));
checks += 1;
console.log(`PASS ${checks}. Cashier cannot publish a full store version`);
await assertFails(setDoc(doc(asPublic(), 'storeItemConfig', storeItemConfigDocId(ids.noida29, 'DENIED')), deniedPayload));
checks += 1;
console.log(`PASS ${checks}. Public cannot publish a full store version`);
await assertSucceeds(getDoc(doc(asPublic(), 'publicMenuAvailability', codes[ids.noida29])));
checks += 1;
console.log(`PASS ${checks}. Public access remains limited to the canonical public snapshot`);

// The engine reads the draft; callers never provide product content.
const engineSource = fs.readFileSync('frontend/lib/globalItemPublish.ts', 'utf8');
const publishInputStart = engineSource.indexOf('export type PublishGlobalItemInput');
const publishInputSource = engineSource.slice(publishInputStart, engineSource.indexOf('};', publishInputStart) + 2);
ok(!/product\s*:/.test(publishInputSource), 'Publish API accepts no client product payload');
ok(engineSource.includes('runTransaction(firestore'), 'All selected writes use one Firestore transaction');
ok(engineSource.includes('buildPublicMenuAvailabilitySnapshot'), 'Selected snapshots use the canonical builder');
ok(!engineSource.includes('GlobalItems.tsx'), 'Publish engine is independent of the current Global Items UI');

const configCount = (await getDocs(collection(adminDb, 'storeItemConfig'))).size;
ok(configCount >= 4, 'Successful engine publications persisted expected version documents');

await testEnv.cleanup();
console.log(`\n${checks} G8.2 publish-engine emulator checks passed.`);
