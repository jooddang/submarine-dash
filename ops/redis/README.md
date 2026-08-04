# Submarine Dash Redis host foundation

This directory defines the additive Phase 1A host boundary. It has not been
installed. Submarine Dash gets one dedicated process on `127.0.0.1:6691` under
the `_submarine` user and group. Homebrew Redis `6379`, Torrence `6688`,
X-to-Notion `6690`, shared SRH `8079`, ngrok, and both existing applications are
preserved as listener/PID invariants and are never restarted by this installer.

## Ownership and persistence

- Root-private credentials, the preserved SRH token, and committed backup
  generations: `/Library/Application Support/SubmarineDash` (`0700`; files
  `0600`). Reinstall reuses these exact values and fails closed if malformed.
- Redis config and ACL: `/Library/Application Support/SubmarineDashRedis`,
  `root:_submarine:0750`; config and ACL are `root:_submarine:0640`.
- Redis data and service logs: `_submarine:_submarine:0750` beneath that tree.
- Root maintenance logs: `/Library/Logs/SubmarineDashRedis`, `root:wheel:0700`.
- Redis binds only loopback, uses one database, `noeviction`, AOF with
  `appendfsync always`, and periodic RDB generations. The default ACL user is
  disabled. App and SRH users are restricted to `sd:*` and
  `submarine-dash:*`; backup has only `PING`, `INFO`, `LASTSAVE`, and `BGSAVE`.

The runtime builder authenticates the reviewed Redis 8.8.0/OpenSSL input bytes,
copies them into Submarine's own root-owned content-addressed runtime, rewrites
Mach-O dependencies to relative immutable libraries, ad-hoc signs the result,
and normalizes runtime directories to traversable read/execute modes. This
specifically prevents the prior restrictive-umask/implicit-`0700` exit-126
failure. `umask 0077` is not process-global; secret modes are assigned only at
the file descriptors that create them.

## Shared route compatibility

The installer accepts only the reviewed current Torrence registry digest. It
retains those exact bytes as `torrence-route-registry.pre-submarine` and
atomically installs a compatibility shim at the canonical helper path. The shim
extends both the default port set and the cutover invariant to the three
reviewed routes. Therefore already-installed publishers and future Torrence/X
candidate regeneration preserve all three fragments. Snapshot, publication,
authenticated verification, and rollback hold the helper's canonical
root-owned mutation lock as one transaction. Publication passes the actual
`_torrence` active-file group, publishes only `submarine-dash.json`, and does
not restart SRH or ngrok.

The SRH token is durably stored before route publication and is included in
installation rollback. Existing credentials/tokens are never silently rotated.
The installer snapshots the shared helper, Submarine fragment, candidate,
active and last-known-good registries, every Submarine-managed file, runtime
pointer, exact directory metadata, first-install roots, complete separate
user/group records, and exact Submarine LaunchDaemon state. Deterministic
installer after-images are authorized in the durable journal before each shared
write; a digest CAS refuses to overwrite registry files changed by another
publisher after a crash. A normal
failure first proves that only Submarine jobs were booted out and port 6691 is
closed, then restores that exact state.
The durable transaction remains if quiescence or restoration fails. An interrupted install is
represented by the root-private transaction boundary and must be recovered by
rerunning the same pinned bootstrap; checkout workers are not operator entry
points.

## Backups and verification

`submarine-redis-host backup` performs authenticated `BGSAVE`, copies the RDB
into a private generation, fsyncs data and manifest, and launches a disposable
loopback Redis from that RDB. Only a successful disposable restore receives the
final `COMMITTED` marker. Interrupted or checksum-divergent generations are
ineligible for doctor/restore. `restore-disposable` never replaces live data.

`submarine-redis-host doctor` validates exact parsed configuration/ACLs and
credential hashes, LaunchDaemon state, service UID, content-addressed executable
and command, authenticated backup-user `PING`, the exact three-route registry,
and authenticated health at every Redis backend and through SRH `8079` using
every registry token. After a separately approved
install, the public proof must use `verify-public-auth` against the exact origin
and path in root-owned `public-ingress.json` (mode `0600`). Redirects, queries,
fragments, and cross-origin responses fail closed. Success
is the SRH JSON `400/401/403` missing/invalid Authorization response. HTTP 200,
HTML, an ngrok Cloud Endpoint page, a non-ngrok public host, or Redis TCP output
fails.

## Operator boundary

Never run `submarine_redis_host.py`, a checkout shell script, or the installer
directly with `sudo`. The only production entrypoint is the reviewed inline
SHA-256 loader for `secure-install-bootstrap.py`. Its literal digest is updated
only after tests and review; the bootstrap then verifies every dependent byte,
copies a root-owned content-addressed bundle, and executes that protected copy
in an empty environment. A stale dependent hash fails before any host mutation.

No command in this document was executed as part of Phase 1A code preparation.
Before live approval, the authoritative X and Torrence worktrees must be clean
and their helper bytes must match the pinned digest. They were observed
dirty/uncommitted during this code-only phase and were intentionally not edited;
this is a hard pre-live prerequisite, not an installer side effect.
The eventual approved command must use this form with the reviewed digest:

```sh
sudo /usr/bin/env -i HOME=/var/empty PATH=/usr/bin:/bin:/usr/sbin:/sbin \
  /usr/bin/python3 -I -c 'import hashlib,os,sys;p="/Users/jooddang/dev/submarine-dash-wt-auth-consolidation/ops/redis/secure-install-bootstrap.py";f=os.fdopen(os.open(p,os.O_RDONLY|os.O_NOFOLLOW),"rb");b=f.read();f.close();h="cfbb7769cffebb1d40ac9002a5be9b952ba3b66c575fae1780ce85b84ca0cb0b";exec(compile(b,p,"exec"),{"__name__":"__main__","__file__":p}) if hashlib.sha256(b).hexdigest()==h else sys.exit("Submarine installer bootstrap digest mismatch")'
```

Local deterministic contracts run without root and never inspect live secrets:

```sh
npm run test:redis-host
```
