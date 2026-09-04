# POS Implementation History

This is the durable implementation history, not a commit log. Exact production deploys
and rollback identifiers live in `DEPLOYMENT_HISTORY.md`.

## Existing POS foundation

Coffee Bond already had Cash, UPI, split payment, role-capped discounts, hold/recall,
voids, receipts, reporting, KOT, inventory, online orders, and store-scoped permissions.
New work must preserve these behaviours rather than replacing checkout.

Held bills deliberately create no KOT or stock movement. Recall resumes one transaction.
Voids require a reason, reverse stock exactly once, and remain visible in reporting.

## Customer payment-first ordering

Customer ordering evolved to an OTP-authenticated canonical private checkout. The server
re-prices the cart and verifies Razorpay independently; a browser callback alone is never
proof of payment. Paid requests wait for staff acceptance before POS/KOT/stock creation.
Idempotency and webhook recovery cover retries and callback loss.

## Finished Goods V2 and deferred BOM

Inventory moved to Finished Goods and structured BOMs. Per-store policies introduced
strict stock, negative-stock selling, and explicit missing-BOM deferral. Deferred lines
retain immutable context in `pendingInventoryConsumption` and backfill exactly once.

Sellability remains an operational availability decision; it is not inferred from a
positive stock number. Existing strict stores were not globally migrated.

## Logical sales versus physical inventory

One-level `inventoryStoreId` aliasing was added for concepts such as the Tasting Room.
Orders, KOT, reporting, and loyalty remain logical while stock and movements use the
physical store. Chained or missing aliases fail closed, and movements preserve logical
attribution.

## Composite fulfilment and KOT aggregation

One-level composites gained immutable canonical component snapshots, static children,
`SINGLE` and `EXACT_DISTINCT` choices, component BOM expansion, and independent station
routing. Multiple KOT tasks still represent one commercial sale.

`aggregateKotOrderStatus` moved sibling-state aggregation to server authority so station
staff do not require cross-station reads. Cancellation, return, wastage, and remake states
retain explicit precedence.

## Tasting Room rollout

The Tasting Room first proved the complete flow in isolated preview, including two-station
Mini Affogato routing and exactly-once stock/loyalty. Preview quantities were explicitly
provisional and were not promoted as recipe truth.

Production then launched `TASTING_ROOM_29` with Noida 29's real document id as physical
inventory, an explicit `ALLOW_NEGATIVE_DEFER_BOM` policy, isolated public menu, and
nearest-store exclusion. Eighteen items are live; Mini Affogato and Sets A/B remain
blocked until structurally complete.

## BOND provenance change

Production point earning was narrowed to verified customer Pay Online checkout provenance.
Pay at Counter and staff/POS orders earn zero. The gate was kept out of shared origin
resolution so qualifying-visit policy remained unchanged, and customer copy shipped with
the policy.

## Repository caveat

The production implementation described above was deployed ahead of Git and remains an
uncommitted working-tree delta at this handoff. Preserving that exact delta is the current
highest repository-safety priority.
