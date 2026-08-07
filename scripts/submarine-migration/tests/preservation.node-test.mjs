import assert from 'node:assert/strict';
import { chmodSync, closeSync, existsSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:net';
import { openArchive, openArchiveFromFds, sealArchive } from '../archive.mjs';
import { canonicalJson, sha256 } from '../canonical.mjs';
import { captureManifest, scanRawKeys } from '../capture.mjs';
import { buildManifest, classifyKey, compareManifestSnapshots, redactedManifest, verifyProtectedInvariants } from '../manifest.mjs';
import { parseArguments, runCapture } from '../cli.mjs';
import { assertUnprivileged, cleanupOwnedRestore, redisCommand, stopOwnedProcess, verifyLogicalRestore } from '../restore-verifier.mjs';
import { ReadOnlyUpstashClient, validateReadCommand } from '../upstash-readonly.mjs';
import { SUBMARINE_PRESERVATION_KEY_SPECS } from '../../../shared/productionRouteInventory.js';

const CAPTURE = Object.freeze({ capturedAt: '2026-08-06T00:00:00.000Z', sourceDatabaseId: 'fixture-database', captureId: 'fixture-capture', applicationCommit: 'f23f2ed000000000000000000000000000000000' });

function string(value) { return { type: 'string', value: Buffer.from(value), pttl: -1 }; }

function fixtureEntries() {
  return new Map([
    ['sd:loginId:jooddang', string('user-a')],
    ['sd:loginId:oceanlord', string('user-b')],
    ['sd:user:user-a', string(JSON.stringify({ userId: 'user-a', loginId: 'JoodDang' }))],
    ['sd:user:user-b', string(JSON.stringify({ userId: 'user-b', loginId: 'OceanLord' }))],
    ['sd:user:user-a:coins', string(Buffer.from([0, 255, 1, 2]))],
    ['sd:inbox:user-a', { type: 'list', value: [Buffer.alloc(0), Buffer.from('duplicate'), Buffer.from('duplicate')], pttl: -1 }],
    ['sd:user:user-a:skins:owned', { type: 'set', value: [Buffer.alloc(0), Buffer.from('skin-blue'), Buffer.from([255])], pttl: -1 }],
    ['sd:user:user-a:achievements', { type: 'hash', value: [Buffer.alloc(0), Buffer.from('empty-field'), Buffer.from('binary'), Buffer.from([0, 255])], pttl: -1 }],
    ['sd:pvp:user-invites:user-b', { type: 'zset', value: [Buffer.from('member-b'), Buffer.from('1.23'), Buffer.alloc(0), Buffer.from('0')], pttl: -1 }],
    ['submarine-dash:leaderboards:weekly:v1', string(JSON.stringify({ weeks: {
      '2026-W01': { entries: [
        { userId: 'JoodDang', score: 100, name: 'first' },
        { userId: 'OceanLord', score: 200, name: 'second' },
        { userId: 'JoodDang', score: 100, name: 'duplicate retained' },
      ] },
    } }))],
  ]);
}

class FixtureRedis {
  constructor(entries = fixtureEntries(), pages) {
    this.entries = entries;
    const keys = [...entries.keys()].map(Buffer.from);
    this.pages = pages || [[Buffer.from('1'), [...keys.slice(0, 5), keys[0]]], [Buffer.from('0'), keys.slice(5)]];
    this.scanIndex = 0;
  }
  async execute(command) {
    const name = String(command[0]).toUpperCase();
    if (name === 'SCAN') return this.pages[this.scanIndex++];
    const key = Buffer.from(command[1]).toString();
    const entry = this.entries.get(key);
    if (name === 'TYPE') return Buffer.from(entry?.type || 'none');
    if (name === 'PTTL') return entry ? entry.pttl : -2;
    return structuredClone(entry.value);
  }
}

function keyFile(directory, bytes = Buffer.alloc(32, 7)) {
  const path = join(directory, `key-${Math.random()}`);
  writeFileSync(path, bytes, { mode: 0o600 });
  return openSync(path, 'r');
}

test('sd-archive-v1 seals exact framing and decrypts losslessly', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sd-archive-test-'));
  const output = join(directory, 'capture.sealed');
  const plaintext = Buffer.concat([Buffer.from('binary\0'), Buffer.from([0, 255, 128])]);
  const keyFd = keyFile(directory);
  await sealArchive({
    outputPath: output, keyFd, plaintext,
    header: { keyId: 'fixture-key', captureId: 'capture-1', artifactKind: 'logical-redis', sourceDatabaseId: 'fixture-db', createdAt: CAPTURE.capturedAt },
  });
  closeSync(keyFd);
  const envelope = readFileSync(output);
  assert.equal(envelope.subarray(0, 8).toString(), 'SDARCV01');
  const headerLength = envelope.readUInt32BE(8);
  const headerText = envelope.subarray(12, 12 + headerLength).toString();
  assert.equal(canonicalJson(JSON.parse(headerText)), headerText);
  assert.equal(statSync(output).mode & 0o777, 0o600);
  assert.equal(existsSync(`${output}.partial`), false);
  const decryptFd = keyFile(directory);
  assert.deepEqual(openArchive({ archivePath: output, keyFd: decryptFd }).plaintext, plaintext);
  closeSync(decryptFd);
});

test('quarantine archive input is authenticated through already-open FDs', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sd-archive-fd-test-'));
  chmodSync(directory, 0o700);
  const output = join(directory, 'capture.sealed');
  const keyPath = join(directory, 'key.bin');
  writeFileSync(keyPath, Buffer.alloc(32, 17), { mode: 0o600 });
  let keyFd = openSync(keyPath, 'r');
  try {
    await sealArchive({
      keyFd, outputPath: output, plaintext: Buffer.from('{"fixture":true}'),
      header: { artifactKind: 'logical-redis', captureId: 'fd-capture', createdAt: '2026-08-07T00:00:00.000Z', keyId: 'fd-key', sourceDatabaseId: 'fixture-source' },
    });
  } finally { closeSync(keyFd); }
  const archiveFd = openSync(output, 'r');
  keyFd = openSync(keyPath, 'r');
  try {
    const opened = openArchiveFromFds({ archiveFd, keyFd });
    assert.equal(opened.plaintext.toString(), '{"fixture":true}');
    assert.match(opened.archiveSha256, /^[a-f0-9]{64}$/);
  } finally {
    closeSync(archiveFd); closeSync(keyFd); rmSync(directory, { recursive: true, force: true });
  }
});

test('archive rejects tamper, truncation, wrong key, and non-32-byte key', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sd-archive-failure-'));
  const output = join(directory, 'capture.sealed');
  const keyFd = keyFile(directory);
  await sealArchive({ outputPath: output, keyFd, plaintext: Buffer.from('secret fixture'), header: { keyId: 'k', captureId: 'c', artifactKind: 'logical-redis', sourceDatabaseId: 'db', createdAt: CAPTURE.capturedAt } });
  closeSync(keyFd);
  const original = readFileSync(output);
  const tampered = Buffer.from(original); tampered[tampered.length - 17] ^= 1;
  writeFileSync(join(directory, 'tampered.sealed'), tampered, { mode: 0o600 });
  const tamperFd = keyFile(directory);
  assert.throws(() => openArchive({ archivePath: join(directory, 'tampered.sealed'), keyFd: tamperFd })); closeSync(tamperFd);
  writeFileSync(join(directory, 'truncated.sealed'), original.subarray(0, 20), { mode: 0o600 });
  const truncateFd = keyFile(directory);
  assert.throws(() => openArchive({ archivePath: join(directory, 'truncated.sealed'), keyFd: truncateFd })); closeSync(truncateFd);
  const wrongFd = keyFile(directory, Buffer.alloc(32, 9));
  assert.throws(() => openArchive({ archivePath: output, keyFd: wrongFd })); closeSync(wrongFd);
  for (const length of [0, 31, 33]) {
    const invalidFd = keyFile(directory, Buffer.alloc(length, 1));
    assert.throws(() => openArchive({ archivePath: output, keyFd: invalidFd }), /exactly 32 bytes/); closeSync(invalidFd);
  }
});

test('archive removes and fsyncs partial when plaintext streaming fails', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sd-archive-partial-'));
  const output = join(directory, 'capture.sealed');
  async function *broken() { yield Buffer.from('prefix'); throw new Error('injected stream failure'); }
  const keyFd = keyFile(directory);
  await assert.rejects(sealArchive({ outputPath: output, keyFd, plaintext: broken(), header: { keyId: 'k', captureId: 'c', artifactKind: 'logical-redis', sourceDatabaseId: 'db', createdAt: CAPTURE.capturedAt } }), /injected/);
  closeSync(keyFd);
  assert.equal(existsSync(output), false);
  assert.equal(existsSync(`${output}.partial`), false);
});

test('archive retains recoverable finals with abort markers after post-link failure and preserves replacements', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sd-archive-postlink-'));
  const header = { keyId: 'k', captureId: 'c', artifactKind: 'logical-redis', sourceDatabaseId: 'db', createdAt: CAPTURE.capturedAt };
  for (const hookName of ['afterLink', 'afterPartialUnlink', 'afterParentFsync', 'afterChecksum']) {
    const output = join(directory, `${hookName}.sealed`);
    const keyFd = keyFile(directory);
    await assert.rejects(sealArchive({ outputPath: output, keyFd, plaintext: Buffer.from('fixture'), header,
      hooks: { [hookName]: () => { throw new Error(`injected ${hookName}`); } } }), new RegExp(hookName));
    closeSync(keyFd);
    assert.equal(existsSync(output), true);
    assert.equal(JSON.parse(readFileSync(`${output}.aborted.json`, 'utf8')).publicationState, 'aborted-final-retained');
    assert.equal(existsSync(`${output}.partial`), false);
  }
  const swapped = join(directory, 'swapped.sealed');
  const replacement = join(directory, 'replacement'); writeFileSync(replacement, 'competitor', { mode: 0o600 });
  const swapKeyFd = keyFile(directory);
  await assert.rejects(sealArchive({ outputPath: swapped, keyFd: swapKeyFd, plaintext: Buffer.from('fixture'), header,
    hooks: { afterLink: () => renameSync(replacement, swapped) } }), /ownership changed/);
  closeSync(swapKeyFd);
  assert.equal(readFileSync(swapped, 'utf8'), 'competitor');
  assert.equal(existsSync(`${swapped}.aborted.json`), true);
  assert.equal(existsSync(`${swapped}.partial`), false);
  const partialSwapped = join(directory, 'partial-swapped.sealed');
  const partialReplacement = join(directory, 'partial-replacement'); writeFileSync(partialReplacement, 'competitor partial', { mode: 0o600 });
  const partialSwapKeyFd = keyFile(directory);
  await assert.rejects(sealArchive({ outputPath: partialSwapped, keyFd: partialSwapKeyFd, plaintext: Buffer.from('fixture'), header,
    hooks: { afterLink: ({ partialPath }) => renameSync(partialReplacement, partialPath) } }), /partial ownership changed/);
  closeSync(partialSwapKeyFd);
  assert.equal(existsSync(partialSwapped), true);
  assert.equal(readFileSync(`${partialSwapped}.partial`, 'utf8'), 'competitor partial');
  assert.equal(existsSync(`${partialSwapped}.aborted.json`), true);
  for (let index = 0; index < 12; index += 1) {
    const stressed = join(directory, `swap-stress-${index}.sealed`);
    const stressedReplacement = join(directory, `swap-stress-replacement-${index}`);
    writeFileSync(stressedReplacement, `competitor-${index}`, { mode: 0o600 });
    const stressedKeyFd = keyFile(directory);
    await assert.rejects(sealArchive({ outputPath: stressed, keyFd: stressedKeyFd, plaintext: Buffer.from('fixture'), header,
      hooks: { afterLink: () => renameSync(stressedReplacement, stressed) } }), /ownership changed/);
    closeSync(stressedKeyFd);
    assert.equal(readFileSync(stressed, 'utf8'), `competitor-${index}`);
  }
});

test('archive publication is atomic no-replace under competing sealers', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sd-archive-race-'));
  const output = join(directory, 'capture.sealed');
  const firstFd = keyFile(directory); const secondFd = keyFile(directory);
  const header = { keyId: 'k', captureId: 'c', artifactKind: 'logical-redis', sourceDatabaseId: 'db', createdAt: CAPTURE.capturedAt };
  const results = await Promise.allSettled([
    sealArchive({ outputPath: output, keyFd: firstFd, plaintext: Buffer.from('first'), header }),
    sealArchive({ outputPath: output, keyFd: secondFd, plaintext: Buffer.from('second'), header }),
  ]);
  closeSync(firstFd); closeSync(secondFd);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.equal(existsSync(`${output}.partial`), false);
});

test('native RDB archive header requires and preserves provider snapshot identity', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sd-native-header-'));
  const output = join(directory, 'native.sealed');
  const keyFd = keyFile(directory);
  await sealArchive({ outputPath: output, keyFd, plaintext: Buffer.from('fixture-rdb'), header: {
    keyId: 'k', captureId: 'c', artifactKind: 'native-rdb', sourceDatabaseId: 'db', createdAt: CAPTURE.capturedAt,
    providerSnapshotId: 'snapshot-123', providerSnapshotVersion: 'provider-v1',
  } });
  closeSync(keyFd);
  const openFd = keyFile(directory);
  const opened = openArchive({ archivePath: output, keyFd: openFd }); closeSync(openFd);
  assert.equal(opened.header.providerSnapshotId, 'snapshot-123');
  assert.equal(opened.header.providerSnapshotVersion, 'provider-v1');
  const missingFd = keyFile(directory);
  await assert.rejects(sealArchive({ outputPath: join(directory, 'invalid.sealed'), keyFd: missingFd, plaintext: Buffer.from('x'), header: {
    keyId: 'k', captureId: 'c', artifactKind: 'native-rdb', sourceDatabaseId: 'db', createdAt: CAPTURE.capturedAt,
  } }), /provider snapshot/); closeSync(missingFd);
  const malformedFd = keyFile(directory);
  await assert.rejects(sealArchive({ outputPath: join(directory, 'malformed.sealed'), keyFd: malformedFd, plaintext: Buffer.from('x'), header: {
    keyId: 'k', captureId: 'c', artifactKind: 'native-rdb', sourceDatabaseId: 'db', createdAt: CAPTURE.capturedAt,
    providerSnapshotId: 'snapshot with spaces', providerSnapshotVersion: 'v1',
  } }), /provider snapshot/); closeSync(malformedFd);
  const oversizedFd = keyFile(directory);
  await assert.rejects(sealArchive({ outputPath: join(directory, 'oversized.sealed'), keyFd: oversizedFd, plaintext: Buffer.from('x'), header: {
    keyId: 'k', captureId: 'x'.repeat(70_000), artifactKind: 'logical-redis', sourceDatabaseId: 'db', createdAt: CAPTURE.capturedAt,
  } }), /header is too large/); closeSync(oversizedFd);
});

test('read-only client enforces exact grammar, base64, and header-only credentials', async () => {
  for (const command of [['MGET', 'a'], ['SET', 'a', 'b'], ['EVAL', 'return 1', 0], ['LRANGE', 'a', 0, 2], ['ZRANGE', 'a', 0, -1]]) {
    assert.throws(() => validateReadCommand(command), /forbidden/);
  }
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ result: Buffer.from([0, 255]).toString('base64') }) };
  };
  const client = new ReadOnlyUpstashClient({ endpoint: 'https://fixture.upstash.io', readOnlyToken: 'readonly-fixture-token', fetchImpl });
  assert.deepEqual(await client.execute(['GET', Buffer.from([0, 255])]), Buffer.from([0, 255]));
  assert.match(calls[0].url, /%00%FF$/);
  assert.equal(calls[0].url.includes('readonly-fixture-token'), false);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer readonly-fixture-token');
  assert.equal(calls[0].options.headers['Upstash-Encoding'], 'base64');
  assert.equal(calls[0].options.redirect, 'error');
  const invalid = new ReadOnlyUpstashClient({
    endpoint: 'https://fixture.upstash.io', readOnlyToken: 'readonly-fixture-token',
    fetchImpl: async () => ({ ok: true, json: async () => ({ result: 'A===' }) }),
  });
  await assert.rejects(invalid.execute(['GET', 'key']), /base64/);
  assert.throws(() => new ReadOnlyUpstashClient({ endpoint: 'https://attacker.example', readOnlyToken: 'readonly-fixture-token', fetchImpl }), /invalid Upstash/);
  assert.throws(() => new ReadOnlyUpstashClient({ endpoint: 'https://upstash.io.attacker.example', readOnlyToken: 'readonly-fixture-token', fetchImpl }), /invalid Upstash/);
  const fixtureClient = new ReadOnlyUpstashClient({ endpoint: 'http://127.0.0.1:9999', readOnlyToken: 'readonly-fixture-token', fetchImpl, allowFixtureEndpoint: true });
  assert.ok(fixtureClient);
});

test('capture deduplicates raw SCAN keys and canonicalizes every Redis type', async () => {
  const manifest = await captureManifest({ client: new FixtureRedis(), ...CAPTURE });
  assert.equal(manifest.records.length, fixtureEntries().size);
  assert.deepEqual(new Set(manifest.records.map((record) => record.type)), new Set(['string', 'list', 'set', 'hash', 'zset']));
  const list = manifest.records.find((record) => record.type === 'list');
  assert.equal(list.value.items[0], '');
  assert.equal(list.value.items[1], list.value.items[2]);
  const hash = manifest.records.find((record) => record.type === 'hash');
  assert.equal(hash.value.pairs.some((pair) => pair.field === ''), true);
  const zset = manifest.records.find((record) => record.type === 'zset');
  assert.deepEqual(zset.value.pairs.map((pair) => Buffer.from(pair.score, 'base64').toString()), ['0', '1.23']);
  assert.equal(manifest.protectedAccounts.jooddang.originalLoginId, 'JoodDang');
  assert.equal(manifest.protectedAccounts.oceanlord.originalLoginId, 'OceanLord');
  assert.equal(manifest.protectedAccounts.jooddang.leaderboardAssociationCount, 2);
});

test('reviewed classifier covers concrete builders, rewards, streak, IPv6 rate limits, and every control key', () => {
  const concrete = [
    ['sd:reward:weeklyWinnerDolphin:claimed:user-1', 'weekly-reward-claim'],
    ['sd:reward:dolphin:grant:user-1', 'legacy-dolphin-grant'],
    ['sd:user:user-1:reward:dolphin:streak:lastAwarded', 'dolphin-streak-award'],
    ['sd:rl:login:2001:db8::1:oceanlord', 'rate-limit'],
    ['sd:pvp:lobby:online', 'pvp-lobby-index'],
    ['sd:loginId:captain:red', 'login-index'],
    ...['gate', 'epoch', 'fence', 'leases', 'expired-leases', 'hard-failure', 'hard-failure-at', 'closed-at', 'max-lease-ttl-ms', 'mutation-count', 'reconciliations']
      .map((suffix) => [`sd:migration:control:${suffix}`, `migration-control-${suffix}`]),
    ['sd:migration:control:lease:request-1', 'migration-control-lease'],
  ];
  for (const [key, family] of concrete) assert.equal(classifyKey(Buffer.from(key)).family, family, key);
  assert.equal(classifyKey(Buffer.from('sd:user:user-1:unreviewed')).classification, 'unknown');
  assert.equal(classifyKey(Buffer.from('sd:pvp:lobby:online')).ttl, 'ephemeral');
  for (const specification of SUBMARINE_PRESERVATION_KEY_SPECS) {
    for (const source of specification.sources) assert.equal(existsSync(join(process.cwd(), source)), true, `${specification.id}: ${source}`);
  }
});

test('manifest checksum is deterministic across SCAN and collection reorder', async () => {
  const entries = fixtureEntries();
  const keys = [...entries.keys()].reverse().map(Buffer.from);
  const reordered = new FixtureRedis(entries, [[Buffer.from('0'), keys]]);
  const clock = () => Date.parse(CAPTURE.capturedAt);
  const first = await captureManifest({ client: new FixtureRedis(entries), ...CAPTURE, clock });
  const second = await captureManifest({ client: reordered, ...CAPTURE, clock });
  assert.equal(first.manifestChecksum, second.manifestChecksum);
  assert.equal(canonicalJson(first), canonicalJson(second));
});

test('unknown Submarine key blocks capture and duplicate SCAN is harmless', async () => {
  const duplicateClient = new FixtureRedis();
  const scanned = await scanRawKeys(duplicateClient);
  assert.equal(scanned.length, fixtureEntries().size);
  const entries = fixtureEntries(); entries.set('sd:unclassified-secret-family', string('blocked'));
  await assert.rejects(captureManifest({ client: new FixtureRedis(entries), ...CAPTURE }), /unknown/);
  assert.deepEqual(classifyKey(Buffer.from('foreign:key')), { classification: 'foreign', family: null });
});

test('capture aborts when a key changes between type-aware observations', async () => {
  const client = new FixtureRedis();
  const original = client.execute.bind(client);
  let coinReads = 0;
  client.execute = async (command) => {
    if (String(command[0]).toUpperCase() === 'GET' && Buffer.from(command[1]).toString() === 'sd:user:user-a:coins') {
      coinReads += 1;
      return coinReads === 1 ? Buffer.from('before') : Buffer.from('after');
    }
    return original(command);
  };
  await assert.rejects(captureManifest({ client, ...CAPTURE }), /changed during read-only capture/);
});

test('ephemeral churn is reported and A/B comparison projects TTL with expiry tolerance', async () => {
  const firstEntries = fixtureEntries();
  firstEntries.set('sd:session:fixture-session', { type: 'string', value: Buffer.from('first'), pttl: 10_000 });
  firstEntries.set('sd:pvp:lobby:online', { type: 'set', value: [Buffer.from('user-a')], pttl: -1 });
  const firstClient = new FixtureRedis(firstEntries);
  let sessionReads = 0;
  const original = firstClient.execute.bind(firstClient);
  firstClient.execute = async (command) => {
    if (String(command[0]).toUpperCase() === 'GET' && Buffer.from(command[1]).toString() === 'sd:session:fixture-session') return Buffer.from(++sessionReads === 1 ? 'first' : 'changed');
    return original(command);
  };
  const first = await captureManifest({ client: firstClient, ...CAPTURE, clock: () => Date.parse(CAPTURE.capturedAt) });
  assert.equal(first.records.find((record) => record.family === 'session').churned, true);
  assert.equal(first.records.find((record) => record.family === 'pvp-lobby-index').ttlClassification, 'ephemeral');
  const secondEntries = fixtureEntries();
  secondEntries.set('sd:session:fixture-session', { type: 'string', value: Buffer.from('different'), pttl: 9_000 });
  secondEntries.set('sd:pvp:lobby:online', { type: 'set', value: [Buffer.from('user-b')], pttl: -1 });
  const later = new Date(Date.parse(CAPTURE.capturedAt) + 1_000).toISOString();
  const second = await captureManifest({ client: new FixtureRedis(secondEntries), ...CAPTURE, capturedAt: later, clock: () => Date.parse(later) });
  const comparison = compareManifestSnapshots(first, second, { commonSnapshotAt: later, ttlToleranceMs: 5 });
  assert.equal(comparison.equal, true);
  assert.equal(comparison.ephemeral.mismatches, 0);
  const secondForRestore = structuredClone(second);
  secondForRestore.records.find((record) => record.family === 'pvp-lobby-index').value = structuredClone(first.records.find((record) => record.family === 'pvp-lobby-index').value);
  const restoreComparison = compareManifestSnapshots(first, secondForRestore, { commonSnapshotAt: later, ttlToleranceMs: 5, ephemeralValuePolicy: 'exact-live' });
  assert.equal(restoreComparison.equal, false);
  assert.equal(restoreComparison.ephemeral.mismatches, 1);
});

test('revoked session and ws ticket become checksum-only absence evidence and cannot be restored', async (context) => {
  const entries = fixtureEntries();
  const revokedKeys = ['sd:session:session-credential-secret', 'sd:pvp:ws-ticket:ws-ticket-credential-secret'];
  entries.set(revokedKeys[0], { type: 'string', value: Buffer.from('session-payload'), pttl: 30_000 });
  entries.set(revokedKeys[1], { type: 'string', value: Buffer.from('ws-ticket-payload'), pttl: 30_000 });
  const disappearing = new FixtureRedis(entries);
  const original = disappearing.execute.bind(disappearing);
  const typeReads = new Map();
  disappearing.execute = async (command) => {
    const name = String(command[0]).toUpperCase();
    const key = command[1] === undefined ? '' : Buffer.from(command[1]).toString();
    if (name === 'TYPE' && revokedKeys.includes(key)) {
      const count = (typeReads.get(key) || 0) + 1; typeReads.set(key, count);
      if (count === 2) return Buffer.from('none');
    }
    return original(command);
  };
  const revoked = await captureManifest({ client: disappearing, ...CAPTURE, clock: () => Date.parse(CAPTURE.capturedAt) });
  assert.equal(revoked.records.some((record) => ['session', 'pvp-ws-ticket'].includes(record.family)), false);
  assert.equal(revoked.skippedEphemeral.length, 2);
  assert.equal(revoked.skippedEphemeral.every((entry) => entry.reason === 'absent-at-final-observation' && entry.observations[1].exists === false), true);
  const serialized = canonicalJson(revoked);
  for (const key of revokedKeys) {
    assert.equal(serialized.includes(key), false);
    assert.equal(serialized.includes(Buffer.from(key).toString('base64')), false);
    assert.equal(serialized.includes(key.split(':').at(-1)), false);
  }

  const absent = await captureManifest({ client: new FixtureRedis(), ...CAPTURE, clock: () => Date.parse(CAPTURE.capturedAt) });
  const absentComparison = compareManifestSnapshots(revoked, absent, { commonSnapshotAt: CAPTURE.capturedAt, ephemeralValuePolicy: 'exact-live' });
  assert.equal(absentComparison.equal, true);
  assert.equal(absentComparison.ephemeral.requiredAbsenceCount, 2);
  assert.equal(absentComparison.ephemeral.requiredAbsenceMismatches, 0);

  const resurrected = await captureManifest({ client: new FixtureRedis(entries), ...CAPTURE, clock: () => Date.parse(CAPTURE.capturedAt) });
  for (const key of revokedKeys) {
    assert.equal(revoked.skippedEphemeral.some((entry) => entry.keyChecksum === sha256(Buffer.from(key))), true);
    assert.equal(resurrected.records.some((record) => sha256(Buffer.from(record.key, 'base64')) === sha256(Buffer.from(key))), true);
  }
  const resurrectedComparison = compareManifestSnapshots(revoked, resurrected, { commonSnapshotAt: CAPTURE.capturedAt, ephemeralValuePolicy: 'exact-live' });
  assert.equal(resurrectedComparison.equal, false);
  assert.equal(resurrectedComparison.ephemeral.requiredAbsenceMismatches, 2);

  const redisServerPath = '/opt/homebrew/bin/redis-server';
  if (existsSync(redisServerPath) && process.geteuid() !== 0) {
    const restored = await verifyLogicalRestore({ manifest: revoked, redisServerPath });
    assert.equal(restored.comparison.equal, true);
    assert.equal(restored.comparison.ephemeral.requiredAbsenceMismatches, 0);
  } else context.diagnostic('local Redis unavailable or root; comparator-only absence verification completed');
});

test('protected checksums include explicit shared PVP value associations for both accounts', async () => {
  const linkedEntries = fixtureEntries();
  linkedEntries.set('sd:pvp:room:shared-room', string(JSON.stringify({ ownerUserId: 'user-a', slots: { host: { userId: 'user-a' }, guest: { userId: 'user-b' } } })));
  linkedEntries.set('sd:pvp:match:shared-match', string(JSON.stringify({ players: { host: { userId: 'user-a' }, guest: { userId: 'user-b' } } })));
  const baseline = await captureManifest({ client: new FixtureRedis(linkedEntries), ...CAPTURE });
  const mutatedEntries = new Map(linkedEntries);
  mutatedEntries.set('sd:pvp:room:shared-room', string(JSON.stringify({ ownerUserId: 'changed', slots: { host: { userId: 'changed' }, guest: { userId: 'user-b' } } })));
  const mutated = await captureManifest({ client: new FixtureRedis(mutatedEntries), ...CAPTURE });
  assert.throws(() => verifyProtectedInvariants(mutated, baseline.protectedAccounts), /jooddang/);

  const addedEntries = new Map(linkedEntries);
  addedEntries.set('sd:pvp:invite:shared-invite', string(JSON.stringify({ fromUserId: 'user-a', toUserId: 'user-b', status: 'PENDING' })));
  const added = await captureManifest({ client: new FixtureRedis(addedEntries), ...CAPTURE });
  assert.notEqual(added.protectedAccounts.jooddang.associatedRecordsChecksum, baseline.protectedAccounts.jooddang.associatedRecordsChecksum);
  assert.notEqual(added.protectedAccounts.oceanlord.associatedRecordsChecksum, baseline.protectedAccounts.oceanlord.associatedRecordsChecksum);
  assert.throws(() => verifyProtectedInvariants(added, { ...baseline.protectedAccounts, jooddang: added.protectedAccounts.jooddang }), /oceanlord/);
  const redacted = canonicalJson(redactedManifest(added, 'b'.repeat(64)));
  for (const identifier of ['user-a', 'user-b', 'shared-room', 'shared-match', 'shared-invite']) assert.equal(redacted.includes(identifier), false);
});

test('protected account omission and mutation fail invariant verification', async () => {
  const baseline = await captureManifest({ client: new FixtureRedis(), ...CAPTURE });
  const omitted = fixtureEntries(); omitted.delete('sd:user:user-a:coins');
  const omittedManifest = await captureManifest({ client: new FixtureRedis(omitted), ...CAPTURE });
  assert.throws(() => verifyProtectedInvariants(omittedManifest, baseline.protectedAccounts), /jooddang/);
  const mutated = fixtureEntries(); mutated.set('sd:user:user-b', string(JSON.stringify({ userId: 'user-b', loginId: 'OceanLord', changed: true })));
  const mutatedManifest = await captureManifest({ client: new FixtureRedis(mutated), ...CAPTURE });
  assert.throws(() => verifyProtectedInvariants(mutatedManifest, baseline.protectedAccounts), /oceanlord/);
  const missingIndex = fixtureEntries(); missingIndex.delete('sd:loginId:jooddang');
  await assert.rejects(captureManifest({ client: new FixtureRedis(missingIndex), ...CAPTURE }), /protected login index/);
});

test('redacted external manifest contains no keys, values, identifiers, passwords, or tokens', async () => {
  const manifest = await captureManifest({ client: new FixtureRedis(), ...CAPTURE });
  const redacted = canonicalJson(redactedManifest(manifest, 'a'.repeat(64)));
  for (const secret of ['jooddang', 'oceanlord', 'user-a', 'user-b', 'password', 'token', 'JoodDang', 'OceanLord']) assert.equal(redacted.toLowerCase().includes(secret.toLowerCase()), false, secret);
  assert.equal(redacted.includes('a'.repeat(64)), true);
});

test('foreign keys remain checksum-only metadata outside the logical archive', async () => {
  const entries = fixtureEntries(); entries.set('foreign:user-identifier', string('foreign-secret-value'));
  const manifest = await captureManifest({ client: new FixtureRedis(entries), ...CAPTURE });
  const serialized = canonicalJson(manifest);
  assert.equal(manifest.foreign.length, 1);
  assert.equal(manifest.records.length, fixtureEntries().size);
  assert.equal(serialized.includes(Buffer.from('foreign:user-identifier').toString('base64')), false);
  assert.equal(serialized.includes(Buffer.from('foreign-secret-value').toString('base64')), false);
});

test('foreign expiry between observations records checksum-only churn without aborting', async () => {
  const entries = fixtureEntries(); entries.set('foreign:volatile-user', { type: 'string', value: Buffer.from('never-read-secret'), pttl: 100 });
  const client = new FixtureRedis(entries);
  const original = client.execute.bind(client);
  let foreignPttlReads = 0;
  client.execute = async (command) => {
    const key = command[1] === undefined ? '' : Buffer.from(command[1]).toString();
    if (String(command[0]).toUpperCase() === 'PTTL' && key === 'foreign:volatile-user') return ++foreignPttlReads === 1 ? 100 : -2;
    if (String(command[0]).toUpperCase() === 'GET' && key === 'foreign:volatile-user') throw new Error('foreign value must never be read');
    return original(command);
  };
  const manifest = await captureManifest({ client, ...CAPTURE });
  assert.equal(manifest.foreign.length, 1);
  assert.equal(manifest.foreignChurn.length, 1);
  const serialized = canonicalJson(manifest);
  assert.equal(serialized.includes(Buffer.from('foreign:volatile-user').toString('base64')), false);
  assert.equal(serialized.includes(Buffer.from('never-read-secret').toString('base64')), false);
});

test('manifest rejects non-canonical base64 recursively', async () => {
  const manifest = await captureManifest({ client: new FixtureRedis(), ...CAPTURE });
  const malformed = structuredClone(manifest.records);
  malformed.find((record) => record.type === 'hash').value.pairs[0].value = 'A===';
  assert.throws(() => buildManifest({ records: malformed, ...CAPTURE }), /base64/);
});

test('CLI rejects archive key argv/environment and requires read-only token FD', () => {
  assert.throws(() => parseArguments(['--key=secret'], {}), /forbidden/);
  assert.throws(() => parseArguments([], { SD_ARCHIVE_KEY: 'secret' }), /forbidden/);
  assert.throws(() => parseArguments(['--endpoint', 'https://fixture.upstash.io'], {}), /incomplete/);
});

test('malformed read token fails before archive key descriptor is consumed', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sd-token-order-'));
  const tokenPath = join(directory, 'token'); writeFileSync(tokenPath, 'bad', { mode: 0o600 });
  const keyFd = keyFile(directory); const tokenFd = openSync(tokenPath, 'r');
  await assert.rejects(runCapture({
    endpoint: 'https://fixture.upstash.io', 'readonly-token-fd': String(tokenFd), 'key-fd': String(keyFd),
    'key-id': 'fixture-key', 'capture-id': CAPTURE.captureId, 'source-database-id': CAPTURE.sourceDatabaseId,
    'application-commit': CAPTURE.applicationCommit, 'created-at': CAPTURE.capturedAt, output: join(directory, 'capture.sealed'),
  }, { client: new FixtureRedis() }), /token FD is malformed/);
  const firstKeyByte = Buffer.alloc(1);
  assert.equal(readSync(keyFd, firstKeyByte, 0, 1, null), 1);
  assert.equal(firstKeyByte[0], 7);
  closeSync(keyFd); closeSync(tokenFd);
});

test('capture publishes a recoverable pair and retains ambiguous finals with abort evidence on races', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sd-evidence-pair-'));
  const tokenPath = join(directory, 'token'); writeFileSync(tokenPath, 'readonly-fixture-token', { mode: 0o600 });
  const optionsFor = (output, keyFd, tokenFd) => ({
    endpoint: 'https://fixture.upstash.io', 'readonly-token-fd': String(tokenFd), 'key-fd': String(keyFd),
    'key-id': 'fixture-key', 'capture-id': CAPTURE.captureId, 'source-database-id': CAPTURE.sourceDatabaseId,
    'application-commit': CAPTURE.applicationCommit, 'created-at': CAPTURE.capturedAt, output,
  });
  const output = join(directory, 'logical.sealed');
  const keyFd = keyFile(directory); const tokenFd = openSync(tokenPath, 'r');
  const redacted = await runCapture(optionsFor(output, keyFd, tokenFd), { client: new FixtureRedis() });
  closeSync(keyFd); closeSync(tokenFd);
  assert.equal(existsSync(output), true);
  assert.equal(JSON.parse(readFileSync(`${output}.manifest.json`, 'utf8')).ciphertextChecksum, redacted.ciphertextChecksum);

  const racedOutput = join(directory, 'raced.sealed');
  const racedEvidence = `${racedOutput}.manifest.json`;
  const racingClient = new FixtureRedis();
  const original = racingClient.execute.bind(racingClient);
  let injected = false;
  racingClient.execute = async (command) => {
    if (!injected) { injected = true; writeFileSync(racedEvidence, 'competing evidence', { mode: 0o600 }); }
    return original(command);
  };
  const racedKeyFd = keyFile(directory); const racedTokenFd = openSync(tokenPath, 'r');
  await assert.rejects(runCapture(optionsFor(racedOutput, racedKeyFd, racedTokenFd), { client: racingClient }));
  closeSync(racedKeyFd); closeSync(racedTokenFd);
  assert.equal(existsSync(racedOutput), true);
  assert.equal(readFileSync(racedEvidence, 'utf8'), 'competing evidence');
  assert.equal(existsSync(`${racedEvidence}.partial`), false);
  assert.equal(JSON.parse(readFileSync(`${racedOutput}.pair-aborted.json`, 'utf8')).publicationState, 'aborted-finals-retained');

  const postLinkOutput = join(directory, 'post-link.sealed');
  const postLinkEvidence = `${postLinkOutput}.manifest.json`;
  const postLinkKeyFd = keyFile(directory); const postLinkTokenFd = openSync(tokenPath, 'r');
  await assert.rejects(runCapture(optionsFor(postLinkOutput, postLinkKeyFd, postLinkTokenFd), {
    client: new FixtureRedis(), evidenceHooks: { afterLink: () => { throw new Error('injected post-link failure'); } },
  }), /post-link/);
  closeSync(postLinkKeyFd); closeSync(postLinkTokenFd);
  assert.equal(existsSync(postLinkOutput), true);
  assert.equal(existsSync(postLinkEvidence), true);
  assert.equal(existsSync(`${postLinkEvidence}.partial`), false);
  assert.equal(existsSync(`${postLinkOutput}.pair-aborted.json`), true);

  const swappedEvidenceOutput = join(directory, 'swapped-evidence.sealed');
  const swappedEvidencePath = `${swappedEvidenceOutput}.manifest.json`;
  const evidenceReplacement = join(directory, 'evidence-replacement'); writeFileSync(evidenceReplacement, 'competitor evidence', { mode: 0o600 });
  const swappedEvidenceKeyFd = keyFile(directory); const swappedEvidenceTokenFd = openSync(tokenPath, 'r');
  await assert.rejects(runCapture(optionsFor(swappedEvidenceOutput, swappedEvidenceKeyFd, swappedEvidenceTokenFd), {
    client: new FixtureRedis(), evidenceHooks: { afterLink: () => renameSync(evidenceReplacement, swappedEvidencePath) },
  }), /ownership changed/);
  closeSync(swappedEvidenceKeyFd); closeSync(swappedEvidenceTokenFd);
  assert.equal(readFileSync(swappedEvidencePath, 'utf8'), 'competitor evidence');
  assert.equal(existsSync(swappedEvidenceOutput), true);
  assert.equal(existsSync(`${swappedEvidenceOutput}.pair-aborted.json`), true);

  const swappedArchiveOutput = join(directory, 'swapped-archive.sealed');
  const archiveReplacement = join(directory, 'archive-replacement'); writeFileSync(archiveReplacement, 'competitor archive', { mode: 0o600 });
  const swappedArchiveKeyFd = keyFile(directory); const swappedArchiveTokenFd = openSync(tokenPath, 'r');
  await assert.rejects(runCapture(optionsFor(swappedArchiveOutput, swappedArchiveKeyFd, swappedArchiveTokenFd), {
    client: new FixtureRedis(), captureHooks: { afterArchive: () => renameSync(archiveReplacement, swappedArchiveOutput) },
  }), /ownership changed/);
  closeSync(swappedArchiveKeyFd); closeSync(swappedArchiveTokenFd);
  assert.equal(readFileSync(swappedArchiveOutput, 'utf8'), 'competitor archive');
  assert.equal(existsSync(`${swappedArchiveOutput}.manifest.json`), true);
  assert.equal(existsSync(`${swappedArchiveOutput}.pair-aborted.json`), true);

  const swappedPartialOutput = join(directory, 'swapped-evidence-partial.sealed');
  const swappedPartialEvidence = `${swappedPartialOutput}.manifest.json`;
  const evidencePartialReplacement = join(directory, 'evidence-partial-replacement');
  writeFileSync(evidencePartialReplacement, 'competitor evidence partial', { mode: 0o600 });
  const swappedPartialKeyFd = keyFile(directory); const swappedPartialTokenFd = openSync(tokenPath, 'r');
  await assert.rejects(runCapture(optionsFor(swappedPartialOutput, swappedPartialKeyFd, swappedPartialTokenFd), {
    client: new FixtureRedis(), evidenceHooks: { afterLink: () => renameSync(evidencePartialReplacement, `${swappedPartialEvidence}.partial`) },
  }), /partial ownership changed/);
  closeSync(swappedPartialKeyFd); closeSync(swappedPartialTokenFd);
  assert.equal(existsSync(swappedPartialOutput), true);
  assert.equal(existsSync(swappedPartialEvidence), true);
  assert.equal(readFileSync(`${swappedPartialEvidence}.partial`, 'utf8'), 'competitor evidence partial');
  assert.equal(existsSync(`${swappedPartialOutput}.pair-aborted.json`), true);
});

test('logical restore uses an owned disposable Redis private Unix socket', async (context) => {
  const redisServerPath = '/opt/homebrew/bin/redis-server';
  if (!existsSync(redisServerPath)) return context.skip('fixture redis-server is not installed');
  assert.throws(() => assertUnprivileged(0), /refuses root/);
  if (process.geteuid() === 0) return context.skip('tool correctly refuses root; integration runs unprivileged');
  const manifest = await captureManifest({ client: new FixtureRedis(), ...CAPTURE });
  const restored = await verifyLogicalRestore({ manifest, redisServerPath });
  assert.equal(restored.manifestChecksum, manifest.manifestChecksum);
  assert.equal(restored.processVerified, true);
});

test('owned process cleanup installs exit listener before TERM, forces KILL, and retains uncertain scratch', async () => {
  class FakeChild extends EventEmitter {
    exitCode = null;
    signals = [];
    kill(signal) { this.signals.push(signal); if (signal === 'SIGKILL') { this.exitCode = 137; this.emit('exit', 137); } }
  }
  const child = new FakeChild();
  await stopOwnedProcess(child, { timeoutMs: 1, delayImpl: async () => false });
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
  const boundaryChild = new FakeChild();
  await stopOwnedProcess(boundaryChild, { timeoutMs: 1, delayImpl: async () => {
    boundaryChild.exitCode = 0; boundaryChild.emit('exit', 0); return false;
  } });
  assert.deepEqual(boundaryChild.signals, ['SIGTERM']);
  const signaledChild = new FakeChild(); signaledChild.signalCode = 'SIGTERM';
  await stopOwnedProcess(signaledChild);
  assert.deepEqual(signaledChild.signals, []);
  const scratch = mkdtempSync(join(tmpdir(), 'sd-uncertain-reap-'));
  await assert.rejects(cleanupOwnedRestore(new FakeChild(), scratch, async () => { throw new Error('uncertain'); }), /uncertain/);
  assert.equal(existsSync(scratch), true);
});

test('restore launch failures are contained and leave no scratch directory', async (context) => {
  if (process.geteuid() === 0) return context.skip('restore correctly refuses root before launch');
  const scratchNames = () => new Set(readdirSync('/tmp').filter((name) => name.startsWith('submarine-restore-')));
  const before = scratchNames();
  const fixture = mkdtempSync(join(tmpdir(), 'sd-nonexec-'));
  const nonExecutable = join(fixture, 'redis-server');
  writeFileSync(nonExecutable, '#!/bin/sh\nexit 0\n', { mode: 0o600 });
  chmodSync(nonExecutable, 0o600);
  for (const redisServerPath of [join(fixture, 'missing-redis-server'), nonExecutable]) {
    await assert.rejects(verifyLogicalRestore({ manifest: {}, redisServerPath }), /could not start/);
    assert.deepEqual(scratchNames(), before);
  }
  rmSync(fixture, { recursive: true, force: true });
});

test('private Redis command rejects a socket that closes before a response', async () => {
  const directory = mkdtempSync('/tmp/sd-socket-close-');
  const socketPath = join(directory, 'server.sock');
  const server = createServer((socket) => socket.destroy());
  await new Promise((resolve) => server.listen(socketPath, resolve));
  await assert.rejects(redisCommand(socketPath, ['PING']), /closed|reset|EPIPE/i);
  await new Promise((resolve) => server.close(resolve));
  rmSync(directory, { recursive: true, force: true });
});
