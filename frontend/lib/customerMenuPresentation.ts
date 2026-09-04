import type { FinishedGood } from '../types/menu-management';
import type { CustomerStorePresentation, Store } from '../types';

export const TASTING_ROOM_STORE_CODE = 'TASTING_ROOM_29';
export const TASTING_ROOM_BOND_TABLE_CATEGORY = 'The Bond Table' as const;

export type CustomerMenuCategory =
  | 'Coffee'
  | 'Cold Coffee'
  | 'Cold Drinks'
  | 'Matcha & Tea'
  | 'Food'
  | 'Baked by Bond'
  | 'Desserts'
  | 'Add Ons'
  | 'To Spread & Share'
  | 'Crostini Garden'
  | 'Fresh & Crisp'
  | 'Say Cheese'
  | 'Small Pizzas'
  | 'A Sweet Finish'
  | 'Flights & Experiences'
  | 'For Two'
  | typeof TASTING_ROOM_BOND_TABLE_CATEGORY
  | 'Other';

export type CustomerMenuCategoryFilter = 'ALL' | CustomerMenuCategory;

export type DietaryClassification = 'VEGETARIAN' | 'NON_VEGETARIAN' | 'EGG';

export const CUSTOMER_CATEGORY_ORDER = [
  'ALL',
  'Coffee',
  'Cold Coffee',
  'Cold Drinks',
  'Matcha & Tea',
  'Food',
  'Baked by Bond',
  'Desserts',
  'Add Ons',
  'Other',
] as const satisfies readonly CustomerMenuCategoryFilter[];

export const TASTING_ROOM_CATEGORY_ORDER = [
  'ALL',
  'To Spread & Share',
  'Crostini Garden',
  'Fresh & Crisp',
  'Say Cheese',
  'Small Pizzas',
  'A Sweet Finish',
  'Flights & Experiences',
  'For Two',
  TASTING_ROOM_BOND_TABLE_CATEGORY,
  'Other',
] as const satisfies readonly CustomerMenuCategoryFilter[];

const CATEGORY_BY_CODE: Record<string, CustomerMenuCategory> = {
  ESP: 'Coffee',
  CBV: 'Cold Coffee',
  CCF: 'Cold Drinks',
  JUI: 'Cold Drinks',
  SMO: 'Cold Drinks',
  MAT: 'Matcha & Tea',
  PIZ: 'Food',
  SAL: 'Food',
  ZAF: 'Food',
  BAK: 'Baked by Bond',
  ICE: 'Desserts',
  ADD: 'Add Ons',
  MIS: 'Other',
};

const CATEGORY_BY_NAME: Record<string, CustomerMenuCategory> = {
  'espresso bar': 'Coffee',
  'cold brew vietnamese': 'Cold Coffee',
  'cold crafted': 'Cold Drinks',
  'fresh juices': 'Cold Drinks',
  smoothies: 'Cold Drinks',
  'matcha manual brews': 'Matcha & Tea',
  'pizza pide': 'Food',
  salads: 'Food',
  'zaffle bites': 'Food',
  'baked by bond': 'Baked by Bond',
  'housemade dairy ice cream': 'Desserts',
  'add ons': 'Add Ons',
  misc: 'Other',
};

const TASTING_ROOM_CATEGORY_BY_NAME: Record<string, CustomerMenuCategory> = {
  'to spread share': 'To Spread & Share',
  'crostini garden': 'Crostini Garden',
  'fresh crisp': 'Fresh & Crisp',
  'say cheese': 'Say Cheese',
  'small pizzas': 'Small Pizzas',
  'a sweet finish': 'A Sweet Finish',
  'flights experiences': 'Flights & Experiences',
  'for two': 'For Two',
  'the bond table': TASTING_ROOM_BOND_TABLE_CATEGORY,
};

export type ResolvedCustomerStorePresentation = Required<CustomerStorePresentation>;

type StoreIdentity = Pick<Store, 'id' | 'code' | 'storeCode'>;

export function isTastingRoomStore(store: StoreIdentity | string | null | undefined): boolean {
  if (typeof store === 'string') return store.trim().toUpperCase() === TASTING_ROOM_STORE_CODE;
  return [store?.id, store?.code, store?.storeCode]
    .some(value => String(value || '').trim().toUpperCase() === TASTING_ROOM_STORE_CODE);
}

export function customerCategoryOrder(store: StoreIdentity | string | null | undefined): readonly CustomerMenuCategoryFilter[] {
  return isTastingRoomStore(store) ? TASTING_ROOM_CATEGORY_ORDER : CUSTOMER_CATEGORY_ORDER;
}

/**
 * A direct store link is explicit customer intent, so it is deliberately stricter
 * than the ordinary saved-store fallback. A paused or administratively disabled store
 * must never be selected merely because its code appears in a URL.
 */
export function isCustomerStoreDirectLinkOrderable(store: Store): boolean {
  return store.isActive === true
    && (!store.status || store.status === 'ACTIVE')
    && store.posEnabled !== false
    && store.onlineOrderingEnabled !== false
    && store.customerOrderingEnabled !== false
    && store.publicOrderingEnabled !== false
    && store.acceptingOrders !== false
    && store.isAcceptingOrders !== false
    && store.onlineOrderingPaused !== true
    && store.posLaunchException?.customerOrderingDisabled !== true;
}

export function requestedCustomerStore(stores: Store[], search: string): Store | null {
  const requested = new URLSearchParams(search).get('store')?.trim().toUpperCase();
  if (!requested) return null;
  const store = stores.find(candidate => [candidate.id, candidate.code, candidate.storeCode]
    .some(value => String(value || '').trim().toUpperCase() === requested));
  return store && isCustomerStoreDirectLinkOrderable(store) ? store : null;
}

export function customerStorePresentation(store: Store | null): ResolvedCustomerStorePresentation {
  const tastingRoom = isTastingRoomStore(store);
  const defaults: ResolvedCustomerStorePresentation = tastingRoom ? {
    conceptName: 'THE TASTING ROOM',
    locationLabel: 'Coffee Bond · Noida Sector 29',
    tagline: 'For the love of discovering.',
    orderContextLabel: 'Place order',
    orderActionLabel: 'Place order',
    searchPlaceholder: 'Search flights, small plates, or experiences...',
    searchPromptTitle: 'Search the Tasting Room',
    searchPromptDescription: 'Flights, small plates and experiences.',
    featuredLabel: 'Tasting Room favourites',
    fullMenuLabel: 'Tasting Room menu',
    selectorEyebrow: 'Choose your Bond',
    selectorDescription: 'Flights · Small plates · Experiences',
  } : {
    conceptName: store?.displayName || store?.name || 'Coffee Bond',
    locationLabel: '',
    tagline: '',
    orderContextLabel: '',
    orderActionLabel: 'Send order request',
    searchPlaceholder: 'Search menu, drinks, or flavours...',
    searchPromptTitle: 'Search Coffee Bond',
    searchPromptDescription: 'Coffee, food, smoothies and more.',
    featuredLabel: 'Coffee Bond favourites',
    fullMenuLabel: 'Full menu',
    selectorEyebrow: 'Pickup store',
    selectorDescription: '',
  };
  return { ...defaults, ...(store?.customerPresentation || {}) };
}

function normalizeLabel(value: unknown): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
export function customerMenuCategory(
  item: Pick<FinishedGood, 'posCategoryCode' | 'posCategoryName'>,
  store?: StoreIdentity | string | null,
): CustomerMenuCategory {
  if (isTastingRoomStore(store)) {
    return TASTING_ROOM_CATEGORY_BY_NAME[normalizeLabel(item.posCategoryName)] || 'Other';
  }
  const categoryCode = String(item.posCategoryCode || '').trim().toUpperCase();
  if (CATEGORY_BY_CODE[categoryCode]) return CATEGORY_BY_CODE[categoryCode];
  return CATEGORY_BY_NAME[normalizeLabel(item.posCategoryName)] || 'Other';
}

export function trustedDietaryClassification(item: Record<string, unknown>): DietaryClassification | null {
  const explicitValue = item.dietaryClassification
    ?? item.dietaryType
    ?? item.foodType
    ?? item.vegNonVeg;

  if (typeof explicitValue === 'string') {
    const normalized = normalizeLabel(explicitValue);
    if (['veg', 'vegetarian', 'pure veg'].includes(normalized)) return 'VEGETARIAN';
    if (['non veg', 'non vegetarian', 'nonvegetarian'].includes(normalized)) return 'NON_VEGETARIAN';
    if (['egg', 'eggetarian', 'contains egg'].includes(normalized)) return 'EGG';
  }

  if (typeof item.isVegetarian === 'boolean') {
    return item.isVegetarian ? 'VEGETARIAN' : 'NON_VEGETARIAN';
  }
  if (typeof item.isVeg === 'boolean') {
    return item.isVeg ? 'VEGETARIAN' : 'NON_VEGETARIAN';
  }

  return null;
}

export function dietaryLabel(value: DietaryClassification): string {
  if (value === 'VEGETARIAN') return 'Vegetarian';
  if (value === 'NON_VEGETARIAN') return 'Non-vegetarian';
  return 'Contains egg';
}
