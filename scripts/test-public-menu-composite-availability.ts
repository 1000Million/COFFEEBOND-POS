import assert from 'node:assert/strict';
import { buildPublicMenuAvailabilitySnapshot } from '../frontend/lib/publicMenuAvailability';
import type { Store } from '../frontend/types';
import type { AddOnGroup, FinishedGood, RawIngredient } from '../frontend/types/menu-management';

const STORE_ID = 'TASTING_ROOM_29';
let assertions = 0;

function check(actual: unknown, expected: unknown, message?: string) {
  assert.equal(actual, expected, message);
  assertions += 1;
}

function store(id = STORE_ID): Store {
  return {
    id,
    code: id,
    name: id,
    address: '',
    isActive: true,
    posEnabled: true,
    customerOrderingEnabled: true,
    onlineOrderingEnabled: true,
    publicOrderingEnabled: true,
    acceptingOrders: true,
    isAcceptingOrders: true,
    estimatedPrepMinutes: 20,
    createdAt: null,
    updatedAt: null,
  };
}

function raw(code: string): RawIngredient {
  return {
    id: code,
    code,
    name: code,
    category: 'TEST',
    purchaseUOM: 'PCS',
    usageUOM: 'PCS',
    conversionFactor: 1,
    purchaseCost: 10,
    costPerUsageUnit: 10,
    isActive: true,
  };
}

function child(code: string, overrides: Partial<FinishedGood> = {}): FinishedGood {
  return {
    id: code,
    code,
    name: code,
    posCategoryCode: 'TR_INTERNAL_COMPONENTS',
    posCategoryName: 'Internal components',
    salePrice: 0,
    productionMode: 'MADE_TO_ORDER',
    itemType: 'MADE_TO_ORDER',
    prepStation: 'KITCHEN',
    taxRate: 0,
    bom: [{
      componentType: 'RAW_INGREDIENT',
      componentCode: `${code}_RAW`,
      componentName: `${code} raw`,
      quantity: 1,
      uom: 'PCS',
      costPerUnit: 10,
      lineCost: 10,
    }],
    bomVersion: 1,
    recipeCost: 10,
    grossMargin: 0,
    cogsPercent: 0,
    sortOrder: 100,
    availableStoreIds: [STORE_ID],
    isSellable: false,
    isAvailable: true,
    isActive: true,
    ...overrides,
  };
}

function parent(
  staticCodes: string[],
  overrides: Partial<FinishedGood> = {},
): FinishedGood {
  return {
    id: 'TR_PARENT',
    code: 'TR_PARENT',
    name: 'Composite parent',
    posCategoryCode: 'TASTING_FLIGHTS',
    posCategoryName: 'Tasting Flights',
    salePrice: 595,
    productionMode: 'MADE_TO_ORDER',
    itemType: 'MADE_TO_ORDER',
    prepStation: 'NONE',
    taxRate: 5,
    bom: [],
    bomVersion: 1,
    recipeCost: 0,
    grossMargin: 0,
    cogsPercent: 0,
    sortOrder: 1,
    availableStoreIds: [STORE_ID],
    isSellable: true,
    isAvailable: true,
    isActive: true,
    composite: {
      schemaVersion: 1,
      staticComponents: staticCodes.map(code => ({
        finishedGoodId: code,
        finishedGoodCode: code,
        quantity: 1,
      })),
      choiceGroupIds: [],
    },
    ...overrides,
  };
}

function snapshot(
  finishedGoods: FinishedGood[],
  rawIngredients: RawIngredient[],
  addOnGroups: AddOnGroup[] = [],
  selectedStore = store(),
) {
  return buildPublicMenuAvailabilitySnapshot({
    store: selectedStore,
    finishedGoods,
    rawIngredients,
    addOnGroups,
    storeStock: [],
  });
}

const bun = child('TR_BUN');
const dip = child('TR_DIP');
const complete = snapshot(
  [parent([bun.code, dip.code]), bun, dip],
  [raw('TR_BUN_RAW'), raw('TR_DIP_RAW')],
);
check(complete.items.TR_PARENT.available, true, 'a wrapper without its own BOM is available when every child is ready');
check(complete.items.TR_PARENT.publicStatus, 'AVAILABLE');
check(complete.itemCount, 1, 'hidden child Finished Goods must not be published as menu items');
check(complete.menuItems.TR_BUN, undefined);
check(complete.menuItems.TR_DIP, undefined);

const incompleteChild = child('TR_DIP', { bom: [] });
const incomplete = snapshot(
  [parent([bun.code, incompleteChild.code]), bun, incompleteChild],
  [raw('TR_BUN_RAW'), raw('TR_DIP_RAW')],
);
check(incomplete.items.TR_PARENT.available, false);
check(incomplete.items.TR_PARENT.publicStatus, 'SETUP_INCOMPLETE', 'one missing child BOM blocks its parent');

const unavailableChild = child('TR_DIP', { isAvailable: false });
const unavailable = snapshot(
  [parent([bun.code, unavailableChild.code]), bun, unavailableChild],
  [raw('TR_BUN_RAW'), raw('TR_DIP_RAW')],
);
check(unavailable.items.TR_PARENT.available, false);
check(unavailable.items.TR_PARENT.publicStatus, 'CURRENTLY_UNAVAILABLE');

const wrongStoreChild = child('TR_DIP', { availableStoreIds: [] });
const wrongStore = snapshot(
  [parent([bun.code, wrongStoreChild.code]), bun, wrongStoreChild],
  [raw('TR_BUN_RAW'), raw('TR_DIP_RAW')],
);
check(wrongStore.items.TR_PARENT.available, false, 'composite children require explicit assignment to the logical sales store');
check(wrongStore.items.TR_PARENT.publicStatus, 'CURRENTLY_UNAVAILABLE');

const mismatchedReference = parent([bun.code], {
  composite: {
    schemaVersion: 1,
    staticComponents: [{ finishedGoodId: bun.code, finishedGoodCode: 'CHANGED_CODE', quantity: 1 }],
    choiceGroupIds: [],
  },
});
const mismatch = snapshot([mismatchedReference, bun], [raw('TR_BUN_RAW')]);
check(mismatch.items.TR_PARENT.publicStatus, 'SETUP_INCOMPLETE', 'id/code reference drift fails closed');

const fractionalReference = parent([bun.code], {
  composite: {
    schemaVersion: 1,
    staticComponents: [{ finishedGoodId: bun.code, finishedGoodCode: bun.code, quantity: 1.5 }],
    choiceGroupIds: [],
  },
});
const fractional = snapshot([fractionalReference, bun], [raw('TR_BUN_RAW')]);
check(fractional.items.TR_PARENT.publicStatus, 'SETUP_INCOMPLETE', 'fractional component quantities fail closed like checkout');

const invalidItemTypeChild = child('TR_INVALID_TYPE', { itemType: 'UNKNOWN' as FinishedGood['itemType'] });
const invalidItemType = snapshot(
  [parent([invalidItemTypeChild.code]), invalidItemTypeChild],
  [raw('TR_INVALID_TYPE_RAW')],
);
check(invalidItemType.items.TR_PARENT.publicStatus, 'SETUP_INCOMPLETE', 'invalid child item types fail closed like checkout');

const invalidProductionModeChild = child('TR_INVALID_MODE', {
  productionMode: 'UNKNOWN' as FinishedGood['productionMode'],
});
const invalidProductionMode = snapshot(
  [parent([invalidProductionModeChild.code]), invalidProductionModeChild],
  [raw('TR_INVALID_MODE_RAW')],
);
check(invalidProductionMode.items.TR_PARENT.publicStatus, 'SETUP_INCOMPLETE', 'invalid child production modes fail closed like checkout');

const unresolved = snapshot([
  parent([bun.code], {
    unresolvedCompositeRequirements: [{
      name: 'Two miniature drinks',
      quantity: 2,
      reason: 'Owner input required',
    }],
  }),
  bun,
], [raw('TR_BUN_RAW')]);
check(unresolved.items.TR_PARENT.publicStatus, 'SETUP_INCOMPLETE', 'explicit owner-data gaps fail closed');

const malformedUnresolved = snapshot([
  parent([bun.code], { unresolvedCompositeRequirements: {} as never }),
  bun,
], [raw('TR_BUN_RAW')]);
check(malformedUnresolved.items.TR_PARENT.publicStatus, 'SETUP_INCOMPLETE', 'malformed owner-data gap metadata fails closed');

const choiceA = child('TR_CHOICE_A');
const choiceB = child('TR_CHOICE_B');
const choiceGroup: AddOnGroup = {
  id: 'TR_PICK_ONE',
  name: 'Pick one',
  purpose: 'COMPOSITE_CHOICE',
  selectionMode: 'SINGLE',
  minimumSelections: 1,
  maximumSelections: 1,
  isRequired: true,
  isActive: true,
  options: [choiceA, choiceB].map((item, index) => ({
    id: `OPTION_${index + 1}`,
    code: `OPTION_${index + 1}`,
    name: item.name,
    price: 0,
    isActive: true,
    sortOrder: index + 1,
    finishedGoodComponent: {
      finishedGoodId: item.id!,
      finishedGoodCode: item.code,
      quantity: 1,
    },
  })),
};
const choiceParent = parent([bun.code], {
  addOnGroupIds: [choiceGroup.id!],
  addOnOptionIdsByGroup: { [choiceGroup.id!]: choiceGroup.options.map(option => option.id) },
  composite: {
    schemaVersion: 1,
    staticComponents: [{ finishedGoodId: bun.id!, finishedGoodCode: bun.code, quantity: 1 }],
    choiceGroupIds: [choiceGroup.id!],
  },
});
const readyChoice = snapshot(
  [choiceParent, bun, choiceA, choiceB],
  [raw('TR_BUN_RAW'), raw('TR_CHOICE_A_RAW'), raw('TR_CHOICE_B_RAW')],
  [choiceGroup],
);
check(readyChoice.items.TR_PARENT.available, true);
check(readyChoice.addOnGroups.TR_PICK_ONE.purpose, 'COMPOSITE_CHOICE');

const ordinaryExtraGroup: AddOnGroup = {
  id: 'TR_EXTRA_SAUCE',
  name: 'Extra sauce',
  purpose: 'ADD_ON',
  selectionMode: 'MULTIPLE',
  minimumSelections: 0,
  maximumSelections: 2,
  isActive: true,
  options: [{ id: 'SAUCE', code: 'SAUCE', name: 'Sauce', price: 20, isActive: true, sortOrder: 1 }],
};
const mixedGroupParent = parent([bun.code], {
  ...choiceParent,
  addOnGroupIds: [choiceGroup.id!, ordinaryExtraGroup.id!],
  addOnOptionIdsByGroup: {
    [choiceGroup.id!]: choiceGroup.options.map(option => option.id),
    [ordinaryExtraGroup.id!]: ordinaryExtraGroup.options.map(option => option.id),
  },
});
const mixedGroup = snapshot(
  [mixedGroupParent, bun, choiceA, choiceB],
  [raw('TR_BUN_RAW'), raw('TR_CHOICE_A_RAW'), raw('TR_CHOICE_B_RAW')],
  [choiceGroup, ordinaryExtraGroup],
);
check(mixedGroup.items.TR_PARENT.publicStatus, 'SETUP_INCOMPLETE', 'composites fail closed instead of silently dropping ordinary add-on inventory');

const invalidMultipleGroup: AddOnGroup = { ...choiceGroup, selectionMode: 'MULTIPLE' };
const invalidMultiple = snapshot(
  [choiceParent, bun, choiceA, choiceB],
  [raw('TR_BUN_RAW'), raw('TR_CHOICE_A_RAW'), raw('TR_CHOICE_B_RAW')],
  [invalidMultipleGroup],
);
check(invalidMultiple.items.TR_PARENT.publicStatus, 'SETUP_INCOMPLETE', 'ordinary MULTIPLE groups cannot drive composite choices');

const malformedSingleGroup: AddOnGroup = {
  ...choiceGroup,
  minimumSelections: 2,
  maximumSelections: 2,
};
const malformedSingle = snapshot(
  [choiceParent, bun, choiceA, choiceB],
  [raw('TR_BUN_RAW'), raw('TR_CHOICE_A_RAW'), raw('TR_CHOICE_B_RAW')],
  [malformedSingleGroup],
);
check(malformedSingle.items.TR_PARENT.publicStatus, 'SETUP_INCOMPLETE', 'single groups must declare satisfiable zero-or-one to one bounds');

const malformedExactGroup: AddOnGroup = {
  ...choiceGroup,
  selectionMode: 'EXACT_DISTINCT',
  minimumSelections: 2,
  maximumSelections: 3,
};
const malformedExact = snapshot(
  [choiceParent, bun, choiceA, choiceB],
  [raw('TR_BUN_RAW'), raw('TR_CHOICE_A_RAW'), raw('TR_CHOICE_B_RAW')],
  [malformedExactGroup],
);
check(malformedExact.items.TR_PARENT.publicStatus, 'SETUP_INCOMPLETE', 'exact-distinct groups require one exact positive count');

const choiceWithBrokenBom = child('TR_CHOICE_B', { bom: [] });
const blockedChoice = snapshot(
  [choiceParent, bun, choiceA, choiceWithBrokenBom],
  [raw('TR_BUN_RAW'), raw('TR_CHOICE_A_RAW'), raw('TR_CHOICE_B_RAW')],
  [choiceGroup],
);
check(blockedChoice.items.TR_PARENT.publicStatus, 'SETUP_INCOMPLETE', 'every selectable child must be ready');

const malformedParentBom = snapshot([
  parent([bun.code], {
    bom: [{
      componentType: 'RAW_INGREDIENT',
      componentCode: 'MISSING_PARENT_RAW',
      componentName: 'Missing',
      quantity: 1,
      uom: 'PCS',
      costPerUnit: 0,
      lineCost: 0,
    }],
  }),
  bun,
], [raw('TR_BUN_RAW')]);
check(malformedParentBom.items.TR_PARENT.publicStatus, 'SETUP_INCOMPLETE', 'a declared parent BOM is still verified');

const ordinaryMissingBom = parent([], {
  id: 'ORDINARY_MADE_TO_ORDER',
  code: 'ORDINARY_MADE_TO_ORDER',
  composite: undefined,
});
const ordinaryNoStock = parent([], {
  id: 'ORDINARY_NO_STOCK',
  code: 'ORDINARY_NO_STOCK',
  itemType: 'NO_STOCK',
  productionMode: 'NO_STOCK',
  composite: undefined,
});
const ordinary = snapshot([ordinaryMissingBom, ordinaryNoStock], []);
check(ordinary.items.ORDINARY_MADE_TO_ORDER.publicStatus, 'SETUP_INCOMPLETE');
check(ordinary.items.ORDINARY_NO_STOCK.publicStatus, 'AVAILABLE', 'ordinary products retain their existing availability behavior');

const goldenChild = child('TR_GOLDEN_CHILD', { availableStoreIds: ['GOLDEN_I'], bom: [] });
const goldenParent = parent([goldenChild.code], { availableStoreIds: ['GOLDEN_I'] });
const golden = snapshot([goldenParent, goldenChild], [raw('TR_GOLDEN_CHILD_RAW')], [], store('GOLDEN_I'));
check(golden.items.TR_PARENT.publicStatus, 'SETUP_INCOMPLETE', 'Golden I cannot bypass composite child readiness');

console.log(`public menu composite availability tests passed (${assertions}/${assertions})`);
