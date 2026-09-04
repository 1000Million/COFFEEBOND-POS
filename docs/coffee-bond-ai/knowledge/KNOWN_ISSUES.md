# Known Issues

Open problems. Each entry: what, impact, and what NOT to do about it.

## 1. Deployed production code is not committed — HIGHEST RISK

`DEPLOYED_BUT_UNCOMMITTED=YES`

Branch `release/customer-order-bond-20260820`, HEAD `9845e0ce4b04714e6d027e4336038f754ce18cb4`.
**45 tracked modified files, 18 untracked source files, 0 staged, 0 commits ahead.**
Diffstat: 45 files changed, 3040 insertions(+), 577 deletions(-).

**Impact:** if this working tree is lost, the behaviour currently serving customers is
lost with it. There is no other copy.

**Next step:** review the delta, commit the exact deployed state, push, record the SHA in
`DEPLOYMENT_HISTORY.md`. Requires explicit approval.

## 2. Production POS Razorpay uses a test key

Production `POS_RAZORPAY_KEY_ID` is an **`rzp_test`** key, while the customer-facing
`RAZORPAY_KEY_ID` is **`rzp_live`**.

**Pre-existing**, and deliberately not changed during the Tasting Room rollout. If in-store
POS Razorpay is meant to take real payments, it is currently pointed at test credentials.

**Do not silently change this.** It needs a deliberate decision and its own verification.

## 3. Tasting Room inventory will not move until BOMs are completed

The 18 live items have **no BOMs**. Every accepted sale records
`inventoryConsumptionStatus=PENDING_BOM` against `cJk69Ti1mveh603L4edw` rather than
deducting stock.

This is the agreed design, but it means:

- Noida 29 inventory figures **do not reflect Tasting Room consumption**
- a backlog of pending consumption grows with every sale
- inventory reporting for affected ingredients is misleading until backfill runs

**Next step:** complete real BOMs, then run `scripts/backfill-pending-bom-consumption.mjs`.
Backfill is idempotent and consumes exactly once.

## 4. Three composites still blocked

`TR_MINI_AFFOGATO`, `TR_SET_A`, `TR_SET_B`.

- Sets A and B declare `unresolvedCompositeRequirements` — "two miniature drinks", which
  the owner has not defined.
- Mini Affogato has no approved production recipe.

**Do not** unblock these by weakening composite structural validation.

## 5. No approved production BOM exists for any Tasting Room item

An exhaustive search of `frontend/data/rawData1-5.ts` found only one complete CONFIRMED
recipe relevant to the Tasting Room (`AFFOGATO_BARISTA`), and it is for the full-size
Affogato, not the Mini. Espresso Bun, crostini, labneh, halloumi, tapenade, blue cheese and
cottage cheese have **zero** entries. Tiramisu and Brownie carry `recipeMatchCount=0`.

Also note: the costing sheet prices an espresso shot at a flat 30.4 whether it is 36 ml or
45 ml, so **cost cannot be used to derive quantity**.

**Do not fabricate BOM quantities.**

## 6. Production staff UI not interactively verified

Staff-side production checks were done at the bundle and data layer. No interactive
sign-in was performed (no production staff credentials). Someone should click through
Incoming Online Orders and the KOT screens before relying on them.

## 7. Incoming Online Orders defaults to the alphabetically first store

The page auto-selects `allowed[0]` sorted by name and queries only that store. With
"Coffee Bond QA Preview" or similar sorting first, the Tasting Room is **not** selected by
default — an order can appear missing when it is simply filtered out. Switch the store
dropdown before concluding an order is absent.

## 8. Generic Copy Store Setup is not yet the standard workflow

Location Management and provisioning primitives exist, but a Petpooja-style reusable
Copy Store Setup flow is still a future priority. Before writing store-specific code,
check the existing Admin, assignment, import, readiness, and activation paths.

## 9. Environment and worktree fragility

Worktree dependency sharing, Tailwind scan escape, and gitignored/fragile `.env*` files
are all live hazards that have each cost real debugging time. They are documented in full,
with symptoms and fixes, in `ENVIRONMENT_TRAPS.md` — read that before diagnosing any build
or deploy hang. Summarised here only so the issue is visible from this list:

- root and `functions/` `node_modules` must be local to the active worktree
- the `frontend/index.css` `source(none)` + explicit `@source` lines must remain
- new worktrees do not inherit `.env*`; never reconstruct, print or guess secrets

## 10. Strict stores must not inherit Tasting Room inventory policy

`ALLOW_NEGATIVE_DEFER_BOM` is explicit and store-scoped. Applying it globally would
silently weaken established stock and BOM guarantees for existing strict stores. The
reasoning is recorded in `ARCHITECTURE_DECISIONS.md`.
