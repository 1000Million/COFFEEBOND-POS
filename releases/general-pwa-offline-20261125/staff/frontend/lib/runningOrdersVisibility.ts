import type { Order, StaffProfile, Store } from '../types';

export const DRAFT_SETUP_TEST_STORE_ID = 'BAKED_BY_BOND_51';

type RunningOrdersStaff = Pick<StaffProfile, 'isActive' | 'role'> | null | undefined;
type RunningOrdersStore = Pick<
  Store,
  | 'id'
  | 'status'
  | 'isActive'
  | 'internalPosTestEnabled'
  | 'setupTestMode'
  | 'posEnabled'
  | 'customerOrderingEnabled'
  | 'onlineOrderingEnabled'
  | 'publicOrderingEnabled'
>;
type RunningOrdersOrder = Pick<Order, 'storeId' | 'setupTestMode'>;

export function isActiveRunningOrdersAdmin(staffProfile: RunningOrdersStaff): boolean {
  return staffProfile?.isActive === true && staffProfile.role === 'ADMIN';
}

export function isEligibleDraftSetupStoreForRunningOrders(
  store: RunningOrdersStore,
  staffProfile: RunningOrdersStaff,
): boolean {
  return isActiveRunningOrdersAdmin(staffProfile)
    && store.id === DRAFT_SETUP_TEST_STORE_ID
    && store.status === 'DRAFT'
    && store.isActive !== true
    && store.internalPosTestEnabled === true
    && store.setupTestMode === true
    && store.posEnabled === true
    && store.customerOrderingEnabled === false
    && store.onlineOrderingEnabled === false
    && store.publicOrderingEnabled === false;
}

export function isDraftSetupTestOrder(order: RunningOrdersOrder): boolean {
  return order.storeId === DRAFT_SETUP_TEST_STORE_ID && order.setupTestMode === true;
}

export function isOrderVisibleInRunningOrders(
  order: RunningOrdersOrder,
  store: RunningOrdersStore,
  staffProfile: RunningOrdersStaff,
): boolean {
  if (order.storeId !== store.id) return false;
  if (store.isActive === true) return true;
  return isEligibleDraftSetupStoreForRunningOrders(store, staffProfile)
    && isDraftSetupTestOrder(order);
}
