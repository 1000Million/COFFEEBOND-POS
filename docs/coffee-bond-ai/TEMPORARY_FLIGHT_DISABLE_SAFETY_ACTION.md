# Temporary Tasting Room flight disable — completed and restored

Status: **TEMPORARY DISABLE COMPLETED; OWNER-APPROVED RE-ENABLE APPLIED AFTER PHASE 4 HOTFIX — 2026-09-04**

This bounded production safety action was approved in Phase 3 and applied only to project
`coffee-bond-pos` and logical store `TASTING_ROOM_29`. It held the four flights unavailable
while the composite fix remained preview-only. Phase 4 then deployed the scoped hotfix and,
only after all four functions were ACTIVE, restored the captured availability state under
separate explicit owner approval.

## Exact products

- `finishedGoods/TR_COFFEE_THREE_WAYS`
- `finishedGoods/TR_COLD_BOND_FLIGHT`
- `finishedGoods/TR_ZERO_PROOF_FLIGHT`
- `finishedGoods/TR_WAKE_UP_WITH_BOND`

## Preflight and rollback capture

1. Read the four Finished Good documents and `publicMenuAvailability/TASTING_ROOM_29` without writing.
2. Verify every document exists, its `code` equals its document id, and `availableStoreIds` contains `TASTING_ROOM_29`.
3. Capture each document update time plus the exact current values of `isAvailable` and the corresponding public `items` and `menuItems` entries, including snapshot counts. This captured state is the rollback payload.
4. Abort if the project id, store id, document identity, or any update time differs before the write transaction commits.

## Applied write shape

In one preconditioned transaction:

- Set only `isAvailable=false` on the four Finished Good documents.
- Set the four public `items.<code>` entries to `available=false`, `publicStatus=CURRENTLY_UNAVAILABLE`, and `publicMessage=Currently unavailable`.
- Set `menuItems.<code>.isAvailable=false` for the four public display entries.
- Recalculate `availableCount` and `unavailableCount` from the resulting public snapshot; update only its audit timestamp/actor fields in addition to those availability paths.

Do not alter `isActive`, `isSellable`, prices, tax, composite definitions, BOMs, store policy, stock, orders, KOTs, payments, customers, or the two existing pending orders.

## Temporary disabled-state verification

- All four exact Finished Goods had `isAvailable=false`.
- All four exact public availability entries were `CURRENTLY_UNAVAILABLE`.
- `publicMenuAvailability/TASTING_ROOM_29` reported `availableCount=14` and `unavailableCount=7` across 21 items.
- The `GOLDEN_I`, `NOIDA_29`, `NOIDA_51`, and `UDAY_PARK` public snapshots were byte-for-byte unchanged by the guarded transaction.
- The update times of protected pending production orders `SyxpmdmKJhVH01Ril1Sb` and `ix3Tv99oCC3nzBrC6t57` were unchanged across the action.

## Captured restore target — applied after the Phase 4 hotfix

Immediately before the Phase 3 guarded transaction, all four exact products and their
public entries were available. The captured Tasting Room counts were `availableCount=18`
and `unavailableCount=3`.

After the Phase 4 production functions became ACTIVE, a new guarded preflight verified
the disabled-state document hashes and update times. One transaction then restored only
the four products and their matching public availability entries. Final verification:

- All four exact Finished Goods and public entries are available.
- `publicMenuAvailability/TASTING_ROOM_29` reports `availableCount=18` and
  `unavailableCount=3` across 21 items.
- The blocked set is exactly `TR_MINI_AFFOGATO`, `TR_SET_A`, and `TR_SET_B`.
- The `GOLDEN_I`, `NOIDA_29`, `NOIDA_51`, and `UDAY_PARK` public snapshots are unchanged.
- Both protected historical order document hashes and update times are unchanged.
