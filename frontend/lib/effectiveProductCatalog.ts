import { httpsCallable } from 'firebase/functions';
import type { FinishedGood } from '../types/menu-management';
import { functions } from './firebase';

type EffectivePosProductsResponse = {
  storeId: string;
  products: Array<FinishedGood & { id: string; menuVisible?: boolean }>;
};

const getEffectivePosProductsCallable = httpsCallable<
  { storeId: string },
  EffectivePosProductsResponse
>(functions, 'getEffectivePosProducts');

export async function getEffectivePosProducts(storeId: string) {
  const result = await getEffectivePosProductsCallable({ storeId });
  if (result.data.storeId !== storeId || !Array.isArray(result.data.products)) {
    throw new Error('The server returned an invalid POS catalogue.');
  }
  return result.data.products;
}
