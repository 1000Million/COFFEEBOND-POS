#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const PRODUCTION_PROJECT = 'coffee-bond-pos';
const PREVIEW_PROJECT = 'coffee-bond-pos-preview';
const PROTECTED_BRANCH = 'codex/production-staff-baseline-027a1e1491a811eb';
const DEFAULT_BASELINE_REF = 'production-staff-release-baseline-027a1e1491a811eb';

function fail(message) {
  console.error(`STAFF_RELEASE_PREFLIGHT=FAIL`);
  console.error(`BLOCKER=${message}`);
  process.exit(1);
}

function argument(name) {
  const prefix = `${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length).trim() || '';
}

function argumentsFor(name) {
  const prefix = `${name}=`;
  return process.argv
    .filter((value) => value.startsWith(prefix))
    .map((value) => value.slice(prefix.length).trim())
    .filter(Boolean);
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
  });
}

function parseEnv(contents) {
  const values = {};
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

function walkFiles(directory, output = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) walkFiles(filePath, output);
    else if (entry.isFile()) output.push(filePath);
  }
  return output;
}

function sortedUnique(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

try {
  const project = argument('--project');
  const baselineRef = argument('--baseline') || DEFAULT_BASELINE_REF;
  const allowNoop = process.argv.includes('--allow-noop');
  const baselineVerification = process.argv.includes('--baseline-verification');
  const manifestPath = argument('--approved-manifest');

  if (project !== PRODUCTION_PROJECT) {
    fail(`--project must equal ${PRODUCTION_PROJECT}`);
  }

  if (Number(process.versions.node.split('.')[0]) !== 20) {
    fail(`Node 20 is required; found ${process.version}`);
  }

  const repositoryRoot = run('git', ['rev-parse', '--show-toplevel']).trim();
  if (path.resolve(repositoryRoot) !== path.resolve(process.cwd())) {
    fail('run the gate from the repository root');
  }

  const branch = run('git', ['branch', '--show-current']).trim();
  if (!baselineVerification && branch === PROTECTED_BRANCH) {
    fail('create a separate release branch/worktree; never release directly from the protected baseline branch');
  }

  const statusBefore = run('git', ['status', '--porcelain=v1', '--untracked-files=all']).trim();
  if (statusBefore) fail('git status is not clean');

  run('git', ['rev-parse', '--verify', `${baselineRef}^{commit}`]);
  try {
    run('git', ['merge-base', '--is-ancestor', baselineRef, 'HEAD']);
  } catch {
    fail(`HEAD is not descended from baseline ${baselineRef}`);
  }

  const approvedFiles = argumentsFor('--approved-file');
  if (manifestPath) {
    approvedFiles.push(...readFileSync(manifestPath, 'utf8')
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter((value) => value && !value.startsWith('#')));
  }

  const approved = sortedUnique(approvedFiles);
  const actual = sortedUnique(run('git', [
    'diff',
    '--name-only',
    '--diff-filter=ACDMRTUXB',
    `${baselineRef}..HEAD`,
  ]).split(/\r?\n/).map((value) => value.trim()).filter(Boolean));

  if (!allowNoop && approved.length === 0) {
    fail('provide at least one --approved-file or --approved-manifest');
  }
  if (approved.join('\n') !== actual.join('\n')) {
    fail(`approved files do not match release diff; approved=${JSON.stringify(approved)} actual=${JSON.stringify(actual)}`);
  }

  const envText = readFileSync('.env', 'utf8');
  const env = parseEnv(envText);
  const requiredFirebaseKeys = [
    'VITE_FIREBASE_API_KEY',
    'VITE_FIREBASE_AUTH_DOMAIN',
    'VITE_FIREBASE_PROJECT_ID',
    'VITE_FIREBASE_STORAGE_BUCKET',
    'VITE_FIREBASE_MESSAGING_SENDER_ID',
    'VITE_FIREBASE_APP_ID',
  ];
  if (requiredFirebaseKeys.some((key) => !env[key])) {
    fail('production .env is missing one or more required Firebase values');
  }
  if (env.VITE_FIREBASE_PROJECT_ID !== PRODUCTION_PROJECT) {
    fail(`VITE_FIREBASE_PROJECT_ID must equal ${PRODUCTION_PROJECT}`);
  }
  if (env.VITE_FIREBASE_AUTH_DOMAIN !== `${PRODUCTION_PROJECT}.firebaseapp.com`) {
    fail('VITE_FIREBASE_AUTH_DOMAIN is not the production domain');
  }
  if (![`${PRODUCTION_PROJECT}.appspot.com`, `${PRODUCTION_PROJECT}.firebasestorage.app`]
    .includes(env.VITE_FIREBASE_STORAGE_BUCKET)) {
    fail('VITE_FIREBASE_STORAGE_BUCKET is not the production bucket');
  }
  if (env.VITE_USE_FIREBASE_EMULATORS === 'true') {
    fail('Firebase emulator mode must be disabled for a production build');
  }
  if (envText.includes(PREVIEW_PROJECT)) {
    fail('preview project token is present in .env');
  }

  const firebaseRc = JSON.parse(readFileSync('.firebaserc', 'utf8'));
  const staffSites = firebaseRc.targets?.[PRODUCTION_PROJECT]?.hosting?.staff;
  if (!Array.isArray(staffSites) || staffSites.length !== 1 || staffSites[0] !== PRODUCTION_PROJECT) {
    fail('the staff Hosting target does not resolve exactly to coffee-bond-pos');
  }

  const firebaseConfig = JSON.parse(readFileSync('firebase.json', 'utf8'));
  const hostingEntries = Array.isArray(firebaseConfig.hosting)
    ? firebaseConfig.hosting
    : [firebaseConfig.hosting].filter(Boolean);
  const staffHosting = hostingEntries.find((entry) => entry.target === 'staff');
  if (!staffHosting || staffHosting.public !== 'dist') {
    fail('firebase.json staff target must publish only dist');
  }

  console.log('PRODUCTION_ENV=PASS');
  console.log('PRODUCTION_PROJECT=coffee-bond-pos');
  console.log('PREVIEW_PROJECT_TOKEN_ABSENT=PASS');
  console.log('CLEAN_GIT_STATUS=PASS');
  console.log('EXACT_APPROVED_FILES_ONLY=PASS');

  run('npm', ['run', 'lint'], { inherit: true });
  console.log('TYPESCRIPT=PASS');

  run('npm', ['run', 'build:staff'], { inherit: true });
  if (!statSync('dist').isDirectory()) fail('staff build did not create dist');

  const bundleFiles = walkFiles('dist');
  const bundleBuffers = bundleFiles.map((filePath) => readFileSync(filePath));
  if (bundleBuffers.some((buffer) => buffer.includes(Buffer.from(PREVIEW_PROJECT)))) {
    fail('preview project token is present in the staff bundle');
  }
  if (!bundleBuffers.some((buffer) => buffer.includes(Buffer.from(PRODUCTION_PROJECT)))) {
    fail('production project token is absent from the staff bundle');
  }
  console.log('STAFF_PRODUCTION_BUILD=PASS');

  const statusAfter = run('git', ['status', '--porcelain=v1', '--untracked-files=all']).trim();
  if (statusAfter) fail('build changed tracked or untracked release files');

  console.log(`BASELINE_REF=${baselineRef}`);
  console.log(`RELEASE_HEAD=${run('git', ['rev-parse', 'HEAD']).trim()}`);
  console.log(`APPROVED_FILES=${JSON.stringify(approved)}`);
  console.log('STAFF_RELEASE_PREFLIGHT=PASS');
  console.log('DEPLOYED=NO');
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
