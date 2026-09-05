# 01 — Core Architecture

**This is an existing production system serving real customers.** Treat every change
accordingly.

## Projects

| | |
|---|---|
| Production | `coffee-bond-pos` |
| Preview / QA | `coffee-bond-pos-preview` |

There is **no default project alias**. `--project` is mandatory on every Firebase command.

`coffee-bond-pos` is a **prefix** of `coffee-bond-pos-preview` — never distinguish them
with a substring match.

## Applications

Two frontends share one `frontend/` source tree and one `frontend/index.css`:

| App | Build | Output | Site | Domain |
|---|---|---|---|---|
| Customer | `vite build --config vite.customer.config.ts` | `dist-customer/` | `coffee-bond-order` | `order.coffeebond.in` |
| Staff / POS | `vite build` | `dist/` | `coffee-bond-pos` | `pos.coffeebond.in` |

A change to shared code affects both. Always rebuild and test both.

Customer OTP runs on a **separate Firebase app** (`coffee-bond-customer-auth`) while
Firestore is bound to the default app — which is why customer Firestore traffic is
unauthenticated and reads only the public menu snapshot.

## The approved customer order lifecycle

```
OTP
  → canonical private checkout (server re-prices the cart)
  → Razorpay
  → server-side payment verification
  → PAID_PENDING_ACCEPTANCE
  → staff acceptance
  → POS order
  → KOT
  → inventory consumed exactly once
```

### Non-negotiable rules

1. **Never create a POS order, KOT or stock movement before staff acceptance.**
2. **The browser callback is not authoritative payment proof.** The server independently
   fetches payment and order state from the provider.
3. **Callback-loss recovery and idempotency must remain supported.** A lost browser
   callback is recovered by the webhook path; every write is idempotency-keyed.

## Key collections

`stores` · `finishedGoods` · `menuItems` · `categories` · `addOnGroups` · `storeItemConfig` ·
`publicMenuAvailability` ·
`rawIngredients` · `prepItems` · `storeStock` · `stockMovements` ·
`pendingInventoryConsumption` · `orders` · `onlineOrders` · `customerCheckoutSessions` ·
`customerOrderSubmissions` · `kotItems` · `publicOrderTracking` · `loyaltyPointLedger` ·
`qualifyingVisitEvents` · `qualifyingVisitDays` · `loyaltyAccounts` · `loyaltyShadowLogs` ·
`users` · `appSettings`

## Where to look first

| Concern | File |
|---|---|
| Order → inventory | `functions/onlineOrderInventory.js` |
| Menu availability | `frontend/lib/publicMenuAvailability.ts` |
| Store aliasing | `functions/inventoryStoreResolver.js` |
| Payment-first flow | `functions/razorpayPaymentFirst.js` |
| Checkout canonicalization | `functions/customerCheckoutCanonicalization.js` |
| Composite policy | `functions/compositeProductPolicy.js` |
| KOT aggregation | `functions/kotStatusAggregation.js` |
| Loyalty | `functions/bondLoyalty.js`, `functions/bondLoyaltyPolicy.js` |
| Native POS inventory | `frontend/lib/inventoryDeduction.ts` |

## The global catalogue is already global

`finishedGoods`, `menuItems` and `categories` are **global root collections**. There is one
product document per item, shared by every store. The store-membership axis is a single
field:

```text
finishedGoods.availableStoreIds: string[]
```

Adding a store to that array is what "assigning" a product means. Consequences:

- **Do not build a second global catalogue.** It exists.
- **Do not duplicate a product document per store.** Cloning a store appends an id to
  `availableStoreIds`; it never copies the product.
- Product images are global shared references (`imageUrl` + `imageStoragePath`, Storage
  prefix `menu-images`). Never duplicate image binaries per store.
- Add-on groups and KOT `prepStation` are global fields on the Finished Good, referenced by
  id, never copied.

## Per-store overrides: `storeItemConfig`

A store may override commercial and menu-presentation intent without duplicating the product.

```text
storeItemConfig/{storeId}__{itemCode}     id via storeItemConfigDocId()
  priceOverride?           number
  isAvailableOverride?     boolean
  menuVisibilityOverride?  boolean
  sortOrderOverride?       number
```

**Presence semantics, not truthiness.** A field that is *absent* inherits the global value;
a field that is *present* overrides it. `0` and `false` are valid explicit overrides, so
never resolve with `||`. (Note this is the inverse of the `taxRate` convention in
`07-reporting-gst-permissions.md`, where `0` falls *through* — the two must not be conflated.)

**One shared resolver.** `frontend/lib/storeItemConfig.ts` — `resolveStoreItem()`, plus
`resolvePosMenuItems()` for POS-shaped rows. Do not reimplement precedence in the Admin UI,
POS, the customer snapshot builder, or clone tooling. With zero override documents the
resolver returns the item unchanged, so legacy behaviour is preserved exactly.

Scope of each override:

| Override | POS | Customer menu |
|---|---|---|
| `priceOverride` | yes | yes |
| `isAvailableOverride` | yes | yes (commercial intent only) |
| `menuVisibilityOverride` | **no** | yes — customer menu only |
| `sortOrderOverride` | yes | yes |

Customer-menu visibility must never hide an item from POS.

**Structural safety always wins.** An override expresses commercial intent, not structural
authorization. It cannot make a malformed-BOM, missing-setup, invalid-prep-station or
zero-price item sellable — those blocks stay authoritative. See
`04-inventory-finished-goods-bom.md`.

There is no store-level BOM, KOT, GST, image or add-on override in the current architecture.

## Global Items admin UI

Route `/admin/global-items` (`frontend/pages/admin/GlobalItems.tsx`), Admin only — guarded
both at the route (`ProtectedRoute allowedRoles={['ADMIN']}`) and in-page.

Its scope is **per-store overrides only**. Global product fields are read-only there; edit
them in Menu Management. UX rules:

- every override field is an explicit **Inherit global** vs **Override** choice — never an
  ambiguous blank input, since a blank cannot distinguish "inherit" from "set to zero";
- Global / Override / Not assigned must be obvious at a glance;
- the product image is shown read-only and shared;
- an unassigned store is not an editable override target;
- clearing every field deletes the override document rather than leaving an empty shell.

Saving publishes the override and the rebuilt customer snapshot atomically — see
`03-customer-ordering.md`.

## Menu availability: two different files

- `frontend/lib/storeItemConfig.ts` — resolves **effective per-store values**. Start here for
  price/availability questions.
- `frontend/lib/publicMenuAvailability.ts` — the canonical builder that **generates** the
  customer snapshot from those resolved values. It is derived output, not source of truth.
