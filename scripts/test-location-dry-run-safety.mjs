#!/usr/bin/env node
// Proves scripts/dry-run-location-management.mjs cannot reach a production project
// through any ordinary invocation. Spawns the real script; never contacts Firestore.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const SCRIPT = 'scripts/dry-run-location-management.mjs';

function run(args = [], env = {}) {
  const baseEnv = { ...process.env };
  delete baseEnv.FIRESTORE_EMULATOR_HOST;
  delete baseEnv.GOOGLE_APPLICATION_CREDENTIALS;
  const result = spawnSync('node', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...baseEnv, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { status: result.status, out: `${result.stdout || ''}${result.stderr || ''}` };
}

const checks = [];
function check(name, fn) {
  fn();
  checks.push(name);
  console.log(`PASS ${checks.length}. ${name}`);
}

check('Bare invocation without an emulator is blocked, not silently run against production', () => {
  const { status, out } = run();
  assert.equal(status, 1);
  assert.match(out, /BLOCKED \(EMULATOR_REQUIRED\)/);
});

check('Explicitly naming the production project without --allow-production is blocked', () => {
  const { status, out } = run(['--project=coffee-bond-pos'], { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' });
  assert.equal(status, 1);
  assert.match(out, /BLOCKED \(NON_DEMO_PROJECT\)/);
});

check('The preview project is equally refused on the default path', () => {
  const { status, out } = run(['--project=coffee-bond-pos-preview'], { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' });
  assert.equal(status, 1);
  assert.match(out, /BLOCKED \(NON_DEMO_PROJECT\)/);
});

check('Any non-demo project is refused on the default path', () => {
  const { status, out } = run(['--project=some-other-project'], { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' });
  assert.equal(status, 1);
  assert.match(out, /BLOCKED \(NON_DEMO_PROJECT\)/);
});

check('--allow-production alone is refused without exact project confirmation', () => {
  const { status, out } = run(['--allow-production']);
  assert.equal(status, 1);
  assert.match(out, /BLOCKED \(PROJECT_CONFIRMATION_REQUIRED\)/);
});

check('--allow-production with a mismatched confirmation is refused', () => {
  const { status, out } = run(['--allow-production', '--confirm-project=coffee-bond-pos-preview']);
  assert.equal(status, 1);
  assert.match(out, /BLOCKED \(PROJECT_CONFIRMATION_REQUIRED\)/);
});

check('--allow-production is refused while an emulator host is set', () => {
  const { status, out } = run(
    ['--allow-production', '--confirm-project=coffee-bond-pos'],
    { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' },
  );
  assert.equal(status, 1);
  assert.match(out, /BLOCKED \(EMULATOR_HOST_SET\)/);
});

check('The script no longer hardcodes a production project id as its default target', () => {
  const source = spawnSync('node', ['-e', `process.stdout.write(require('node:fs').readFileSync('${SCRIPT}','utf8'))`], { encoding: 'utf8' }).stdout;
  assert.doesNotMatch(source, /const PROJECT_ID = 'coffee-bond-pos'/);
  assert.match(source, /DEFAULT_EMULATOR_PROJECT_ID = 'demo-/);
  assert.match(source, /TARGET\.useApplicationDefault \? \{ credential: applicationDefault\(\) \}/);
});

console.log(`\n${checks.length} Location dry-run safety checks passed.`);
