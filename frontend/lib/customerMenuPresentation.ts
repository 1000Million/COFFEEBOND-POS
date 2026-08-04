import type { FinishedGood } from '../types/menu-management';

export type CustomerMenuCategory =
  | 'Coffee'
  | 'Cold Coffee'
  | 'Cold Drinks'
  | 'Matcha & Tea'
  | 'Food'
  | 'Baked by Bond'
  | 'Desserts'
  | 'Add Ons'
  | 'Other';

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
] as const;

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

function normalizeLabel(value: unknown): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
export function customerMenuCategory(item: Pick<FinishedGood, 'posCategoryCode' | 'posCategoryName'>): CustomerMenuCategory {
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
