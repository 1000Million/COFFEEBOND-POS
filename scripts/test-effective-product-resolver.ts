// G8.1: version schema + canonical effective-product precedence and zero-change fallback.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import {
  GLOBAL_ITEM_MASTER_DRAFT_COLLECTION,
  GLOBAL_ITEM_VERSION_SCHEMA_VERSION,
  globalItemMasterDraftDocId,
  globalItemMasterDraftDocPath,
  type GlobalItemProductVersion,
  type PublishedStoreProductVersion,
} from '../frontend/types/global-items';
import {
  resolveEffectiveProduct,
  resolveStoreItem,
  storeItemConfigDocPath,
  type StoreItemConfig,
} from '../frontend/lib/storeItemConfig';
import type { FinishedGood } from '../frontend/types/menu-management';

const require = createRequire(import.meta.url);
const serverPolicy = require(resolve(process.cwd(), 'functions/storeItemConfigPolicy.js')) as {
  GLOBAL_ITEM_VERSION_SCHEMA_VERSION: number;
  resolveEffectiveProduct: (item: FinishedGood, config?: StoreItemConfig | null) => FinishedGood;
};

const GOLDEN = 'GOLDEN_I';
const NOIDA_29 = 'NOIDA_29';
let checks = 0;
const ok = (condition: unknown, message: string) => {
  assert.ok(condition, message);
  checks += 1;
  console.log(`PASS ${checks}. ${message}`);
};
const eq = (actual: unknown, expected: unknown, message: string) => {
  assert.deepEqual(actual, expected, `${message} (got ${JSON.stringify(actual)})`);
  checks += 1;
  console.log(`PASS ${checks}. ${message}`);
};

function product(code: string, fields: Partial<FinishedGood> = {}): FinishedGood {
  return {
    id: code,
    code,
    name: 'Affogato',
    displayName: 'Affogato',
    description: 'Espresso over gelato',
    imageUrl: 'https://storage.googleapis.com/menu/affogato-v1.webp',
    imageStoragePath: 'menu/affogato-v1.webp',
    categoryId: 'SPECIALTY',
    categoryCode: 'SPECIALTY',
    categoryName: 'Specialty',
    posCategoryCode: 'COFFEE',
    posCategoryName: 'Coffee',
    salePrice: 280,
    itemType: 'MADE_TO_ORDER',
    productionMode: 'MADE_TO_ORDER',
    prepStation: 'BARISTA',
    taxRate: 5,
    addOnGroupIds: ['MILK'],
    addOnOptionIdsByGroup: { MILK: ['OAT'] },
    bom: [{
      componentType: 'RAW_INGREDIENT', componentCode: 'ESPRESSO', componentName: 'Espresso',
      quantity: 30, uom: 'ML', costPerUnit: 1, lineCost: 30,
    }],
    bomVersion: 1,
    recipeCost: 30,
    grossMargin: 250,
    cogsPercent: 10.71,
    sortOrder: 40,
    availableStoreIds: [GOLDEN, NOIDA_29],
    isSellable: true,
    isAvailable: true,
    isActive: true,
    ...fields,
  };
}

function publishedVersion(
  storeId: string,
  base: FinishedGood,
  fields: Partial<GlobalItemProductVersion> = {},
): PublishedStoreProductVersion {
  return {
    schemaVersion: GLOBAL_ITEM_VERSION_SCHEMA_VERSION,
    storeId,
    itemCode: base.code,
    publishedRevision: 'published-revision-2',
    sourceDraftRevision: 'master-draft-2',
    previousPublishedRevision: 'published-revision-1',
    publishedAt: { seconds: 1, nanoseconds: 0 },
    publishedBy: 'admin-uid',
    publishedByName: 'Admin',
    product: {
      ...base,
      menuVisible: true,
      ...fields,
    },
  };
}

const base = product('AFFOGATO');

// Schema identity and deterministic document paths.
eq(GLOBAL_ITEM_VERSION_SCHEMA_VERSION, 1, 'Schema version is explicit');
eq(serverPolicy.GLOBAL_ITEM_VERSION_SCHEMA_VERSION, 1, 'Frontend and server use the same schema version');
eq(GLOBAL_ITEM_MASTER_DRAFT_COLLECTION, 'globalItemMasterDrafts', 'Master drafts have a dedicated non-live collection');
eq(globalItemMasterDraftDocId('AFFOGATO'), 'AFFOGATO', 'Ordinary item codes remain readable document IDs');
eq(globalItemMasterDraftDocId('A/B'), 'A%2FB', 'Unsafe path characters are encoded');
eq(globalItemMasterDraftDocPath('AFFOGATO'), 'globalItemMasterDrafts/AFFOGATO', 'Master draft path is deterministic');
eq(storeItemConfigDocPath(NOIDA_29, 'AFFOGATO'), 'storeItemConfig/v1|NOIDA_29|AFFOGATO', 'Published version reuses the existing deterministic store/item path');

// Exact no-published-version fallback. Strict reference identity is stronger than JSON parity.
assert.strictEqual(resolveEffectiveProduct(base), base);
checks += 1;
console.log(`PASS ${checks}. Missing config returns the exact existing FinishedGood object`);
assert.strictEqual(resolveEffectiveProduct(base, null), base);
checks += 1;
console.log(`PASS ${checks}. Null config returns the exact existing FinishedGood object`);
eq(serverPolicy.resolveEffectiveProduct(base), base, 'Server fallback is logically byte-identical');

const legacy: StoreItemConfig = {
  storeId: NOIDA_29,
  itemCode: base.code,
  priceOverride: 295,
  isAvailableOverride: false,
  menuVisibilityOverride: false,
  sortOrderOverride: 3,
};
const { appliedOverrides: _auditOnly, ...legacyEffectiveFields } = resolveStoreItem(base, legacy);
eq(resolveEffectiveProduct(base, legacy), legacyEffectiveFields, 'Legacy four-field behavior is preserved before first version publication');
eq(serverPolicy.resolveEffectiveProduct(base, legacy), resolveEffectiveProduct(base, legacy), 'Legacy frontend/server resolver parity');

// A complete published version wins as one unit, including all owner-approved fields.
const version = publishedVersion(NOIDA_29, base, {
  productType: 'NORMAL_SELLABLE',
  name: 'Affogato Nuovo',
  displayName: 'Affogato Nuovo',
  description: 'New description',
  imageUrl: 'https://storage.googleapis.com/menu/affogato-v2.webp',
  imageStoragePath: 'menu/affogato-v2.webp',
  categoryId: 'SIGNATURE',
  categoryCode: 'SIGNATURE',
  categoryName: 'Signature',
  posCategoryCode: 'SIGNATURE',
  posCategoryName: 'Signature',
  salePrice: 300,
  isAvailable: false,
  menuVisible: false,
  sortOrder: 9,
  taxRate: 12,
  prepStation: 'KITCHEN',
  addOnGroupIds: ['TOPPINGS'],
  addOnOptionIdsByGroup: { TOPPINGS: ['COCOA'] },
  bom: [{
    componentType: 'PREP_ITEM', componentCode: 'GELATO', componentName: 'Gelato',
    quantity: 1, uom: 'PCS', costPerUnit: 50, lineCost: 50,
  }],
  bomVersion: 2,
});
const versionedConfig: StoreItemConfig = {
  ...legacy,
  publishedVersion: version,
};
const effective = resolveEffectiveProduct(base, versionedConfig);
assert.strictEqual(effective, version.product);
checks += 1;
console.log(`PASS ${checks}. Published product snapshot is returned as one indivisible version`);
for (const [field, expected] of Object.entries({
  name: 'Affogato Nuovo',
  description: 'New description',
  imageUrl: 'https://storage.googleapis.com/menu/affogato-v2.webp',
  categoryId: 'SIGNATURE',
  salePrice: 300,
  isAvailable: false,
  menuVisible: false,
  sortOrder: 9,
  taxRate: 12,
  prepStation: 'KITCHEN',
  productType: 'NORMAL_SELLABLE',
  bomVersion: 2,
})) {
  eq((effective as unknown as Record<string, unknown>)[field], expected, `Published ${field} resolves from the selected store version`);
}
eq(effective.addOnGroupIds, ['TOPPINGS'], 'Published add-on mapping resolves from the selected store version');
eq(effective.bom[0].componentCode, 'GELATO', 'Published BOM resolves from the selected store version');
eq(effective.salePrice, 300, 'Published version supersedes a conflicting legacy price override');
eq(serverPolicy.resolveEffectiveProduct(base, versionedConfig), effective, 'Published frontend/server resolver parity');

const compositeBase = product('COMPOSITE', {
  productType: 'COMPOSITE_PARENT',
  prepStation: 'NONE',
  bom: [],
  composite: {
    schemaVersion: 1,
    staticComponents: [{ finishedGoodId: 'CHILD', finishedGoodCode: 'CHILD', quantity: 1 }],
    choiceGroupIds: [],
  },
});
const compositeVersion = publishedVersion(NOIDA_29, compositeBase, {
  productType: 'COMPOSITE_PARENT',
  composite: compositeBase.composite,
});
const compositeEffective = resolveEffectiveProduct(compositeBase, {
  storeId: NOIDA_29,
  itemCode: compositeBase.code,
  publishedVersion: compositeVersion,
});
eq(compositeEffective.productType, 'COMPOSITE_PARENT', 'Published composite role resolves from the selected store version');
eq(compositeEffective.composite, compositeBase.composite, 'Published composite child mapping remains intact');

// Store isolation and roll-forward behavior: another store without a version stays on base.
const noidaEffective = resolveEffectiveProduct(base, versionedConfig);
const goldenEffective = resolveEffectiveProduct(base);
eq(noidaEffective.salePrice, 300, 'Selected store resolves the published price');
eq(goldenEffective.salePrice, 280, 'Unpublished store retains its existing price');
eq(base.salePrice, 280, 'Resolving a publication never mutates the master fallback');
const laterMaster = { ...base, salePrice: 320 };
eq(resolveEffectiveProduct(laterMaster, versionedConfig).salePrice, 300, 'Later master edits do not roll a published store forward');
eq(resolveEffectiveProduct(laterMaster).salePrice, 320, 'A store without a version continues to use the current fallback');

// The verified production menu cardinalities cannot change through an identity resolver.
for (const count of [125, 128]) {
  const catalogue = Array.from({ length: count }, (_, index) => product(`ITEM_${index}`));
  const resolved = catalogue.map(item => resolveEffectiveProduct(item));
  eq(resolved.length, count, `No-version fallback preserves a ${count}-item menu count`);
  ok(resolved.every((item, index) => item === catalogue[index]), `All ${count} no-version products preserve reference identity`);
}

// Present-but-invalid publication data fails closed instead of mixing versions.
assert.throws(
  () => resolveEffectiveProduct(base, {
    storeId: NOIDA_29,
    itemCode: base.code,
    publishedVersion: { ...version, itemCode: 'OTHER' },
  }),
  /invalid/,
);
checks += 1;
console.log(`PASS ${checks}. Mismatched published item identity fails closed`);
assert.throws(
  () => resolveEffectiveProduct(base, {
    storeId: GOLDEN,
    itemCode: base.code,
    publishedVersion: version,
  }),
  /invalid/,
);
checks += 1;
console.log(`PASS ${checks}. Mismatched published store identity fails closed`);
assert.throws(
  () => resolveEffectiveProduct(base, {
    storeId: NOIDA_29,
    itemCode: base.code,
    publishedVersion: { ...version, schemaVersion: 2 as 1 },
  }),
  /invalid/,
);
checks += 1;
console.log(`PASS ${checks}. Unknown published schema version fails closed`);

console.log(`\n${checks} G8.1 effective-product checks passed.`);
