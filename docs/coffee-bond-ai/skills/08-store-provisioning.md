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

## Desired generic workflow

```text
ADMIN → NEW LOCATION → COPY/PROVISION STORE SETUP → EDIT STORE-SPECIFIC DATA
      → STAFF → OPENING STOCK → READINESS → ACTIVATE
```

The future priority is a Petpooja-style generic **Copy Store Setup** workflow. Do not
solve each future store through custom code.

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
