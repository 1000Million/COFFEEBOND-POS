# Stores and Document IDs

_Verified against production Firestore, 2026-09-04._

## The critical distinction

**A store's document id is not always its code.** This has already caused one
near-miss production defect.

| Store name | Document id | Code |
|---|---|---|
| Golden I | `GOLDEN_I` | `GOLDEN_I` |
| Baked by Bond 51 | `BAKED_BY_BOND_51` | `BAKED_BY_BOND_51` |
| **Noida Sector 29** | **`cJk69Ti1mveh603L4edw`** | `NOIDA_29` |
| Noida Sector 51 | `L0qB13uuPxHvv089YtGQ` | `NOIDA_51` |
| Uday Park | `HCLGB7BRuIxp9gLjDdca` | `UDAY_PARK` |
| The Tasting Room by Coffee Bond | `TASTING_ROOM_29` | `TASTING_ROOM_29` |

Golden I and Baked by Bond happen to use their code as the document id. **Noida 29,
Noida 51 and Uday Park use opaque Firestore ids.** Anything that looks up a store by id
must use the real document id.

## Which identifier each collection uses

| Collection | Keyed by |
|---|---|
| `stores` | **document id** |
| `storeStock` | **document id** — `{storeId}_{stockItemType}_{stockItemCode}` |
| `publicMenuAvailability` | **store CODE** |

Verified: production `storeStock` has **199 documents** prefixed
`cJk69Ti1mveh603L4edw_` and **zero** prefixed `NOIDA_29_`.

## The near-miss

The Tasting Room was designed and fully verified in preview against
`inventoryStoreId = NOIDA_29`, because the preview seed created Noida 29 with its id
equal to its code. In production that id does not exist. The inventory resolver **fails
closed**, so every Tasting Room acceptance would have thrown
`Inventory store NOIDA_29 ... does not exist` — after taking payment.

Caught during production pre-flight, before any write.

**Rule: never assume preview document ids match production.** Verify against production
before configuring any store alias.
