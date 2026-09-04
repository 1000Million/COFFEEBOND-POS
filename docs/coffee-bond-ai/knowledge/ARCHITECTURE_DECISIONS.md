# Architecture Decisions

Each entry: the decision, why, and what it rules out.

## 1. Logical sales store aliased to a physical inventory store

The Tasting Room sells under its own identity but consumes Noida 29's stock.
`inventoryStoreId` maps logical → physical, **one level only**, failing closed on a
missing or chained alias.

Rules out: a duplicate stock pool, and silent mis-attribution of either sales or stock.

## 2. Payment-first lifecycle; nothing before acceptance

Money moves before the store commits. No POS order, KOT or stock movement exists until a
staff member accepts. Browser callback is never authoritative — the server independently
verifies with the provider, and a webhook path recovers lost callbacks.

Rules out: phantom orders from abandoned checkouts, and double-creation on retry.

## 3. Inventory policy is opt-in per store

`STRICT` (default) · `ALLOW_NEGATIVE` · `ALLOW_NEGATIVE_DEFER_BOM`, read from the store
document. Chosen over a global behaviour change so existing stores keep their guarantees.

Golden I retains its historical behaviour through an identity fallback when the field is
absent.

## 4. Sellability and inventory are separate concerns

Manual availability is the **only** operational sell/stop control. Stock shortage does not
withdraw an item; a missing BOM does not withdraw an item. Consumption defers to
`PENDING_BOM` and is backfilled exactly once.

Rules out: silent loss of sales because a back-office recipe is incomplete.

## 5. Composite structural validation was NOT weakened

For a store with an **explicit** `ALLOW_NEGATIVE_DEFER_BOM` policy, only a *missing or
empty child BOM* is tolerated. Genuine structural faults still block.

The reasoning: `SETUP_INCOMPLETE` conflates "recipe pending" (reconcilable later) with
"structurally broken" (never reconcilable — it fails at KOT routing or canonicalization).
Bypassing both would let a broken composite take money.

This is why `TR_MINI_AFFOGATO`, `TR_SET_A` and `TR_SET_B` remain blocked rather than being
forced live.

### Gated on the explicit field, not the identity fallback

An existing invariant states **"Golden I cannot bypass composite child readiness"**. A
first attempt gated this on the broader sales-first predicate and broke that invariant;
the test suite caught it. The bypass is therefore gated on the explicit `inventoryPolicy`
field, which Golden I does not set.

## 6. BOND points require payment completed online in the app

Point earning requires `PRIVATE_CHECKOUT_SESSION` provenance — written only by the
verified Razorpay payment-first flow. `PRIVATE_CUSTOMER_SUBMISSION` (Pay at Counter placed
in the app) and POS orders earn nothing.

Applied at the **point-earn path only**. Points and visits share `resolveOrigin`, so
changing that shared function would have silently altered visit policy too. The gate sits
downstream instead, leaving qualifying visits untouched.

This changed prior behaviour: in-app Pay-at-Counter orders previously *did* earn points.
The customer copy and the server policy were shipped together so the app and the ledger
cannot disagree.

## 7. Provisional data must be labelled and preview-only

The preview Mini Affogato BOM was marked `bomStatus: PROVISIONAL_PREVIEW`,
`ownerReviewRequired: true`, `bomApprovedForProduction: false`. It was never promoted.

Rules out: a QA convenience quietly becoming production truth.

## 8. New stores should be configuration, not development

Before writing code for a new store, check whether existing Location Management, store
provisioning, Finished Goods assignment, menu assignment, BOM import, availability, GST,
staff assignment, opening stock and readiness can already do it.

Target workflow:

```
ADMIN → NEW LOCATION → COPY/PROVISION STORE SETUP → EDIT STORE-SPECIFIC DATA
      → STAFF → OPENING STOCK → READINESS → ACTIVATE
```

A generic Petpooja-style **Copy Store Setup** is a future priority. Do not rebuild
store-specific architecture if generic configuration can solve it.
