# November 25, 2026 production source snapshot

This directory contains the full Staff PWA build inputs corresponding to deployed Staff version 6adb2e7f34961c2c, plus the exact source-file trees for tableService revision tableservice-00005-gon and offlineCash revision offlinecash-00003-mop.

The application source files are copied without edits from the qualified November worktree. This is the complete build baseline, not only its 49-file delta. The originating worktree's Git HEAD was a historical Print Station commit; provenance.json identifies the actual uncommitted application source by individual and aggregate SHA-256 hashes.

## Coverage

- Staff: all 269 pinned build-input files, shared source modules, public icons, configuration, lockfiles and source tests.
- offlineCash: all 52 members of its deployed source package.
- tableService: all 36 members of its deployed source package.
- Optional managed Mac session clock: public source only. Private signing material and binary distributions are excluded.
- The other 57 reported deployed Functions are not mapped or certified by this snapshot. Shared modules in staff/functions do not establish a match to those deployed functions.
- Customer code included as a Staff source dependency is not certification of the separately deployed customer Hosting version.

## Verify source identity

From this snapshot directory:

~~~bash
python3 tools/verify-published-source.py
~~~

The verifier checks every copied source file, the ordered Staff build-input hash, the complete two-function member sets, and deterministic source ZIP hashes. It performs no network or production operation.

To regenerate the two source archives into the ignored artifacts/source-packages directory:

~~~bash
python3 tools/verify-published-source.py --package
~~~

## Build Staff

Use Node.js 22 and the committed staff/package-lock.json. The production-configured build helper reads only Firebase's public SDK configuration, checks its pinned digest, and builds locally:

~~~bash
cd staff
npm ci
cd ..
mkdir -p evidence release-qualification
node tools/build-general-staff.mjs candidate
~~~

The helper never deploys or writes production business data. Build output and local verification records are ignored by Git. It requires the public configuration to match the qualified release and will stop if that configuration changes. Dependency installation and a fresh build are not performed as part of preparing this source publication.

The original publication retained 3,112 historical immutable/static paths for existing clients, yielding 3,268 Hosting paths. Those compiled historical assets are intentionally not in this source snapshot. A fresh Staff build alone does not reproduce the complete Hosting publication. Do not use a generic Hosting deploy from this checkout to replace the retained production asset set.

## Tests and historical tooling

Original public source tests and release tooling are preserved. Some installed-browser and historical baseline comparisons reference the original machine's earlier source fixtures, browser installation or emulator dependencies. They are retained as qualification source; this publication does not claim that every historical harness runs on a new machine without its documented environment.

The portable verifier above checks the copied source and exact two-function packages independently. No historical test result is presented as a newly executed test.

## Runtime and activation boundary

Eligible ordinary browsers may save Cash during a prepared, authorized foreground outage session. A stock browser that loses trusted session continuity retains signed work but requires online preparation before new Cash. The separately qualified managed Mac clock provides the bounded restart-continuity path. The signing key is intentionally absent; generating another extension identity is not an authorized replacement for the deployed clock identity.

Store policies, staff permissions, device enrollment, credentials and production data are managed outside this source snapshot. Publication does not activate a store or enroll a device. Physical printing remains separately qualified.

## Historical records

provenance.json is the source lookup for this snapshot. The original pre-release notes are not used as the current deployment or activation state. See the repository-root CURRENT_PRODUCTION_SOURCE.md for the current source location.
