# Current production source

The authoritative source snapshot for the November 25, 2026 Staff release is [releases/general-pwa-offline-20261125](releases/general-pwa-offline-20261125/README.md).

| Deployed surface | Identity | Source |
| --- | --- | --- |
| Staff Hosting | 6adb2e7f34961c2c | releases/general-pwa-offline-20261125/staff |
| tableService | tableservice-00005-gon | releases/general-pwa-offline-20261125/backend/tableService |
| offlineCash | offlinecash-00003-mop | releases/general-pwa-offline-20261125/backend/offlineCash |

The repository's pre-existing root application files originate from the July baseline. Use the November snapshot above for this deployed release. This additive publication preserves the historical files and does not deploy, merge main, activate stores, enroll devices, alter payments or modify production configuration.

The snapshot includes all pinned Staff build inputs and exact members of the two named deployed function source packages. It does not map or certify the other 57 reported deployed Functions. Its provenance manifest records file hashes, source-package hashes and verification boundaries. Compiled historical Hosting assets, credentials, private signing material and production evidence/data are excluded.

See the snapshot README for verified source lookup, local build instructions and the distinction between source reproduction and the full retained Hosting asset publication.
