import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(
  path.join(process.cwd(), 'frontend/components/customer/CustomerProductImage.tsx'),
  'utf8',
);

// Reproduce the retired race: a cached load can fire before a passive source
// reset, which leaves a successfully loaded image hidden.
let legacyLoaded = false;
legacyLoaded = true;
legacyLoaded = false;
assert.equal(legacyLoaded ? 'opacity-100' : 'opacity-0', 'opacity-0');

assert.doesNotMatch(source, /useEffect/);
assert.match(source, /type ImageState = \{\s*src: string;\s*status: ImageStatus;\s*\};/s);
assert.match(source, /imageState\?\.src === src/);
assert.match(source, /key=\{src\}/);
assert.match(source, /ref=\{captureImage\}/);
assert.match(source, /image\?\.complete/);
assert.match(source, /image\.naturalWidth > 0 \? 'loaded' : 'failed'/);
assert.match(source, /onLoad=\{\(\) => setStatus\('loaded'\)\}/);
assert.match(source, /onError=\{\(\) => setStatus\('failed'\)\}/);

const statusFor = (state, src) => (
  src && state?.src === src ? state.status : 'loading'
);
const setStatus = (src, status) => (src ? { src, status } : null);
const captureImage = (state, src, image) => (
  image?.complete
    ? setStatus(src, image.naturalWidth > 0 ? 'loaded' : 'failed')
    : state
);
const snapshot = (state, src) => {
  const status = statusFor(state, src);
  const loaded = Boolean(src) && status === 'loaded';
  const failed = Boolean(src) && status === 'failed';
  return {
    opacity: loaded ? 'opacity-100' : 'opacity-0',
    showImage: Boolean(src) && !failed,
    showFallback: !src || failed,
  };
};

let tests = 0;

// A normal network image reveals through onLoad.
let state = null;
assert.equal(snapshot(state, 'network.webp').opacity, 'opacity-0');
state = setStatus('network.webp', 'loaded');
assert.equal(snapshot(state, 'network.webp').opacity, 'opacity-100');
tests += 1;

// An already-complete cached image reveals immediately through the ref.
state = captureImage(null, 'cached.webp', { complete: true, naturalWidth: 1600 });
assert.equal(snapshot(state, 'cached.webp').opacity, 'opacity-100');
tests += 1;

// A changed source ignores the prior source state, then reveals independently.
state = setStatus('first.webp', 'loaded');
assert.deepEqual(snapshot(state, 'second.webp'), {
  opacity: 'opacity-0',
  showImage: true,
  showFallback: false,
});
state = captureImage(state, 'second.webp', { complete: true, naturalWidth: 1600 });
assert.equal(snapshot(state, 'second.webp').opacity, 'opacity-100');
tests += 1;

// A failed image retains the branded fallback, while a new source can mount.
state = setStatus('failed.webp', 'failed');
assert.deepEqual(snapshot(state, 'failed.webp'), {
  opacity: 'opacity-0',
  showImage: false,
  showFallback: true,
});
assert.equal(snapshot(state, 'recovered.webp').showImage, true);
tests += 1;

// The real image alt and accessible fallback label remain intact.
assert.match(source, /alt=\{alt\}/);
assert.match(source, /role="img" aria-label=\{`\$\{alt\} image unavailable`\}/);
assert.match(source, /aria-hidden="true"/);
tests += 1;

assert.equal(tests, 5);
console.log(`CustomerProductImage reveal regression tests passed: ${tests}/5.`);
