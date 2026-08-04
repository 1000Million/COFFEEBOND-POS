import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AUTHORITATIVE_PROTEIN_CODE,
  GOLDEN_I_STORE_ID,
  LEGACY_PROTEIN_CODE,
  MEZZE_CATEGORY,
  MEZZE_CODE,
  PROJECT_ID,
  SCHEMA_VERSION,
  TEMPORARY_PROTEIN_CODE,
  buildPosMenuCorrectnessPlan,
  buildPublicMenuDisplayEntry,
  canonicalize,
  proteinCodesVisibleAtGoldenI,
  resolveEffectiveGst,
} from './pos-menu-correctness-plan.mjs';
import {
  ALLOWED_WRITE_PATHS,
  CONFIRM_PHRASE,
  EXPECTED_OPERATION_COUNT,
  FORBIDDEN_COLLECTIONS,
  FORBIDDEN_WRITE_PATHS,
  buildTransactionWrites,
  isDeleteSentinel,
  parseApplyArgs,
  verifyChecksum,
  verifyPlanScope,
  verifyPostApply,
  verifyPreconditions,
} from './apply-pos-menu-correctness.mjs';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const passed = [];
function test(name, condition) {
  assert(condition, name);
  passed.push(name);
}

// ---------------------------------------------------------------------------
// Fixtures mirroring the live coffee-bond-pos documents.
// ---------------------------------------------------------------------------
const PROTEIN_STORE_IDS = ['HCLGB7BRuIxp9gLjDdca', 'cJk69Ti1mveh603L4edw', 'L0qB13uuPxHvv089YtGQ', 'BAKED_BY_BOND_51'];
const TEMP_STORE_IDS = ['BAKED_BY_BOND_51', GOLDEN_I_STORE_ID, 'HCLGB7BRuIxp9gLjDdca', 'L0qB13uuPxHvv089YtGQ', 'cJk69Ti1mveh603L4edw'];
const TEMP_STORE_IDS_WITHOUT_GOLDEN = ['BAKED_BY_BOND_51', 'HCLGB7BRuIxp9gLjDdca', 'L0qB13uuPxHvv089YtGQ', 'cJk69Ti1mveh603L4edw'];
const PROTEIN_IMAGE_URL = 'https://firebasestorage.googleapis.com/v0/b/coffee-bond-pos.firebasestorage.app/o/menu-images%2F36G_PROTEIN_POWER%2Fcard-20260724T075423.webp?alt=media&token=1cd2b775-a3bf-4fcb-bf73-166853c73f94';
const BEVERAGE_OPTIONS = ['ALMOND_MILK', 'CARAMEL_FLAVOUR', 'COLD_FOAM', 'HAZELNUT_FLAVOUR', 'HONEY_AND_CINNAMON', 'MILK_ON_SIDE', 'MOCHA', 'OAT_MILK', 'SMOKED_JAGGERY_FLAVOUR', 'SOY_MILK', 'VANILLA_FLAVOUR', 'VANILLA_ICE_CREAM_2_SCOOPS'];
const FOOD_OPTIONS = ['EGG_3', 'EXTRA_BREAD_2_SLICES', 'EXTRA_MOZZARELLA', 'EXTRA_VEGGIES', 'FALAFEL', 'GARLIC_AIOLI', 'HONEY', 'HUMMUS', 'ICE_CREAM_2_SCOOPS', 'PESTO', 'PITA_BREAD', 'RICOTTA_CHEESE', 'SOUR_CREAM', 'TOMATO_RELISH', 'TZATZIKI'];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function snapshotMenuEntry(code, overrides = {}) {
  return {
    id: code, code, name: code, displayName: code,
    posCategoryCode: 'MIS', posCategoryName: 'Misc', salePrice: 390,
    prepStation: 'BARISTA', itemType: 'MADE_TO_ORDER', sortOrder: 999,
    availableStoreIds: [GOLDEN_I_STORE_ID], productionMode: 'MADE_TO_ORDER',
    isSellable: true, isAvailable: true, isActive: true,
    ...overrides,
  };
}

function availabilityEntry(code) {
  return { itemCode: code, fgCode: code, available: true, publicStatus: 'AVAILABLE', publicMessage: 'Available' };
}

/** Live shape: the duplicate is assigned to Golden I but is NOT in the public snapshot. */
function baseInput() {
  return {
    generatedAt: '2026-08-04T00:00:00.000Z',
    // Live: store carries no GST fields; the app default supplies 5%.
    store: { code: GOLDEN_I_STORE_ID, name: 'Golden I', onlineOrderingEnabled: true },
    gstConfig: { defaultGstRate: 5, storeOverrides: {} },
    finishedGoods: [
      {
        id: AUTHORITATIVE_PROTEIN_CODE,
        data: {
          code: AUTHORITATIVE_PROTEIN_CODE,
          name: '36G Protein Power',
          displayName: '36G Protein Power',
          description: '',
          salePrice: 390,
          taxRate: 0,
          posCategoryCode: 'MIS',
          posCategoryName: 'Misc',
          prepStation: 'BARISTA',
          itemType: 'MADE_TO_ORDER',
          productionMode: 'MADE_TO_ORDER',
          sortOrder: 999,
          imageUrl: PROTEIN_IMAGE_URL,
          addOnGroupIds: ['beverage_add_on'],
          addOnOptionIdsByGroup: { beverage_add_on: [...BEVERAGE_OPTIONS] },
          isActive: true,
          isSellable: true,
          isAvailable: true,
          availableStoreIds: [...PROTEIN_STORE_IDS],
          bom: [{ componentCode: 'PROTEIN_POWER_BASE', quantity: 350 }],
          bomVersion: 10,
        },
      },
      {
        id: TEMPORARY_PROTEIN_CODE,
        data: {
          code: TEMPORARY_PROTEIN_CODE,
          name: '36 gm Protein Power',
          displayName: '36 gm Protein Power',
          salePrice: 390,
          taxRate: 5,
          posCategoryCode: 'MIS',
          posCategoryName: 'Misc',
          prepStation: 'BARISTA',
          itemType: 'MADE_TO_ORDER',
          sortOrder: 0,
          bom: [],
          bomVersion: 1,
          isActive: true,
          isSellable: true,
          isAvailable: true,
          availableStoreIds: [...TEMP_STORE_IDS],
        },
      },
      {
        id: MEZZE_CODE,
        data: {
          code: MEZZE_CODE,
          name: 'Mediterranean Mezze Platter',
          salePrice: 390,
          taxRate: 5,
          posCategoryCode: 'ESP',
          posCategoryName: 'Espresso Bar',
          prepStation: 'KITCHEN',
          productionMode: 'ASSEMBLED_TO_ORDER',
          isActive: true,
          isSellable: true,
          isAvailable: true,
          availableStoreIds: [GOLDEN_I_STORE_ID],
        },
      },
    ],
    menuItems: [
      {
        id: LEGACY_PROTEIN_CODE,
        data: { code: LEGACY_PROTEIN_CODE, name: '36G Protien Power', isActive: true, availableStoreIds: [] },
      },
    ],
    publicMenuAvailability: [
      {
        id: GOLDEN_I_STORE_ID,
        data: {
          storeId: GOLDEN_I_STORE_ID,
          storeCode: GOLDEN_I_STORE_ID,
          storeName: 'Golden I',
          itemCount: 80,
          availableCount: 80,
          unavailableCount: 0,
          menuItems: {
            GREEN: snapshotMenuEntry('GREEN', { name: 'Green', displayName: 'Green', salePrice: 250 }),
            [MEZZE_CODE]: snapshotMenuEntry(MEZZE_CODE, {
              name: 'Mediterranean Mezze Platter', displayName: 'Mediterranean Mezze Platter',
              posCategoryCode: 'ESP', posCategoryName: 'Espresso Bar',
              prepStation: 'KITCHEN', productionMode: 'ASSEMBLED_TO_ORDER', taxRate: 5,
              addOnGroupIds: ['food_add_on'],
              addOnOptionIdsByGroup: { food_add_on: [...FOOD_OPTIONS] },
            }),
          },
          items: {
            GREEN: availabilityEntry('GREEN'),
            [MEZZE_CODE]: availabilityEntry(MEZZE_CODE),
          },
          addOnGroups: { food_add_on: { id: 'food_add_on', name: 'Food add on' } },
        },
      },
    ],
  };
}

/** Variant where the duplicate IS published in the Golden I snapshot. */
function replacementInput() {
  const input = baseInput();
  const snapshot = input.publicMenuAvailability[0].data;
  snapshot.menuItems[TEMPORARY_PROTEIN_CODE] = snapshotMenuEntry(TEMPORARY_PROTEIN_CODE, {
    name: '36 gm Protein Power', displayName: '36 gm Protein Power', taxRate: 5, sortOrder: 0,
  });
  snapshot.items[TEMPORARY_PROTEIN_CODE] = availabilityEntry(TEMPORARY_PROTEIN_CODE);
  return input;
}

const plan = buildPosMenuCorrectnessPlan(baseInput());
const replacementPlan = buildPosMenuCorrectnessPlan(replacementInput());

// --- Plan envelope ---------------------------------------------------------
test('plan carries schemaVersion, generatedAt, project id and target store',
  plan.schemaVersion === SCHEMA_VERSION
  && plan.generatedAt === '2026-08-04T00:00:00.000Z'
  && plan.projectId === PROJECT_ID
  && plan.targetStore === GOLDEN_I_STORE_ID);
test('plan is ready for owner approval with no blockers', plan.status === 'READY_FOR_OWNER_APPROVAL' && plan.blockers.length === 0);

// --- 1. Exactly four operations -------------------------------------------
test('1. planner emits exactly four document operations', plan.operations.length === EXPECTED_OPERATION_COUNT);
test('1. proposedWriteCount matches the operation list', plan.proposedWriteCount === EXPECTED_OPERATION_COUNT);
test('1. operations target exactly the four approved documents',
  JSON.stringify(plan.operations.map((operation) => operation.path).sort())
  === JSON.stringify([...ALLOWED_WRITE_PATHS].sort()));
test('1. the replacement variant also emits four operations', replacementPlan.operations.length === EXPECTED_OPERATION_COUNT);

// --- 2. Deterministic checksum --------------------------------------------
const rebuilt = buildPosMenuCorrectnessPlan(baseInput());
test('2. checksum is stable across identical runs', rebuilt.checksum === plan.checksum);
test('2. checksum is a sha256 hex digest', /^[0-9a-f]{64}$/.test(plan.checksum));

const laterClock = buildPosMenuCorrectnessPlan({ ...baseInput(), generatedAt: '2027-01-01T00:00:00.000Z' });
test('2. checksum ignores generatedAt', laterClock.checksum === plan.checksum && laterClock.generatedAt !== plan.generatedAt);

const shuffled = baseInput();
shuffled.finishedGoods.reverse();
shuffled.finishedGoods[0].data = Object.fromEntries(Object.entries(shuffled.finishedGoods[0].data).reverse());
test('2. checksum ignores document and field ordering', buildPosMenuCorrectnessPlan(shuffled).checksum === plan.checksum);
test('2. canonicalize sorts object keys at every depth',
  canonicalize({ b: 1, a: { d: 2, c: 3 } }) === '{"a":{"c":3,"d":2},"b":1}');

const mutated = baseInput();
mutated.finishedGoods[0].data.availableStoreIds = [...PROTEIN_STORE_IDS, 'ANOTHER_STORE'];
test('2. checksum changes when the planned payload changes', buildPosMenuCorrectnessPlan(mutated).checksum !== plan.checksum);

const mutatedPrice = replacementInput();
mutatedPrice.finishedGoods[0].data.salePrice = 400;
test('2. checksum tracks the published entry payload', buildPosMenuCorrectnessPlan(mutatedPrice).checksum !== replacementPlan.checksum);
test('2. the replacement variant has its own distinct checksum', replacementPlan.checksum !== plan.checksum);

// --- Operation 1: authoritative product gains Golden I --------------------
const proteinOperation = plan.operations.find((operation) => operation.path === `finishedGoods/${AUTHORITATIVE_PROTEIN_CODE}`);
test('op1 touches only availableStoreIds', JSON.stringify(proteinOperation.fieldPaths) === JSON.stringify(['availableStoreIds']));
test('op1 appends GOLDEN_I and preserves every prior store',
  JSON.stringify(proteinOperation.after.availableStoreIds) === JSON.stringify([...PROTEIN_STORE_IDS, GOLDEN_I_STORE_ID]));
test('op1 rollback restores the exact prior assignments',
  JSON.stringify(proteinOperation.rollback.availableStoreIds) === JSON.stringify(PROTEIN_STORE_IDS));

// --- Operation 2: duplicate loses Golden I only ---------------------------
const temporaryOperation = plan.operations.find((operation) => operation.path === `finishedGoods/${TEMPORARY_PROTEIN_CODE}`);
test('op2 touches only availableStoreIds', JSON.stringify(temporaryOperation.fieldPaths) === JSON.stringify(['availableStoreIds']));
test('op2 removes exactly GOLDEN_I and nothing else',
  JSON.stringify(temporaryOperation.after.availableStoreIds) === JSON.stringify(TEMP_STORE_IDS_WITHOUT_GOLDEN));
test('op2 preserves BAKED_BY_BOND_51 and every other store',
  temporaryOperation.after.availableStoreIds.includes('BAKED_BY_BOND_51')
  && temporaryOperation.after.availableStoreIds.length === TEMP_STORE_IDS.length - 1);
test('op2 rollback restores Golden I on the duplicate',
  JSON.stringify(temporaryOperation.rollback.availableStoreIds) === JSON.stringify(TEMP_STORE_IDS));
test('op2 never deletes or deactivates the duplicate',
  temporaryOperation.type === 'update'
  && !('isActive' in temporaryOperation.after)
  && !('isSellable' in temporaryOperation.after)
  && !('isAvailable' in temporaryOperation.after));

// --- Operation 3: Mezze category ------------------------------------------
const mezzeOperation = plan.operations.find((operation) => operation.path === `finishedGoods/${MEZZE_CODE}`);
test('op3 touches only the two category fields',
  JSON.stringify(mezzeOperation.fieldPaths) === JSON.stringify(['posCategoryCode', 'posCategoryName']));
test('op3 sets the approved category',
  mezzeOperation.after.posCategoryCode === MEZZE_CATEGORY.code && mezzeOperation.after.posCategoryName === MEZZE_CATEGORY.name);
test('op3 rollback restores ESP / Espresso Bar',
  mezzeOperation.rollback.posCategoryCode === 'ESP' && mezzeOperation.rollback.posCategoryName === 'Espresso Bar');

// --- Operation 4: snapshot -------------------------------------------------
const snapshotOperation = plan.operations.find((operation) => operation.path === `publicMenuAvailability/${GOLDEN_I_STORE_ID}`);
test('op4 never writes itemCount or availableCount',
  !snapshotOperation.fieldPaths.includes('itemCount') && !snapshotOperation.fieldPaths.includes('availableCount'));
test('op4 leaves the catalogue at 80 items',
  plan.evidence.goldenSnapshotCounts.after.itemCount === 80
  && plan.evidence.goldenSnapshotCounts.after.availableCount === 80
  && plan.evidence.goldenSnapshotCounts.catalogueMembershipChanged === false);
test('op4 does NOT publish the authoritative entry when the duplicate is absent from the catalogue',
  !snapshotOperation.fieldPaths.includes(`menuItems.${AUTHORITATIVE_PROTEIN_CODE}`));
test('op4 corrects only the Mezze category when the duplicate is absent',
  JSON.stringify(snapshotOperation.fieldPaths) === JSON.stringify([
    `menuItems.${MEZZE_CODE}.posCategoryCode`,
    `menuItems.${MEZZE_CODE}.posCategoryName`,
  ]));

// Replacement variant: swap in place, counts untouched.
const replacementSnapshot = replacementPlan.operations.find((operation) => operation.path === `publicMenuAvailability/${GOLDEN_I_STORE_ID}`);
test('op4 replacement deletes exactly the duplicate entries',
  isDeleteSentinel(replacementSnapshot.after[`menuItems.${TEMPORARY_PROTEIN_CODE}`])
  && isDeleteSentinel(replacementSnapshot.after[`items.${TEMPORARY_PROTEIN_CODE}`]));
test('op4 replacement publishes the authoritative entries',
  replacementSnapshot.after[`menuItems.${AUTHORITATIVE_PROTEIN_CODE}`].code === AUTHORITATIVE_PROTEIN_CODE
  && replacementSnapshot.after[`items.${AUTHORITATIVE_PROTEIN_CODE}`].available === true);
test('op4 replacement is net-zero on catalogue size and writes no counts',
  !replacementSnapshot.fieldPaths.includes('itemCount')
  && !replacementSnapshot.fieldPaths.includes('availableCount')
  && replacementPlan.evidence.goldenSnapshotCounts.after.itemCount === 80);
test('op4 replacement rollback restores the duplicate and removes the authoritative entries',
  JSON.stringify(replacementSnapshot.rollback[`menuItems.${TEMPORARY_PROTEIN_CODE}`].code) === JSON.stringify(TEMPORARY_PROTEIN_CODE)
  && isDeleteSentinel(replacementSnapshot.rollback[`menuItems.${AUTHORITATIVE_PROTEIN_CODE}`])
  && isDeleteSentinel(replacementSnapshot.rollback[`items.${AUTHORITATIVE_PROTEIN_CODE}`]));

// --- 3. Complete Protein snapshot entry, not placeholder prose -------------
const proteinEntry = replacementSnapshot.after[`menuItems.${AUTHORITATIVE_PROTEIN_CODE}`];
const proteinAvailability = replacementSnapshot.after[`items.${AUTHORITATIVE_PROTEIN_CODE}`];

test('3. Protein entry carries the code and document reference',
  proteinEntry.id === AUTHORITATIVE_PROTEIN_CODE && proteinEntry.code === AUTHORITATIVE_PROTEIN_CODE);
test('3. Protein entry carries the authoritative name', proteinEntry.name === '36G Protein Power' && proteinEntry.displayName === '36G Protein Power');
test('3. Protein entry carries the authoritative price', proteinEntry.salePrice === 390);
test('3. Protein entry carries the authoritative category', proteinEntry.posCategoryCode === 'MIS' && proteinEntry.posCategoryName === 'Misc');
test('3. Protein entry carries the KOT route', proteinEntry.prepStation === 'BARISTA');
test('3. Protein entry carries active/sellable/available status',
  proteinEntry.isActive === true && proteinEntry.isSellable === true && proteinEntry.isAvailable === true);
test('3. Protein entry carries the Golden I store assignment',
  JSON.stringify(proteinEntry.availableStoreIds) === JSON.stringify([GOLDEN_I_STORE_ID]));
test('3. Protein entry carries add-on references',
  JSON.stringify(proteinEntry.addOnGroupIds) === JSON.stringify(['beverage_add_on'])
  && JSON.stringify(proteinEntry.addOnOptionIdsByGroup.beverage_add_on) === JSON.stringify(BEVERAGE_OPTIONS));
test('3. Protein entry carries the image reference', proteinEntry.imageUrl === PROTEIN_IMAGE_URL);
test('3. Protein entry carries itemType, productionMode and sortOrder',
  proteinEntry.itemType === 'MADE_TO_ORDER' && proteinEntry.productionMode === 'MADE_TO_ORDER' && proteinEntry.sortOrder === 999);
test('3. Protein availability entry carries status and reason',
  proteinAvailability.itemCode === AUTHORITATIVE_PROTEIN_CODE
  && proteinAvailability.fgCode === AUTHORITATIVE_PROTEIN_CODE
  && proteinAvailability.available === true
  && proteinAvailability.publicStatus === 'AVAILABLE'
  && proteinAvailability.publicMessage === 'Available');
test('3. Protein entry contains no placeholder prose',
  !/\baction\b|approved|placeholder|TODO|after Finished Good|source/i.test(JSON.stringify(proteinEntry)));
test('3. Protein entry field set matches the live snapshot schema',
  Object.keys(proteinEntry).every((key) => [
    'id', 'code', 'name', 'displayName', 'description', 'posCategoryCode', 'posCategoryName',
    'salePrice', 'prepStation', 'itemType', 'sortOrder', 'availableStoreIds', 'isSellable',
    'isAvailable', 'isActive', 'productionMode', 'taxRate', 'imageUrl', 'addOnGroupIds',
    'addOnOptionIdsByGroup',
  ].includes(key)));

const refreshSource = fs.readFileSync(path.join(scriptsDir, 'refresh-public-menu-availability.mjs'), 'utf8');
const canonicalBuilderFields = [...refreshSource
  .slice(refreshSource.indexOf('function sanitizedDisplayItem'), refreshSource.indexOf('function sanitizedAddOnGroup'))
  .matchAll(/display\.([a-zA-Z]+)\s*=|^\s{4}([a-zA-Z]+):/gm)]
  .map((match) => match[1] || match[2])
  .filter(Boolean);
const maximalEntry = buildPublicMenuDisplayEntry(GOLDEN_I_STORE_ID, {
  ...baseInput().finishedGoods[0].data, description: 'Cold protein shake', taxRate: 5,
});
test('3. builder stays in sync with the canonical sanitizedDisplayItem source',
  canonicalBuilderFields.length > 0 && canonicalBuilderFields.every((field) => field in maximalEntry));

// --- TAX: fallback chain, duplicate rate never copied ---------------------
test('TAX. the duplicate 5% rate is never copied onto the authoritative entry',
  !('taxRate' in proteinEntry) && plan.evidence.gst.duplicateRateCopied === false);
test('TAX. the authoritative product resolves to a positive rate via the app default',
  plan.evidence.gst.resolvedRate === 5
  && plan.evidence.gst.resolvedSource === 'appSettings/gstConfig.defaultGstRate'
  && plan.evidence.gst.authoritativeItemTaxRate === 0);
test('TAX. a zero item rate falls through rather than zero-rating',
  resolveEffectiveGst({ item: { taxRate: 0 }, store: null, gstConfig: { defaultGstRate: 5 }, storeCode: GOLDEN_I_STORE_ID }).rate === 5);
test('TAX. a store override wins over the application default',
  resolveEffectiveGst({ item: { taxRate: 0 }, store: null, gstConfig: { defaultGstRate: 5, storeOverrides: { [GOLDEN_I_STORE_ID]: 12 } }, storeCode: GOLDEN_I_STORE_ID }).rate === 12);
test('TAX. a positive item rate wins over every fallback',
  resolveEffectiveGst({ item: { taxRate: 18 }, store: null, gstConfig: { defaultGstRate: 5 }, storeCode: GOLDEN_I_STORE_ID }).rate === 18);
test('TAX. the store document is consulted before the application default',
  resolveEffectiveGst({ item: {}, store: { gstRate: 9 }, gstConfig: { defaultGstRate: 5 }, storeCode: GOLDEN_I_STORE_ID }).rate === 9);

const zeroRated = baseInput();
zeroRated.gstConfig = { defaultGstRate: 0, storeOverrides: {} };
const zeroRatedPlan = buildPosMenuCorrectnessPlan(zeroRated);
test('TAX. the plan is BLOCKED if the product would become zero-rated',
  zeroRatedPlan.status === 'BLOCKED'
  && zeroRatedPlan.blockers.some((blocker) => blocker.reason.includes('zero-rated')));
test('TAX. a zero-rated plan is refused by the apply tool', verifyPlanScope(zeroRatedPlan).ok === false);

// --- POS visibility: exactly one Protein item -----------------------------
test('POS. only the temporary duplicate is visible at Golden I before the change',
  JSON.stringify(plan.evidence.goldenIPosVisibility.before) === JSON.stringify([TEMPORARY_PROTEIN_CODE]));
test('POS. the count of visible Protein products never exceeds one',
  plan.evidence.goldenIPosVisibility.before.length === 1
  && plan.evidence.goldenIPosVisibility.after.length === 1);
test('POS. a plan that did not withdraw the duplicate would expose two products',
  proteinCodesVisibleAtGoldenI([
    { id: AUTHORITATIVE_PROTEIN_CODE, data: { isActive: true, availableStoreIds: [...PROTEIN_STORE_IDS, GOLDEN_I_STORE_ID] } },
    { id: TEMPORARY_PROTEIN_CODE, data: { isActive: true, availableStoreIds: [...TEMP_STORE_IDS] } },
  ], GOLDEN_I_STORE_ID).length === 2);
test('POS. exactly one Protein product is visible at Golden I after the change',
  plan.evidence.goldenIPosVisibility.after.length === 1
  && plan.evidence.goldenIPosVisibility.after[0] === AUTHORITATIVE_PROTEIN_CODE);
test('POS. the legacy typo item is never visible at Golden I',
  !plan.evidence.goldenIPosVisibility.before.includes(LEGACY_PROTEIN_CODE)
  && !plan.evidence.goldenIPosVisibility.after.includes(LEGACY_PROTEIN_CODE));
test('POS. the duplicate remains visible at its other stores',
  proteinCodesVisibleAtGoldenI(
    [{ id: TEMPORARY_PROTEIN_CODE, data: { isActive: true, availableStoreIds: temporaryOperation.after.availableStoreIds } }],
    'BAKED_BY_BOND_51',
  ).length === 1);

// --- Blocked rather than guessed ------------------------------------------
const incomplete = baseInput();
incomplete.finishedGoods[0].data.salePrice = 0;
const incompletePlan = buildPosMenuCorrectnessPlan(incomplete);
test('planner blocks instead of guessing when the Finished Good is incomplete', incompletePlan.status === 'BLOCKED');
test('a blocked plan is refused by the apply tool', verifyPlanScope(incompletePlan).ok === false);

// --- 4/5/6. Gates ----------------------------------------------------------
test('4. wrong checksum is rejected', verifyChecksum(plan, 'deadbeef'.repeat(8)).ok === false);
test('4. absent checksum is rejected', verifyChecksum(plan, null).ok === false);
test('4. exact checksum is accepted', verifyChecksum(plan, plan.checksum).ok === true);
test('4. the replacement plan checksum does not unlock the base plan', verifyChecksum(plan, replacementPlan.checksum).ok === false);
test('5. missing confirmation is rejected', parseApplyArgs(['--apply', '--checksum', plan.checksum]).gatesSatisfied === false);
test('5. near-miss confirmation phrase is rejected',
  parseApplyArgs(['--apply', '--checksum', plan.checksum, '--confirm', 'apply golden i menu corrections']).gatesSatisfied === false);
test('5. trailing-whitespace confirmation phrase is rejected',
  parseApplyArgs(['--apply', '--checksum', plan.checksum, '--confirm', `${CONFIRM_PHRASE} `]).gatesSatisfied === false);
test('5. all three gates together are accepted',
  parseApplyArgs(['--apply', '--checksum', plan.checksum, '--confirm', CONFIRM_PHRASE]).gatesSatisfied === true);
test('6. missing --apply leaves the tool in dry-run',
  parseApplyArgs(['--checksum', plan.checksum, '--confirm', CONFIRM_PHRASE]).gatesSatisfied === false);
test('6. bare invocation is dry-run', parseApplyArgs([]).gatesSatisfied === false && parseApplyArgs([]).apply === false);

const applySource = fs.readFileSync(path.join(scriptsDir, 'apply-pos-menu-correctness.mjs'), 'utf8');
test('6. no write API is reachable before the gates are satisfied',
  applySource.indexOf('gates.gatesSatisfied') < applySource.indexOf('runTransaction')
  && applySource.indexOf('verifyChecksum(plan, gates.checksum)') < applySource.indexOf('runTransaction'));

// --- 7/8/9. Precondition drift aborts -------------------------------------
function liveDocuments(input) {
  const byPath = {};
  for (const document of input.finishedGoods) byPath[`finishedGoods/${document.id}`] = document.data;
  for (const document of input.publicMenuAvailability) byPath[`publicMenuAvailability/${document.id}`] = document.data;
  return byPath;
}

test('preconditions pass against unchanged documents', verifyPreconditions(plan, liveDocuments(baseInput())).ok === true);

const driftStores = baseInput();
driftStores.finishedGoods[0].data.availableStoreIds = [...PROTEIN_STORE_IDS, 'SOME_OTHER_STORE'];
test('7. changed authoritative availableStoreIds aborts the apply',
  verifyPreconditions(plan, liveDocuments(driftStores)).ok === false);

const driftDuplicate = baseInput();
driftDuplicate.finishedGoods[1].data.availableStoreIds = ['BAKED_BY_BOND_51'];
test('7. changed duplicate availableStoreIds aborts the apply',
  verifyPreconditions(plan, liveDocuments(driftDuplicate)).ok === false);

const driftMezze = baseInput();
driftMezze.finishedGoods[2].data.posCategoryCode = 'FOOD';
const mezzeDrift = verifyPreconditions(plan, liveDocuments(driftMezze));
test('8. changed Mezze category aborts the apply',
  mezzeDrift.ok === false && mezzeDrift.failures.some((failure) => failure.includes('posCategoryCode')));

const driftSnapshot = baseInput();
driftSnapshot.publicMenuAvailability[0].data.menuItems[MEZZE_CODE].posCategoryName = 'Changed';
test('9. changed Golden I snapshot aborts the apply', verifyPreconditions(plan, liveDocuments(driftSnapshot)).ok === false);

const lateDuplicatePublish = verifyPreconditions(replacementPlan, liveDocuments(baseInput()));
test('9. a snapshot that no longer matches the planned before-state aborts the apply', lateDuplicatePublish.ok === false);

const missingDocument = liveDocuments(baseInput());
delete missingDocument[`finishedGoods/${MEZZE_CODE}`];
test('9. a missing target document aborts the apply', verifyPreconditions(plan, missingDocument).ok === false);

// --- 10. Atomicity ---------------------------------------------------------
function setByPath(target, fieldPath, value) {
  const segments = fieldPath.split('.');
  let cursor = target;
  for (const segment of segments.slice(0, -1)) {
    if (typeof cursor[segment] !== 'object' || cursor[segment] === null) cursor[segment] = {};
    cursor = cursor[segment];
  }
  if (value === '__DELETE__') delete cursor[segments.at(-1)];
  else cursor[segments.at(-1)] = value;
}

/** Mirrors the apply tool's transaction body: read all, verify all, then write all. */
function simulateTransaction(currentPlan, documents) {
  const staged = clone(documents);
  const writes = buildTransactionWrites(currentPlan);
  const check = verifyPreconditions(currentPlan, staged);
  if (!check.ok) return { committedWriteCount: 0, documents, aborted: true, failures: check.failures };
  for (const write of writes) {
    for (const [fieldPath, value] of Object.entries(write.updates)) {
      setByPath(staged[write.path], fieldPath, value);
    }
  }
  return { committedWriteCount: writes.length, documents: staged, aborted: false, failures: [] };
}

const before = liveDocuments(baseInput());
const applied = simulateTransaction(plan, before);
test('10. a clean apply commits exactly four document writes', applied.committedWriteCount === EXPECTED_OPERATION_COUNT);

const abortedRun = simulateTransaction(plan, liveDocuments(driftMezze));
test('10. a drifting apply commits zero writes', abortedRun.committedWriteCount === 0 && abortedRun.aborted === true);
test('10. a drifting apply leaves every document untouched',
  JSON.stringify(abortedRun.documents) === JSON.stringify(liveDocuments(driftMezze)));
test('10. the apply tool verifies preconditions inside the transaction before writing',
  applySource.includes('transaction.getAll')
  && applySource.indexOf('verifyPreconditions(plan, transactional)') < applySource.indexOf('transaction.update'));
test('10. the apply tool uses a single transaction, not per-document writes',
  (applySource.match(/runTransaction/g) || []).length === 1 && !applySource.includes('.set('));
test('10. deletions go through FieldValue.delete inside the transaction',
  applySource.includes('buildTransactionWrites(plan, FieldValue.delete())'));

const replacementBefore = liveDocuments(replacementInput());
const replacementApplied = simulateTransaction(replacementPlan, replacementBefore);
const replacedSnapshot = replacementApplied.documents[`publicMenuAvailability/${GOLDEN_I_STORE_ID}`];
test('10. the replacement swap removes the duplicate and adds the authoritative entry',
  !(TEMPORARY_PROTEIN_CODE in replacedSnapshot.menuItems)
  && !(TEMPORARY_PROTEIN_CODE in replacedSnapshot.items)
  && AUTHORITATIVE_PROTEIN_CODE in replacedSnapshot.menuItems
  && AUTHORITATIVE_PROTEIN_CODE in replacedSnapshot.items);
test('10. the replacement swap keeps the catalogue size unchanged',
  Object.keys(replacedSnapshot.menuItems).length === Object.keys(replacementBefore[`publicMenuAvailability/${GOLDEN_I_STORE_ID}`].menuItems).length
  && Object.keys(replacedSnapshot.items).length === Object.keys(replacementBefore[`publicMenuAvailability/${GOLDEN_I_STORE_ID}`].items).length);
test('10. the replacement swap leaves the stored counts at 80',
  replacedSnapshot.itemCount === 80 && replacedSnapshot.availableCount === 80);

// --- 11. Unrelated fields unchanged ---------------------------------------
const proteinAfterDoc = applied.documents[`finishedGoods/${AUTHORITATIVE_PROTEIN_CODE}`];
const proteinBeforeDoc = before[`finishedGoods/${AUTHORITATIVE_PROTEIN_CODE}`];
test('11. Protein price, GST, BOM and every other field are untouched',
  proteinAfterDoc.salePrice === proteinBeforeDoc.salePrice
  && proteinAfterDoc.taxRate === proteinBeforeDoc.taxRate
  && JSON.stringify(proteinAfterDoc.bom) === JSON.stringify(proteinBeforeDoc.bom)
  && proteinAfterDoc.bomVersion === proteinBeforeDoc.bomVersion
  && proteinAfterDoc.posCategoryCode === proteinBeforeDoc.posCategoryCode);

const temporaryAfterDoc = applied.documents[`finishedGoods/${TEMPORARY_PROTEIN_CODE}`];
const temporaryBeforeDoc = before[`finishedGoods/${TEMPORARY_PROTEIN_CODE}`];
test('11. the duplicate keeps every field except availableStoreIds',
  Object.keys(temporaryBeforeDoc)
    .filter((key) => key !== 'availableStoreIds')
    .every((key) => JSON.stringify(temporaryAfterDoc[key]) === JSON.stringify(temporaryBeforeDoc[key])));
test('11. the duplicate document still exists and stays active',
  Boolean(temporaryAfterDoc) && temporaryAfterDoc.isActive === true && temporaryAfterDoc.isSellable === true);
test('11. the duplicate keeps its price, GST and identity',
  temporaryAfterDoc.salePrice === 390 && temporaryAfterDoc.taxRate === 5 && temporaryAfterDoc.code === TEMPORARY_PROTEIN_CODE);

const mezzeAfterDoc = applied.documents[`finishedGoods/${MEZZE_CODE}`];
test('11. Mezze price, GST and prep station are untouched',
  mezzeAfterDoc.salePrice === 390 && mezzeAfterDoc.taxRate === 5 && mezzeAfterDoc.prepStation === 'KITCHEN');

const snapshotAfterDoc = applied.documents[`publicMenuAvailability/${GOLDEN_I_STORE_ID}`];
const snapshotBeforeDoc = before[`publicMenuAvailability/${GOLDEN_I_STORE_ID}`];
test('11. unrelated snapshot entries are unchanged field-for-field',
  JSON.stringify(snapshotAfterDoc.menuItems.GREEN) === JSON.stringify(snapshotBeforeDoc.menuItems.GREEN)
  && JSON.stringify(snapshotAfterDoc.items.GREEN) === JSON.stringify(snapshotBeforeDoc.items.GREEN)
  && JSON.stringify(snapshotAfterDoc.addOnGroups) === JSON.stringify(snapshotBeforeDoc.addOnGroups));
test('11. the Mezze snapshot entry keeps every non-category field',
  snapshotAfterDoc.menuItems[MEZZE_CODE].salePrice === 390
  && snapshotAfterDoc.menuItems[MEZZE_CODE].taxRate === 5
  && snapshotAfterDoc.menuItems[MEZZE_CODE].prepStation === 'KITCHEN'
  && JSON.stringify(snapshotAfterDoc.menuItems[MEZZE_CODE].addOnOptionIdsByGroup.food_add_on) === JSON.stringify(FOOD_OPTIONS));
test('11. the catalogue still holds exactly 80 items and counts are untouched',
  snapshotAfterDoc.itemCount === 80 && snapshotAfterDoc.availableCount === 80 && snapshotAfterDoc.unavailableCount === 0);
test('11. snapshot store identity fields are unchanged',
  snapshotAfterDoc.storeId === GOLDEN_I_STORE_ID && snapshotAfterDoc.storeName === 'Golden I');

// --- 12. Out-of-scope documents never appear ------------------------------
const allOperationPaths = plan.operations.map((operation) => operation.path);
test('12. the legacy typo menu item is never in the write plan',
  !allOperationPaths.includes(`menuItems/${LEGACY_PROTEIN_CODE}`));
test('12. the legacy typo item is reported as a warning instead',
  plan.warnings.some((warning) => warning.path === `menuItems/${LEGACY_PROTEIN_CODE}`));
test('12. the duplicate withdrawal is documented as preserving history',
  plan.warnings.some((warning) => warning.path === `finishedGoods/${TEMPORARY_PROTEIN_CODE}`
    && warning.reason.includes('historical references are preserved')));
test('12. the duplicate GST discrepancy is surfaced as a warning, not a write',
  plan.warnings.some((warning) => warning.reason.includes('is NOT copied')));
test('12. plan scope verification accepts the approved plan', verifyPlanScope(plan).ok === true);
test('12. plan scope verification accepts the replacement plan', verifyPlanScope(replacementPlan).ok === true);

const smuggled = clone(plan);
smuggled.operations.push({ type: 'update', path: `menuItems/${LEGACY_PROTEIN_CODE}`, fieldPaths: ['isActive'], before: {}, after: { isActive: false }, rollback: {} });
smuggled.proposedWriteCount = 5;
test('12. plan scope verification rejects a smuggled fifth operation', verifyPlanScope(smuggled).ok === false);

const overreach = clone(plan);
const overreachOperation = overreach.operations.find((operation) => operation.path === `finishedGoods/${TEMPORARY_PROTEIN_CODE}`);
overreachOperation.fieldPaths.push('isActive');
overreachOperation.after.isActive = false;
test('12. plan scope verification rejects deactivating the duplicate', verifyPlanScope(overreach).ok === false);

const overRemoval = clone(plan);
const overRemovalOperation = overRemoval.operations.find((operation) => operation.path === `finishedGoods/${TEMPORARY_PROTEIN_CODE}`);
overRemovalOperation.after.availableStoreIds = ['BAKED_BY_BOND_51'];
test('12. plan scope verification rejects removing more than GOLDEN_I from the duplicate',
  verifyPlanScope(overRemoval).ok === false);

// --- 13. Follow-up dry run proposes zero writes ---------------------------
const followUpInput = baseInput();
followUpInput.finishedGoods[0].data = applied.documents[`finishedGoods/${AUTHORITATIVE_PROTEIN_CODE}`];
followUpInput.finishedGoods[1].data = applied.documents[`finishedGoods/${TEMPORARY_PROTEIN_CODE}`];
followUpInput.finishedGoods[2].data = applied.documents[`finishedGoods/${MEZZE_CODE}`];
followUpInput.publicMenuAvailability[0].data = applied.documents[`publicMenuAvailability/${GOLDEN_I_STORE_ID}`];
const followUpPlan = buildPosMenuCorrectnessPlan(followUpInput);
test('13. follow-up dry run proposes zero writes',
  followUpPlan.status === 'NO_CHANGES_REQUIRED'
  && followUpPlan.operations.length === 0
  && followUpPlan.proposedWriteCount === 0);
test('13. an already-applied plan can no longer be applied', verifyPlanScope(followUpPlan).ok === false);
test('13. the follow-up state shows exactly one Protein product at Golden I',
  followUpPlan.evidence.goldenIPosVisibility.before.length === 1
  && followUpPlan.evidence.goldenIPosVisibility.before[0] === AUTHORITATIVE_PROTEIN_CODE);

const replacementFollowUp = replacementInput();
replacementFollowUp.finishedGoods[0].data = replacementApplied.documents[`finishedGoods/${AUTHORITATIVE_PROTEIN_CODE}`];
replacementFollowUp.finishedGoods[1].data = replacementApplied.documents[`finishedGoods/${TEMPORARY_PROTEIN_CODE}`];
replacementFollowUp.finishedGoods[2].data = replacementApplied.documents[`finishedGoods/${MEZZE_CODE}`];
replacementFollowUp.publicMenuAvailability[0].data = replacementApplied.documents[`publicMenuAvailability/${GOLDEN_I_STORE_ID}`];
test('13. follow-up dry run after the replacement variant also proposes zero writes',
  buildPosMenuCorrectnessPlan(replacementFollowUp).operations.length === 0);

// --- Post-apply verification ----------------------------------------------
const postApply = verifyPostApply(plan, applied.documents, before);
test('post-apply verification passes on a correct apply', postApply.ok === true && postApply.checks.length >= 14);
test('post-apply verification confirms GOLDEN_I was added and prior stores kept',
  postApply.checks.find((check) => check.name.includes('GOLDEN_I added')).passed === true
  && postApply.checks.find((check) => check.name.includes('previous store assignments preserved')).passed === true);
test('post-apply verification confirms exactly one Protein product remains visible',
  postApply.checks.find((check) => check.name.includes('exactly one 36 g Protein')).passed === true);
test('post-apply verification confirms the duplicate document survives',
  postApply.checks.find((check) => check.name.includes('duplicate document preserved')).passed === true);
test('post-apply verification passes on the replacement variant',
  verifyPostApply(replacementPlan, replacementApplied.documents, replacementBefore).ok === true);

const tampered = clone(applied.documents);
tampered[`publicMenuAvailability/${GOLDEN_I_STORE_ID}`].menuItems.GREEN.salePrice = 999;
test('post-apply verification catches drift in an unrelated snapshot entry',
  verifyPostApply(plan, tampered, before).ok === false);

const tamperedDuplicate = clone(applied.documents);
tamperedDuplicate[`finishedGoods/${TEMPORARY_PROTEIN_CODE}`].isActive = false;
test('post-apply verification catches deactivation of the duplicate',
  verifyPostApply(plan, tamperedDuplicate, before).ok === false);

const deletedDuplicate = clone(applied.documents);
delete deletedDuplicate[`finishedGoods/${TEMPORARY_PROTEIN_CODE}`];
test('post-apply verification catches deletion of the duplicate',
  verifyPostApply(plan, deletedDuplicate, before).ok === false);

const bothVisible = clone(applied.documents);
bothVisible[`finishedGoods/${TEMPORARY_PROTEIN_CODE}`].availableStoreIds = [...TEMP_STORE_IDS];
test('post-apply verification catches both Protein products being visible',
  verifyPostApply(plan, bothVisible, before).ok === false);

// --- 14. No order/payment/KOT/stock paths ---------------------------------
const writePaths = buildTransactionWrites(plan).map((write) => write.path);
test('14. every write path is on the approved allowlist',
  writePaths.every((writePath) => ALLOWED_WRITE_PATHS.includes(writePath)));
const applyBodyOutsideDenyList = applySource.replace(/export const FORBIDDEN_COLLECTIONS = \[[\s\S]*?\];/, '');
test('14. the apply tool opens no forbidden collection',
  FORBIDDEN_COLLECTIONS.every((collection) => !applySource.includes(`collection('${collection}')`)
    && !applySource.includes(`collection("${collection}")`)));
test('14. the apply tool references no order, payment, KOT or stock path outside the deny list',
  !/createOrder|recordPayment|kotRoute|stockMovement|storeStock|\borders\b|\bpayments\b/i.test(applyBodyOutsideDenyList));
test('14. the apply tool only resolves collections from the plan operation paths',
  (applySource.match(/firestore\.collection\(/g) || []).length === 1
  && applySource.includes('const [collection, documentId] = write.path.split(\'/\')'));
test('14. the legacy typo item remains a forbidden write target',
  FORBIDDEN_WRITE_PATHS.includes(`menuItems/${LEGACY_PROTEIN_CODE}`) && verifyPlanScope(smuggled).ok === false);

console.log(`POS menu correctness tests passed (${passed.length} assertions).`);
