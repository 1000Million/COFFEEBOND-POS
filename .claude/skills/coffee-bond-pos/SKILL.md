---
name: coffee-bond-pos
description: Entry point for Coffee Bond POS work. Points at the canonical knowledge bank in docs/coffee-bond-ai/. Use when building, testing, deploying or debugging anything in this repo or a coffeebond-* worktree - especially before any firebase deploy, vite build, or production change.
---

# Coffee Bond POS

**Read the canonical knowledge bank before doing Coffee Bond work.** It is in this repo at
`docs/coffee-bond-ai/`. Do not re-derive what is already recorded there.

## Read these first, in order

1. `docs/coffee-bond-ai/README.md` — how the bank is organised
2. `docs/coffee-bond-ai/knowledge/CURRENT_PRODUCTION_STATE.md` — what is live now
3. `docs/coffee-bond-ai/CURRENT_HANDOFF.md` — where development is right now

Then check `git branch --show-current`, `git rev-parse HEAD`, `git status --short`, and
continue only the next verified task.

## Then read what your task touches

| Task | Skill |
|---|---|
| Anything | `skills/01-core-architecture.md` |
| POS tenders, discounts, holds, voids | `skills/02-pos-checkout-payments.md` |
| Checkout, OTP, Razorpay, acceptance | `skills/03-customer-ordering.md` |
| Stock, BOM, availability | `skills/04-inventory-finished-goods-bom.md` |
| KOT, stations, order status | `skills/05-kot-online-order-lifecycle.md` |
| Points, visits, loyalty | `skills/06-bond-loyalty.md` |
| Reporting, GST, roles, rules | `skills/07-reporting-gst-permissions.md` |
| Global catalogue, per-store item overrides | `skills/01-core-architecture.md` |
| Stores, aliases, new locations, cloning / provisioning | `skills/08-store-provisioning.md` |
| Building, deploying, QA | `skills/09-release-deployment-qa.md` |

Before debugging any build or deploy hang, read
`docs/coffee-bond-ai/knowledge/ENVIRONMENT_TRAPS.md` — several silent hangs in this
project have a known cause and a one-line fix.

## Non-negotiables

- **This is a live production system.** `coffee-bond-pos` is production;
  `coffee-bond-pos-preview` is QA. `--project` is mandatory on every Firebase command.
- **Never use the `npm run deploy:*` scripts** — they all hardcode production.
- **Never create a POS order, KOT or stock movement before staff acceptance.**
- **Never fabricate BOM quantities, GST data or secret values.**
- **Never weaken** composite structural validation, Firestore rules, or loyalty
  idempotency.
- **The store clone / provisioning engine already exists** (`functions/storeProvisioning.js`).
  Extend it; never write a second one. Same for the global catalogue — `finishedGoods` is
  already global — and the shared store-item resolver.
- **`publicMenuAvailability` is generated state**, not source data. Rebuild it only through
  the canonical builder; never hand-edit a stored snapshot.
- **Maintenance scripts default to a demo project + emulator + no ADC.** Production needs an
  explicit `--allow-production --confirm-project=<id>`.
- **Parallel agents:** isolated emulator project ids and ports, inspect occupied ports first,
  **never kill a process you did not start**, one worktree per agent, and never reset or
  stash another agent's work.
- **Report status as** `PASS` / `FAIL` / `PARTIAL` / `BLOCKED` / `NOT TESTED`, with
  evidence. Never claim something works without it. On handoffs also report
  `SKILL_USED` / `SKILL_PATHS` / `SKILL_COMPLIANCE`.

## When blocked

**One blocker → one decisive diagnostic → stop and report.** Do not spend hours on
speculative debugging.

## Keep the bank current

When you build, decide or verify something, update the relevant file under
`docs/coffee-bond-ai/knowledge/` and refresh `CURRENT_HANDOFF.md`. The bank is only useful
if it stays true.
