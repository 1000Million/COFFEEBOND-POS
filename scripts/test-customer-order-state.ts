import assert from 'node:assert/strict';
import { deriveCustomerOrderingState } from '../frontend/lib/customerOrderingState';
import { Store } from '../frontend/types';

function store(overrides: Partial<Store> = {}): Store {
  return {
    id: 'GOLDEN_I',
    code: 'GOLDEN_I',
    name: 'Golden I',
    address: '',
    isActive: true,
    onlineOrderingEnabled: true,
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
  assert.equal(state.statusLabel, 'Unavailable');
  assert.match(state.message, /unavailable/i);
}

{
  const state = deriveCustomerOrderingState({
    store: store(),
    availabilitySnapshot: snapshot(2),
    availabilityLoading: false,
    orderableItemCount: 0,
  });
  assert.equal(state.canAcceptOrders, false);
  assert.equal(state.statusLabel, 'Unavailable');
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
  assert.equal(state.statusLabel, 'Menu updating');
  assert.match(state.message, /menu is being refreshed/i);
  assertNoAcceptingUnavailableContradiction(state);
}

console.log('Customer ordering state tests passed.');
