import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { spawnSync } from 'node:child_process';

const stage = path.resolve(import.meta.dirname, '..');
const mode = process.argv[2];
assert(['candidate', 'recovery'].includes(mode), 'Choose candidate or recovery');
const recovery = mode === 'recovery';
const staff = path.join(stage, 'staff');
const output = path.join(stage, 'release-qualification', recovery ? 'recovery-build' : 'production-build');
const reportPrefix = mode;
const hash = value => createHash('sha256').update(value).digest('hex');
assert.match(process.version, /^v22\./);

const sdkUrl = 'https://pos.coffeebond.in/__/firebase/init.json';
const config = await new Promise((resolve, reject) => {
  https.get(sdkUrl, {family:4, signal:AbortSignal.timeout(25000)}, response => {
    const chunks = [];
    response.on('data', chunk => chunks.push(chunk));
    response.on('error', reject);
    response.on('end', () => {
      try {
        assert.equal(response.statusCode, 200);
        resolve(JSON.parse(Buffer.concat(chunks)));
      } catch (error) { reject(error); }
    });
  }).on('error', reject);
});
assert.equal(config.projectId, 'coffee-bond-pos');
assert.equal(config.storageBucket, 'coffee-bond-pos.firebasestorage.app');
assert.equal(hash(JSON.stringify(config)), '42eb46e8aadc174241d7d9aa7a4cf37cfc7c246ef7ce1dee038fe220f3193632',
  'Public SDK configuration differs from the verified Nov17 production build');
const environment = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('VITE_'))),
  NODE_ENV: 'production',
  VITE_TILL_RECOVERY_ONLY: recovery?'true':'false',
  VITE_FIREBASE_API_KEY: config.apiKey,
  VITE_FIREBASE_AUTH_DOMAIN: config.authDomain,
  VITE_FIREBASE_PROJECT_ID: config.projectId,
  VITE_FIREBASE_MESSAGING_SENDER_ID: config.messagingSenderId,
  VITE_FIREBASE_APP_ID: config.appId,
  VITE_FIREBASE_STORAGE_BUCKET: config.storageBucket,
  VITE_FIREBASE_MEASUREMENT_ID: config.measurementId || '',
  VITE_FIREBASE_FUNCTIONS_REGION: 'us-central1',
  VITE_OFFLINE_RELEASE: 'production',
  VITE_USE_FIREBASE_EMULATORS: 'false',
  VITE_OFFLINE_LOCAL_ONLY: 'false',
};
const tracked = ['frontend','public','vite.config.ts','index.html','package.json','package-lock.json'];
function snapshot() {
  const hashes = {};
  function walk(file) {
    const full = path.join(staff, file);
    if (fs.statSync(full).isDirectory()) {
      for (const child of fs.readdirSync(full).sort()) walk(path.join(file, child));
    } else hashes[file] = hash(fs.readFileSync(full));
  }
  for (const file of tracked) walk(file);
  return hash(JSON.stringify(hashes));
}
const sourceHash = snapshot();
const result = spawnSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--mode', 'production', '--outDir', output, '--emptyOutDir'], {
  cwd: staff, env: environment, timeout: 90000, encoding:'utf8',
});
fs.writeFileSync(path.join(stage, 'evidence/' + reportPrefix + '-build.log'), (result.stdout || '') + (result.stderr || ''));
assert.equal(result.status, 0, 'Production-configured Staff build failed');
assert.equal(snapshot(), sourceHash, 'Input changed during Staff build');
const html = fs.readFileSync(path.join(output, 'index.html'), 'utf8');
const entry = html.match(/src="\/(assets\/index-[^"]+\.js)"/)?.[1];
assert(entry, 'Built Staff entry missing');
const entryBytes = fs.readFileSync(path.join(output, entry));
for (const value of [config.projectId, config.storageBucket, config.authDomain, 'production', 'us-central1']) {
  assert(entryBytes.includes(Buffer.from(value)), 'Production binding missing from new entry');
}
const clockSource = fs.readFileSync(path.join(staff, 'frontend/lib/offline/desktopClock.ts'), 'utf8');
const extensionId = clockSource.match(/const extensionId\s*=\s*['"]([a-p]{32})['"]/)?.[1];
assert(extensionId, 'Managed clock public binding missing');
const publicManifest = JSON.parse(fs.readFileSync(path.join(stage, 'continuity/extension/manifest.json')));
const nibbles = hash(Buffer.from(publicManifest.key, 'base64')).slice(0,32);
assert.equal(extensionId, [...nibbles].map(n => String.fromCharCode(97+parseInt(n,16))).join(''), 'Managed extension identity changed');
assert(!entryBytes.includes(Buffer.from('demo-coffee-bond-offline')), 'Demo project leaked into production entry');
const worker = fs.readFileSync(path.join(output, 'sw.js'));
assert.match(worker.toString(), /const CACHE_VERSION = 'v3-[0-9a-f]{24}';/);
const metadata = {
  status:'PASS', node:process.version, sourceHash, output:path.relative(stage,output), managedExtensionId:extensionId,
  configuration:{recoveryOnly:recovery,source:sdkUrl, sha256:hash(JSON.stringify(config)), project:config.projectId, storageBucket:config.storageBucket, region:'us-central1', mode:'production', emulators:false, localOnly:false},
  indexSha256:hash(html), entry, entrySha256:hash(entryBytes), workerSha256:hash(worker),
  publicConfigurationReads:1, productionBusinessRequests:0, productionWrites:0,
};
fs.writeFileSync(path.join(stage, 'evidence/' + reportPrefix + '-build.json'), JSON.stringify(metadata,null,2)+'\n');
console.log(reportPrefix + ' build verified ' + metadata.entry);
