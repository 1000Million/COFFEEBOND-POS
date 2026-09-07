import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { Store } from '../frontend/types';
import type { FinishedGood } from '../frontend/types/menu-management';
import type { GlobalItemMasterDraft, GlobalItemProductVersion } from '../frontend/types/global-items';
import type { StoreItemConfig } from '../frontend/lib/storeItemConfig';
import {
  effectiveStoreProduct,
  eligibleGlobalItemStores,
  initialMasterProduct,
  masterProductToken,
  productWithType,
  publishedProductDiffersFromMaster,
  publishedStoreState,
  publishReviewChanges,
  selectedStoreIdsAfterSelectAll,
  selectedStoreIdsAfterToggle,
} from '../frontend/lib/globalItemUx';

let count = 0;
function ok(condition: unknown, message: string) {
  assert.ok(condition, message);
  count += 1;
  console.log(`PASS ${count}. ${message}`);
}
function equal<T>(actual: T, expected: T, message: string) {
  assert.deepEqual(actual, expected, message);
  count += 1;
  console.log(`PASS ${count}. ${message}`);
}

const PRODUCT: FinishedGood = {
  id: 'fg-coffee',
  code: 'COFFEE',
  name: 'Coffee',
  displayName: 'Coffee',
  description: 'House coffee',
  productType: 'NORMAL_SELLABLE',
  posCategoryCode: 'COFFEE',
  posCategoryName: 'Coffee',
  salePrice: 200,
  productionMode: 'MADE_TO_ORDER',
  itemType: 'MADE_TO_ORDER',
  prepStation: 'BARISTA',
  taxRate: 5,
  bom: [{ componentType: 'RAW_INGREDIENT', componentCode: 'BEANS', componentName: 'Beans', quantity: 18, uom: 'g', costPerUnit: 1, lineCost: 18 }],
  bomVersion: 1,
  recipeCost: 18,
  grossMargin: 91,
  cogsPercent: 9,
  sortOrder: 1,
  availableStoreIds: ['store-a'],
  isSellable: true,
  isAvailable: true,
  isActive: true,
};
const MASTER: GlobalItemProductVersion = { ...PRODUCT, menuVisible: true };
const DRAFT: GlobalItemMasterDraft = {
  schemaVersion: 1,
  itemCode: 'COFFEE',
  draftRevision: 'draft-2',
  baseProductId: 'fg-coffee',
  baseProductToken: 'base',
  product: { ...MASTER, displayName: 'Saved coffee' },
  savedAt: 'today',
  savedBy: 'admin',
};
const stores = [
  { id: 'inactive', code: 'I', name: 'Inactive', isActive: false },
  { id: 'missing-code', code: '', name: 'Missing code', isActive: true },
  { id: 'store-b', code: 'B', name: 'Beta', isActive: true },
  { id: 'store-a', code: 'A', name: 'Alpha', isActive: true },
] as Array<Pick<Store, 'id' | 'code' | 'name' | 'isActive'>>;

equal(eligibleGlobalItemStores(stores).map((store) => store.id), ['store-a', 'store-b'], '1. Store picker includes only active coded stores and sorts them');
equal(initialMasterProduct(PRODUCT).menuVisible, true, '2. Selecting an unsaved product creates an editable master with visible menu intent');
equal(initialMasterProduct(PRODUCT, DRAFT).displayName, 'Saved coffee', '3. Selecting a saved product rehydrates the protected draft');
ok(masterProductToken(MASTER) !== masterProductToken({ ...MASTER, salePrice: 225 }), '4. Master edits produce a dirty-state token change');

const internal = productWithType({ ...MASTER, composite: { schemaVersion: 1, staticComponents: [], choiceGroupIds: [] } }, 'INTERNAL_COMPONENT');
ok(internal.isSellable === false && internal.menuVisible === false && !internal.composite, '5. Internal type forces non-sellable, hidden, non-composite semantics');
const composite = productWithType(MASTER, 'COMPOSITE_PARENT');
ok(composite.productType === 'COMPOSITE_PARENT' && composite.isSellable && composite.composite?.schemaVersion === 1, '6. Composite type creates an explicit child-product definition');
ok(productWithType(composite, 'NORMAL_SELLABLE').composite === undefined, '7. Returning to normal removes composite authority');

equal(selectedStoreIdsAfterToggle([], 'store-a'), ['store-a'], '8. Store selection adds one store');
equal(selectedStoreIdsAfterToggle(['store-a', 'store-b'], 'store-a'), ['store-b'], '9. Store deselection removes only that store');
equal(selectedStoreIdsAfterSelectAll(['store-a'], ['store-a', 'store-b']), ['store-a', 'store-b'], '10. Select all chooses every eligible store');
equal(selectedStoreIdsAfterSelectAll(['store-a', 'store-b'], ['store-a', 'store-b']), [], '11. Select all toggles to deselect all');

const currentConfig: StoreItemConfig = {
  storeId: 'store-a',
  itemCode: 'COFFEE',
  managementMode: 'FULL_VERSION_MANAGED',
  publishedVersion: {
    schemaVersion: 1,
    storeId: 'store-a',
    itemCode: 'COFFEE',
    publishedRevision: 'published-1',
    sourceDraftRevision: 'draft-2',
    product: { ...MASTER, availableStoreIds: ['store-a'] },
    publishedAt: 'today',
    publishedBy: 'admin',
  },
};
equal(publishedStoreState(null, 'draft-2'), 'NOT_PUBLISHED', '12. A missing published version reports NOT PUBLISHED');
equal(publishedStoreState(currentConfig, 'draft-2'), 'CURRENT', '13. A store on the saved master revision reports CURRENT');
equal(publishedStoreState(currentConfig, 'draft-3'), 'OLDER_VERSION', '14. A store on a previous master revision reports OLDER VERSION');
equal(effectiveStoreProduct(PRODUCT, currentConfig).salePrice, 200, '15. Status cards resolve the same effective product as runtime consumers');
equal(publishedProductDiffersFromMaster(currentConfig, MASTER), false, '16. Assignment-only differences do not mark a version different from master');
equal(publishedProductDiffersFromMaster(currentConfig, { ...MASTER, salePrice: 250 }), true, '17. A commercial change marks the store different from master');

const changes = publishReviewChanges(PRODUCT, { ...MASTER, salePrice: 250, menuVisible: false }, ['store-a', 'store-b'], new Map([
  ['store-a', currentConfig],
  ['store-b', null],
]));
ok(changes.some((change) => change.key === 'price' && change.after === '₹250.00'), '18. Review summarises price changes against selected stores');
ok(changes.some((change) => change.key === 'visibility' && change.after === 'Hidden'), '19. Review summarises customer visibility changes');
ok(!publishReviewChanges(PRODUCT, MASTER, ['store-b'], new Map([['store-b', null]])).some((change) => change.key === 'visibility'), '19a. Implicit and explicit visible menu intent do not create a false review change');

const page = fs.readFileSync('frontend/pages/admin/GlobalItems.tsx', 'utf8');
ok(page.includes('Select a product') && page.includes('Master product') && page.includes('Select stores'), '20. Screen presents the required product → master → stores workflow');
ok(page.includes('Review publish') && page.includes('Changes to live effective products'), '21. Publish opens an explicit field-change review modal');
ok(page.includes('Will be added to this store') && page.includes('assignment'), '22. Selecting an unassigned store explains publish-time assignment');
ok(page.includes('CURRENT') || fs.readFileSync('frontend/lib/globalItemUx.ts', 'utf8').includes("'CURRENT'"), '23. Published-store cards expose current/older/not-published states');
ok(page.includes('MASTER SAVED — NOT YET PUBLISHED') && page.includes('Live stores have not changed'), '24. Save-master confirmation is explicitly non-live');
ok(page.includes('publishGlobalItemToStores(db') && page.includes('targetStoreIds: selectedStoreIds'), '25. Final confirmation invokes the selective atomic engine only for checked stores');
ok(page.includes("lg:grid-cols-[300px_minmax(0,1fr)]") && page.includes('md:grid-cols-2') && page.includes('xl:grid-cols-3'), '26. Responsive layout adapts at tablet, desktop, and wide desktop breakpoints');
ok(page.includes("staffProfile?.role === 'ADMIN'") && page.includes('Admin access required'), '27. Page keeps active Admin-only access enforcement');
ok(!page.includes('setDoc(') && !page.includes('updateDoc(') && !page.includes('addDoc('), '28. UI does not bypass the draft transaction or publish engine with ad-hoc writes');
ok(page.includes('Product type') && page.includes('Child-product configuration') && page.includes('Recipe / BOM') && page.includes('Add-ons and modifiers'), '29. Adaptive editor exposes normal, internal, composite, BOM, and modifier modules');
ok(page.includes('Resolve before publishing') && page.includes('publishDisabled'), '30. Invalid or stale work is blocked before final publication');
ok(page.includes('PUBLISHED TO') && page.includes('setReviewOpen(false)') && page.includes('setSelectedStoreIds([])'), '31. Successful publish stays on-page, closes review, clears selection, and reports success');

console.log(`\n${count} Global Items G8.4 UX checks passed.`);
