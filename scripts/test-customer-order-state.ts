import assert from 'node:assert/strict';
import { deriveCustomerOrderingState } from '../frontend/lib/customerOrderingState';
import {
  buildPublicMenuAvailabilitySnapshot,
  isGoldenISetupWarningOnly,
} from '../frontend/lib/publicMenuAvailability';
import { Store } from '../frontend/types';

function store(overrides: Partial<Store> = {}): Store {
  return {
    id: 'GOLDEN_I',
    code: 'GOLDEN_I',
    name: 'Golden I',
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
    ...overrides,
  };
}

function snapshot(itemCount = 1) {
  return {
    menuItems: Object.fromEntries(Array.from({ length: itemCount }, (_, index) => [
      `ITEM_${index + 1}`,
      { code: `ITEM_${index + 1}` },
    ])),
  };
}

function assertNoAcceptingUnavailableContradiction(state: ReturnType<typeof deriveCustomerOrderingState>) {
  const accepts = state.statusLabel.toLowerCase().includes('accepting');
  const unavailable = state.message.toLowerCase().includes('unavailable');
  assert.equal(accepts && unavailable, false, 'state must not show accepting orders and unavailable message together');
}

{
  const state = deriveCustomerOrderingState({
    store: store({ onlineOrderingMessage: 'Pickup available in 15-20 minutes' }),
    availabilitySnapshot: snapshot(2),
    availabilityLoading: false,
    orderableItemCount: 2,
  });
  assert.equal(state.canAcceptOrders, true);
  assert.equal(state.statusLabel, 'Accepting orders');
  assert.equal(state.message, 'Pickup available in 15-20 minutes');
  assertNoAcceptingUnavailableContradiction(state);
}

{
  const state = deriveCustomerOrderingState({
    store: store({ onlineOrderingEnabled: false }),
    availabilitySnapshot: snapshot(2),
    availabilityLoading: false,
    orderableItemCount: 2,
  });
  assert.equal(state.canAcceptOrders, false);
  assert.equal(state.statusLabel, 'Temporarily unavailable');
  assert.match(state.message, /unavailable/i);
}

{
  const state = deriveCustomerOrderingState({
    store: store({ acceptingOrders: false }),
    availabilitySnapshot: snapshot(80),
    availabilityLoading: false,
    orderableItemCount: 80,
  });
  assert.equal(state.canAcceptOrders, false);
  assert.equal(state.statusLabel, 'Closed');
}

{
  const state = deriveCustomerOrderingState({
    store: store(),
    availabilitySnapshot: snapshot(2),
    availabilityLoading: false,
    orderableItemCount: 0,
  });
  assert.equal(state.canAcceptOrders, false);
  assert.equal(state.statusLabel, 'Menu unavailable');
  assert.match(state.message, /No items/i);
  assertNoAcceptingUnavailableContradiction(state);
}

{
  const staleSetupMessage = deriveCustomerOrderingState({
    store: store({ onlineOrderingMessage: 'Online ordering is currently unavailable for this store.' }),
    availabilitySnapshot: snapshot(2),
    availabilityLoading: false,
    orderableItemCount: 2,
  });
  assert.equal(staleSetupMessage.canAcceptOrders, true);
  assert.equal(staleSetupMessage.statusLabel, 'Accepting orders');
  assert.match(staleSetupMessage.message, /Pickup available/i);
  assertNoAcceptingUnavailableContradiction(staleSetupMessage);
}

{
  const firstStore = deriveCustomerOrderingState({
    store: store({ id: 'GOLDEN_I', code: 'GOLDEN_I' }),
    availabilitySnapshot: snapshot(1),
    availabilityLoading: false,
    orderableItemCount: 1,
  });
  const secondStore = deriveCustomerOrderingState({
    store: store({ id: 'UDAY_PARK', code: 'UDAY_PARK', onlineOrderingEnabled: false }),
    availabilitySnapshot: snapshot(1),
    availabilityLoading: false,
    orderableItemCount: 1,
  });
  assert.equal(firstStore.canAcceptOrders, true);
  assert.equal(secondStore.canAcceptOrders, false);
  assertNoAcceptingUnavailableContradiction(firstStore);
}

{
  const state = deriveCustomerOrderingState({
    store: store(),
    availabilitySnapshot: { menuItems: {} },
    availabilityLoading: false,
    orderableItemCount: 0,
  });
  assert.equal(state.canAcceptOrders, false);
  assert.equal(state.statusLabel, 'Menu unavailable');
  assert.match(state.message, /menu is being refreshed/i);
  assertNoAcceptingUnavailableContradiction(state);
}

{
  const setupIncompleteCodes = Array.from({ length: 11 }, (_, index) => `SETUP_INCOMPLETE_${index + 1}`);
  const finishedGoods = Array.from({ length: 80 }, (_, index) => {
    const setupIncomplete = index < setupIncompleteCodes.length;
    const code = setupIncomplete ? setupIncompleteCodes[index] : `READY_${index + 1}`;
    return {
      id: code,
      code,
      name: code,
      salePrice: 100 + index,
      prepStation: setupIncomplete ? 'KITCHEN' : 'BARISTA',
      itemType: setupIncomplete ? 'MADE_TO_ORDER' : 'NO_STOCK',
      productionMode: setupIncomplete ? 'MADE_TO_ORDER' : 'NO_STOCK',
      bom: [],
      posCategoryCode: setupIncomplete ? 'FOOD' : 'DRINKS',
      posCategoryName: setupIncomplete ? 'Food' : 'Drinks',
      availableStoreIds: ['GOLDEN_I', 'UDAY_PARK'],
      isActive: true,
      isSellable: true,
      isAvailable: true,
    };
  });

  const goldenSnapshot = buildPublicMenuAvailabilitySnapshot({
    store: store(),
    finishedGoods: finishedGoods as any,
    storeStock: [],
  });
  assert.equal(goldenSnapshot.itemCount, 80);
  assert.equal(goldenSnapshot.availableCount, 80);
  assert.equal(goldenSnapshot.unavailableCount, 0);
  assert.equal(Object.keys(goldenSnapshot.menuItems).length, 80);
  setupIncompleteCodes.forEach((code) => {
    assert.equal(goldenSnapshot.items[code].available, true);
    assert.equal(goldenSnapshot.items[code].publicStatus, 'AVAILABLE');
  });
  assert.equal(isGoldenISetupWarningOnly(store(), 'SETUP_INCOMPLETE'), true);

  const strictSnapshot = buildPublicMenuAvailabilitySnapshot({
    store: store({ id: 'UDAY_PARK', code: 'UDAY_PARK' }),
    finishedGoods: finishedGoods as any,
    storeStock: [],
  });
  assert.equal(strictSnapshot.itemCount, 80);
  assert.equal(strictSnapshot.availableCount, 69);
  assert.equal(strictSnapshot.unavailableCount, 11);
  setupIncompleteCodes.forEach((code) => {
    assert.equal(strictSnapshot.items[code].available, false);
    assert.equal(strictSnapshot.items[code].publicStatus, 'SETUP_INCOMPLETE');
  });
  assert.equal(isGoldenISetupWarningOnly(store({ id: 'UDAY_PARK', code: 'UDAY_PARK' }), 'SETUP_INCOMPLETE'), false);
  assert.equal(isGoldenISetupWarningOnly(store({ id: 'GOLDEN_I', code: 'NOIDA_29' }), 'SETUP_INCOMPLETE'), false);

  const invalidPriceSnapshot = buildPublicMenuAvailabilitySnapshot({
    store: store(),
    finishedGoods: [{ ...finishedGoods[0], salePrice: 0 }] as any,
    storeStock: [],
  });
  assert.equal(invalidPriceSnapshot.items[setupIncompleteCodes[0]].available, false);
  assert.equal(invalidPriceSnapshot.items[setupIncompleteCodes[0]].publicStatus, 'SETUP_INCOMPLETE');
}

{
  const snapshot = buildPublicMenuAvailabilitySnapshot({
    store: store(),
    finishedGoods: [{
      id: '36G_PROTEIN_POWER',
      code: '36G_PROTEIN_POWER',
      name: '36G Protein Power',
      displayName: '36G Protein Power',
      salePrice: 390,
      prepStation: 'BARISTA',
      itemType: 'NO_STOCK',
      productionMode: 'NO_STOCK',
      bom: [],
      posCategoryCode: 'SMOOTHIES',
      posCategoryName: 'Smoothies',
      availableStoreIds: ['GOLDEN_I'],
      isActive: true,
      isSellable: true,
      isAvailable: true,
    }, {
      id: 'MEDITERRANEAN_MEZZE_PLATTER',
      code: 'MEDITERRANEAN_MEZZE_PLATTER',
      name: 'Mediterranean Mezze Platter',
      displayName: 'Mediterranean Mezze Platter',
      salePrice: 390,
      prepStation: 'KITCHEN',
      itemType: 'NO_STOCK',
      productionMode: 'NO_STOCK',
      bom: [],
      posCategoryCode: 'ALWAYS_AT_BOND',
      posCategoryName: 'Always at Bond',
      availableStoreIds: ['GOLDEN_I'],
      isActive: true,
      isSellable: true,
      isAvailable: true,
    }] as any,
    storeStock: [],
  });
  assert.equal(snapshot.menuItems['36G_PROTEIN_POWER'].displayName, '36G Protein Power');
  assert.equal(snapshot.items['36G_PROTEIN_POWER'].available, true);
  assert.equal(snapshot.menuItems['MEDITERRANEAN_MEZZE_PLATTER'].posCategoryCode, 'ALWAYS_AT_BOND');
  assert.equal(snapshot.menuItems['MEDITERRANEAN_MEZZE_PLATTER'].posCategoryName, 'Always at Bond');
}

console.log('Customer ordering state tests passed.');
