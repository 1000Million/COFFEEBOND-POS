# 05 — KOT and Online-Order Lifecycle

## Acceptance boundary

Paid customer orders wait in `PAID_PENDING_ACCEPTANCE`. Staff acceptance is the only
boundary that may create the POS order, KOT tasks, and stock consumption. Acceptance is
idempotent and must preserve one commercial sale.

## Stations and composites

Supported stations are `BARISTA`, `KITCHEN`, `BOTH`, and `NONE`. A composite parent may
use `NONE` while its canonical children route independently. Multiple station tasks do
not create multiple sales.

Normal lifecycle:

```text
PENDING → PREPARING → READY → SERVED
```

Cancellation, return, wastage, and remake states have explicit precedence and must not be
overwritten by a later sibling update.

## Server aggregation

`aggregateKotOrderStatus` watches `kotItems/{kotId}` updates and computes customer-facing
status with server authority. Station staff do not need cross-station reads. The trigger
may run more than once; aggregation and fulfilment remain idempotent.

The public result belongs in `publicOrderTracking`. The commercial order remains one sale
even when BARISTA and KITCHEN complete at different times.

## Store scoping

KOT, order, reporting, and loyalty use the logical sales store. Inventory uses the
physical alias. Non-admin fulfilment requires access to both sides of an aliased pair;
Admin remains exempt. Always check the selected store filter before concluding an online
order is missing.

## Concrete identifiers

KOT documents live in `kotItems` with deterministic ids, e.g.
`{orderId}_{orderId}_ITEM_01_COMP_001_BARISTA`. A single composite order produces one POS
order and one ticket per station.

The KOT screen filters on `status in ['PENDING','PREPARING']`, so a ticket leaves that view
once it reaches `READY`; serving happens on the Ready to Serve screen, which writes
`status: 'SERVED'` plus `servedAt` and the handling staff.

A composite parent typically carries `prepStation: NONE` — routing comes from its
components.

Aggregation writes the customer-facing rollup to `publicOrderTracking` (`publicStatus`,
`customerStatusMessage`, `readyAt`). The POS order's own `status` reflects
payment/fulfilment and does not change on serve.

Incoming Online Orders auto-selects the alphabetically first accessible store and queries
only that one, so an order can appear missing when it is merely filtered out.

## First places to inspect

- `frontend/pages/pos/IncomingOnlineOrders.tsx`
- `frontend/pages/kot/KOTScreen.tsx`
- `frontend/pages/kot/ReadyToServe.tsx`
- `functions/kotStatusAggregation.js`
- `functions/onlineOrderInventory.js`
