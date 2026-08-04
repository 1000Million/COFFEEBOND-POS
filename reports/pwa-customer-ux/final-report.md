# Coffee Bond Staff PWA and Customer Ordering UX Final Report

Generated: 2026-08-04
Overall status: **PARTIAL**

The implementation and automated regression suite pass. Local Chrome verified the manifest, active service-worker shell, server-loss recovery, and user-controlled update flow. The owner subsequently confirmed successful real-device installation and standalone launch on Android Chrome and iPhone Safari. The remaining release gaps are true browser/device network-loss and reconnection, plus owner-approved dietary/category source data. No payment or customer order was submitted.

## 1. Repository Provenance

- Source repository: `/Users/narendrashukla/Documents/Codex/2026-06-02/COFFEEBOND-POS-release-razorpay`
- Source branch: `fix/simple-location-onboarding`
- Source SHA: `4939d51d1a29e2cfbbb3e80d1dd9e9694f99efb9`
- Source commit: `4939d51 Isolate POS Razorpay Test Mode configuration`
- Source initial state: clean
- Worktree: `/Users/narendrashukla/Documents/Codex/2026-06-02/COFFEEBOND-POS-staff-pwa`
- Worktree branch: `feature/staff-pos-pwa-phase-1`
- Worktree initial state: clean at the exact source SHA
- Razorpay isolation: fully committed before this worktree was created

## 2. Implementation Plan Completed

1. Verified the clean source repository and created the isolated worktree.
2. Audited dependencies, routes, payment boundaries, customer ordering, and existing tests.
3. Added a native staff PWA foundation without a new package.
4. Added shared connectivity state, safe update handling, and reusable online-only mutation guards.
5. Protected POS, online-order, KOT, inventory, day-close, and operational-admin writes at UI and handler boundaries.
6. Corrected the customer header and mobile account treatment.
7. Added trusted-data-only dietary marker support.
8. Added stable product image loading, skeletons, fallbacks, and first-viewport priority.
9. Removed duplicate basket-restoration feedback.
10. Added explicit store statuses, horizontal-scroll affordances, safe one-tap add behavior, empty states, and accessibility refinements.
11. Audited the live Golden I public menu without writing data.
12. Ran the complete regression suite and production-equivalent local browser QA.

## 3. Files Changed

### Existing files modified

- `frontend/App.tsx`
- `frontend/components/ConnectionStatusBanner.tsx`
- `frontend/components/add-ons/AddOnSelector.tsx`
- `frontend/components/customer/CustomerHeader.tsx`
- `frontend/components/customer/CustomerOtpPanel.tsx`
- `frontend/index.css`
- `frontend/lib/customerOrderingState.ts`
- `frontend/lib/publicMenuAvailability.ts`
- `frontend/main.tsx`
- `frontend/pages/admin/LocationManagement.tsx`
- `frontend/pages/admin/MenuItems.tsx`
- `frontend/pages/admin/POSReadiness.tsx`
- `frontend/pages/customer/CustomerOrder.tsx`
- `frontend/pages/inventory/PurchaseEntry.tsx`
- `frontend/pages/inventory/StockCorrection.tsx`
- `frontend/pages/kot/KOTScreen.tsx`
- `frontend/pages/kot/ReadyToServe.tsx`
- `frontend/pages/pos/IncomingOnlineOrders.tsx`
- `frontend/pages/pos/POSHome.tsx`
- `frontend/pages/pos/RunningOrders.tsx`
- `frontend/pages/reports/DayClose.tsx`
- `frontend/types/menu-management.ts`
- `index.html`
- `package.json`
- `scripts/test-customer-account.mjs`
- `scripts/test-customer-order-state.ts`

### New source and public files

- `frontend/components/PwaStatusUI.tsx`
- `frontend/components/customer/CustomerProductImage.tsx`
- `frontend/components/customer/DietaryMarker.tsx`
- `frontend/components/customer/HorizontalScroller.tsx`
- `frontend/contexts/ConnectivityContext.tsx`
- `frontend/lib/connectivity.ts`
- `frontend/lib/customerMenuPresentation.ts`
- `frontend/lib/pwa.ts`
- `public/manifest.webmanifest`
- `public/offline.html`
- `public/sw.js`
- `public/pwa/icon-192.png`
- `public/pwa/icon-512.png`
- `public/pwa/icon-maskable-512.png`
- `public/pwa/apple-touch-icon.png`
- `public/pwa/favicon-32.png`
- `public/pwa/favicon-16.png`
- `scripts/audit-pwa-customer-menu.ts`
- `scripts/test-pwa-customer-ux.ts`

### Local report artifacts

- `reports/pwa-customer-ux/customer-menu-data-audit.json`
- `reports/pwa-customer-ux/customer-menu-data-audit.csv`
- `reports/pwa-customer-ux/final-report.md`
- `reports/pwa-customer-ux/device-and-network-verification.md`
- `reports/pwa-customer-ux/golden-i-owner-review.md`
- `reports/pwa-customer-ux/golden-i-owner-review.csv`
- `reports/pwa-customer-ux/golden-i-owner-review-preview.png`
- `reports/pwa-customer-ux/local-pwa-login.png`
- `reports/pwa-customer-ux/local-pwa-server-loss.png`
- `reports/pwa-customer-ux/local-pwa-update-available.png`

## 4. PWA Package and Assets

- PWA package: none added; implementation uses native Service Worker and install-prompt APIs.
- Build tool used: Vite 6.4.2 from the existing dependency range.
- Manifest name: `Coffee Bond POS`
- Short name: `CB POS`
- Start URL: `/pos`
- Scope: `/`
- Display: `standalone`
- Orientation: `any`, preserving tablet portrait and landscape use.
- Source logo: `frontend/assets/coffee-bond-logo.png`
- Manifest: `public/manifest.webmanifest`
- Offline shell: `public/offline.html`
- Service worker: `public/sw.js`
- Generated icons: all six files under `public/pwa/` listed above.

## 5. Service-Worker Strategy

The service worker handles same-origin static GET requests only. It does not implement Background Sync, transaction queues, or request replay.

| Request class | Strategy | Stored | Safety result |
|---|---|---:|---|
| App shell, manifest, offline page, icons | Pre-cache during install | Yes | Static files only |
| Hashed JS/CSS and local fonts/brand assets | Cache first, fetch and cache on miss | Yes | Same-origin GET only |
| Navigation | Network first, then cached app shell/offline fallback | Shell only | No page data cached |
| Non-GET requests | Service worker bypass | No | Mutations never cached or replayed |
| Cross-origin Firebase, Functions, Razorpay, image CDN | Service worker bypass | No | Operational/private data excluded |
| Firebase reserved `__/` routes | Service worker bypass | No | Auth/config endpoints excluded |

Old PWA caches are deleted on activation. An update waits for explicit user action; refresh occurs only after the waiting worker is activated, and prompts are suppressed while a critical operation is active.

## 6. Offline-Protected Actions

The reusable guard is enforced in both mutation handlers and marked UI controls. The blocked message is:

`This action requires an internet connection and has not been submitted.`

Protected surfaces include:

- Cash, UPI, Split, Complimentary, and Razorpay checkout initiation/finalization.
- Complimentary OTP request and verification.
- Hold, recall, and held-bill deletion.
- Online-order accept, reject, and refund.
- Running-order KOT updates, payment reversal actions, and void.
- Barista/Kitchen/Ready KOT status mutations.
- Stock correction, purchase posting, invoice upload/parsing actions, and stock confirmation.
- Day-close save.
- Item availability/menu operational save.
- Location preview/create/edit/activate/deactivate, staff assignment, opening stock, launch exception, and setup-test controls.
- POS readiness and GST/configuration saves.
- Customer checkout and payment entry points.

Reconnect announces that the app is back online but never resubmits a blocked action. The staff and customer routes receive different offline wording.

## 7. Customer UX Audit Matrix

| ID | Finding | Expected | Actual | Status | Evidence | Files/Data Involved | Corrective Action |
|---|---|---|---|---|---|---|---|
| F-01 | Duplicate My Orders | One clear account/history entry | Header renders one conditional account entry; history remains inside account UI | PASS | Source assertion and local `/order` inspection | `CustomerHeader.tsx`, customer account tests | None |
| F-02 | Cramped mobile header | One-line brand, compact controls, no overflow | One-line wordmark, compact 44 px account control; zero overflow at 320-430 px | PASS | Browser measurements at six mobile widths | `CustomerHeader.tsx`, `index.css` | None |
| F-03 | Image placeholder | Stable 4:3 slot, skeleton, fallback, prioritized initial images | 400x300 dimensions, skeleton/fade/fallback; first three eager/high priority, remaining images lazy | PASS | 87 rendered images had explicit dimensions; zero broken images | `CustomerProductImage.tsx`, `CustomerOrder.tsx` | None |
| F-04 | Dietary marker | Render only trusted dietary data | UI supports Vegetarian, Non-vegetarian, and Egg; unknown values render no invented marker | PARTIAL | Golden I audit: 0 of 80 products have trusted dietary data | `DietaryMarker.tsx`, `menu-management.ts`, audit reports | Owner-approved source-data backfill required for 80 products |
| F-05 | Duplicate restoration notice | One accessible notice | One inline `role=status` notice; duplicate toast removed | PASS | Reloaded a persisted basket and observed one notice | `CustomerOrder.tsx`, ordering-state tests | None |
| F-06 | Horizontal affordance | Snap, end-aware cue/arrows, keyboard support | Touch snapping and keyboard arrows work; arrows/fade disappear at end; reduced motion honored | PASS | Mobile and tablet browser scroll measurements | `HorizontalScroller.tsx`, `index.css` | None |
| F-07 | Store wording | Explicit states from trusted fields | Accepting, busy, closed, temporarily unavailable, and menu unavailable map only from source state | PASS | Unit state mapping plus local store picker | `customerOrderingState.ts`, `CustomerOrder.tsx` | None |
| F-08 | Category accuracy | Deterministic source mapping; flag data issues | `MIS` maps to Other and `ESP` to Coffee; two source records require owner review | PARTIAL | Read-only 80-product Golden I audit | `customerMenuPresentation.ts`, audit reports | Confirm/correct source categories for Bond frappe and Mediterranean Mezze Platter |
| F-09 | Quick add | One tap only without configurable add-ons | Label removed; no-group Pour Over adds directly; Cappuccino and Iced Americano open customization | PASS | Local browser interaction and source assertions | `CustomerOrder.tsx`, `addOns.ts` behavior | None |
| F-10 | Add feedback | Restrained feedback with reduced-motion support | Basket badge bump and polite announcement; no layout shift or sound | PASS | Browser announcement and CSS/source inspection | `CustomerHeader.tsx`, `CustomerOrder.tsx`, `index.css` | None |
| F-11 | Empty states | Explain and offer useful next action | Empty search provides Show full menu; unavailable/closed states remain navigable | PASS | Browser empty-search test | `CustomerOrder.tsx`, ordering state | None |
| F-12 | Accessibility | Focus, labels, touch targets, announcements | Visible focus rings; 44 px controls; unique close labels; polite basket/offline announcements | PASS | Keyboard focus check, dialog measurements, source assertions | Customer components, connectivity UI, `index.css` | Real assistive-technology audit remains recommended |
| F-13 | Mobile basket bar | Compact count/total/action without overlap | Persistent compact bar fits all tested mobile widths and safe-area spacing | PASS | 320-430 px measurements; basket sheet fit test | `CustomerOrder.tsx`, `PwaStatusUI.tsx` | None |

## 8. Category and Data Issues Requiring Approval

| Product | Current source category | Current customer category | Required owner action |
|---|---|---|---|
| `BOND_FRAPPE` / Bond frappe | `MIS` / Misc | Other | Confirm the correct source category; UI no longer guesses Food |
| `MEDITERRANEAN_MEZZE_PLATTER` | `ESP` / Espresso Bar | Coffee | Correct the source category if Espresso Bar is not authoritative |

No Firestore or import data was changed.

## 9. Products Lacking Trusted Dietary Classification

The Golden I read-only audit found **80 of 80** products without a trusted dietary field:

`BOND_FRAPPE`, `CHEESE_GARLIC_BREAD`, `CHILLI_CRISP_HUNG_CURD_FOLD`, `GARLIC_BREAD`, `HUMMUS_GREENS_AND_PICKLED_ONION`, `HUNG_CURD__CHARED_VEG_TARTINE`, `ICED_CAPPUCCINO`, `MIX_BUSINESS`, `MR_PESTO`, `PROTEIN_NACHOS`, `THE_GREEN_HARISSA_SMASH`, `THE_MELBOURNE_FOLD`, `THE_MIGHTY_MUSHROOM`, `TRES_LECHES_NUTTY`, `AFFOGATO`, `AVOCADO_AND_QUINOA_SALAD`, `AVOCADO_BREAKFAST_BOWL`, `BEACH_BREW`, `BERRY_SMOOTHIE_BOWL`, `BOND_PIZZA`, `BREAD_2_SLICES`, `BROWNIE`, `CAPPUCCINO`, `CLASSIC_COLD_BREW`, `CLASSIC_ZAFFLE`, `CLOUD_BLACK`, `COCO_MANGO`, `COCONUT_VIETNAMESE`, `COLD_BREW_TONIC`, `COLD_COFFEE`, `COOKIE_HAZELNUT_CHOCOLATE`, `CORTADO`, `DOUBLE_ESPRESSO`, `ESPRESSO_TONIC`, `EXTRA_DIP`, `FLAT_WHITE`, `FOCUS_LATTE`, `FRENCH_PRESS`, `FRUIT_SALAD_GRANOLA_YOGURT`, `GINGER_LEMON_HONEY`, `GREEN`, `HERBAL`, `HOJI_MAPLE_LATTE`, `HOMEMADE_ICED_TEA`, `HONG_KONG_GUNNER`, `HUMMUS_VEGGIES`, `ICED_AMERICANO`, `ICED_LATTE`, `ICED_VIETNAMESE`, `KALE_RICOTTA_TOAST`, `KIMCHI_FRIED_RICE`, `LATTE`, `LEMON_ICE_CREAM`, `LEMON_OJ_BITTER`, `LONG_BLACK`, `MACCHIATO`, `MAGIK`, `MAISON_LEMONADE`, `MANGO_ICE_CREAM`, `MANGO_MATCHA`, `MARGHERITA`, `MATCHA_LATTE_HOT_ICED`, `MEDITERRANEAN_MEZZE_PLATTER`, `MISO_LATTE`, `MIXED_BUSINESS_ZAFFLE`, `MOZZARELLA_PESTO`, `MR_PINK`, `MR_RED`, `MR_WHITE`, `PANCAKES`, `POTATO_ONION_ZAFFLE`, `POUR_OVER`, `ROASTED_FRIES`, `SEASONAL_JUICE`, `SHROOM_ZAFFLE`, `TIRAMISU`, `VANILLA_ICE_CREAM`, `VEGGIES`, `WATERMELON_AND_RICOTTA`, `WATERMELON_ICE_CREAM`.

Evidence is preserved in the JSON and CSV audit reports so an owner-approved backfill can be reviewed separately. A second read-only recursive BOM review found 15 products with explicit Egg evidence, 53 ambiguous products, and 12 products with missing source evidence. It found no product that could be safely labelled vegetarian or non-vegetarian from trusted stored metadata. See `golden-i-owner-review.md`; no dietary value was written.

## 10. Commands and Results

| Command | Result |
|---|---|
| `npm ci` | PASS |
| `npm ci --prefix functions` | PASS |
| `npm run audit:pwa-customer-menu` | PASS; read-only audit, 80 products, 0 writes |
| `npm run test:pwa-customer-ux` | PASS |
| `npm run test:customer-ordering` | PASS, including checkout persistence 28/28 and customer account 38/38 |
| `npm run test:addon-group-mapping` | PASS |
| `npm run test:berry-base-split` | PASS |
| `npm run test:complimentary-orders` | PASS |
| `npm run test:franchise-viewer` | PASS, 52 checks |
| `npm run test:location-management` | PASS, 61 checks |
| `npm run test:location-management-emulator` | PASS against local demo emulator; 0 production writes |
| `npm run test:menu-setup-unit-repair` | PASS |
| `npm run test:packaging-applicability` | PASS |
| `npm run test:pos-addon-authorization` | PASS |
| `npm run test:pos-razorpay` | PASS, 30/30 |
| `npm run test:product-addon-controls` | PASS |
| `npm run test:product-images` | PASS |
| `npm run test:purchase-calculations` | PASS |
| `npm run test:purchase-invoice-draft` | PASS |
| `npm run test:razorpay-checkout` | PASS, 99/99 |
| `npm run test:reporting-centre` | PASS, 57 checks |
| `npm run test:security-rules` | PASS |
| `npm run test:verified-kitchen-bom-repair` | PASS |
| `npm run test:void-payment-reversal` | PASS |
| `npm run lint` | PASS; TypeScript `tsc --noEmit` |
| `npm run build` | PASS; existing 500 kB chunk warning only |
| `git diff --check` | PASS; no output |

The final build produced the manifest, service worker, offline page, and all PWA icons. No POS secret names were found in built assets.

## 11. Coffee Bond POS Release QA Matrix

| Test | Expected | Actual | Status | Evidence | Corrective Action |
|---|---|---|---|---|---|
| 1. Authentication and role permissions | Existing boundaries unchanged | Security rules pass; signed-out protected routes redirect to login | PARTIAL | Security-rules suite and local route checks | Complete signed-in staff role matrix on a non-production environment |
| 2. Store and product selection | Existing selection works | Golden I public menu loaded all 80 products; protected staff routes load or redirect safely | PARTIAL | Local browser and read-only menu audit | Exercise signed-in staff store selector before release |
| 3. Cash, UPI and split payments | Calculations and behavior unchanged | Payment, void, Complimentary, POS Razorpay, and customer Razorpay suites pass; no live transaction run | PASS | Automated regression suites | None for code gate |
| 4. Percentage discounts and role limits | Existing authorization preserved | Security and checkout regressions pass; no manual multi-role transaction was run | PARTIAL | Rules and checkout suites | Manual role QA recommended |
| 5. Hold, recall and delete held bills | Workflow preserved and offline writes blocked | Handler and UI guards are present; no browser transaction was created | PARTIAL | PWA guard test and source inspection | Run signed-in emulator/non-production scenario |
| 6. KOT generation and department routing | Existing routes remain correct | KOT/void regressions pass and mutation controls are connectivity-guarded | PARTIAL | Automated suites and source checks | Manual signed-in KOT scenario remains |
| 7. Online-order acceptance and rejection | Idempotent behavior preserved | Customer/Razorpay/security suites pass; both handlers use final connectivity checks | PASS | Customer checkout 99/99 plus security tests | None for code gate |
| 8. Stock deduction and void reversal | Exactly-once behavior unchanged | Void/payment-reversal suite passes; inventory mutations are guarded | PASS | Automated void and security suites | None |
| 9. Reports, GST and payment summaries | Existing totals unchanged | Reporting Centre 57 checks and Complimentary/void suites pass | PASS | Automated reports regression | None |
| 10. Firestore and Storage permissions | Existing policy preserved | Security-rules and Product Images tests pass; no rule changed | PASS | Automated rule/image tests | None |
| 11. Razorpay verification, retries, recovery, idempotency | Server verification unchanged | Customer Razorpay 99/99 and POS Razorpay 30/30 pass | PASS | Automated Razorpay suites | None |
| 12. Customer ordering on mobile | Usable at required widths | Required emulated widths have zero page overflow and no clipped Add controls | PASS | Production-equivalent local browser QA | Physical-device installation remains separately blocked |
| 13. Item availability and store-specific controls | Trusted store state only | Explicit status mapping/store picker pass; no operational data changed | PASS | Unit and browser checks | None |
| 14. Receipt legal and GST behavior | Existing behavior unchanged | Complimentary, void, Razorpay, and reporting regressions pass; receipt code unchanged | PASS | Automated regression suites | None |
| 15. PWA installation | Install correctly on desktop, Android, and iPhone | Manifest/assets and desktop worker pass; owner confirmed Android Chrome installation/standalone mode and iPhone Safari Add to Home Screen/standalone mode | PASS | Manifest checks and owner-confirmed real-device results in device report | Record device/browser versions in a future regression run |
| 16. Offline protection | Shell works; all transactional actions fail closed | Cached shell remained available when origin server stopped; handler/UI tests pass; true `navigator.onLine=false` could not be exercised | PARTIAL | Server-loss screenshot, worker source, PWA tests | Run Chrome DevTools Offline and physical network-loss matrix |
| 17. Reconnection without duplicate mutations | No queued/automatic retry or duplicate writes | No Background Sync or mutation queue exists; idempotency suites pass; true reconnect was unavailable | PARTIAL | Source inspection and automated idempotency tests | Run offline-to-online double-click test in emulator/non-production environment |
| 18. Service-worker update safety | Prompt, defer active work, one controlled reload, clear old cache | Version B prompt appeared; no forced reload; explicit Refresh caused one reload and no loop; active transaction deferral and exact cache inventory were not browser-tested | PARTIAL | Update screenshot, timed Chrome observation, source/test assertions | Repeat while an authenticated non-production transaction is active and inspect CacheStorage |

## 12. Desktop Verification

- Production-equivalent local build tested at approximately 1280 px.
- `/order` loaded the Golden I 80-item menu with search, categories, Popular Today, customization, add-ons, basket, customer details, Pay Online, and Pay at Counter entry points.
- Cappuccino + Oat Milk changed the displayed item price from Rs 225 to Rs 275.
- Pay Online showed verification and final amount with no separate Send Order Request action.
- Pay at Counter retained the existing Send Order Request action.
- Empty search showed a useful recovery action.
- Product cards had no broken image and no measured image-slot layout collapse.
- `/order/my-orders` loaded independently and browser Back returned predictably.
- Signed-out `/pos`, `/pos/incoming-orders`, `/kot/barista`, and `/reports` redirected to `/login`.
- Browser console contained no application error during the recorded checks.

## 13. Mobile and Tablet Verification

| Viewport | Page overflow | Clipped Add controls | Basket bar | Result |
|---|---:|---:|---|---|
| 320 px | 0 px | 0 | Fits | PASS |
| 360 px | 0 px | 0 | Fits | PASS |
| 375 px | 0 px | 0 | Fits | PASS |
| 390 px | 0 px | 0 | Fits | PASS |
| 414 px | 0 px | 0 | Fits | PASS |
| 430 px | 0 px | 0 | Fits | PASS |
| 768 px portrait | 0 px | 0 | Responsive | PASS |
| 1024 px landscape | 0 px | 0 | Desktop/tablet layout | PASS |

At 320 px, the basket sheet, store sheet, and customization dialog fit the viewport, remain scrollable, expose unique 44 px close controls, and keep the Add Item action reachable. Category chips had 1021 px of scroll content in a 320 px viewport and retained touch/keyboard navigation. A valid restored basket kept its selected store and showed one accessible restoration message.

## 14. Installation Status

- Desktop/local PWA: **PARTIAL**. The manifest and assets pass, the service worker controlled the page, the app shell survived local-origin server loss, and the explicit update prompt completed one controlled reload without a loop. Exact Chrome DevTools CacheStorage enumeration and active-transaction update deferral were unavailable.
- Android/Chromium installation: **PASS**. The owner confirmed installation on a real Android device using Chrome and successful installed standalone-mode launch. Device model, Android version, and Chrome version were not supplied.
- iPhone installation: **PASS**. The owner confirmed Safari Add to Home Screen installation on a real iPhone and successful installed standalone-mode launch. Device model, iOS version, and Safari version were not supplied.

The production build was served at `http://127.0.0.1:4173` and `http://192.168.0.5:4173`. The LAN URL was recorded but not opened on a physical device. Full evidence is in `device-and-network-verification.md`.

## 15. Remaining Risks and Unverified Items

- Android and iPhone installation plus standalone launch are verified by the owner. Exact device/browser versions, installed-app offline behavior, and installed-app update behavior remain unrecorded.
- iPhone safe-area, home-indicator, keyboard, and instruction-dismissal details were not separately recorded and remain follow-up checks rather than installation blockers.
- The available Chrome integration did not expose network throttling/offline controls. Static shell recovery during local server loss passed, but live offline banner, blocked mutation clicks, reconnect, and double-click-after-reconnect behavior remain **BLOCKED** in-browser. Source-level guards and automated assertions pass.
- Exact CacheStorage contents and old-cache removal were not enumerable through the available Chrome surface; request-policy source inspection passes.
- Update detection, user prompt, no-forced-refresh, one explicit reload, and no-loop behavior passed. Deferral during an authenticated active transaction remains unverified in-browser.
- Signed-in staff login/logout, POS transaction buttons, KOT mutations, hold/recall, and report data were not exercised in the browser because no transaction or production-data action was authorized.
- No real payment, customer order, POS order, KOT, stock movement, or Firebase mutation was performed.
- Dietary UI completion remains owner-gated: recursive BOM evidence supports Egg for 15 products, while 53 are ambiguous and 12 lack complete source evidence; 0 can be safely labelled vegetarian and 0 non-vegetarian from trusted stored metadata.
- Bond frappe and Mediterranean Mezze Platter need owner-approved source-category decisions.
- Existing main bundle size warning remains; route chunks are present, but the shared `index` chunk is approximately 974 kB minified.

## 16. Safety Confirmation

- No commit or push was made.
- No preview or production deployment was made.
- No production Firebase write was made.
- No payment or Firebase configuration was changed.
- No live payment or customer order was created.

## 17. Verification-Only Follow-up

### PWA endpoints and browser evidence

- Local preview: `http://127.0.0.1:4173`
- LAN preview: `http://192.168.0.5:4173`
- Manifest: `/manifest.webmanifest`, HTTP 200, correct manifest MIME type
- Service worker: `/sw.js`, HTTP 200, JavaScript MIME type
- Offline fallback: `/offline.html`, HTTP 200
- Manifest values: Coffee Bond POS / CB POS / `/pos` / standalone / scope `/`
- Worker result: active cached shell remained renderable after the local preview server stopped.
- Update result: version B produced a user-controlled prompt; it did not force-refresh; one Refresh action caused one reload; no reload loop was observed; the temporary cache marker was restored to `v1` and the final build passed.
- Application console errors: none observed. One unrelated Chrome-extension `No Listener` warning was ignored as instructed.

### Golden I owner-review result

| Classification | Count |
|---|---:|
| Clearly vegetarian from trusted source | 0 |
| Clearly contains egg from recursive BOM | 15 |
| Clearly non-vegetarian from trusted source | 0 |
| Ambiguous | 53 |
| Missing source evidence | 12 |

All 80 public products matched an exact Finished Good. The two category decisions remain `finishedGoods/BOND_FRAPPE` (`MIS / Misc`) and `finishedGoods/MEDITERRANEAN_MEZZE_PLATTER` (`ESP / Espresso Bar`). No approved Coffee Bond workbook file was present in this worktree or sibling worktrees, so the report does not claim workbook evidence.

### Verification-only commands

The follow-up reran or completed `npm run test:pwa-customer-ux`, `npm run test:customer-ordering`, `npm run test:pos-razorpay`, `npm run test:razorpay-checkout`, `npm run test:void-payment-reversal`, `npm run test:reporting-centre`, `npm run test:security-rules`, `npm run test:product-images`, `npm run test:location-management`, `npm run test:addon-group-mapping`, `npm run test:complimentary-orders`, `npm run lint`, `npm run build`, and `git diff --check`. All passed. No test made a production write or real payment.

### Final classification

**PARTIAL**. No critical or high-severity code regression was found, and real Android/iPhone installation and standalone launch now pass. The mandatory real network-loss/reconnection mutation matrix remains incomplete, so offline/reconnect rows remain PARTIAL or BLOCKED rather than being promoted from source and automated evidence.

No commit, push, deployment, production Firebase write or payment configuration change was performed.
