import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(path, 'utf8');
const app = read('frontend/App.tsx');
const types = read('frontend/types.ts');
const protectedRoute = read('frontend/components/ProtectedRoute.tsx');
const entryRedirect = read('frontend/components/EntryRedirect.tsx');
const layout = read('frontend/components/Layout.tsx');
const staffManagement = read('frontend/pages/admin/StaffManagement.tsx');
const login = read('frontend/pages/franchise/FranchiseLogin.tsx');
const staffLogin = read('frontend/pages/Login.tsx');
const api = read('frontend/lib/bondPolicyCampaigns.ts');
const workspace = read('frontend/components/bond/BondPolicyCampaignWorkspace.tsx');
const rules = read('firestore.rules');

const passed = [];
function check(name, condition) {
  assert.equal(Boolean(condition), true, name);
  passed.push(name);
  console.log(`PASS ${passed.length}. ${name}`);
}

check('distinct Franchise Manager role exists', types.includes('"FRANCHISE_MANAGER"'));
check('Admin policy route is ADMIN-only', /allowedRoles=\{\['ADMIN'\]\}[\s\S]*path="\/admin\/bond-policy"/.test(app));
check('Franchise Manager uses an isolated route outside operational Layout', /allowedRoles=\{\['FRANCHISE_MANAGER'\]\}[\s\S]*path="\/franchise\/bond"/.test(app));
check('Franchise Viewer route remains viewer-only', /allowedRoles=\{\['FRANCHISE_VIEWER'\]\}[\s\S]*path="\/franchise\/daily-sales"/.test(app));
check('protected-route fallback sends managers only to their BOND workspace', protectedRoute.includes("staffProfile.role === 'FRANCHISE_MANAGER'") && protectedRoute.includes("fallback = '/franchise/bond'"));
check('entry redirect sends managers only to their BOND workspace', entryRedirect.includes("staffProfile.role === 'FRANCHISE_MANAGER'") && entryRedirect.includes('to="/franchise/bond"'));
check('operational navigation never grants a Franchise Manager role branch', !layout.includes("role === 'FRANCHISE_MANAGER'"));
check('ordinary staff editor excludes both franchise-only roles', staffManagement.includes("['FRANCHISE_VIEWER', 'FRANCHISE_MANAGER'].includes"));
check('franchise sign-in copy supports a workspace without changing viewer authentication', login.includes('Franchise Workspace') && login.includes('FRANCHISE_AUTH_DOMAIN'));
check('staff sign-in hides raw Firebase errors behind generic credential copy',
  staffLogin.includes('setErrorMsg("Email or password is incorrect")')
  && !staffLogin.includes('err.message ||'));

for (const callableName of [
  'getBondPolicyCampaignManagerState',
  'previewBondPolicyCampaign',
  'saveBondPolicyDraft',
  'submitBondPolicyDraft',
  'saveBondCampaignDraft',
  'submitBondCampaignDraft',
  'approveBondConfiguration',
  'scheduleBondConfiguration',
  'pauseBondConfiguration',
  'rollbackBondConfiguration',
]) {
  check(`typed client uses ${callableName}`, api.includes(`'${callableName}'`));
}

check('manager client uses callables and no direct Firestore access', api.includes("from 'firebase/functions'") && !api.includes("from 'firebase/firestore'") && !workspace.includes("from 'firebase/firestore'"));
check('every mutating callable carries a client request ID', api.includes('function newBondRequestId') && [
  'save-policy',
  'submit-policy',
  'save-campaign',
  'submit-campaign',
  'approve',
  'schedule',
  'pause',
  'rollback',
].every((action) => api.includes(`newBondRequestId('${action}')`)));
check('HQ guardrail fields are sourced from manager state, not fixed policy constants', [
  'minEarnRateBps',
  'maxEarnRateBps',
  'maxMultiplierBps',
  'maxFixedBonusPoints',
  'maxCampaignDays',
  'maxCustomerAwards',
  'liabilityPaisePerPoint',
].every((field) => api.includes(field) && workspace.includes(field)));
check('missing HQ guardrails remain blank and cannot be silently saved as numeric defaults', api.includes('number | null') && workspace.includes("value == null ? '' : String(value)") && workspace.includes('Complete every HQ guardrail field'));
check('global and per-store policy scopes are explicit', workspace.includes('Global default + guardrails') && workspace.includes('Per-store override'));
check('campaign supports exactly fixed points or multiplier', workspace.includes('FIXED_POINTS') && workspace.includes('EARN_MULTIPLIER') && workspace.includes("fixedBonusPoints: campaign.rewardType === 'FIXED_POINTS'") && workspace.includes("multiplierBps: campaign.rewardType === 'EARN_MULTIPLIER'"));
check('campaign captures spend, products, categories, unique IST days, customer limit and budget', [
  'Minimum eligible spend',
  'Eligible product codes',
  'Eligible category codes',
  'Unique IST visit days',
  'Awards per customer',
  'Campaign budget (points)',
].every((label) => workspace.includes(label)));
check('campaign stacking is explicitly exclusive', api.includes("stackingMode: 'EXCLUSIVE_ONE'") && workspace.includes('EXCLUSIVE_ONE'));
check('dry-run requires an explicit covered store and shows reward, liability and zero writes', workspace.includes('Preview store')
  && workspace.includes('previewStoreId')
  && workspace.includes('Select one store covered by every candidate configuration')
  && workspace.includes('Customer reward')
  && workspace.includes('Store liability')
  && workspace.includes('writesPerformed'));
check('dry-run models mixed-basket campaign spend separately from total base spend',
  api.includes('matchingEligibleSpendPaise')
  && workspace.includes('Campaign-matching spend')
  && workspace.includes('previewMatchingSpend'));
check('dry-run surfaces runtime rejection and activation-readiness details',
  workspace.includes('dryRun.validationErrors') && workspace.includes('dryRun.conflicts'));
check('all required workflow controls are present', ['> Approve<', '> Schedule<', '> Pause<', 'Roll back to this version'].every((label) => workspace.includes(label)));
check('approved versions use a fresh in-window activation chooser',
  workspace.includes('Activation start (ISO timestamp, inside the approved window)')
  && workspace.includes('Activation end (ISO timestamp'));
check('rollback uses the immutable approved window instead of an ended schedule row',
  api.includes('approvedEndsAt')
  && workspace.includes('version.approvedEndsAt')
  && workspace.includes('Rollback end (ISO timestamp inside the original approved window'));
check('persisted drafts remain submittable after a reload',
  workspace.includes("value.status === 'DRAFT'") && workspace.includes('submitPersistedDraft'));
check('Franchise Managers never receive a global-policy pause control', workspace.includes("value.scope !== 'GLOBAL'"));
check('redemption remains visibly read-only and off', workspace.includes('Points redemption') && workspace.includes('Production redemption remains OFF'));
check('native POS remains visibly excluded', workspace.includes('Native POS remains excluded'));

const activeStaffBody = rules.slice(rules.indexOf('function isActiveStaff()'), rules.indexOf('function isFranchiseProfile'));
check('rules do not add Franchise Manager to active operational staff', !activeStaffBody.includes('FRANCHISE_MANAGER'));
for (const collectionName of [
  'bondPolicyGuardrails',
  'bondPolicyVersions',
  'bondCampaignVersions',
  'bondPolicyScopes',
  'bondCampaignScopes',
  'bondRewardApprovals',
  'bondRewardSchedules',
  'bondRewardRuntime',
  'bondCampaignBudgets',
  'bondCampaignCustomerUsage',
  'bondPolicyAudit',
]) {
  const start = rules.indexOf(`match /${collectionName}/`);
  const block = start >= 0 ? rules.slice(start, rules.indexOf('\n    }', start) + 6) : '';
  check(`${collectionName} denies all direct client access`, /allow read, create, update, delete: if false;/.test(block));
}

console.log(`\nBOND Policy & Campaign Manager UI/security contracts passed: ${passed.length}/${passed.length}.`);
