import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Hosting cache-header contract.
 *
 * SPA document routes are served by rewriting to /index.html, but a rewrite does
 * NOT inherit the headers declared for /index.html. Without an explicit rule each
 * route fell back to Firebase's default (max-age=3600), which held a stale document
 * — and therefore a stale JS bundle — in front of customers and staff for up to an
 * hour after a deploy. Every SPA document route must declare no-store explicitly.
 *
 * Hashed assets under /assets/** must keep their immutable year-long caching: they
 * are content-addressed, so a new deploy produces new filenames.
 */
const NO_STORE = 'no-cache, no-store, must-revalidate';
const IMMUTABLE = 'public, max-age=31536000, immutable';

const config = JSON.parse(readFileSync(resolve(process.cwd(), 'firebase.json'), 'utf8'));
// Hosting is a multi-site array since the customer app moved to its own site. These
// assertions cover the STAFF site; the customer site is covered by
// scripts/test-customer-separate-origin.mjs.
assert.ok(Array.isArray(config.hosting), 'hosting must be a multi-site array');
const hosting = config.hosting.find((site) => site.target === 'staff');
assert.ok(hosting, 'a staff hosting target must exist');

const headerRules = hosting.headers || [];
const cacheControlFor = (source) => {
  const rule = headerRules.find((entry) => entry.source === source);
  if (!rule) return null;
  return (rule.headers || []).find((header) => header.key === 'Cache-Control')?.value ?? null;
};

const SPA_DOCUMENT_SOURCES = [
  '/',
  '/index.html',
  '/order',
  '/order/**',
  '/pos',
  '/pos/**',
  '/login',
  '/admin/**',
  '/reports/**',
  '/inventory/**',
  '/kot/**',
  '/franchise/**',
];

for (const source of SPA_DOCUMENT_SOURCES) {
  assert.equal(
    cacheControlFor(source),
    NO_STORE,
    `${source} must be served no-store so a deploy reaches clients immediately`,
  );
}

assert.equal(
  cacheControlFor('/assets/**'),
  IMMUTABLE,
  'hashed assets must keep immutable caching',
);

// No SPA rule may accidentally capture the hashed asset directory.
for (const source of SPA_DOCUMENT_SOURCES) {
  assert.ok(
    !source.startsWith('/assets'),
    `${source} must not overlap the immutable asset directory`,
  );
}

// The catch-all rewrite that makes these document routes resolve must still exist.
const rewrites = hosting.rewrites || [];
assert.ok(
  rewrites.some((rewrite) => rewrite.source === '**' && rewrite.destination === '/index.html'),
  'the SPA catch-all rewrite must remain intact',
);
assert.equal(hosting.public, 'dist');

// This batch is Hosting-only: nothing else in firebase.json may move.
assert.equal(config.functions?.source, 'functions');
assert.equal(config.firestore?.rules, 'firestore.rules');
assert.equal(config.firestore?.indexes, 'firestore.indexes.json');
assert.equal(config.storage?.rules, 'storage.rules');

console.log(`Hosting header tests passed (${SPA_DOCUMENT_SOURCES.length} no-store routes, assets immutable).`);
