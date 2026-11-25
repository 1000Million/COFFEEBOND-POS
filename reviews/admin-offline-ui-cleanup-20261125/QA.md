# Scoped release QA

FULL_RELEASE_QA = PARTIAL. Local source-review candidate; no production requests or financial submissions. Synthetic emulator Cash transactions are the only new financial scenarios.

| Test | Expected | Actual | Status | Evidence | Corrective Action |
| --- | --- | --- | --- | --- | --- |
| Historical UI and routes | Retire old pages, retain active Menu Management | Historical section/routes removed; 13 files deleted; only obsolete fixture entry removed; all 129 assertions retained | PASS | evidence/retirement-final.json | None for deletion |
| TypeScript | Candidate compiles | TypeScript 5.8.3 exit 0 before and after deletion | PASS | evidence/build-after-retirement.json | None |
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

| Final retirement follow-up | Expected | Actual | Status | Evidence | Corrective Action |
| --- | --- | --- | --- | --- | --- |
| Active code and fixture preservation | 20 active files and all assertions unchanged | Eight focused retirement checks PASS; 129 original assertions and ten non-retired guarded entries retained | PASS | evidence/retirement-final.json | None |
| Final production build | Build the source after deleting old pages | TypeScript and build exit 0; generated asset bytes differ from earlier build | PASS | evidence/build-after-retirement.json | No identical-byte claim |
| Extra post-deletion browser rerun | Repeat six Cash checks on final built assets | Remote call timed out before PID/output; earlier six-case PASS preserved | BLOCKED | evidence/followup-limitations.json | Inspect existing process/evidence state after Mac reconnects before retrying |
