// Global Items must be reachable from Menu Management, and ONLY by an active ADMIN.
// The page itself already existed at /admin/global-items; this pins its exposure.
import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync('frontend/App.tsx', 'utf8');
const hub = fs.readFileSync('frontend/pages/admin/MenuManagementHub.tsx', 'utf8');
const overview = fs.readFileSync('frontend/components/admin/menu-management/OverviewTab.tsx', 'utf8');
const adminHome = fs.readFileSync('frontend/pages/admin/AdminHome.tsx', 'utf8');

let n = 0;
const ok = (c: unknown, m: string) => { assert.ok(c, m); n += 1; console.log(`PASS ${n}. ${m}`); };

// ---- route ------------------------------------------------------------------------------
ok(/<Route path="\/admin\/global-items" element={<GlobalItems \/>} \/>/.test(app), 'ROUTE: /admin/global-items is registered');
ok(/const GlobalItems = lazy\(\(\) => import\('\.\/pages\/admin\/GlobalItems'\)\)/.test(app), 'ROUTE: the page is lazy-imported like every other admin page');
ok(fs.existsSync('frontend/pages/admin/GlobalItems.tsx'), 'ROUTE: the existing page file is present (not rebuilt)');

// The route must sit inside the ADMIN-only guard, not the ADMIN+STORE_MANAGER one.
const adminOnly = app.slice(app.indexOf("allowedRoles={['ADMIN']}"), app.indexOf("allowedRoles={['ADMIN', 'STORE_MANAGER']}"));
ok(adminOnly.includes('/admin/global-items'), 'GUARD: the route is inside the ADMIN-only ProtectedRoute block');
const adminPlusManager = app.slice(app.indexOf("allowedRoles={['ADMIN', 'STORE_MANAGER']}"));
ok(!adminPlusManager.slice(0, adminPlusManager.indexOf('</Route>')).includes('/admin/global-items'), 'GUARD: the route is NOT in the ADMIN+STORE_MANAGER block');

// ---- Menu Management nav ------------------------------------------------------------------
ok(/to="\/admin\/global-items"/.test(hub), 'NAV: Menu Management links to /admin/global-items');
ok((hub.match(/to="\/admin\/global-items"/g) || []).length === 2, 'NAV: both the desktop rail and the mobile menu carry the link');
ok(/Global Items/.test(hub), 'NAV: the entry is labelled "Global Items"');
ok(/canManageGlobalItems/.test(hub), 'NAV: the link is gated by a role check');
ok(/staffProfile\?\.role === 'ADMIN'/.test(hub), 'NAV: the gate requires role ADMIN');
ok(/staffProfile\?\.isActive === true/.test(hub), 'NAV: the gate also requires an active profile');
ok((hub.match(/\{canManageGlobalItems && \(/g) || []).length === 2, 'NAV: BOTH links are wrapped in the gate');

// ---- overview card -------------------------------------------------------------------------
ok(/to="\/admin\/global-items"/.test(overview), 'CARD: the overview card links to /admin/global-items');
ok(/<h3 className="text-lg font-bold text-neutral-800 mb-2">Global Items<\/h3>/.test(overview), 'CARD: titled "Global Items"');
ok(/Manage master items, store assignments, store prices, availability, visibility and/.test(overview), 'CARD: carries the approved description');
ok(/canManageGlobalItems/.test(overview) && /staffProfile\?\.role === 'ADMIN'/.test(overview), 'CARD: gated on an active ADMIN');

// ---- the existing dashboard tile is preserved ------------------------------------------------
ok(/to="\/admin\/global-items"/.test(adminHome), 'DASHBOARD: the pre-existing admin dashboard tile still links to the page');

// ---- nothing else was touched ------------------------------------------------------------------
ok(/id: "finished", label: "Sellable Items"/.test(hub.replace(/\s+/g, ' ')) || /label: "Sellable Items"/.test(hub), 'UNCHANGED: the Sellable Items module is untouched');
ok(!/GlobalItemsTab|global-items-tab/.test(hub), 'UNCHANGED: Global Items was NOT duplicated as an in-hub tab panel');
const tabIds = (hub.match(/\{ id: "([a-z-]+)"/g) || []).length;
ok(tabIds === 10, `UNCHANGED: the hub still declares its original 10 in-page tabs (found ${tabIds})`);

console.log(`\n${n} Global Items exposure checks passed.`);
