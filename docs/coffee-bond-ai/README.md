# Coffee Bond AI Bank

Canonical knowledge for anyone — human or AI — working on Coffee Bond POS.
**Read this before touching the codebase.** It exists so a new session does not
re-discover the whole POS from scratch.

## The three parts

| Part | Question it answers | Lives in |
|---|---|---|
| **Skill bank** | *How do Coffee Bond systems work, permanently?* | `skills/` |
| **Knowledge bank** | *What has been built, decided and verified?* | `knowledge/` |
| **Current handoff** | *Where is development right now?* | `CURRENT_HANDOFF.md` |

Skills change slowly — they describe architecture and rules.
Knowledge changes when something is built, decided or proven.
The handoff changes every session.

## Start-of-session checklist

Every new Codex session should, in order:

1. Read repository-root `CODEX.md`.
2. Read this `README.md`.
3. Read `knowledge/CURRENT_PRODUCTION_STATE.md`.
4. Read `CURRENT_HANDOFF.md`.
5. Confirm `pwd`, `git branch --show-current`, `git rev-parse HEAD`,
   `git status --short --branch`, and `git diff --check`.
6. Continue only from verified state.

Do **not** re-explore the entire POS. Do **not** re-derive facts already recorded here.

## When you get blocked

**One blocker → one decisive diagnostic → stop and report.**

Do not spend hours on speculative debugging. Several long debugging spirals in this
project's history were each resolved by a single targeted check; see
`knowledge/ENVIRONMENT_TRAPS.md`.

## Evidence rule

When asked to test, review, deploy or go live, report status as one of:

`PASS` · `FAIL` · `PARTIAL` · `BLOCKED` · `NOT TESTED`

Never claim functionality works without evidence. Acceptable evidence: a test result,
a build result, browser verification, a Firestore record, a log line, a screenshot, or
a completed transaction. "It should work" is not evidence.

## Contents

**Skill bank — permanent rules and architecture**

- `01-core-architecture.md` — projects, applications, shared invariants
- `02-pos-checkout-payments.md` — POS tenders, discounts, holds, voids, receipts
- `03-customer-ordering.md` — OTP, canonical checkout, payment-first lifecycle
- `04-inventory-finished-goods-bom.md` — Finished Goods, BOM, negative stock, deferral
- `05-kot-online-order-lifecycle.md` — acceptance, station routing, aggregation
- `06-bond-loyalty.md` — points, visits, provenance, idempotency
- `07-reporting-gst-permissions.md` — attribution, GST chain, roles and rules
- `08-store-provisioning.md` — store identity, aliasing and reusable provisioning
- `09-release-deployment-qa.md` — build/deploy discipline and release evidence

**Knowledge bank — what is built, deployed, decided and verified**

- `CURRENT_PRODUCTION_STATE.md` — what is live right now
- `POS_IMPLEMENTATION_HISTORY.md` — durable implementation evolution and invariants
- `STORES_AND_IDS.md` — real store document ids
- `TASTING_ROOM.md` — the Tasting Room in full
- `VERIFIED_BEHAVIOURS.md` — what has actually been proven, with evidence
- `ARCHITECTURE_DECISIONS.md` — decisions and their reasoning
- `KNOWN_ISSUES.md` — open problems
- `ENVIRONMENT_TRAPS.md` — build/tooling traps that cost real time
- `DEPLOYMENT_HISTORY.md` — what was deployed and when
- `TEST_EVIDENCE_INDEX.md` — known suite counts and evidence sources

`CURRENT_HANDOFF.md` is the concise current branch/status/next-task record. `CODEX.md`
is the short bootstrap that makes this bank the first repository context Codex reads.
