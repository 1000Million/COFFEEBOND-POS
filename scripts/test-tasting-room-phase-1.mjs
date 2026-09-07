#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  TASTING_ROOM_INVENTORY_STORE_ID,
  TASTING_ROOM_STORE_ID,
  buildTastingRoomPublicPreviewSnapshot,
  tastingRoomAddOnGroups,
  tastingRoomBomGapReport,
  tastingRoomCategories,
  tastingRoomFinishedGoods,
  tastingRoomInformationalExperiences,
  tastingRoomPhase1Catalog,
  tastingRoomPreviewStore,
  tastingRoomProductionGuardStore,
} from './tasting-room-phase-1-catalog.mjs';

const passed = [];
function test(name, fn) {
  fn();
  passed.push(name);
}

const displayedItems = tastingRoomFinishedGoods.filter((item) => item.productType !== 'INTERNAL_COMPONENT');
const internalComponents = tastingRoomFinishedGoods.filter((item) => item.productType === 'INTERNAL_COMPONENT');
const byCode = Object.fromEntries(tastingRoomFinishedGoods.map((item) => [item.code, item]));
const groupById = Object.fromEntries(tastingRoomAddOnGroups.map((group) => [group.id, group]));

test('preview store keeps logical and physical identities separate', () => {
  assert.equal(tastingRoomPreviewStore.id, TASTING_ROOM_STORE_ID);
  assert.equal(tastingRoomPreviewStore.inventoryStoreId, TASTING_ROOM_INVENTORY_STORE_ID);
  assert.equal(tastingRoomPreviewStore.physicalParentStoreId, TASTING_ROOM_INVENTORY_STORE_ID);
  assert.equal(tastingRoomPreviewStore.excludeFromNearestSelection, true);
});

test('production guard remains inactive and non-orderable', () => {
  assert.equal(tastingRoomProductionGuardStore.isActive, false);
  assert.equal(tastingRoomProductionGuardStore.onlineOrderingEnabled, false);
  assert.equal(tastingRoomProductionGuardStore.customerOrderingEnabled, false);
  assert.equal(tastingRoomProductionGuardStore.publicOrderingEnabled, false);
});

test('owner-approved menu contains exactly 21 display items and eight categories', () => {
  assert.equal(displayedItems.length, 21);
  assert.equal(tastingRoomCategories.length, 8);
  assert.deepEqual(displayedItems.map((item) => item.salePrice), [
    245, 395, 325, 695, 595, 425, 525, 425, 475, 575, 525, 475, 495, 350, 220,
    495, 595, 545, 595, 2795, 3100,
  ]);
});

test('BOM-incomplete preview items are visible but never orderable or NO_STOCK', () => {
  assert.ok(displayedItems.every((item) => item.isActive === true && item.isSellable === true));
  assert.ok(tastingRoomFinishedGoods.every((item) => item.isAvailable === false));
  assert.ok(tastingRoomFinishedGoods.every((item) => item.itemType !== 'NO_STOCK' && item.productionMode !== 'NO_STOCK'));
  assert.ok(tastingRoomFinishedGoods.every((item) => Array.isArray(item.bom) && item.bom.length === 0));
});

test('internal component Finished Goods remain hidden and BOM-blocked', () => {
  assert.equal(internalComponents.length, 14);
  assert.ok(internalComponents.every((item) => item.salePrice === 0 && item.isSellable === false));
  assert.ok(internalComponents.every((item) => ['BARISTA', 'KITCHEN'].includes(item.prepStation)));
});

test('every Tasting Room Finished Good has one explicit commercial role', () => {
  const composites = displayedItems.filter((item) => item.productType === 'COMPOSITE_PARENT');
  const normal = displayedItems.filter((item) => item.productType === 'NORMAL_SELLABLE');
  assert.equal(composites.length, 7);
  assert.equal(normal.length, 14);
  assert.equal(internalComponents.length, 14);
  assert.ok(composites.every((item) => item.composite && item.prepStation === 'NONE'));
  assert.ok(normal.every((item) => !item.composite));
});

test('fixed flights and Mini Affogato use independent component routing', () => {
  assert.equal(byCode.TR_COFFEE_THREE_WAYS.composite.staticComponents.length, 3);
  assert.equal(byCode.TR_WAKE_UP_WITH_BOND.composite.staticComponents.length, 3);
  assert.deepEqual(
    byCode.TR_MINI_AFFOGATO.composite.staticComponents.map((component) => byCode[component.finishedGoodId].prepStation),
    ['BARISTA', 'KITCHEN'],
  );
  assert.ok(['TR_COFFEE_THREE_WAYS', 'TR_WAKE_UP_WITH_BOND', 'TR_MINI_AFFOGATO']
    .every((code) => byCode[code].prepStation === 'NONE'));
});

for (const groupId of ['TR_COLD_BOND_DISTINCT_3', 'TR_ZERO_PROOF_DISTINCT_3']) {
  test(`${groupId} requires exactly three distinct component options`, () => {
    const group = groupById[groupId];
    assert.equal(group.purpose, 'COMPOSITE_CHOICE');
    assert.equal(group.selectionMode, 'EXACT_DISTINCT');
    assert.equal(group.minimumSelections, 3);
    assert.equal(group.maximumSelections, 3);
    assert.equal(group.options.length, 3);
    assert.equal(new Set(group.options.map((option) => option.finishedGoodComponent.finishedGoodId)).size, 3);
  });
}

test('Set A has exactly the approved Halloumi-or-pizza choices', () => {
  const group = groupById.TR_SET_A_MAIN_CHOICE;
  assert.equal(group.selectionMode, 'SINGLE');
  assert.equal(group.minimumSelections, 1);
  assert.equal(group.maximumSelections, 1);
  assert.deepEqual(group.options.map((option) => option.name), [
    'Charred Halloumi',
    'Blue Cheese, Pear & Walnut',
    'Shroom, Cheddar & Parmesan',
    'Tomato, Mozzarella',
  ]);
});

test('Set B has exactly the approved pasta-or-pizza choices', () => {
  const group = groupById.TR_SET_B_MAIN_CHOICE;
  assert.equal(group.selectionMode, 'SINGLE');
  assert.equal(group.minimumSelections, 1);
  assert.equal(group.maximumSelections, 1);
  assert.deepEqual(group.options.map((option) => option.name), [
    'Pasta Halloumi',
    '3 Cheese Pasta',
    'Blue Cheese, Pear & Walnut',
    'Shroom, Cheddar & Parmesan',
    'Tomato, Mozzarella',
  ]);
});

test('both sets explicitly block on the undefined miniature-drink selection', () => {
  for (const code of ['TR_SET_A', 'TR_SET_B']) {
    assert.deepEqual(byCode[code].unresolvedCompositeRequirements, [{
      name: 'Two miniature drinks',
      quantity: 2,
      reason: 'Owner must define the eligible miniature-drink Finished Goods.',
    }]);
  }
});

test('every Finished Good/component is covered by the exact machine-readable BOM gap schema', () => {
  const requiredKeys = [
    'ITEM',
    'REQUIRED COMPONENT/PREP ITEM',
    'KNOWN/UNKNOWN',
    'UNIT REQUIRED',
    'QUANTITY REQUIRED',
    'EXISTING ITEM MATCH IF FOUND',
    'OWNER INPUT REQUIRED',
  ];
  const covered = new Set(tastingRoomBomGapReport.map((row) => row.ITEM));
  assert.ok(tastingRoomFinishedGoods.every((item) => covered.has(item.displayName)));
  assert.ok(tastingRoomBomGapReport.every((row) => requiredKeys.every((key) => Object.hasOwn(row, key))));
  assert.ok(tastingRoomBomGapReport.every((row) => String(row['OWNER INPUT REQUIRED']).startsWith('YES')));
});

test('candidate matches remain review-only and never become a BOM automatically', () => {
  assert.match(tastingRoomPhase1Catalog.candidateEvidence.policy, /No existing BOM is automatically reused/);
  assert.ok(tastingRoomFinishedGoods.every((item) => item.bom.length === 0));
});

test('The Bond Table is informational and cannot create a cart, booking or payment', () => {
  const [experience] = tastingRoomInformationalExperiences;
  assert.equal(experience.title, 'THE BOND TABLE');
  assert.deepEqual(experience.moments, ['01 Welcome', '02 Spread', '03 Garden', '04 Fire', '05 Finish']);
  assert.equal(experience.cta, 'Ask about The Bond Table');
  assert.equal(experience.informationalOnly, true);
  assert.equal(experience.createsCartLine, false);
  assert.equal(experience.createsBooking, false);
  assert.equal(experience.createsPayment, false);
});

test('public preview snapshot exposes all 21 items as setup-incomplete and none as available', () => {
  const snapshot = buildTastingRoomPublicPreviewSnapshot();
  assert.equal(snapshot.storeId, TASTING_ROOM_STORE_ID);
  assert.equal(snapshot.itemCount, 21);
  assert.equal(snapshot.availableCount, 0);
  assert.equal(snapshot.unavailableCount, 21);
  assert.ok(Object.values(snapshot.items).every((item) => item.available === false && item.publicStatus === 'SETUP_INCOMPLETE'));
  assert.ok(!Object.values(snapshot.menuItems).some((item) => item.code === 'THE_BOND_TABLE'));
});

test('preview preparation target is isolated and production is explicitly forbidden', () => {
  assert.equal(tastingRoomPhase1Catalog.targetProject, 'coffee-bond-pos-preview');
  assert.equal(tastingRoomPhase1Catalog.productionProjectForbidden, 'coffee-bond-pos');
  assert.equal(tastingRoomPhase1Catalog.deepLink, '/?store=TASTING_ROOM_29');
  const productionRefresh = readFileSync(new URL('./refresh-public-menu-availability.mjs', import.meta.url), 'utf8');
  assert.match(productionRefresh, /PREVIEW_ONLY_STORE_CODES = new Set\(\['TASTING_ROOM_29'\]\)/);
  assert.match(productionRefresh, /This production refresh script cannot publish it/);
});

console.log(`Tasting Room Phase 1 catalog tests passed (${passed.length}/${passed.length}).`);
