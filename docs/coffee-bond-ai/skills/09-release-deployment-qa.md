# 09 — Release, Deployment, and QA

## Approval and target gate

Production is Firebase project `coffee-bond-pos`; preview is
`coffee-bond-pos-preview`. Before every Firebase write or deploy, print and verify:

```text
TARGET_PROJECT=
TARGET_IS_PRODUCTION=
```

Without explicit production approval, stop. Always pass the exact `--project`; never use
a broad deploy. Repository npm deploy scripts hard-code production, including misleading
preview names, so use explicit raw Firebase CLI commands after inspecting configuration.

## Workspace gate

Before edits or release work confirm `pwd`, branch, HEAD, status, and `git diff --check`.
Never reset, stash, clean, or discard existing work without owner approval. Use Node 20.
Both root and Functions `node_modules` must resolve inside the active worktree; never
symlink dependencies across Coffee Bond worktrees.

Preview and production env files are distinct and gitignored. Build preview targets with
their explicit Vite modes. Verify whole project-id tokens in bundles because the production
id is a prefix of the preview id. Never print or recreate secrets.

## Evidence vocabulary

Use only `PASS`, `FAIL`, `PARTIAL`, `BLOCKED`, or `NOT TESTED`. A passing claim needs
observable evidence such as suite output, build output, browser verification, a log, a
document read, a screenshot, or one controlled transaction.

For relevant releases cover authentication/permissions, store selection, Cash, UPI,
split payment, discounts, hold/recall, KOT, online acceptance/rejection, stock/void,
reports/GST/payment summaries, security rules, Razorpay retries/callback loss/idempotency,
mobile customer ordering, availability, and receipts/legal data.

Test mobile customer UI at 320, 375, 390, and 430 px, including horizontal overflow,
clipping, text wrapping, visible prices, and 44 px minimum targets.

## Build modes (exact commands)

| Target | Command | Loads |
|---|---|---|
| Customer production | `npx vite build --config vite.customer.config.ts` | `.env` |
| Customer preview | `npx vite build --config vite.customer.config.ts --mode customer-preview` | `.env.customer-preview` |
| Staff production | `npx vite build` | `.env` |
| Staff preview | `npx vite build --mode staff-preview` | `.env.staff-preview` |

`npm run build:customer` passes **no mode**, so it silently produces a production-wired
bundle. The `customer-preview` mode also gates the storage bucket and the BOND preview
module. `functions/package.json` pins `engines.node: "20"`.

## Verifying a bundle target

`coffee-bond-pos` is a prefix of `coffee-bond-pos-preview`, so substring grep is unsafe.
Extract whole quoted tokens:

```bash
grep -oE '"[A-Za-z0-9-]*coffee-bond[A-Za-z0-9-]*"' dist-customer/assets/*.js | sort -u
```

Also confirm the API key is 39 characters and that no string carries the `nexport`
corruption signature.

## Deploy order

**Code first, then data.** Deploy functions, rules and hosting before creating the data
that depends on them. Remember the customer app reads only `publicMenuAvailability` —
creating finished goods without regenerating the snapshot leaves the storefront blank.

That snapshot is **generated state**, so regenerate it only through the canonical builder
`buildPublicMenuAvailabilitySnapshot()` (see `03-customer-ordering.md`). Never hand-edit a
stored snapshot and never patch a single field into one — a canonical rebuild replaces the
whole document for that store.

Dry-run every data write with hard guards on expected counts, and prefer write
preconditions (`currentDocument.exists=false` for create-only).

## Measuring mobile overflow

Check programmatically rather than by eye:

```js
Math.max(document.documentElement.scrollWidth, document.body.scrollWidth)
  - document.documentElement.clientWidth   // must be 0
```

Some sheets render twice in the DOM (one hidden) — measure the instance with a non-zero
height, or the reading is meaningless.

## Secrets

To reuse an existing configuration, recover it from the live deployment rather than
retyping: publishable ids can be read from a deployed function's
`serviceConfig.environmentVariables`, and values compared by SHA-256 prefix without ever
exposing them.

## Production readiness

Capture rollback points before deployment. Deploy only required targets. Re-read live
state after each write, smoke exact routes, and distinguish static/test proof from a real
transaction. Never claim production-ready without evidence.

Read `../knowledge/ENVIRONMENT_TRAPS.md` before diagnosing a build or deployment hang.

## Maintenance scripts default to the emulator

Distinct from the `npm run deploy:*` scripts above, which hardcode production. Node
maintenance scripts under `scripts/` must default to a **demo project + emulator + no ADC**.
Reaching a real project requires two explicit flags:

```text
--allow-production --confirm-project=<projectId>
```

and is refused while `FIRESTORE_EMULATOR_HOST` is set. `dry-run:location-management` and
`refresh:public-menu-availability` already follow this and run through
`firebase emulators:exec`. Do not add a script that casually hardcodes a production project
id, and do not remove these gates for convenience.

## Parallel agents: emulator and worktree discipline

Claude and Codex frequently run at the same time on this machine.

- Use **isolated emulator project ids and ports** per agent; inspect occupied ports first.
- **Never kill a process or emulator you did not start** — choose another port instead.
- One worktree and branch per agent. Never reset, stash, clean or otherwise modify another
  agent's worktree, and never share uncommitted state.

## Release QA matrix — store overrides and customer Home

In addition to the coverage listed under "Evidence vocabulary", a release that touches the
global catalogue, per-store overrides or customer Home must cover:

- POS ↔ customer parity for **both** effective price and effective availability;
- discount, GST and payment totals computed from an **override** price — cash, UPI, split
  tender and multi-quantity lines;
- **receipt and report rounding on fractional payables** — OPEN, see below;
- held bill and recall with an override active;
- live store switching with overrides present;
- atomic public-menu publish: override write and snapshot rebuild committing together, with
  no partial state on failure;
- Firestore security rules, including `storeItemConfig` read/write roles;
- every customer Home state listed in `03-customer-ordering.md`;
- Razorpay callback-loss recovery and idempotency.

### OPEN: rounding on override-derived totals

A store override price combined with a percentage discount can produce fractional payable
values under current calculation semantics — **₹375 with a 10% discount yields ₹354.375**.

This is **not solved**. Receipt, report and payment rounding for such totals has not been
verified. Do not invent or prescribe a rounding algorithm. It must be explicitly verified
and approved in release QA before override prices reach a production store.
