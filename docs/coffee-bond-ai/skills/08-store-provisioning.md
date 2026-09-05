# 08 — Store Provisioning

Future stores should be configuration, not bespoke development.

## First decision

Before proposing code, inspect whether the request is already supported by:

- Location Management and `storeProvisioning` / `storeProvisioningPolicy`;
- POS Readiness and Go Live Readiness;
- store and Finished Goods assignment;
- BOM and prep imports;
- add-ons, modifiers, availability, and public-menu publication;
- GST/legal configuration;
- synchronized `storeIds` and `assignedStoreIds`;
- opening stock and activation controls.

Only add code when the current implementation proves a limitation.

## Identity and alias rules

Do not assume store document id equals store code. `stores` and `storeStock` use document
ids; `publicMenuAvailability` uses store code. Confirm the authoritative production id
before any alias or stock write.

Aliasing is one level: `effectiveInventoryStoreId = store.inventoryStoreId || store.id`.
A missing or chained alias fails closed. Sales/order/KOT/reporting/loyalty retain logical
identity while stock uses physical identity and movements record both.

## The clone engine already exists — extend it, never rebuild it

**Superseded (2026-09): this workflow is shipped, not aspirational.** Earlier revisions of
this file described a Petpooja-style Copy Store Setup as "the future priority". It exists.

```text
ADMIN → NEW LOCATION → COPY/PROVISION STORE SETUP → EDIT STORE-SPECIFIC DATA
      → STAFF → OPENING STOCK → READINESS → ACTIVATE
```

`functions/storeProvisioning.js` + `functions/storeProvisioningPolicy.js` expose ten Admin
callables (`previewStoreProvisioning`, `createStoreFromTemplate`, `updateStoreConfiguration`,
`enableInternalPosTest`, `markInternalPosTestPassed`, `saveLocationOpeningStock`,
`saveLocationStaffAssignments`, `setPosLaunchException`, `activateStore`,
`setStoreCustomerOrdering`), driven from `frontend/pages/admin/LocationManagement.tsx`.

What it already guarantees:

- dry-run preview before any write, with a deterministic SHA-256 plan checksum;
- idempotency on a caller-supplied `provisioningJobId`; a completed job replays instead of
  rewriting, and apply refuses unless the caller echoes the preview checksum back;
- destination created as `status: DRAFT` with POS, customer ordering and activation off,
  `assignedStaffCount: 0`, and every readiness key false;
- `NEVER_COPY_COLLECTIONS` (24 entries) excluding orders, payments, KOT, held bills,
  customers, stock movements, users, void records and the public menu snapshot;
- menu copied by **reference** — the destination id is appended to
  `finishedGoods.availableStoreIds`; no product document is duplicated;
- add-ons and KOT routing reused as global Finished Good fields, never duplicated;
- destination `storeStock` rows created at zero unless an operator explicitly chooses a
  non-default inventory option (which additionally requires a typed store-code
  confirmation and a reason).

Do not solve a future store through custom code, and do not write a second clone engine.
When new behaviour is needed, extend these files.

## Cloning never copies images or the public menu

Product images are **global shared references** (`finishedGoods.imageUrl` +
`imageStoragePath`, Firebase Storage prefix `menu-images`). Because the product document is
shared, a cloned store reuses the same Storage object automatically. Never copy or
re-upload image binaries per store, and never add a per-store image override.

`publicMenuAvailability` is not copied either. The destination snapshot must be **rebuilt
from destination-resolved state**, never cloned from the source. POS Readiness can create a
store's first snapshot. Customer-ordering enablement remains separately gated — publishing a
snapshot does not turn a store on.

Preview ids and sparse fixtures are not production truth. Re-resolve every production
document id and legal/GST source before promotion.

## Store flags that matter

```
isActive, status
posEnabled, onlineOrderingEnabled, customerOrderingEnabled,
publicOrderingEnabled, acceptingOrders, isAcceptingOrders
excludeFromNearestSelection     - keeps a store out of nearest-store auto-selection
inventoryPolicy                 - STRICT | ALLOW_NEGATIVE | ALLOW_NEGATIVE_DEFER_BOM
inventoryMode                   - e.g. FINISHED_GOODS
legalAndGstSourceStoreId        - where legal/GST config is inherited from
customerPresentation            - concept name, location label, tagline, labels
```

Non-admin fulfilment requires staff access to **both** stores of an aliased pair; Admin is
exempt. Real production document ids are recorded in `../knowledge/STORES_AND_IDS.md`.
