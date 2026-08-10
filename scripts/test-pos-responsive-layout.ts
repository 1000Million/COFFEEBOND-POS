import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(resolve('frontend/pages/pos/POSHome.tsx'), 'utf8');

assert.match(
  source,
  /grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4/,
  'product cards must scale from one mobile column to four wide-desktop columns',
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
  /sm:grid-cols-2 xl:hidden/,
  'the compact category selector must remain visible on mobile, tablet, and laptop widths',
);
assert.match(
  source,
  /flex flex-wrap gap-1\.5/,
  'payment methods must wrap instead of forcing horizontal overflow',
);
assert.match(
  source,
  /sm:p-4 xl:hidden/,
  'the sticky cart summary must remain available below the desktop breakpoint',
);

console.log('POS responsive layout tests passed.');
