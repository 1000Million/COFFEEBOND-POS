# 06 — BOND Loyalty

Point earning and qualifying visits are separate mechanisms. They share some origin
resolution but have independent eligibility gates. Never change one by editing shared
origin logic without explicitly evaluating the other.

## Current production point policy

| Origin | BOND points |
|---|---|
| Customer app + verified Pay Online | eligible |
| Customer app + Pay at Counter | zero |
| POS or staff-created order | zero |

Point earning requires `PRIVATE_CHECKOUT_SESSION` provenance.
`PRIVATE_CUSTOMER_SUBMISSION` must not earn points. Apply future point-policy changes in
the point path unless the owner separately approves a visit-policy change.

## Visits

Qualifying visits remain governed by their existing origin, takeaway/final-state, minimum
eligible-spend, business-date, and one-per-day lock rules. The lock id is customer plus
business date. Partial-cancel and remake visit semantics are intentionally unresolved and
must not be changed incidentally.

## Exactly once

Ledger event ids and visit-lock ids are the idempotency keys. Retries must create no
second point earn, reversal, visit, or day lock. Reversals remain possible for a historic
posted event even if earning is disabled later. Never rewrite historic ledger entries.

Eligible spend excludes GST and other non-qualifying amounts. UI copy and server policy
must ship together so customers are never promised points that the ledger will reject.

## Idempotency key formats

The document id **is** the idempotency key in every case:

```
POINT_EARN__{orderId}__{policyVersion}
POINT_EARN_REVERSAL__{orderId}__{policyVersion}
QUALIFY_VISIT_ORDER__{orderId}__{policyVersion}
QUALIFY_VISIT_REVERSAL__{orderId}__{policyVersion}
```

The visit day lock is `qualifyingVisitDays/{customerId}__{businessDate}`.

## Visit gating (concrete)

`origin.eligible` AND `orderType === 'TAKEAWAY'` AND a final settled order AND
`eligibleSpendPaise >= BOND_POLICY.visitMinimumPaise` (currently 15000 paise = Rs 150),
then capped at one per customer per business day by the lock above.

## Spend excludes GST

Points are calculated on `taxableAmount`. A Rs 220 item with Rs 11 GST yields
`eligibleSpendPaise = 22000`, not 23100. Delivery fees, service fees, tips, gift cards,
membership fees and point-funded amounts are all excluded.

## Where the point gate lives

Both the point path and the visit path call `resolveOrigin`. The payment-provenance gate is
applied **downstream, on the point-earn path only** — never inside `resolveOrigin` — which
is what keeps visit policy untouched. Deploying only `processBondOrderLoyalty` is a
legitimate way to change point policy without touching visits.

## Functions

- `processBondOrderLoyalty` owns point earning and reversal.
- `processBondPickupLoyalty` owns qualifying-visit processing.
- `getCustomerBondSummary` serves the customer account view.
