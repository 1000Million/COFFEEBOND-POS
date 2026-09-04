# 07 — Reporting, GST & Permissions

## Sales attribution

Reporting groups **strictly by `order.storeId`**, which is the **logical** sales store.

- A Tasting Room sale reports under `TASTING_ROOM_29`, never under Noida 29.
- `stockMovements.storeId` is the **physical** store — inventory and sales attribution
  deliberately differ.
- `logicalSalesStoreId` does not appear in reporting code; the split is carried by using
  the right field in the right collection.

## GST resolution

The chain is, in order:

```
item taxRate  →  store override  →  appSettings/gstConfig.defaultGstRate
```

**A `taxRate` of 0 does not mean zero-rated.** Zero or absent falls *through* to the next
level. Production `finishedGoods/AFFOGATO` carries `taxRate: 0` and correctly bills at 5%
from the application default.

Do not "fix" a 0 by copying another item's explicit rate.

**Never invent legal or GST data.** Legal/GST configuration is inherited from the store
named by `legalAndGstSourceStoreId`.

## Roles and discount limits

| Role | Maximum percentage discount |
|---|---|
| Cashier | **10%** |
| Store Manager | **20%** |
| Admin | **100%** |

## Store access

- Managers may only access their assigned stores.
- Multi-store staff use the existing `storeIds` **and** `assignedStoreIds` fields — keep
  them synchronized.
- `hasStoreAccess(storeId)` is `isAdmin() || (active profile && storeId in storeIds
  || storeId in assignedStoreIds)`.
- **Admin is exempt from store gating** and sees all active stores.

## Firestore rules — do not weaken

The entire public (unauthenticated) read surface is exactly four grants:

- `stores` — only when not signed in and `isActive == true`
- `appSettings/gstConfig` — get
- `publicOrderTracking/{token}` — get (list denied)
- `publicMenuAvailability/{storeCode}` — get (list denied)

Everything else — `finishedGoods`, `categories`, `addOnGroups`, `prepItems`,
`rawIngredients`, `storeStock` — is `isActiveStaff()` only.

Loyalty collections are server-write-only: customers cannot write their balance, create
ledger entries, create daily visits or activate Club; native POS users cannot write
loyalty; a Cashier cannot read another customer's loyalty account.

**Do not weaken any of these.** If a change touches `firestore.rules`, run the rules test
suites.
