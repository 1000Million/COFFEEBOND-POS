import { Store } from '../types';
import { isGoldenISalesFirstOrderingStore } from './publicMenuAvailability';

type AvailabilitySnapshotLike = {
  menuItems?: Record<string, unknown>;
};

type CustomerOrderingStateInput = {
  store: Store | null;
  availabilitySnapshot: AvailabilitySnapshotLike | null;
  availabilityLoading: boolean;
  orderableItemCount: number;
  availabilityChecked?: boolean;
};

export type CustomerOrderingState = {
  storeOnlineEnabled: boolean;
  canAcceptOrders: boolean;
  statusLabel: string;
  message: string;
  tone: 'green' | 'amber' | 'red';
};

function toNumber(value: unknown): number {
  if (value === null || value === undefined || value === '') return 0;
  const parsed = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function prepWindowLabel(minutes?: number | null): string {
  if (!minutes || minutes <= 0) return '';
  const safeMinutes = minutes;
  const min = Math.max(5, safeMinutes - 5);
  return `${min}-${safeMinutes} min`;
}

export function isStoreOnlineEnabled(store: Store | null): boolean {
  if (!store) return false;
  if (isGoldenISalesFirstOrderingStore(store)) {
    return store.isActive === true
      && store.posEnabled === true
      && store.customerOrderingEnabled === true
      && store.onlineOrderingEnabled === true
      && store.publicOrderingEnabled === true
      && store.acceptingOrders === true
      && store.isAcceptingOrders === true;
  }
  return store.isActive !== false
    && store.onlineOrderingEnabled !== false
    && store.acceptingOrders !== false
    && store.isAcceptingOrders !== false;
}

function looksLikeDisabledMessage(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  return /unavailable|not accepting|currently closed|ordering is closed|disabled/.test(normalized);
}

export function storeOnlineMessage(store: Store | null): string {
  if (!store) return 'Select a store to start your order.';
  if (!isStoreOnlineEnabled(store)) return 'Online ordering is currently unavailable for this store.';

  const configuredMessage = store.onlineOrderingMessage?.trim();
  if (configuredMessage && !looksLikeDisabledMessage(configuredMessage)) {
    return configuredMessage;
  }

  if (toNumber(store.estimatedPrepMinutes) > 0) {
    return `Pickup available in ${prepWindowLabel(store.estimatedPrepMinutes)}`;
  }
  return 'Pickup available soon after store confirmation.';
}

function unavailableStoreState(store: Store): Pick<CustomerOrderingState, 'statusLabel' | 'message' | 'tone'> {
  if (store.onlineOrderingPaused === true) {
    return {
      statusLabel: 'Temporarily unavailable',
      message: 'Online ordering is temporarily unavailable for this store.',
      tone: 'amber',
    };
  }
  if (store.acceptingOrders === false || store.isAcceptingOrders === false) {
    return {
      statusLabel: 'Closed',
      message: 'This store is not accepting online orders right now.',
      tone: 'red',
    };
  }
  return {
    statusLabel: 'Temporarily unavailable',
    message: 'Online ordering is currently unavailable for this store.',
    tone: 'red',
  };
}

function snapshotMenuItemCount(snapshot: AvailabilitySnapshotLike | null): number {
  if (!snapshot?.menuItems || typeof snapshot.menuItems !== 'object') return 0;
  return Object.keys(snapshot.menuItems).length;
}

export function deriveCustomerOrderingState(input: CustomerOrderingStateInput): CustomerOrderingState {
  const {
    store,
    availabilitySnapshot,
    availabilityLoading,
    orderableItemCount,
    availabilityChecked = true,
  } = input;
  const storeOnlineEnabled = isStoreOnlineEnabled(store);

  if (!store) {
    return {
      storeOnlineEnabled: false,
      canAcceptOrders: false,
      statusLabel: 'Select store',
      message: 'Select a store to start your order.',
      tone: 'amber',
    };
  }

  if (!storeOnlineEnabled) {
    const unavailableState = unavailableStoreState(store);
    return {
      storeOnlineEnabled,
      canAcceptOrders: false,
      ...unavailableState,
    };
  }

  if (availabilityLoading) {
    return {
      storeOnlineEnabled,
      canAcceptOrders: false,
      statusLabel: 'Checking menu',
      message: 'Checking the online menu for this store.',
      tone: 'amber',
    };
  }

  if (availabilityChecked && snapshotMenuItemCount(availabilitySnapshot) === 0) {
    return {
      storeOnlineEnabled,
      canAcceptOrders: false,
      statusLabel: 'Menu unavailable',
      message: 'The online menu is being refreshed for this store.',
      tone: 'amber',
    };
  }

  if (availabilityChecked && orderableItemCount <= 0) {
    return {
      storeOnlineEnabled,
      canAcceptOrders: false,
      statusLabel: 'Menu unavailable',
      message: 'No items are currently available for online ordering at this store.',
      tone: 'red',
    };
  }

  const storeRecord = store as Store & Record<string, unknown>;
  const busy = storeRecord.isBusy === true || storeRecord.orderingStatus === 'BUSY';
  const busyMinutes = toNumber(store.estimatedPrepMinutes);

  return {
    storeOnlineEnabled,
    canAcceptOrders: true,
    statusLabel: busy && busyMinutes > 0
      ? `Busy · approximately ${busyMinutes} min`
      : 'Accepting orders',
    message: storeOnlineMessage(store),
    tone: 'green',
  };
}
