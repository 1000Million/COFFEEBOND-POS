# The Tasting Room

_Live in production since 2026-09-03._

## Identity

| | |
|---|---|
| Logical sales store | `TASTING_ROOM_29` |
| Name | The Tasting Room by Coffee Bond |
| Customer URL | `https://order.coffeebond.in/?store=TASTING_ROOM_29` |
| Physical inventory store | `cJk69Ti1mveh603L4edw` (Noida Sector 29) |

## Production configuration

```
inventoryStoreId          = cJk69Ti1mveh603L4edw
physicalParentStoreId     = cJk69Ti1mveh603L4edw
legalAndGstSourceStoreId  = cJk69Ti1mveh603L4edw
inventoryPolicy           = ALLOW_NEGATIVE_DEFER_BOM
excludeFromNearestSelection = true
customerOrderingEnabled   = true
```

**Do NOT use `NOIDA_29` as the production `inventoryStoreId`** — see `STORES_AND_IDS.md`.

## The logical/physical split

- **Sales, orders, KOT, loyalty and reporting** attribute to `TASTING_ROOM_29`
- **All stock movements** attribute to `cJk69Ti1mveh603L4edw`
- Movements preserve the sales identity in `logicalSalesStoreId` /
  `logicalSalesStoreCode` / `logicalSalesStoreName`

**There is no separate Tasting Room stock pool.** It draws on Noida 29's physical stock.

The resolver is **one level only** and fails closed on a missing or chained alias.

## Customer presentation

```
THE TASTING ROOM
Coffee Bond · Noida Sector 29
For the love of discovering.
```

No "Pickup from" wording — that is the ordinary-store copy. The Bond Table is an
informational-only category and cannot enter cart, checkout or payment paths.

## Menu state

**18 available · 3 blocked.**

Blocked: `TR_MINI_AFFOGATO`, `TR_SET_A`, `TR_SET_B`.

Live flights: `TR_COFFEE_THREE_WAYS`, `TR_COLD_BOND_FLIGHT`, `TR_ZERO_PROOF_FLIGHT`,
`TR_WAKE_UP_WITH_BOND`.

Catalogue totals: 35 finished goods (21 sellable + 14 internal components), 8 categories,
4 add-on/choice groups.

Internal components are `isSellable: false` so they never appear on the menu, but their
`isAvailable` state decides whether their composite parent can be sold.

## Composite validation — do not weaken

For a store with an explicit `ALLOW_NEGATIVE_DEFER_BOM` policy, a **missing or empty
child BOM** is tolerated (consumption defers to `PENDING_BOM`).

**Everything else still blocks:**

- missing / unresolvable child Finished Good
- malformed child identity
- invalid prep station
- unsupported nested composite
- invalid item type or production mode
- manually unavailable component
- malformed BOM references (a BOM that exists but points at a non-existent master)

These cannot be reconciled by backfill and would fail at KOT routing or canonicalization.
All six were verified to still block by fault injection.

## Why Set A and Set B remain blocked

Both declare `unresolvedCompositeRequirements`: "two miniature drinks", which the owner
has not defined. Mini Affogato is blocked pending an approved recipe — see
`ARCHITECTURE_DECISIONS.md`.
