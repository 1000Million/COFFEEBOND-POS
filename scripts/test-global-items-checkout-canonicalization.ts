import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import {
  resolveStoreItem as resolveFrontendStoreItem,
  storeItemConfigDocId as frontendConfigDocId,
  type StoreItemConfig,
} from '../frontend/lib/storeItemConfig';

const require = createRequire(import.meta.url);
const checkoutPolicy = require(resolve(process.cwd(), 'functions/customerCheckoutCanonicalization.js'));
const serverPolicy = require(resolve(process.cwd(), 'functions/storeItemConfigPolicy.js'));
const { canonicalizeCustomerCheckout, resolvePublicCheckoutProduct } = checkoutPolicy;
const { resolveStoreItem: resolveServerStoreItem, storeItemConfigDocId: serverConfigDocId } = serverPolicy;

const STORE_ID = 'STORE_1';
const ITEM_CODE = 'FG_A';
let checks = 0;
const ok = (condition: unknown, message: string) => {
  assert.ok(condition, message);
  checks += 1;
  console.log(`PASS ${checks}. ${message}`);
};
const eq = (actual: unknown, expected: unknown, message: string) => {
  assert.deepEqual(actual, expected, message);
  checks += 1;
  console.log(`PASS ${checks}. ${message}`);
};

function store(overrides: Record<string, unknown> = {}) {
  return {
    id: STORE_ID,
    code: STORE_ID,
    name: 'Store 1',
    isActive: true,
    onlineOrderingEnabled: true,
    ...overrides,
  };
}

function product(overrides: Record<string, unknown> = {}) {
  return {
    id: ITEM_CODE,
    code: ITEM_CODE,
    name: 'Global Item',
    displayName: 'Global Item',
    salePrice: 350,
    taxRate: 5,
    itemType: 'NO_STOCK',
    productionMode: 'NO_STOCK',
    prepStation: 'NONE',
    availableStoreIds: [STORE_ID],
    addOnGroupIds: [],
    isActive: true,
    isSellable: true,
    isAvailable: true,
    ...overrides,
  };
}

function availability(overrides: Record<string, unknown> = {}) {
  return {
    itemCode: ITEM_CODE,
    fgCode: ITEM_CODE,
    available: true,
    publicStatus: 'AVAILABLE',
    publicMessage: 'Available',
    ...overrides,
  };
}

function publicMenuItem(overrides: Record<string, unknown> = {}) {
  return {
    id: ITEM_CODE,
    code: ITEM_CODE,
    name: 'Global Item',
    salePrice: 350,
    taxRate: 5,
    itemType: 'NO_STOCK',
    productionMode: 'NO_STOCK',
    prepStation: 'NONE',
    availableStoreIds: [STORE_ID],
    isActive: true,
    isSellable: true,
    isAvailable: true,
    ...overrides,
  };
}

function snapshot(id: string, value: unknown) {
  return { id, exists: value !== undefined, data: () => value };
}

function fakeFirestore(documents: Map<string, unknown>) {
  return {
    collection(collectionName: string) {
      return {
        doc(documentId: string) {
          return {
            async get() {
              return snapshot(documentId, documents.get(`${collectionName}/${documentId}`));
            },
          };
        },
      };
    },
  };
}

type CheckoutOptions = {
  checkoutStore?: ReturnType<typeof store>;
  privateProduct?: ReturnType<typeof product>;
  config?: StoreItemConfig | null;
  extraConfigs?: StoreItemConfig[];
  publicAvailability?: ReturnType<typeof availability>;
  publicItem?: ReturnType<typeof publicMenuItem>;
  includeAvailability?: boolean;
  includeMenuItem?: boolean;
};

function checkoutDocuments({
  checkoutStore = store(),
  privateProduct = product(),
  config = null,
  extraConfigs = [],
  publicAvailability = availability(),
  publicItem = publicMenuItem(),
  includeAvailability = true,
  includeMenuItem = true,
}: CheckoutOptions = {}) {
  const documents = new Map<string, unknown>([
    [`stores/${checkoutStore.id}`, { ...checkoutStore }],
    ['appSettings/gstConfig', { defaultGstRate: 5 }],
    [`finishedGoods/${privateProduct.id}`, { ...privateProduct }],
    [`publicMenuAvailability/${checkoutStore.code}`, {
      items: includeAvailability ? { [ITEM_CODE]: publicAvailability } : {},
      menuItems: includeMenuItem ? { [ITEM_CODE]: publicItem } : {},
      addOnGroups: {},
    }],
  ]);
  if (config) {
    documents.set(
      `storeItemConfig/${serverConfigDocId(checkoutStore.id, ITEM_CODE)}`,
      { ...config },
    );
  }
  extraConfigs.forEach((extraConfig) => {
    documents.set(
      `storeItemConfig/${serverConfigDocId(extraConfig.storeId, extraConfig.itemCode)}`,
      { ...extraConfig },
    );
  });
  return documents;
}

async function checkout(options: CheckoutOptions = {}) {
  return canonicalizeCustomerCheckout({
    db: fakeFirestore(checkoutDocuments(options)),
    sessionId: 'global_items_checkout_test',
    data: {
      storeId: options.checkoutStore?.id || STORE_ID,
      storeCode: options.checkoutStore?.code || STORE_ID,
      customerName: 'Global Items Test',
      orderType: 'PICKUP',
      items: [{
        parentProductId: ITEM_CODE,
        parentProductCode: ITEM_CODE,
        quantity: 1,
        selectedAddOns: [],
      }],
    },
  });
}

for (const [storeId, itemCode] of [
  [STORE_ID, ITEM_CODE],
  ['store|with/slash', 'item | latte/large'],
  ['दुकान ☕', 'कैफ़े/ITEM|1'],
]) {
  eq(serverConfigDocId(storeId, itemCode), frontendConfigDocId(storeId, itemCode), `server/frontend document IDs match for ${storeId}`);
}

for (const config of [
  null,
  { storeId: STORE_ID, itemCode: ITEM_CODE, priceOverride: 0 },
  { storeId: STORE_ID, itemCode: ITEM_CODE, isAvailableOverride: false, menuVisibilityOverride: false, sortOrderOverride: 0 },
  { storeId: STORE_ID, itemCode: ITEM_CODE, priceOverride: 375.5, isAvailableOverride: true, menuVisibilityOverride: true, sortOrderOverride: 12 },
] as Array<StoreItemConfig | null>) {
  const source = product();
  const frontend = resolveFrontendStoreItem(source as never, config);
  const server = resolveServerStoreItem(source, config);
  eq(
    {
      salePrice: server.salePrice,
      isAvailable: server.isAvailable,
      menuVisible: server.menuVisible,
      sortOrder: server.sortOrder,
    },
    {
      salePrice: frontend.salePrice,
      isAvailable: frontend.isAvailable,
      menuVisible: frontend.menuVisible,
      sortOrder: frontend.sortOrder,
    },
    `server/frontend resolver parity holds for ${JSON.stringify(config)}`,
  );
}

const baselineCheckout = await checkout();
eq(baselineCheckout.items[0].baseUnitPrice, 350, 'no override keeps the private global price');

const priceConfig: StoreItemConfig = { storeId: STORE_ID, itemCode: ITEM_CODE, priceOverride: 375.5 };
const overriddenCheckout = await checkout({ config: priceConfig, publicItem: publicMenuItem({ salePrice: 375.5 }) });
eq(overriddenCheckout.items[0].baseUnitPrice, 375.5, 'Pay Online uses the private source-resolved store price');
eq(overriddenCheckout.items[0].lineSubtotal, 375.5, 'line money uses the source-resolved price');

for (const tamperedPrice of [350, 374, 376, 999]) {
  await assert.rejects(
    checkout({ config: priceConfig, publicItem: publicMenuItem({ salePrice: tamperedPrice }) }),
    /currently unavailable/,
  );
  ok(true, `a stale/tampered public price ${tamperedPrice} cannot override the private config`);
}

await assert.rejects(checkout({ includeMenuItem: false }), /currently unavailable/);
ok(true, 'a missing public menu row rejects a stale cart');
await assert.rejects(checkout({ includeAvailability: false }), /currently unavailable/);
ok(true, 'a missing public availability row rejects a stale cart');

const unavailableConfig: StoreItemConfig = { storeId: STORE_ID, itemCode: ITEM_CODE, isAvailableOverride: false };
await assert.rejects(
  checkout({
    config: unavailableConfig,
    publicAvailability: availability({ available: false, publicStatus: 'CURRENTLY_UNAVAILABLE' }),
    publicItem: publicMenuItem({ isAvailable: false }),
  }),
  /currently unavailable/,
);
ok(true, 'a matching availability=false override is enforced');
await assert.rejects(
  checkout({
    config: unavailableConfig,
    publicAvailability: availability({ available: true }),
    publicItem: publicMenuItem({ isAvailable: true }),
  }),
  /currently unavailable/,
);
ok(true, 'a public re-add cannot bypass a private availability=false override');

const availableConfig: StoreItemConfig = { storeId: STORE_ID, itemCode: ITEM_CODE, isAvailableOverride: true };
const availableCheckout = await checkout({
  privateProduct: product({ isAvailable: false }),
  config: availableConfig,
  publicAvailability: availability({ available: true, publicStatus: 'AVAILABLE' }),
  publicItem: publicMenuItem({ isAvailable: true }),
});
eq(availableCheckout.items[0].baseUnitPrice, 350, 'a matching availability=true override over a global false state succeeds');

const hiddenConfig: StoreItemConfig = { storeId: STORE_ID, itemCode: ITEM_CODE, menuVisibilityOverride: false };
await assert.rejects(
  checkout({ config: hiddenConfig, publicAvailability: availability(), publicItem: publicMenuItem() }),
  /currently unavailable/,
);
ok(true, 'a public re-add cannot bypass a private visibility=false override');

const zeroConfig: StoreItemConfig = { storeId: STORE_ID, itemCode: ITEM_CODE, priceOverride: 0 };
await assert.rejects(
  checkout({ config: zeroConfig, publicItem: publicMenuItem({ salePrice: 0 }) }),
  /currently unavailable/,
);
ok(true, 'explicit zero remains representable but cannot create a zero-value Pay Online charge');

const allStoresConfig: StoreItemConfig = { storeId: STORE_ID, itemCode: ITEM_CODE, priceOverride: 375.5 };
const allStoresCheckout = await checkout({
  privateProduct: product({ availableStoreIds: [] }),
  config: allStoresConfig,
  publicItem: publicMenuItem({ salePrice: 375.5 }),
});
eq(allStoresCheckout.items[0].baseUnitPrice, 375.5, 'empty assignment keeps its protected all-stores meaning in customer checkout');

await assert.rejects(
  checkout({ privateProduct: product({ availableStoreIds: ['OTHER_STORE'] }) }),
  /currently unavailable/,
);
ok(true, 'an explicitly different private store assignment cannot be bypassed by the public snapshot');

for (const sourceState of [{ isActive: false }, { isSellable: false }]) {
  await assert.rejects(
    checkout({ privateProduct: product(sourceState), publicItem: publicMenuItem() }),
    /currently unavailable/,
  );
  ok(true, `a public re-add cannot bypass private ${Object.keys(sourceState)[0]}=false`);
}

const otherStoreOverride = { storeId: 'OTHER_STORE', itemCode: ITEM_CODE, priceOverride: 999 };
const isolatedCheckout = await checkout({ extraConfigs: [otherStoreOverride] });
eq(isolatedCheckout.items[0].baseUnitPrice, 350, 'another store override never changes this store checkout');

await assert.rejects(
  checkout({ config: { storeId: 'OTHER_STORE', itemCode: ITEM_CODE, priceOverride: 375.5 } }),
  /Menu configuration is being refreshed/,
);
ok(true, 'a malformed config identity at the deterministic path fails closed');

const goldenStore = store({
  id: 'GOLDEN_I',
  code: 'GOLDEN_I',
  name: 'Golden I',
  posEnabled: true,
  customerOrderingEnabled: true,
  publicOrderingEnabled: true,
  acceptingOrders: true,
  isAcceptingOrders: true,
});
const goldenProduct = product({ availableStoreIds: ['GOLDEN_I'] });
const goldenConfig: StoreItemConfig = { storeId: 'GOLDEN_I', itemCode: ITEM_CODE, priceOverride: 375.5 };
const goldenWarningCheckout = await checkout({
  checkoutStore: goldenStore,
  privateProduct: goldenProduct,
  config: goldenConfig,
  publicAvailability: availability({ available: false, publicStatus: 'SETUP_INCOMPLETE' }),
  publicItem: publicMenuItem({ availableStoreIds: ['GOLDEN_I'], salePrice: 375.5 }),
});
eq(goldenWarningCheckout.items[0].baseUnitPrice, 375.5, 'the exact Golden I setup-warning exception preserves the source-resolved price');

await assert.rejects(
  checkout({
    checkoutStore: goldenStore,
    privateProduct: goldenProduct,
    config: { ...goldenConfig, priceOverride: 0 },
    publicAvailability: availability({ available: false, publicStatus: 'SETUP_INCOMPLETE' }),
    publicItem: publicMenuItem({ availableStoreIds: ['GOLDEN_I'], salePrice: 0 }),
  }),
  /currently unavailable/,
);
ok(true, 'the Golden I warning exception never permits a zero-value charge');

const effective = resolveServerStoreItem(product(), priceConfig);
const guarded = resolvePublicCheckoutProduct({
  product: effective,
  publicAvailability: availability(),
  publicMenuItem: publicMenuItem({ salePrice: 375.5 }),
  store: store(),
});
eq(guarded.salePrice, 375.5, 'the snapshot gate returns the private source-resolved product unchanged');

console.log(`\n${checks} Global Items checkout canonicalization checks passed. No Firebase or Razorpay network calls were made.`);
