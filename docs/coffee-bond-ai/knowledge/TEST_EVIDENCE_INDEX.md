# Test Evidence Index

Only recorded results are listed. Counts are assertions/tests as reported by the owning
suite. Unless a row says otherwise, the original run timestamp was not preserved; the
source is the owner-approved Coffee Bond handoff consolidated on 2026-09-04.

| Area | Result | Evidence source |
|---|---:|---|
| Razorpay payment-first / customer checkout | PASS — 105/105 | Phase 4 hotfix verification |
| POS Razorpay | PASS — 33/33 | Tasting Room release handoff |
| BOND static | PASS — 58/58 | Tasting Room release handoff |
| BOND emulator | PASS — 62/62 | Tasting Room release handoff |
| Inventory alias | PASS — 12/12 | Tasting Room release handoff |
| Public menu composite availability | PASS — 34/34 | Phase 4 hotfix verification |
| Tasting Room customer | PASS — 33/33 | Tasting Room release handoff |
| KOT public tracking Auth + Firestore emulator | PASS — 28/28 | Tasting Room release handoff; production writes 0 |
| Reporting centre | PASS — 60 | Tasting Room release handoff |
| Customer basket/checkout UI | PASS — 146 | After BOND payment-copy update |
| Customer home UI | PASS — 138 | Tasting Room release handoff |
| Customer account/orders UI | PASS — 71 | Tasting Room release handoff |
| Customer My Usual | PASS — 217 | Tasting Room release handoff |
| POS menu correctness | PASS — 126 | Tasting Room release handoff |
| Franchise viewer | PASS — 52 | Tasting Room release handoff |
| Location Management | PASS — 61 | Tasting Room release handoff |

Additional verified suites: customer checkout persistence 30/30, customer account 38/38,
Tasting Room catalog 16/16, composite structural policy, KOT aggregation, Firestore rules,
TypeScript/lint, store/KOT/cashier access, add-ons, complimentary orders, void/reversal,
packaging, BOM repair, purchases, product images, PWA, and both production builds.

## End-to-end evidence

Preview order `CB-TASTING_ROOM_29-20260903-0001` proved OTP through served state, one POS
order, one BARISTA KOT, one KITCHEN KOT, exactly-once physical stock, logical sales
attribution, one point event, one qualifying visit, and one day lock, with no duplicates.
The Mini Affogato quantities were preview-only provisional evidence, not approved
production BOM truth.

Phase 3 preview order `CBWEB-ZYTKQ7QUQH` / POS order
`CB-TASTING_ROOM_29-20260904-0001` proved the Coffee Three Ways immutable three-child
snapshot, deferred empty BOM markers, deterministic BARISTA/KITCHEN KOT routing,
PENDING_BOM creation and acceptance idempotency with no duplicate POS, KOT, stock
movement, acceptance or pending-BOM records.

Phase 4 production verification deployed only the four scoped functions and staff
hosting, matched live function archive sources to the local patch, confirmed Razorpay
configuration fingerprints unchanged, restored the four flights to 18 available / 3
blocked, preserved all other menu/store-policy hashes and both protected historical order
hashes, and observed no ERROR/CRITICAL/ALERT function logs. No paid production order was
placed.

## Evidence rule

Re-run task-relevant suites after material changes. Do not convert an old PASS into a
current production-readiness claim without checking whether the code, data, environment,
or deployment changed.
