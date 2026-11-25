# Scoped release QA

FULL_RELEASE_QA = PARTIAL. Local source-review candidate; no production requests or financial submissions. Synthetic emulator Cash transactions are the only new financial scenarios.

| Test | Expected | Actual | Status | Evidence | Corrective Action |
| --- | --- | --- | --- | --- | --- |
| Historical UI and routes | Retire old pages, retain active Menu Management | Historical section/state/icons and 11 routes/imports removed; 13 unreferenced page modules listed | PASS | Source diff and reference audit | Fixture cleanup before physically deleting MenuItems |
| TypeScript | Candidate compiles | TypeScript 5.8.3 exit 0 | PASS | typecheck.log | None |
| Staff production build | Compile guarded PWA and active app | Build exit 0; 82 injected manifest entries | PASS | production-build.log | No deployment in this task |
| Firestore persistent cache | Reload and multiple tabs retain data | Real demo SDK/emulator and two-tab/reload cases pass | PASS | persistence-tests/RESULT.json | Installed-device check remains separate |
| Profile and connection metadata | Cached data cannot authorize or imply server sync | Actual React components passed controlled callback cases | PASS | persistence-tests/RESULT.json | Preserve signed offline authorization |
| Worker shell/update/cache | Shell cached; pending work blocks activation; images bounded | 12 runtime controls plus emitted-artifact verification pass | PASS | worker-controls.json; emitted-worker-integrity.json | Live browser CORS and installed upgrade untested |
| Authentication and roles | Preserve actual permissions | Cache-authority controls pass locally; production roles not exercised | PARTIAL | Persistence/auth checks | Do not promote local test to live role verification |
| Store/product selection | Preserve active systems | Active routes preserved; full menu workflow not repeated | PARTIAL | App.tsx diff and build | Reuse matching existing evidence |
| Cash/UPI/split | Preserve settlement | New local counter/table Cash smoke passed; UPI/Split not rerun | PARTIAL | evidence/offline-cash-smoke.json | Live financial flows remain untested |
| Discounts | Preserve role limits | No discount implementation changes or new transactions | NOT TESTED | Source scope | Keep existing limits |
| Hold/recall/delete | Preserve original references | Original journal and POS implementation unchanged | NOT TESTED | Source hashes/diff | No clearing saved work |
| KOT routing | Exactly-once effects | Synthetic KOT counts and replay deduplication passed; physical output untested | PARTIAL | evidence/offline-cash-smoke.json | No printer changes |
| Online acceptance/rejection | Preserve payment-first lifecycle | Backend and customer system unchanged | NOT TESTED | Source scope | No customer changes |
| Stock/void | Preserve deduction and reversal | Synthetic deductions and replay deduplication passed; void not rerun | PARTIAL | evidence/offline-cash-smoke.json | No production mutation |
| Reports/GST/payments | Preserve financial reporting | Reporting implementation unchanged | NOT TESTED | Source scope | No report refresh/backfill |
| Firebase permissions | Preserve rules and runtime enforcement | No rules/IAM/collection edits; local cache authority tested | PARTIAL | Local checks/source scope | No permission grants |
| Razorpay/recovery | Preserve provider flows | No provider or financial backend change | NOT TESTED | Source scope | No payment/refund tests |
| Customer mobile ordering | Preserve customer release | No customer deployment; not exercised | NOT TESTED | Scope | None in this task |
| Availability/store controls | Preserve active Menu Management | Components unchanged; no menu data edits | PARTIAL | Source scope | Keep eligibility restrictions |
| Receipt/legal display | Preserve receipts | Counter and original table pending receipts shown locally; physical/legal scenarios not requalified | PARTIAL | evidence/offline-cash-smoke.json | No physical-output claim |

The six new full-app smoke cases and fresh build were run on November 25. The 14 persistence controls and 12 worker controls are prior exact-source evidence. The broad historical `test-pwa-customer-ux` suite retains obsolete pre-November worker source assertions; it is not claimed as passing or weakened in this review.
