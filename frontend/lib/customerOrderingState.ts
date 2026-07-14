import { Store } from '../types';

type AvailabilitySnapshotLike = {
  menuItems?: Record<string, unknown>;
};

type CustomerOrderingStateInput = {
  store: Store | null;
  availabilitySnapshot: AvailabilitySnapshotLike | null;
  availabilityLoading: boolean;
  orderableItemCount: number;
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
  const safeMinutes = minutes && minutes > 0 ? minutes : 20;
  const min = Math.max(5, safeMinutes - 5);
  return `${min}-${safeMinutes} min`;
}

export function isStoreOnlineEnabled(store: Store | null): boolean {
  return !!store && store.onlineOrderingEnabled !== false;
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

function snapshotMenuItemCount(snapshot: AvailabilitySnapshotLike | null): number {
  if (!snapshot?.menuItems || typeof snapshot.menuItems !== 'object') return 0;
  return Object.keys(snapshot.menuItems).length;
}

export function deriveCustomerOrderingState(input: CustomerOrderingStateInput): CustomerOrderingState {
  const { store, availabilitySnapshot, availabilityLoading, orderableItemCount } = input;
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
    return {
      storeOnlineEnabled,
      canAcceptOrders: false,
      statusLabel: 'Unavailable',
      message: 'Online ordering is currently unavailable for this store.',
      tone: 'red',
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

  if (snapshotMenuItemCount(availabilitySnapshot) === 0) {
    return {
      storeOnlineEnabled,
      canAcceptOrders: false,
      statusLabel: 'Menu updating',
      message: 'The online menu is being refreshed for this store.',
      tone: 'amber',
    };
  }

  if (orderableItemCount <= 0) {
    return {
      storeOnlineEnabled,
      canAcceptOrders: false,
      statusLabel: 'Unavailable',
      message: 'No items are currently available for online ordering at this store.',
      tone: 'red',
    };
  }

  return {
    storeOnlineEnabled,
    canAcceptOrders: true,
    statusLabel: 'Accepting orders',
    message: storeOnlineMessage(store),
    tone: 'green',
  };
}
