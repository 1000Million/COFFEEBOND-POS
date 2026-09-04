import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  TASTING_ROOM_BOND_TABLE_CATEGORY,
  TASTING_ROOM_CATEGORY_ORDER,
  TASTING_ROOM_STORE_CODE,
  customerCategoryOrder,
  customerMenuCategory,
  customerStorePresentation,
  isCustomerStoreDirectLinkOrderable,
  requestedCustomerStore,
} from '../frontend/lib/customerMenuPresentation';
import type { Store } from '../frontend/types';

const root = process.cwd();
const source = (path: string) => readFileSync(resolve(root, path), 'utf8');
const customerOrder = source('frontend/pages/customer/CustomerOrder.tsx');
const storeCard = source('frontend/components/customer/CustomerStoreCard.tsx');
const customerApp = source('frontend/CustomerApp.tsx');

const results: string[] = [];
function check(name: string, condition: unknown) {
  assert.ok(condition, name);
  results.push(name);
}

function store(overrides: Partial<Store> = {}): Store {
  return {
    id: 'NOIDA_29',
    code: 'NOIDA_29',
    name: 'Coffee Bond Noida Sector 29',
    address: 'Noida Sector 29',
    status: 'ACTIVE',
    isActive: true,
    posEnabled: true,
    onlineOrderingEnabled: true,
    customerOrderingEnabled: true,
    publicOrderingEnabled: true,
    acceptingOrders: true,
    isAcceptingOrders: true,
    onlineOrderingPaused: false,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

const noida = store();
const tastingRoom = store({
  id: TASTING_ROOM_STORE_CODE,
  code: TASTING_ROOM_STORE_CODE,
  name: 'THE TASTING ROOM BY COFFEE BOND',
  excludeFromNearestSelection: true,
});

check('the Tasting Room stays in the existing customer application',
  customerApp.includes('<Route path="/" element={<CustomerOrder />}')
  && !customerApp.includes('TastingRoomApp'));

check('the direct store query matches the active Tasting Room by code',
  requestedCustomerStore([noida, tastingRoom], '?store=TASTING_ROOM_29')?.id === TASTING_ROOM_STORE_CODE);
check('the direct store query is case insensitive',
  requestedCustomerStore([noida, tastingRoom], '?store=tasting_room_29')?.id === TASTING_ROOM_STORE_CODE);
check('an invalid direct store query falls back instead of selecting a store',
  requestedCustomerStore([noida, tastingRoom], '?store=UNKNOWN') === null);

for (const [field, value] of [
  ['isActive', false],
  ['status', 'DRAFT'],
  ['posEnabled', false],
  ['onlineOrderingEnabled', false],
  ['customerOrderingEnabled', false],
  ['publicOrderingEnabled', false],
  ['acceptingOrders', false],
  ['isAcceptingOrders', false],
  ['onlineOrderingPaused', true],
] as const) {
  const blocked = store({ id: TASTING_ROOM_STORE_CODE, code: TASTING_ROOM_STORE_CODE, [field]: value });
  check(`a direct query rejects a store when ${field}=${String(value)}`,
    !isCustomerStoreDirectLinkOrderable(blocked)
    && requestedCustomerStore([noida, blocked], '?store=TASTING_ROOM_29') === null);
}

const directPosition = customerOrder.indexOf('const directStore = requestedCustomerStore');
const draftPosition = customerOrder.indexOf('const draftResult = readCustomerCheckoutDraft');
const initialPosition = customerOrder.indexOf('const initialStoreId = acceptedDirectStore?.id');
check('a valid direct store is resolved before saved draft/default selection',
  directPosition >= 0 && draftPosition > directPosition && initialPosition > draftPosition);
check('direct selection is explicit and suppresses nearest-store replacement',
  /if \(acceptedDirectStore\) \{[\s\S]*?userStoreChoiceRef\.current = true;[\s\S]*?triedAutoLocationRef\.current = true;/.test(customerOrder));
check('an incompatible persisted basket uses the existing confirmation and clear path',
  customerOrder.includes('window.confirm(STORE_CHANGE_CONFIRMATION)')
  && customerOrder.includes('clearCustomerCheckoutDraft(window.localStorage)')
  && customerOrder.includes('draftToRestore = null'));
check('a direct-store query stays aligned after a later explicit store switch',
  customerOrder.includes('alignExistingStoreQuery(store)')
  && customerOrder.includes("params.set('store', store.code)"));

check('stores can be explicitly excluded from nearest-store selection',
  customerOrder.includes('store.excludeFromNearestSelection === true')
  && customerOrder.includes('store.excludeFromNearestSelection !== true && storeCoordinate(store)'));

const normalPresentation = customerStorePresentation(noida);
const tastingPresentation = customerStorePresentation(tastingRoom);
check('Noida keeps the established customer copy',
  normalPresentation.featuredLabel === 'Coffee Bond favourites'
  && normalPresentation.orderActionLabel === 'Send order request'
  && normalPresentation.searchPlaceholder === 'Search menu, drinks, or flavours...');
check('the Tasting Room exposes its required context without pickup language',
  tastingPresentation.conceptName === 'THE TASTING ROOM'
  && tastingPresentation.locationLabel === 'Coffee Bond · Noida Sector 29'
  && tastingPresentation.tagline === 'For the love of discovering.'
  && tastingPresentation.orderContextLabel === 'Place order'
  && tastingPresentation.selectorDescription === 'Flights · Small plates · Experiences');
check('the shared store card renders neutral custom ordering language',
  storeCard.includes("`${contextLabel} · ${storeName}`")
  && customerOrder.includes('contextLabel={selectedStoreContextLabel}'));

const tastingCategories = [
  'To Spread & Share',
  'Crostini Garden',
  'Fresh & Crisp',
  'Say Cheese',
  'Small Pizzas',
  'A Sweet Finish',
  'Flights & Experiences',
  'For Two',
] as const;
for (const categoryName of tastingCategories) {
  check(`the Tasting Room maps ${categoryName} only in its own store context`,
    customerMenuCategory({ posCategoryCode: '', posCategoryName: categoryName } as never, tastingRoom) === categoryName
    && customerMenuCategory({ posCategoryCode: '', posCategoryName: categoryName } as never, noida) === 'Other');
}
check('the requested Tasting category order is store-scoped',
  customerCategoryOrder(tastingRoom) === TASTING_ROOM_CATEGORY_ORDER
  && customerCategoryOrder(noida) !== TASTING_ROOM_CATEGORY_ORDER);
check('ordinary Noida category mapping remains unchanged',
  customerMenuCategory({ posCategoryCode: 'ESP', posCategoryName: 'Espresso Bar' } as never, noida) === 'Coffee');

const bondTableStart = customerOrder.indexOf('const renderBondTableInformation');
const bondTableEnd = customerOrder.indexOf("const checkoutAction", bondTableStart);
const bondTableCode = customerOrder.slice(bondTableStart, bondTableEnd);
check('the Bond Table is a Tasting-only informational category',
  TASTING_ROOM_BOND_TABLE_CATEGORY === 'The Bond Table'
  && customerOrder.includes('tastingRoomSelected && renderBondTableInformation()')
  && customerOrder.includes('data-customer-informational-only="true"'));
check('the Bond Table cannot enter cart, checkout, payment, or booking mutation paths',
  bondTableStart >= 0 && bondTableEnd > bondTableStart
  && !/addItem|commitCartItem|setCart|submitOrder|createCustomerCheckoutSession|verifyCustomerRazorpayPayment/.test(bondTableCode)
  && bondTableCode.includes('<details')
  && customerOrder.includes('customerMenuCategory(item, selectedStore) === TASTING_ROOM_BOND_TABLE_CATEGORY'));

console.log(`Tasting Room customer tests passed: ${results.length}/${results.length}`);
