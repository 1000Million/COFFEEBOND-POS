#!/usr/bin/env node
// Proves scripts/refresh-public-menu-availability.mjs cannot write a real project through
// any ordinary invocation. Spawns the real script; never contacts Firestore.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const SCRIPT = 'scripts/refresh-public-menu-availability.mjs';

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

const EMU = { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' };
let n = 0;
function check(name, fn) { fn(); n += 1; console.log(`PASS ${n}. ${name}`); }

check('Bare invocation without an emulator is blocked', () => {
  const { status, out } = run();
  assert.equal(status, 1);
  assert.match(out, /BLOCKED \(EMULATOR_REQUIRED\)/);
});

check('Bare invocation WITH --apply is still blocked before any write', () => {
  const { status, out } = run(['--apply']);
  assert.equal(status, 1);
  assert.match(out, /BLOCKED \(EMULATOR_REQUIRED\)/);
  assert.doesNotMatch(out, /Wrote /);
});

check('Production project without --allow-production is blocked', () => {
  const { status, out } = run(['--project=coffee-bond-pos'], EMU);
  assert.equal(status, 1);
  assert.match(out, /BLOCKED \(NON_DEMO_PROJECT\)/);
});

check('Preview project without --allow-production is blocked', () => {
  const { status, out } = run(['--project=coffee-bond-pos-preview'], EMU);
  assert.equal(status, 1);
  assert.match(out, /BLOCKED \(NON_DEMO_PROJECT\)/);
});

check('Any non-demo project is blocked on the default path', () => {
  const { status, out } = run(['--project=some-other-project'], EMU);
  assert.equal(status, 1);
  assert.match(out, /BLOCKED \(NON_DEMO_PROJECT\)/);
});

check('--allow-production without exact confirmation is blocked', () => {
  const { status, out } = run(['--allow-production', '--apply']);
  assert.equal(status, 1);
  assert.match(out, /BLOCKED \(PROJECT_CONFIRMATION_REQUIRED\)/);
});

check('--allow-production with a mismatched confirmation is blocked', () => {
  const { status, out } = run(['--allow-production', '--confirm-project=coffee-bond-pos-preview', '--apply']);
  assert.equal(status, 1);
  assert.match(out, /BLOCKED \(PROJECT_CONFIRMATION_REQUIRED\)/);
});

check('--allow-production while an emulator host is set is blocked', () => {
  const { status, out } = run(['--allow-production', '--confirm-project=coffee-bond-pos'], EMU);
  assert.equal(status, 1);
  assert.match(out, /BLOCKED \(EMULATOR_HOST_SET\)/);
});

check('Source no longer hardcodes a production project and gates ADC on confirmed production', () => {
  const source = fs.readFileSync(SCRIPT, 'utf8');
  assert.doesNotMatch(source, /const PROJECT_ID = 'coffee-bond-pos'/);
  assert.match(source, /DEFAULT_EMULATOR_PROJECT_ID = 'demo-/);
  assert.match(source, /TARGET\.useApplicationDefault \? \{ credential: applicationDefault\(\) \}/);
  assert.match(source, /PRODUCTION_PROJECT_IDS = new Set\(\['coffee-bond-pos', 'coffee-bond-pos-preview'\]\)/);
});

check('Write-intent banner is emitted before the write decision', () => {
  const source = fs.readFileSync(SCRIPT, 'utf8');
  for (const key of ['MODE=', 'PROJECT_ID=', 'EMULATOR_HOST=', 'STORE_CODES=', 'WRITE_TARGET=publicMenuAvailability']) {
    assert.ok(source.includes(key), `banner missing ${key}`);
  }
});

check('Preview-only store guard and dry-run-by-default are preserved', () => {
  const source = fs.readFileSync(SCRIPT, 'utf8');
  assert.match(source, /PREVIEW_ONLY_STORE_CODES = new Set\(\['TASTING_ROOM_29'\]\)/);
  assert.match(source, /const APPLY = process\.argv\.includes\('--apply'\)/);
  assert.match(source, /const DRY_RUN = !APPLY/);
});

console.log(`\n${n} public menu refresh safety checks passed.`);
