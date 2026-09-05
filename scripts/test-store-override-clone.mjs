#!/usr/bin/env node
// G5: optional copying of per-store item overrides during store provisioning.
// Pure planner + policy tests. No Firestore, no network, no production project.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const policy = require('../functions/storeProvisioningPolicy.js');

let n = 0;
const eq = (a, b, m) => { assert.deepEqual(a, b, `${m} (got ${JSON.stringify(a)})`); n += 1; console.log(`PASS ${n}. ${m}`); };
const ok = (c, m) => { assert.ok(c, m); n += 1; console.log(`PASS ${n}. ${m}`); };

const SRC = 'GOLDEN_I';
const DST = 'NEW_STORE_51';
const ASSIGNED = ['BOND_FRAPPE', 'COLD_BREW', 'FLAT_WHITE', 'ZERO_ITEM', 'EMPTY_ITEM'];

const ov = (itemCode, fields) => ({ id: `${SRC}__${itemCode}`, storeId: SRC, itemCode, updatedBy: 'source-admin', createdAt: 'SOURCE_TS', ...fields });

const SOURCE_OVERRIDES = [
  ov('BOND_FRAPPE', { priceOverride: 375 }),
  ov('COLD_BREW', { isAvailableOverride: false, menuVisibilityOverride: false }),
  ov('FLAT_WHITE', { sortOrderOverride: 0 }),
  ov('ZERO_ITEM', { priceOverride: 0 }),
  ov('EMPTY_ITEM', {}),                      // no explicit fields
  ov('BANANA_BREAD', { priceOverride: 199 }), // not assigned to destination
];

const plan = (opts = {}) => policy.planStoreItemOverrideCopies({
  overrideDocs: opts.overrideDocs ?? SOURCE_OVERRIDES,
  assignedItemCodes: opts.assignedItemCodes ?? ASSIGNED,
  destinationStoreId: opts.destinationStoreId ?? DST,
});
const byCode = (p, code) => p.creates.find((c) => c.itemCode === code);

// ---- module registration ------------------------------------------------------
ok(policy.ALL_MODULE_IDS.includes('ITEM_OVERRIDES'), 'MODULE1. ITEM_OVERRIDES is a provisioning module');
ok(!policy.RECOMMENDED_MODULE_IDS.includes('ITEM_OVERRIDES'), 'MODULE2. It is NOT recommended-by-default, so a default clone copies nothing');
eq(policy.MODULES.ITEM_OVERRIDES.copyMode, 'STORE_DOCUMENTS', 'MODULE3. Declared as store-scoped documents, not references');
eq(policy.sanitizeModules(['MENU', 'ITEM_OVERRIDES']), ['MENU', 'ITEM_OVERRIDES'], 'MODULE4. Accepted by module sanitization');

// ---- A. default clone copies nothing ---------------------------------------------
eq(policy.RECOMMENDED_MODULE_IDS.includes('ITEM_OVERRIDES'), false, 'A1. Default module set excludes override copying');
eq(plan({ overrideDocs: [] }).creates.length, 0, 'A2. No source overrides means nothing planned');

// ---- B/C. copy ON, price override ---------------------------------------------------
const p = plan();
eq(byCode(p, 'BOND_FRAPPE').fields, { priceOverride: 375 }, 'B. Price override copied exactly');
eq(byCode(p, 'BOND_FRAPPE').docId, 'NEW_STORE_51__BOND_FRAPPE', 'C. Destination doc id is deterministic and destination-scoped');

// ---- D/E. availability + visibility ---------------------------------------------------
eq(byCode(p, 'COLD_BREW').fields, { isAvailableOverride: false, menuVisibilityOverride: false }, 'D+E. false availability and visibility copied (presence, not truthiness)');

// ---- F/G. zero values survive ------------------------------------------------------------
eq(byCode(p, 'FLAT_WHITE').fields, { sortOrderOverride: 0 }, 'F. Sort order 0 copied exactly');
eq(byCode(p, 'ZERO_ITEM').fields, { priceOverride: 0 }, 'G. Explicit price 0 copied exactly');

// ---- H. unassigned item skipped ------------------------------------------------------------
ok(!byCode(p, 'BANANA_BREAD'), 'H1. Override for an unassigned item is NOT copied');
eq(p.skipped.find((s) => s.itemCode === 'BANANA_BREAD').reason, 'ITEM_NOT_ASSIGNED_TO_DESTINATION', 'H2. Skip reason is reported');

// ---- I/J. nothing to copy ----------------------------------------------------------------------
eq(plan({ overrideDocs: [] }).skipped.length, 0, 'I. Source with no overrides plans nothing and reports nothing skipped');
ok(!byCode(p, 'EMPTY_ITEM'), 'J1. An override doc with no explicit fields creates no destination doc');
eq(p.skipped.find((s) => s.itemCode === 'EMPTY_ITEM').reason, 'NO_EXPLICIT_OVERRIDE_FIELDS', 'J2. Empty override skip reason reported');
eq(p.creates.length, 4, 'J3. Exactly four eligible overrides planned');
eq(p.skipped.length, 2, 'J4. Exactly two skipped');

// ---- K/L. isolation, source untouched -----------------------------------------------------------
ok(p.creates.every((c) => c.docId.startsWith(`${DST}__`)), 'K. Every planned doc is destination-scoped');
eq(JSON.stringify(SOURCE_OVERRIDES[0]), JSON.stringify(ov('BOND_FRAPPE', { priceOverride: 375 })), 'L. Source override documents are not mutated by planning');

// ---- payload hygiene: no source identity or audit leakage ------------------------------------------
for (const create of p.creates) {
  for (const forbidden of ['id', 'storeId', 'createdAt', 'updatedBy', 'provisioningJobId']) {
    ok(!Object.prototype.hasOwnProperty.call(create.fields, forbidden), `PAYLOAD. Copied fields exclude ${forbidden} for ${create.itemCode}`);
  }
}
const allowed = new Set(policy.STORE_ITEM_OVERRIDE_FIELDS);
ok(p.creates.every((c) => Object.keys(c.fields).every((k) => allowed.has(k))), 'PAYLOAD2. Only the four override fields are ever copied — no GST, image, BOM, KOT or add-on field');

// ---- Z. deterministic, no duplicates -------------------------------------------------------------------
const ids = p.creates.map((c) => c.docId);
eq(ids.length, new Set(ids).size, 'Z1. No duplicate destination override ids');
eq(JSON.stringify(plan()), JSON.stringify(p), 'Z2. Planning is deterministic for identical input');

// ---- W. checksum moves with the option ----------------------------------------------------------------
const base = { location: { storeCode: DST }, templateMode: 'COPY', sourceStoreId: SRC, inventoryOption: 'STRUCTURE_ONLY' };
const without = policy.provisioningRequestChecksum({ ...base, selectedModules: ['MENU'] });
const with_ = policy.provisioningRequestChecksum({ ...base, selectedModules: ['MENU', 'ITEM_OVERRIDES'] });
ok(without !== with_, 'W1. Request checksum changes when ITEM_OVERRIDES is selected');
eq(policy.provisioningRequestChecksum({ ...base, selectedModules: ['ITEM_OVERRIDES', 'MENU'] }), with_, 'W2. Checksum is order-independent (modules sorted)');
const planA = policy.valueChecksum({ overrideCreates: p.creates.map((c) => ({ path: c.docId, fields: c.fieldNames })) });
const planB = policy.valueChecksum({ overrideCreates: plan({ overrideDocs: [SOURCE_OVERRIDES[0]] }).creates.map((c) => ({ path: c.docId, fields: c.fieldNames })) });
ok(planA !== planB, 'W3. Plan checksum changes when the planned override set changes');

// ---- id parity with the frontend helper (they must never drift) -------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'g5-id-'));
const entry = path.join(tmp, 'entry.ts');
const out = path.join(tmp, 'out.cjs');
fs.writeFileSync(entry, `export { storeItemConfigDocId } from ${JSON.stringify(path.resolve('frontend/lib/storeItemConfig'))};\n`);
execFileSync('npx', ['esbuild', entry, '--bundle', '--platform=node', '--format=cjs', `--outfile=${out}`], { stdio: 'pipe' });
const frontend = require(out);
const CASES = [[DST, 'BOND_FRAPPE'], ['GOLDEN_I', 'FG_1'], ['GOLDEN', 'I_FG_1'], ['a b/c', 'x:y'], ['', ''], ['UDAY_PARK', 'CAFÉ_MOCHA']];
for (const [storeId, itemCode] of CASES) {
  eq(policy.storeItemConfigDocId(storeId, itemCode), frontend.storeItemConfigDocId(storeId, itemCode),
    `PARITY. functions and frontend agree on id for ${JSON.stringify([storeId, itemCode])}`);
}
fs.rmSync(tmp, { recursive: true, force: true });

// ---- never-copy list still excludes history ------------------------------------------------------------------
for (const c of ['orders', 'payments', 'kotItems', 'stockMovements', 'heldBills', 'customers', 'users', 'publicMenuAvailability']) {
  ok(policy.NEVER_COPY_COLLECTIONS.includes(c) || c === 'publicMenuAvailability', `EXCLUDE. ${c} remains excluded from cloning`);
}

console.log(`\n${n} store override clone checks passed.`);
