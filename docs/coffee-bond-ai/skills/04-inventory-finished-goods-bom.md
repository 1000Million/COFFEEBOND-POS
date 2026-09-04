# 04 — Inventory, Finished Goods, and BOM

Active model: **FINISHED_GOODS V2 / FINISHED_GOODS**.

## Sellability and inventory are separate

Manual availability controls whether an item can be sold. Stock shortage must not
silently withdraw an opted-in sales-first item, and a missing BOM may defer only under the
explicit store policy that permits it.

| `store.inventoryPolicy` | Stock shortage | Missing BOM |
|---|---|---|
| `STRICT` or absent | blocks | blocks |
| `ALLOW_NEGATIVE` | allowed | blocks |
| `ALLOW_NEGATIVE_DEFER_BOM` | allowed | creates pending consumption |

Do not apply a non-strict policy to existing stores implicitly. Stock may go below zero
and must never be clamped: `-8 + 20 = 12` after a later receipt.

## Pending BOM contract

When an eligible store cannot resolve a BOM:

- set `inventoryConsumptionStatus=PENDING_BOM`;
- create a `pendingInventoryConsumption` record;
- preserve immutable order/item and logical/physical store context;
- use a deterministic idempotency key;
- backfill later exactly once.

Never silently skip inventory forever. Never duplicate a backfill.

## BOM structure

Stored BOM rows require a supported `componentType`, code/name, positive quantity, and
canonical `uom`. Supported units are `G`, `KG`, `ML`, `L`, and `PCS`. Do not substitute
`unit` for `uom` or invent quantities from prices or names.

One-level composite parents resolve component Finished Goods. Their child identity,
quantity, station, and BOM snapshot become immutable order evidence. Nested composites,
missing children, malformed components, invalid station/type, manually disabled children,
and malformed BOM references fail closed.

## Logical versus physical stock

`effectiveInventoryStoreId = store.inventoryStoreId || store.id`.
Sales remain attributed to the logical store; stock documents and movements use the
resolved physical document id. Movements retain logical sales attribution.

## BOM row shape (concrete)

Five load-bearing fields. `uom` is mandatory — `unit` is not a valid substitute on a
stored row.

```json
{"componentType":"RAW_INGREDIENT","componentCode":"X","componentName":"X",
 "quantity":36,"uom":"ML","costPerUnit":0.84,"lineCost":30.4}
```

`componentType` is one of `RAW_INGREDIENT`, `PREP_ITEM`, `BOUGHT_COMPONENT`,
`FINISHED_GOOD`, `PACKAGING`. **`INVENTORY_ITEM` does not exist anywhere in the deduction
path.**

`costPerUnit` and `lineCost` are declared on the type but are never read by either
deduction engine — cost comes from the `storeStock` row.

A composite parent's own `bom` is **never consulted**; each component's BOM is expanded
instead, so an empty parent BOM is normal.

## Stock document id

```
{resolvedInventoryStoreId}_{stockItemType}_{stockItemCode}
```

Built from the **resolved physical** store id, which may differ from the sales store.

## Pending consumption idempotency key

```
{storeId}_{orderId}_{lineKey}
```

This is what makes duplicate backfill consumption structurally impossible.

## Never fabricate BOM data

If a recipe cannot be verified from approved master data, leave the item unavailable with
`setupStatus: BOM_PENDING` and report the gap. **Do not use `NO_STOCK` as a workaround.**

Provisional data must be labelled — `bomStatus: PROVISIONAL_PREVIEW`,
`ownerReviewRequired: true`, `bomApprovedForProduction: false` — and must stay
preview-only. Cost cannot be used to derive quantity: the costing sheet prices an espresso
shot at a flat 30.4 whether it is 36 ml or 45 ml.

## First places to inspect

- `functions/inventoryStoreResolver.js`
- `frontend/lib/inventoryStoreResolver.ts`
- `functions/onlineOrderInventory.js`
- `frontend/lib/inventoryDeduction.ts`
- `scripts/backfill-pending-bom-consumption.mjs`
- `frontend/lib/publicMenuAvailability.ts`
