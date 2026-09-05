#!/usr/bin/env node
// G7.1: the functions-side resolver and the frontend resolver must stay equivalent.
// functions/ is CommonJS and cannot import the frontend TS module, so the two
// implementations are separate by necessity and locked together by this test.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const server = require('../functions/storeItemConfig.js');

// Bundle the frontend TS implementation to CJS so both can be exercised in one process.
const bundle = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sic-parity-')), 'fe.cjs');
const entry = path.join(path.dirname(bundle), 'entry.ts');
fs.writeFileSync(entry, "export { storeItemConfigDocId, storeItemConfigDocPath, resolveStoreItem } from '" + path.resolve('frontend/lib/storeItemConfig') + "';\n");
execFileSync('npx', ['esbuild', entry, '--bundle', '--platform=node', '--format=cjs', '--outfile=' + bundle], { stdio: 'pipe' });
const client = require(bundle);

let n = 0;
const eq = (a, b, m) => { assert.deepEqual(a, b, `${m} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`); n += 1; console.log(`PASS ${n}. ${m}`); };

// ---- deterministic identity parity -------------------------------------------------
const idCases = [
  ['GOLDEN_I', 'BOND_FRAPPE'], ['GOLDEN_I', 'FG_1'], ['GOLDEN', 'I_FG_1'],
  ['NOIDA_29', 'ICED-VIETNAMESE'], ['store with spaces', 'item with spaces'],
  ['STORE/SLASH', 'ITEM/SLASH'], ['a.b~c:d@e+f', 'x.y~z:1@2+3'],
  ['', ''], ['  PADDED  ', '  CODE  '], ['UNI_café', 'ITEM_café'],
  ['A'.repeat(300), 'B'.repeat(300)],
];
for (const [s, i] of idCases) {
  eq(server.storeItemConfigDocId(s, i), client.storeItemConfigDocId(s, i), `Doc id parity: ${JSON.stringify([s.slice(0,20), i.slice(0,20)])}`);
}
eq(server.storeItemConfigDocPath('GOLDEN_I', 'BOND_FRAPPE'), client.storeItemConfigDocPath('GOLDEN_I', 'BOND_FRAPPE'), 'Doc path parity');
// The collision guard the doubled separator exists for.
assert.notEqual(server.storeItemConfigDocId('GOLDEN_I', 'FG_1'), server.storeItemConfigDocId('GOLDEN', 'I_FG_1'));
n += 1; console.log(`PASS ${n}. Separator prevents store/item id collision on the server too`);

// ---- price resolution parity ---------------------------------------------------------
const product = (salePrice, extra = {}) => ({ code: 'BOND_FRAPPE', salePrice, isAvailable: true, ...extra });
const priceCases = [
  ['no override', undefined],
  ['null override', null],
  ['empty override', {}],
  ['priceOverride 375', { priceOverride: 375 }],
  ['priceOverride 0 (explicit)', { priceOverride: 0 }],
  ['priceOverride null (inherit)', { priceOverride: null }],
  ['priceOverride undefined (inherit)', { priceOverride: undefined }],
  ['priceOverride NaN (ignored)', { priceOverride: NaN }],
  ['priceOverride Infinity (ignored)', { priceOverride: Infinity }],
  ['priceOverride string (ignored)', { priceOverride: '375' }],
  ['priceOverride negative', { priceOverride: -5 }],
  ['priceOverride fractional', { priceOverride: 375.375 }],
  ['unrelated field only', { sortOrderOverride: 0 }],
];
for (const [label, ov] of priceCases) {
  const p = product(350);
  const serverPrice = server.resolveEffectiveSalePrice(p, ov);
  const clientPrice = client.resolveStoreItem(p, ov).salePrice;
  eq(serverPrice, clientPrice, `Price parity — ${label}`);
}
eq(server.resolveEffectiveSalePrice(product(0), { priceOverride: 0 }), client.resolveStoreItem(product(0), { priceOverride: 0 }).salePrice, 'Price parity — global 0 and override 0');

// ---- availability resolution parity ---------------------------------------------------
const availCases = [
  ['no override', undefined],
  ['isAvailableOverride false (explicit)', { isAvailableOverride: false }],
  ['isAvailableOverride true', { isAvailableOverride: true }],
  ['isAvailableOverride null (inherit)', { isAvailableOverride: null }],
  ['isAvailableOverride non-boolean (ignored)', { isAvailableOverride: 'false' }],
];
for (const [label, ov] of availCases) {
  for (const globalAvail of [true, false]) {
    const p = product(350, { isAvailable: globalAvail });
    eq(server.resolveEffectiveIsAvailable(p, ov), client.resolveStoreItem(p, ov).isAvailable, `Availability parity — ${label}, global=${globalAvail}`);
  }
}

// ---- presence semantics must never be truthiness --------------------------------------
eq(server.hasOverride({ priceOverride: 0 }, 'priceOverride'), true, 'Server: priceOverride 0 counts as PRESENT');
eq(server.hasOverride({ isAvailableOverride: false }, 'isAvailableOverride'), true, 'Server: isAvailableOverride false counts as PRESENT');
eq(server.hasOverride({ priceOverride: null }, 'priceOverride'), false, 'Server: null counts as ABSENT');
eq(server.hasOverride({}, 'priceOverride'), false, 'Server: missing counts as ABSENT');

// ---- store scoping ---------------------------------------------------------------------
const rows = [{ storeId: 'GOLDEN_I', itemCode: 'A', priceOverride: 1 }, { storeId: 'NOIDA_29', itemCode: 'A', priceOverride: 2 }];
eq(Object.keys(server.storeItemConfigByItemCode('GOLDEN_I', rows)), ['A'], 'Server indexes only the requested store');
eq(server.storeItemConfigByItemCode('GOLDEN_I', rows).A.priceOverride, 1, 'Server picks the correct store row');
eq(Object.keys(server.storeItemConfigByItemCode('OTHER', rows)).length, 0, 'Server ignores rows for other stores');

console.log(`\n${n} functions/frontend store-item-config parity checks passed.`);
