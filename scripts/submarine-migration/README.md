# Submarine preservation foundation

This directory is the offline/fixture-only Phase 1A boundary from the corrected
account-consolidation plan at plan commit `980036f`. It creates no persistent
Redis, user, service, LaunchDaemon, fixed listener, SRH/ngrok route, deployment,
or Supabase object. Upstash remains the unchanged source and rollback authority.

## Components and decisions

- `archive.mjs` implements `sd-archive-v1`: `SDARCV01`, a big-endian `u32`
  canonical-header length, canonical UTF-8 header authenticated as GCM AAD,
  ciphertext, then the 16-byte tag. AES-256-GCM keys are accepted only as
  exactly 32 bytes from an already-open descriptor and are wiped after the one
  permitted sealing attempt. The mode-`0600` partial is finalized and fsynced,
  then published with an atomic no-replace hard link and a parent-directory
  fsync. Ciphertext checksumming is streaming, including for native RDB-sized
  inputs. Errors before publication remove the owned partial. Errors after a
  final link retain the recoverable final and write a no-replace, fsynced
  `.aborted.json` marker.
- `upstash-readonly.mjs` has an injected transport and accepts only `SCAN`,
  `TYPE`, `GET`, `LRANGE 0 -1`, `SMEMBERS`, `HGETALL`, `ZRANGE 0 -1
  WITHSCORES`, and `PTTL`. The read-only token is header-only and responses use
  `Upstash-Encoding: base64`, following the
  [official REST contract](https://upstash.com/docs/redis/features/restapi).
  Production credentials can be sent only to HTTPS `*.upstash.io` endpoints;
  non-Upstash fixture endpoints require both an explicit fixture override and
  an injected transport.
- `manifest.mjs` uses reviewed concrete key specifications traced to every
  route-level family in `shared/productionRouteInventory.js`, including rewards,
  streaks, multi-colon rate-limit identities, PvP state, and every
  migration-control key. Unknown `sd:*` keys fail closed. Owned values remain
  strict canonical base64 in the encrypted manifest. Foreign keys contribute
  type/TTL metadata checksums only; foreign keys and values are excluded. The
  external manifest exposes counts and anonymized checksums only.
- `restore-verifier.mjs` is fixture-only. It starts an explicit Redis executable
  inside a mode-`0700` `/tmp/submarine-restore-*` directory with `port 0` and a
  private Unix socket, verifies `INFO server` reports the owned child PID,
  regenerates the manifest, compares durable records exactly and ephemeral TTLs
  at a common instant with bounded tolerance, terminates/kills the child, and
  removes the tree only after the process is proven reaped. It refuses root and
  fails closed on premature socket end or close.

Durable keys must be persistent and byte-stable across two observations.
Ephemeral keys retain observation times, PTTL evidence, and churn status; expiry
during capture is recorded as an explicit skip. Source A/B comparison permits
expected ephemeral value churn, while archive-to-restore verification requires
the exact archived value and type for every still-live ephemeral key plus a
bounded projected-TTL difference. Restore projects remaining TTL from capture
time, so elapsed time is never added back. A session or WebSocket ticket present
in the first observation but absent in the final observation is never archived
as a restorable record: encrypted evidence retains only the key checksum,
first-value checksum/PTTL/type, and final `exists:false`. Neither the raw key nor
its base64 encoding is retained. Restore hashes every key found by its complete
SCAN and requires no hash to match skipped evidence; the external report exposes
only the skipped count and aggregate checksum. Foreign disappearance or metadata
churn is recorded with checksums only and never causes a foreign value read.

The protected manifest requires exact login-index-to-user-record association for
both protected accounts, retains each original login spelling inside encrypted
evidence, and checks all user-associated records plus shared leaderboard
associations without exposing those identifiers in the external report. Shared
PvP room, match, and invite JSON records are linked only through reviewed user-ID
fields; exact collection-member links are included for reviewed PvP families.

## Operator boundary

The CLI exists so its authority can be reviewed, but it was not run against any
network or credential during Phase 1A. It requires `--readonly-token-fd` and
`--key-fd`; archive key material in argv or the recognized key environment
variables is rejected. Do not run it against production until the distributed
freeze gate, provider-native export preflight, explicit read credentials, two
approved encrypted failure domains, and operator authorization all pass.

Archive and redacted evidence use no-replace publication and dev/inode identity
checks as one recoverable pair. Node cannot atomically condition an unlink on
inode identity, so no published final is automatically deleted on a pair failure.
Instead, all finals are retained and a no-replace, fsynced
`.pair-aborted.json` marker blocks silent use and supports operator recovery.
This also prevents cleanup from deleting a same-UID competitor that swaps a
pathname after publication. The mode-`0700`, same-owner directory is the trust
boundary; another same-UID process can still disrupt publication, but identity
validation makes that disruption fail closed and deterministic swap stress tests
cover the recovery contract.

Upstash documents that some powerful reads can be restricted for read-only
tokens. A real capture therefore remains blocked until preflight proves that the
dedicated token can perform the required complete `SCAN`; a standard/write token
must not be substituted silently.

The archive layer accepts a streaming `native-rdb` input only when the bounded,
authenticated header carries both provider snapshot ID and snapshot version.
Provider acquisition is deliberately absent in Phase 1A, so live export remains
blocked on the approved preflight above.

No raw key, value, user identifier, credential, endpoint token, or plaintext
artifact path is written to stdout. The CLI output is the canonical redacted
manifest only.

## Fixture verification

```sh
npm run test:submarine-migration
```

The fixtures cover archive framing/decryption, tamper/truncation/wrong keys,
atomic competing sealers, native snapshot identity/header bounds, partial and
abort recovery, identity-swap stress, exact command grammar, hostname pinning,
canonical Upstash base64, duplicate SCAN
results, durable stability, ephemeral churn/TTL projection, concrete key-family
coverage, unknown families, binary and empty values across every Redis type,
strict recursive base64, deterministic reorder equality, protected
omission/mutation and shared-PvP association, foreign expiry/value exclusion,
revoked session/WebSocket non-resurrection, redaction, child-exit races, forced
cleanup, premature socket close, and owned private-socket restore.
