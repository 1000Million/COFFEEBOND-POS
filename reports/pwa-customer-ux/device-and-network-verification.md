# Staff POS PWA Device and Network Verification

Generated: 2026-08-04
Mode: verification only
Status: **PARTIAL**

## Scope and Safety

- Worktree: `/Users/narendrashukla/Documents/Codex/2026-06-02/COFFEEBOND-POS-staff-pwa`
- Branch: `feature/staff-pos-pwa-phase-1`
- Base SHA: `4939d51d1a29e2cfbbb3e80d1dd9e9694f99efb9`
- Local production build only; no Hosting preview or production deployment.
- No real payment, order, KOT, stock movement, or Firebase mutation was performed.
- The owner subsequently completed real-device installation checks on Android Chrome and iPhone Safari. Device model, OS version, and browser version were not supplied and are therefore not invented in this report.

## Local Environment

| Item | Result | Evidence |
|---|---|---|
| Production build | PASS | `npm run build`; Vite 6.4.2; only the existing large shared-chunk warning |
| Preview command | PASS | Repository has no `preview` script, so the built output was served with `vite preview --host 0.0.0.0 --port 4173` |
| Loopback URL | `http://127.0.0.1:4173` | Local Chrome verification |
| LAN URL | `http://192.168.0.5:4173` | Bound on all interfaces; not opened on a physical device |
| Service worker | `http://127.0.0.1:4173/sw.js` | HTTP 200, `text/javascript` |
| Manifest | `http://127.0.0.1:4173/manifest.webmanifest` | HTTP 200, `application/manifest+json` |
| Offline fallback | `http://127.0.0.1:4173/offline.html` | HTTP 200, `text/html` |

## Manifest Verification

| Requirement | Expected | Actual | Status |
|---|---|---|---|
| Name | Coffee Bond POS | Coffee Bond POS | PASS |
| Short name | CB POS | CB POS | PASS |
| Start URL | `/pos` | `/pos` | PASS |
| Scope | `/` | `/` | PASS |
| Display | standalone | standalone | PASS |
| Orientation | Safe for tablets | `any` | PASS |
| 192 px icon | Valid PNG | 192 x 192 PNG, HTTP 200 | PASS |
| 512 px icon | Valid PNG | 512 x 512 PNG, HTTP 200 | PASS |
| Maskable icon | Recognized purpose | 512 x 512 PNG with `purpose: maskable` | PASS |
| Apple touch icon | Valid PNG | 180 x 180 PNG, HTTP 200 | PASS |
| Manifest warnings | None | No application/manifest error was observed; Chrome automation did not expose the DevTools warning panel | PARTIAL |

## Service Worker and Cache Verification

| Check | Expected | Actual | Status | Evidence |
|---|---|---|---|---|
| Registration | One registration with scope `/` | The app registered and controlled subsequent reloads | PASS | Local Chrome reload and server-loss check |
| Active worker | App shell served after origin server stopped | Login shell remained renderable after the preview server was stopped and Chrome was reloaded | PASS | `local-pwa-server-loss.png` |
| Registration/reload loop | No loop | No repeated navigation or reload occurred | PASS | Timed observation after initial load and update |
| Failed SW assets | None | Manifest, worker, fallback, and icon requests returned HTTP 200 | PASS | Direct HTTP checks |
| App shell cache | Cached | Shell remained available with the server stopped | PASS | Server-loss test |
| JS/CSS cache | Cached on same-origin GET | Runtime code implements cache-first storage for `/assets/`; the cached shell rendered with the server stopped | PASS | `public/sw.js` plus server-loss observation |
| Branding/font cache | Cached on same-origin GET | Same-origin static image/font extensions are eligible for cache-first handling | PASS | `STATIC_EXTENSION` and same-origin guard in `public/sw.js` |
| Offline fallback cache | Pre-cached | `/offline.html` is in `APP_SHELL` and returned HTTP 200 | PASS | Static worker inspection and HTTP check |
| Exact CacheStorage inventory | Enumerate every stored URL | Chrome automation did not expose CacheStorage/DevTools internals | NOT TESTED | Browser capability limitation; no workaround attempted |
| Firebase operational responses | Never cached | Cross-origin requests and same-origin `/__/` routes bypass the worker | PASS | `url.origin` and `/__/` guards in `public/sw.js` |
| Cloud Function responses | Never cached | Cross-origin Functions calls bypass the worker | PASS | Same-origin-only cache policy |
| Razorpay requests | Never cached | Cross-origin Razorpay requests bypass the worker | PASS | Same-origin-only cache policy |
| Mutating requests | Never cached or replayed | All non-GET requests return without `respondWith`; no Background Sync exists | PASS | `request.method !== 'GET'` guard and source search |
| Auth/order/KOT/inventory/report responses | Not cached as operational data | Cross-origin APIs, non-GET writes, and `/__/` routes bypass the worker | PASS | Worker policy inspection |

## Network-Loss Verification

Chrome was controlled through the available Chrome integration. It did not expose DevTools network emulation, a physical network toggle, CacheStorage inspection, or service-worker internal pages. Physically disabling the host network would also have disconnected the controlled browser session. No alternate browser or raw debugging protocol was used to work around that boundary.

One bounded server-loss test was completed: the local origin server was stopped and the app shell still rendered from the active service worker. This proves the static offline shell is observable, but it does not change `navigator.onLine` to `false`; therefore it cannot prove runtime disabling, the exact offline banner, reconnect notification, or per-action write suppression.

Expected blocked message in implementation and automated assertions:

`This action requires an internet connection and has not been submitted.`

| Offline action | UI must not show success | No write | No silent retry after reconnect | Runtime result | Supporting evidence |
|---|---|---|---|---|---|
| Cash bill completion | Required | Required | Required | BLOCKED | Handler and UI guard pass automated PWA test; true browser-offline unavailable |
| UPI bill completion | Required | Required | Required | BLOCKED | Same |
| Split payment completion | Required | Required | Required | BLOCKED | Same |
| Razorpay initiation | Required | Required | Required | BLOCKED | PWA test plus POS Razorpay 30/30 and customer Razorpay 99/99 |
| Customer checkout submission | Required | Required | Required | BLOCKED | PWA and customer-ordering tests pass |
| Online-order acceptance | Required | Required | Required | BLOCKED | Handler/UI guard and idempotency tests pass |
| Online-order rejection | Required | Required | Required | BLOCKED | Handler/UI guard tests pass |
| Hold-bill creation | Required | Required | Required | BLOCKED | Handler/UI guard tests pass |
| Held-bill recall/delete | Required | Required | Required | BLOCKED | Handler/UI guard tests pass |
| KOT mutation | Required | Required | Required | BLOCKED | KOT controls/handlers guarded in source and PWA test |
| Void | Required | Required | Required | BLOCKED | Guard plus void-payment-reversal suite passes |
| Refund | Required | Required | Required | BLOCKED | Guard plus Razorpay/payment tests pass |
| Stock adjustment | Required | Required | Required | BLOCKED | Stock Correction handler/UI guarded |
| Opening-stock confirmation | Required | Required | Required | BLOCKED | Location Management handler/UI guarded |
| Item availability toggle | Required | Required | Required | BLOCKED | Menu Items handler/UI guarded |
| Operational Admin save | Required | Required | Required | BLOCKED | Location/POS Readiness handler/UI guarded |

No Firebase write was attempted to turn these blocked rows into a false PASS. The server-loss shell observation and automated assertions support **PARTIAL** offline confidence, not real network-loss acceptance.

## Reconnection and Duplicate Protection

| Check | Expected | Actual | Status |
|---|---|---|---|
| Reconnect notice | Acknowledge restored connectivity | Implemented and asserted; true offline-to-online browser transition unavailable | PARTIAL |
| Automatic retry | Never submit blocked mutation automatically | No mutation queue, Background Sync, or reconnect submit callback exists | PASS |
| Cart/form preservation | Preserve safe local state | Customer ordering persistence suite passes 28/28 | PASS |
| Duplicate order/KOT/payment/movement | None after reconnect/double click | Existing idempotency suites pass; real reconnect double-click not executed | PARTIAL |

## Update-Safety Verification

A reversible local-only worker cache marker was used. `CACHE_VERSION` was changed from `v1` to `verification-v2`, version B was built and served, then the source marker was restored to `v1` and the final build was rerun.

| Check | Expected | Actual | Status | Evidence |
|---|---|---|---|---|
| Detect version B | Waiting worker detected | UI displayed `A new version is available` | PASS | `local-pwa-update-available.png` |
| User-controlled prompt | Refresh/Dismiss controls | Both controls displayed | PASS | Screenshot and Chrome inspection |
| No forced refresh | Remain on current screen | Page stayed stable for a timed observation before approval | PASS | Timed Chrome observation |
| Defer during active transaction | No activation while operation active | Source and automated tests pass; no authenticated local transaction was created | PARTIAL | `frontend/lib/pwa.ts`, PWA test |
| Explicit activation | One user action | Refresh clicked once | PASS | Chrome interaction |
| Reload count | Exactly once | One reload to signed-out `/login` | PASS | Navigation observation |
| Reload loop | None | No second reload during timed observation | PASS | Timed observation |
| Old cache cleanup | Remove prior PWA cache on activation | Worker deletes older `coffee-bond-pos-static-*` caches; exact CacheStorage inventory unavailable | PARTIAL | `activate` handler source inspection |
| Temporary marker cleanup | Restore source and output | `public/sw.js` is back to `CACHE_VERSION = 'v1'`; final build passed | PASS | Final source check/build |

## Android Device Verification

The owner confirmed successful installation from current Android Chrome and successful launch in installed standalone mode using the Firebase Hosting preview. This is real-device evidence, not browser emulation.

| Android check | Status | Evidence / limitation |
|---|---|---|
| Installation from Android Chrome | PASS | Owner-confirmed real-device installation |
| Installed standalone mode | PASS | Owner-confirmed real-device standalone launch |
| Device model/version/Chrome version recorded | NOT TESTED | Metadata was not supplied |
| Exact icon/name/start-route inspection | PARTIAL | Successful installation was confirmed; individual presentation fields were not separately recorded |
| Auth persistence and signed-out redirect | NOT TESTED | Not included in the supplied result |
| Back navigation | NOT TESTED | Not included in the supplied result |
| Offline banner and mutation blocking | BLOCKED | Requires real network loss on the device |
| Update prompt and duplicate protection | NOT TESTED | Requires two installed versions and a transactional scenario |

## iPhone Verification

The owner confirmed successful Safari Add to Home Screen installation and successful launch in installed standalone mode using the Firebase Hosting preview. This is real-device evidence, not browser emulation.

| iPhone check | Status | Evidence / limitation |
|---|---|---|
| Safari Add to Home Screen installation | PASS | Owner-confirmed real-device installation |
| Installed standalone mode | PASS | Owner-confirmed real-device standalone launch |
| Device/iOS/Safari versions recorded | NOT TESTED | Metadata was not supplied |
| Conditional instruction and dismissal persistence | NOT TESTED | Not included in the supplied result |
| Exact icon/name/start-route inspection | PARTIAL | Successful installation was confirmed; individual presentation fields were not separately recorded |
| Authentication and redirect-loop behavior | NOT TESTED | Not included in the supplied result |
| Safe-area, home-indicator, and keyboard behavior | NOT TESTED | Not included in the supplied result |
| Offline/reconnect/update behavior | BLOCKED | Requires installed-app network-loss and update testing |

## Evidence Files

- `reports/pwa-customer-ux/local-pwa-login.png`
- `reports/pwa-customer-ux/local-pwa-server-loss.png`
- `reports/pwa-customer-ux/local-pwa-update-available.png`
- `reports/pwa-customer-ux/golden-i-owner-review.md`
- `reports/pwa-customer-ux/golden-i-owner-review.csv`

## Conclusion

The production build, manifest, native service worker, cached application shell, explicit update prompt, automated mutation guards, Android installation/standalone launch, and iPhone installation/standalone launch pass. The verification remains **PARTIAL** because true browser/device network-loss and reconnection were not completed, and the final classification requires those mutation-safety checks.

No commit, push, deployment, production Firebase write or payment configuration change was performed.
