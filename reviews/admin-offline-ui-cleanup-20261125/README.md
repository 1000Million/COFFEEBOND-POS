# Admin cleanup and persistent PWA cache review

Status: locally qualified candidate for source review; not deployed. Base commit: `4c0ad1bd904561c70d72d534f03b3ba89948fd82`, the November source publication on `codex/production-source-20261125-6adb2e7f34961c2c`. Live Staff remains the previously verified `6adb2e7f34961c2c`; no production request or write was made in this review run.

## Changes

Removed the Historical Setup Tools section and eleven mounted historical routes/imports. Active Menu Management, Inventory Control, Stock Correction and Purchase Entry remain. Added persistent multi-tab Firestore cache with server-confirmed staff-profile authority and truthful connection metadata. Integrated `vite-plugin-pwa` with the existing guarded worker, manifest and registration. Financial offline billing continues to use the existing signed Cash journal and server reconciliation.

The original omitted `staff/data/imports/addon-product-reconciliation-approvals.json` build input is restored unchanged (SHA-256 `42c7ef9e6beef6685f69dbd30c84d8ebbcc23914ca1464627bdd744b34277499`). It contains the existing product reconciliation approvals, not a data migration.

## Fresh verification

TypeScript and the production-configured Staff build passed again. Six full-app synthetic emulator/browser checks passed: online POS preparation, durable counter Cash journal and receipt while disconnected, opening a previously unopened occupied table, adding a round and settling its original bill offline, reconnect synchronization, and repeated reconnect without duplicate effects. Counter total was INR 194.25; original table total INR 572.25. Three journal records synced. Each bill has one positive Cash payment; the table retains its original zero PAY_AT_COUNTER placeholder.

All browser/backend destinations were restricted to loopback emulators. The actual till, live financial records, installed PWA and physical printing were not exercised. Prior fourteen persistence/auth/banner controls and twelve worker runtime controls are retained as prior evidence, not claimed as rerun. Source hashes bind the new smoke to the reviewed candidate.

## Ordered retirement

This first review commit deliberately retains the thirteen old page modules. After its successful branch push, the obsolete MenuItems fixture entry will be removed, active Menu Management references verified and those thirteen files deleted in a separate commit. No Firestore collection is deleted or edited.

## Source and deployment boundary

Application changes are in `releases/general-pwa-offline-20261125/staff`, not the historical July root application. The snapshot provenance manifest describes the deployed baseline, not this un-deployed candidate; its original exact-source verifier is expected to detect these changes. Use the baseline branch when verifying the original release.

Do not deploy this checkout with a generic Hosting command. A future release must prepare a publication retaining existing immutable assets and use the approved guarded PWA update procedure. No store policy, grant, enrollment, offline eligibility, printer setting, backend, rules or index was changed. Full release QA remains PARTIAL.

See [QA.md](QA.md) and [evidence](evidence) for scope and limitations.
