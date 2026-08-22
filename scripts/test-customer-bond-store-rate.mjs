import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = process.cwd();
const loyaltySource = readFileSync(resolve(root, 'frontend/lib/bondLoyalty.ts'), 'utf8');
const orderSource = readFileSync(resolve(root, 'frontend/pages/customer/CustomerOrder.tsx'), 'utf8');
const tempDirectory = mkdtempSync(join(tmpdir(), 'coffee-bond-store-rate-'));
const bundlePath = join(tempDirectory, 'bond-loyalty.mjs');

const passed = [];
const check = (name, condition) => {
  assert(condition, name);
  passed.push(name);
};

try {
  await build({
    entryPoints: [resolve(root, 'frontend/lib/bondLoyalty.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: bundlePath,
    define: {
      'import.meta.env.MODE': '"test"',
      'import.meta.env.VITE_FIREBASE_PROJECT_ID': '"test-project"',
    },
    plugins: [{
      name: 'customer-bond-callable-stubs',
      setup(context) {
        context.onResolve({ filter: /^firebase\/functions$/ }, () => ({
          path: 'firebase-functions',
          namespace: 'customer-bond-functions-test',
        }));
        context.onLoad({ filter: /.*/, namespace: 'customer-bond-functions-test' }, () => ({
          loader: 'js',
          contents: `
            export function httpsCallable() {
              return async (payload) => {
                globalThis.__customerBondSummaryRequests.push(payload);
                return { data: { enabled: true, earnEnabled: true } };
              };
            }
          `,
        }));
        context.onResolve({ filter: /^\.\/customerAuth$/ }, () => ({
          path: 'customer-auth',
          namespace: 'customer-bond-auth-test',
        }));
        context.onLoad({ filter: /^customer-auth$/, namespace: 'customer-bond-auth-test' }, () => ({
          loader: 'js',
          contents: 'export const customerFunctions = {};',
        }));
      },
    }],
  });

  globalThis.__customerBondSummaryRequests = [];
  const { estimateBondPoints, getCustomerBondSummary } = await import(
    `${pathToFileURL(bundlePath).href}?v=${Date.now()}`
  );

  check('legacy 1000-bps fallback remains 10 percent', estimateBondPoints(250) === 25);
  check('server-returned store rate drives the estimate', estimateBondPoints(250, 1500) === 37);
  check('fractional points are rounded down', estimateBondPoints(73.5, 1000) === 7);
  check('zero is a valid effective rate', estimateBondPoints(250, 0) === 0);
  check('invalid rates fall back to the legacy rate', estimateBondPoints(250, Number.NaN) === 25);
  check('negative eligible spend cannot produce points', estimateBondPoints(-100, 1500) === 0);

  await getCustomerBondSummary();
  await getCustomerBondSummary('  NOIDA_29  ');
  check('summary request remains valid without a selected store',
    JSON.stringify(globalThis.__customerBondSummaryRequests[0]) === '{}');
  check('summary request sends only the normalized selected store',
    JSON.stringify(globalThis.__customerBondSummaryRequests[1]) === '{"storeId":"NOIDA_29"}');

  check('summary type carries server-resolved policy evidence',
    loyaltySource.includes('effectiveEarnRateBps?: number;')
      && loyaltySource.includes('effectivePolicyVersionId?: string | null;'));
  check('customer order refetches the summary when its selected store changes',
    orderSource.includes('getCustomerBondSummary(selectedStoreId || undefined)')
      && /\[verifiedCustomer\?\.customerUid, selectedStoreId, isOffline, demoRequested\]/.test(orderSource));
  check('basket estimate consumes only the returned effective earn rate',
    orderSource.includes('estimateBondPoints(totals.taxableAmount, displayedBondSummary.effectiveEarnRateBps)'));
  check('customer helper contains no campaign reward arithmetic',
    !/campaign(?:Bonus|Multiplier|Points|Budget)/i.test(loyaltySource));

  console.log(`Customer BOND store-rate tests passed: ${passed.length}/${passed.length}.`);
} finally {
  delete globalThis.__customerBondSummaryRequests;
  rmSync(tempDirectory, { recursive: true, force: true });
}
