# Current Handoff

_Last updated: 2026-09-04._

## Production

**The Tasting Room is LIVE.**

Customer URL: `https://order.coffeebond.in/?store=TASTING_ROOM_29`

### Current menu

- **18 available**
- **3 blocked:** `TR_MINI_AFFOGATO`, `TR_SET_A`, `TR_SET_B`

The four flights are live: `TR_COFFEE_THREE_WAYS`, `TR_COLD_BOND_FLIGHT`,
`TR_ZERO_PROOF_FLIGHT`, `TR_WAKE_UP_WITH_BOND`.

### Loyalty

- Pay Online (customer app, verified Razorpay) → **points eligible**
- Pay at Counter → **zero points**
- POS / staff-created → **zero points**
- Qualifying visits → **unchanged**

### Inventory

- `inventoryPolicy = ALLOW_NEGATIVE_DEFER_BOM`
- Physical inventory store: `cJk69Ti1mveh603L4edw`
- Logical sales store: `TASTING_ROOM_29`

## HIGHEST RISK: deployed but uncommitted

**`DEPLOYED_BUT_UNCOMMITTED=YES`**

The code currently running in production is **not** preserved in Git.

| | |
|---|---|
| Branch | `release/customer-order-bond-20260820` |
| HEAD | `9845e0ce4b04714e6d027e4336038f754ce18cb4` |
| Tracked modified | **45** |
| Untracked source | **18** |
| Staged | 0 |
| Commits ahead of origin | 0 |
| Diffstat | 45 files changed, 3040 insertions(+), 577 deletions(-) |

If this working tree is lost, the deployed production behaviour is lost with it.
This is the single highest repository-safety risk in the project.

## High-priority TODO

1. **Commit and push the exact deployed production code.** Review the delta, commit,
   push, and record the resulting production commit SHA in `DEPLOYMENT_HISTORY.md`.
2. **Complete real BOMs** for Tasting Room products.
3. **Run the pending-BOM backfill** so inventory reflects sales already made.
4. **Enable `TR_MINI_AFFOGATO`, `TR_SET_A`, `TR_SET_B`** — only once their structural
   setup is genuinely valid, not by weakening validation.
5. **Investigate production POS Razorpay `rzp_test` configuration** (see `KNOWN_ISSUES.md`).
6. **Build generic "Copy Store Setup"** / reusable new-store provisioning.
7. **Keep this skill and knowledge bank current** after every material build, decision,
   verification, deployment, or handoff.

## What NOT to do next

- Do not weaken composite structural validation to unblock items 4.
- Do not apply `ALLOW_NEGATIVE_DEFER_BOM` to existing stores.
- Do not change POS Razorpay keys as a side effect of other work.
