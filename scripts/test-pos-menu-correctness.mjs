import assert from 'node:assert/strict';
import {
  AUTHORITATIVE_PROTEIN_CODE,
  GOLDEN_I_STORE_ID,
  LEGACY_PROTEIN_CODE,
  MEZZE_CATEGORY,
  MEZZE_CODE,
  TEMPORARY_PROTEIN_CODE,
  buildPosMenuCorrectnessPlan,
} from './pos-menu-correctness-plan.mjs';

function doc(id, data) {
  return { id, data: { code: id, ...data } };
}

const plan = buildPosMenuCorrectnessPlan({
  finishedGoods: [
    doc(AUTHORITATIVE_PROTEIN_CODE, {
      name: '36G Protein Power',
      isActive: true,
      isSellable: true,
      isAvailable: true,
      availableStoreIds: ['UDAY_PARK'],
      posCategoryCode: 'MIS',
      posCategoryName: 'Misc',
    }),
    doc(TEMPORARY_PROTEIN_CODE, {
      name: '36 gm Protein Power',
      isActive: true,
      isSellable: true,
      isAvailable: true,
      availableStoreIds: [GOLDEN_I_STORE_ID, 'UDAY_PARK'],
      posCategoryCode: 'MIS',
      posCategoryName: 'Misc',
    }),
    doc(MEZZE_CODE, {
      name: 'Mediterranean Mezze Platter',
      isActive: true,
      isSellable: true,
      isAvailable: true,
      availableStoreIds: [GOLDEN_I_STORE_ID],
      posCategoryCode: 'ESP',
      posCategoryName: 'Espresso Bar',
    }),
  ],
  menuItems: [
    doc(LEGACY_PROTEIN_CODE, {
      code: LEGACY_PROTEIN_CODE,
      name: '36G Protien Power',
      isActive: true,
      availableStoreIds: [],
    }),
  ],
  publicMenuAvailability: [
    doc(GOLDEN_I_STORE_ID, {
      menuItems: {
        [MEZZE_CODE]: {
          code: MEZZE_CODE,
          posCategoryCode: 'ESP',
          posCategoryName: 'Espresso Bar',
        },
      },
      items: {},
    }),
  ],
});

assert.equal(plan.status, 'READY_FOR_OWNER_APPROVAL');
assert(plan.operations.some(operation => (
  operation.path === `finishedGoods/${AUTHORITATIVE_PROTEIN_CODE}`
  && operation.after.availableStoreIds.includes(GOLDEN_I_STORE_ID)
)), 'Authoritative 36G Protein must be assigned to Golden I.');
assert(plan.operations.some(operation => (
  operation.path === `finishedGoods/${MEZZE_CODE}`
  && operation.after.posCategoryCode === MEZZE_CATEGORY.code
  && operation.after.posCategoryName === MEZZE_CATEGORY.name
)), 'Mediterranean Mezze must be moved to Always at Bond.');
assert(plan.operations.some(operation => (
  operation.path === `publicMenuAvailability/${GOLDEN_I_STORE_ID}`
  && operation.after[`menuItems.${MEZZE_CODE}.posCategoryCode`] === MEZZE_CATEGORY.code
  && operation.after[`menuItems.${AUTHORITATIVE_PROTEIN_CODE}`]
)), 'Golden I public snapshot must receive the 36G product and corrected Mezze category.');
assert(plan.warnings.some(warning => warning.path === `finishedGoods/${TEMPORARY_PROTEIN_CODE}`), 'Temporary duplicate must be reported but not deleted.');
assert(plan.warnings.some(warning => warning.path === `menuItems/${LEGACY_PROTEIN_CODE}`), 'Legacy typo-coded menuItem must be reported but unchanged.');

const idempotent = buildPosMenuCorrectnessPlan({
  finishedGoods: [
    doc(AUTHORITATIVE_PROTEIN_CODE, {
      name: '36G Protein Power',
      availableStoreIds: ['UDAY_PARK', GOLDEN_I_STORE_ID],
      posCategoryCode: 'MIS',
      posCategoryName: 'Misc',
    }),
    doc(TEMPORARY_PROTEIN_CODE, {
      name: '36 gm Protein Power',
      availableStoreIds: ['UDAY_PARK'],
    }),
    doc(MEZZE_CODE, {
      name: 'Mediterranean Mezze Platter',
      availableStoreIds: [GOLDEN_I_STORE_ID],
      posCategoryCode: MEZZE_CATEGORY.code,
      posCategoryName: MEZZE_CATEGORY.name,
    }),
  ],
  menuItems: [
    doc(LEGACY_PROTEIN_CODE, {
      name: '36G Protien Power',
      isActive: false,
      availableStoreIds: [],
    }),
  ],
  publicMenuAvailability: [
    doc(GOLDEN_I_STORE_ID, {
      menuItems: {
        [AUTHORITATIVE_PROTEIN_CODE]: { code: AUTHORITATIVE_PROTEIN_CODE },
        [MEZZE_CODE]: {
          code: MEZZE_CODE,
          posCategoryCode: MEZZE_CATEGORY.code,
          posCategoryName: MEZZE_CATEGORY.name,
        },
      },
      items: {
        [AUTHORITATIVE_PROTEIN_CODE]: { available: true, publicStatus: 'AVAILABLE' },
      },
    }),
  ],
});
assert.equal(idempotent.status, 'NO_CHANGES_REQUIRED');
assert.equal(idempotent.operations.length, 0);

console.log('POS menu correctness tests passed.');
