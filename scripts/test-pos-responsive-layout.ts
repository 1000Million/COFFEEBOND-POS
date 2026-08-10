import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(resolve('frontend/pages/pos/POSHome.tsx'), 'utf8');

assert.match(
  source,
  /grid min-w-0 grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4/,
  'product cards must scale from one mobile column to four wide-desktop columns',
);
assert.doesNotMatch(
  source,
  /flex min-w-max items-center gap-2 whitespace-nowrap/,
  'the top POS controls must not force page-level horizontal overflow',
);
assert.match(
  source,
  /w-full min-w-0 max-w-full bg-transparent[^\n]+md:min-w-\[180px\]/,
  'the store selector must be fluid on mobile and retain its desktop minimum width',
);
assert.match(
  source,
  /grid w-full min-w-0 grid-cols-3[^\n]+md:flex md:w-auto/,
  'service-mode controls must fit the mobile viewport and return to a desktop row',
);
assert.match(
  source,
  /xl:grid-cols-\[minmax\(0,1fr\)_420px\]/,
  'the persistent Current Sale column must start only at the desktop breakpoint',
);
assert.match(
  source,
  /translate-y-full xl:translate-y-0/,
  'the Current Sale panel must remain a drawer below the desktop breakpoint',
);
assert.match(
  source,
  /grid w-full min-w-0 grid-cols-1 gap-2 md:grid-cols-2 xl:hidden/,
  'the compact category selector must remain visible on mobile, tablet, and laptop widths',
);
assert.match(
  source,
  /flex flex-wrap gap-1\.5/,
  'payment methods must wrap instead of forcing horizontal overflow',
);
assert.match(
  source,
  /grid min-w-0 grid-cols-1 gap-1\.5 md:grid-cols-\[minmax\(0,1fr\)_minmax\(0,1fr\)_auto\]/,
  'split-payment controls must stack below 768px and stay bounded on larger screens',
);
assert.match(
  source,
  /sm:p-4 xl:hidden/,
  'the sticky cart summary must remain available below the desktop breakpoint',
);

console.log('POS responsive layout tests passed.');
