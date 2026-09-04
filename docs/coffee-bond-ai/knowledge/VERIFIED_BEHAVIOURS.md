# Verified Behaviours

Only behaviours with **evidence** belong here. Each entry states how it was proven.

## Full customer order lifecycle — PREVIEW, end to end

Order `CB-TASTING_ROOM_29-20260903-0001` (`CBWEB-LZAVLL6BY_`), preview project.

```
OTP → canonical checkout → Razorpay TEST → server verification
    → PAID_PENDING_ACCEPTANCE → staff acceptance
    → POS order ×1 → BARISTA KOT ×1 → KITCHEN KOT ×1
    → physical stock ×1 → logical sales attribution
    → SERVED aggregation → BOND points ×1 → qualifying visit ×1 → day lock ×1
```

**No duplicates anywhere.**

### Before acceptance

`status=PAID_PENDING_ACCEPTANCE`, payment captured. Deltas measured against baseline:
POS order 0, KOT 0, stock movement 0. No `acceptedAt` / `linkedOrderId` fields existed.
This proves **nothing is created before staff acceptance**.

### After acceptance

| Measure | Result |
|---|---|
| POS orders | 15 → 16 (+1) |
| KOT tickets | 12 → 14 (+2: one BARISTA, one KITCHEN) |
| Stock movements | 22 → 24 (+2) |
| `inventoryConsumptionStatus` | `APPLIED`, `stockMovementCount=2`, 0 warnings |

Component KOT routing: espresso pour → BARISTA, ice cream → KITCHEN, from a single
commercial order. Deterministic ids ending `_COMP_001_BARISTA` / `_COMP_002_KITCHEN`.

### Consumption proof (PREVIEW QA ONLY)

| Ingredient | Before | After | Consumed |
|---|---|---|---|
| Espresso shot | 5000 ML | **4964 ML** | 36 ML |
| Vanilla ice cream | 5000 G | **4910 G** | 90 G |

> **This was a PREVIEW QA item with a PROVISIONAL BOM. It is not an approved production
> recipe and must not be treated as one.**

Stock movements carried `storeId` = physical store and `inventoryStoreId` = physical
store, while preserving `logicalSalesStoreId=TASTING_ROOM_29`. No physical stock document
existed for the logical store (404) — confirming it holds no inventory of its own.

### After serving both KOTs

Both tickets `SERVED`; `publicOrderTracking.publicStatus=SERVED`. Deltas: POS 0,
stock 0, point-earn 0. Qualifying visit +1 and day lock +1, each exactly once, despite
six status transitions and 24 log lines per trigger, with zero errors.

## Production behaviours

- **Tasting Room live**: 18 enabled / 3 disabled action buttons, correct identity and
  tagline, no "Pickup from". Verified in a real browser on `order.coffeebond.in`.
- **No cross-store leakage**: Noida 29 / Noida 51 / Uday Park each 87 items, 73 orderable,
  zero Tasting Room content.
- **Nearest-store exclusion**: with no `?store=` parameter the app defaults to Golden I.
- **Checkout copy + loyalty warning**: warning appears on Pay at Counter, disappears on
  Pay Online, returns on switching back. Verified live at 320/375/390/430 px with zero
  horizontal overflow.
- **GST chain**: a ₹220 item basket totalled **₹231.00** (5% GST) end to end.

## Policy behaviours proven by test

- Stock shortage blocks only `STRICT` stores; `ALLOW_NEGATIVE` and
  `ALLOW_NEGATIVE_DEFER_BOM` bypass it. Golden I fallback preserved. (13/13 harness)
- Composite structural faults still block under a sales-first policy — six fault
  injections all blocked. (17/17 harness)
- BOND point gate applied exactly once, in the point path only; the visit path never
  references it. (19/19 harness)
- BOND emulator: activation, exactly-once, reversal, rules and failure isolation. (62/62)

## Regression suites green at time of writing

Composite availability 28/28 · Tasting Room 33/33 · inventory alias 12/12 ·
razorpay-checkout 102/102 · pos-razorpay 33/33 · BOND static 58/58 · BOND emulator 62/62 ·
basket/checkout UI 146 assertions · checkout persistence 30/30 · customer account 38/38 ·
location management 61 · KOT aggregation · composite policy · TypeScript 0 real-source errors.
