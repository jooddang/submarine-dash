import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import IORedis from 'ioredis';
import { canonicalJson, sha256 } from '../canonical.mjs';
import { classifyKey, recordChecksum } from '../manifest.mjs';
import {
  deriveStalePvpQuarantinePlan,
  executeQuarantineTransaction,
  PRE_CLEANUP_INVENTORY,
  QUARANTINE_STALE_PVP_LUA,
  quarantineTransaction,
  readQuarantineRedisTime,
  verifyRestoreReportFromFd,
} from '../stale-pvp-quarantine.mjs';

const commit = '3'.repeat(40);
const runtimeCommit = '4'.repeat(40);
const archiveSha256 = 'a'.repeat(64);
const cutoffMs = 1_700_000_000_000;
const quarantineNow = cutoffMs + (31 * 24 * 60 * 60 * 1000);
const restoreEvidence = { restoreReportSha256: 'b'.repeat(64), restoreCaptureId: 'capture-1' };
const b64 = (value) => Buffer.from(value).toString('base64');

function stringRecord(key, value) {
  const record = { key: b64(key), family: classifyKey(Buffer.from(key)).family, type: 'string', pttl: -1, value: { data: b64(value) } };
  return { ...record, checksum: recordChecksum(record) };
}

function setRecord(key, values) {
  const record = { key: b64(key), family: classifyKey(Buffer.from(key)).family, type: 'set', pttl: -1, value: { members: values.map(b64).sort() } };
  return { ...record, checksum: recordChecksum(record) };
}

function gameConfig() {
  return { format: 'single', powerUpMode: 'earned', betting: false, p1Bet: { coins: 0, dolphins: 0, tubePieces: 0 }, p2Bet: { coins: 0, dolphins: 0, tubePieces: 0 } };
}

function player(userId) {
  return { userId, loginId: `${userId}-login`, skinId: 'classic', connected: false, ready: true };
}

function room(override = {}) {
  return {
    roomId: 'room-1', ownerUserId: 'host-1', phase: 'IN_MATCH', version: 7,
    config: gameConfig(), slots: { host: player('host-1'), guest: player('guest-1') },
    pendingInviteId: null, matchId: 'match-1', escrow: { status: 'NONE' }, createdAt: cutoffMs - 20_000, updatedAt: cutoffMs - 10_000,
    ...override,
  };
}

function match(override = {}) {
  return {
    matchId: 'match-1', roomId: 'room-1', phase: 'PLAYING', createdAt: cutoffMs - 20_000, updatedAt: cutoffMs - 9_000,
    seed: 123, countdownStartedAt: cutoffMs - 19_000, config: gameConfig(), players: { host: player('host-1'), guest: player('guest-1') },
    inputs: { host: [], guest: [] }, snapshot: null, winnerSlot: null, completedAt: null,
    series: { roundsPlayed: 0, p1Wins: 0, p2Wins: 0, roundsNeeded: 1, currentRound: 1, roundResults: [] }, ...override,
  };
}

function openedFixture({ roomValue = room(), matchValue = match(), memberships = true, roomIndex = ['room-1'], extra = [] } = {}) {
  const records = [
    ...(roomValue ? [stringRecord('sd:pvp:room:room-1', canonicalJson(roomValue))] : []),
    ...(matchValue ? [stringRecord(`sd:pvp:match:${matchValue.matchId}`, canonicalJson(matchValue))] : []),
    ...(memberships ? [stringRecord('sd:pvp:room-membership:host-1', 'room-1'), stringRecord('sd:pvp:room-membership:guest-1', 'room-1')] : []),
    setRecord('sd:pvp:rooms:all', roomIndex),
    ...extra,
  ].sort((left, right) => Buffer.compare(Buffer.from(left.key, 'base64'), Buffer.from(right.key, 'base64')));
  const core = {
    version: 'sd-manifest-v1', captureId: 'capture-1', sourceDatabaseId: 'source-1', capturedAt: new Date(cutoffMs + 30_000).toISOString(),
    applicationCommit: commit, routeInventoryVersion: PRE_CLEANUP_INVENTORY.version, routeInventoryDigest: PRE_CLEANUP_INVENTORY.digest,
    records, foreign: [], skippedEphemeral: [], foreignChurn: [], protectedAccounts: {}, verifierVersion: 'fixture',
  };
  const manifest = { ...core, manifestChecksum: sha256(Buffer.from(canonicalJson(core))) };
  return {
    openedArchive: {
      archiveSha256, plaintext: Buffer.from(canonicalJson(manifest)),
      header: { captureId: core.captureId, sourceDatabaseId: core.sourceDatabaseId, manifestVersion: core.version },
    },
    manifest,
  };
}

function plan(options = {}) {
  const fixture = openedFixture(options);
  return deriveStalePvpQuarantinePlan({
    openedArchive: fixture.openedArchive, expectedArchiveSha256: archiveSha256,
    expectedManifestChecksum: fixture.manifest.manifestChecksum, expectedArchiveApplicationCommit: commit, restoreEvidence, cutoffMs,
  });
}

async function withFixtureRedis(operation) {
  const directory = mkdtempSync(join(tmpdir(), 'sd-quarantine-redis-'));
  const socket = join(directory, 'redis.sock');
  const child = spawn('redis-server', ['--port', '0', '--unixsocket', socket, '--unixsocketperm', '700', '--save', '', '--appendonly', 'no'], { stdio: 'ignore' });
  try {
    for (let attempt = 0; attempt < 100 && !existsSync(socket); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(existsSync(socket), true, 'fixture Redis socket did not start');
    const redis = new IORedis(socket, { lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 0 });
    await redis.connect();
    try { await operation(redis); } finally { redis.disconnect(); }
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 1_000); });
    rmSync(directory, { recursive: true, force: true });
  }
}

async function seedTransactionState(redis, transaction) {
  await redis.set('sd:migration:control:gate', 'closed');
  await redis.set('sd:migration:control:epoch', String(transaction.spec.epoch));
  for (const item of transaction.spec.expectedStrings) await redis.set(transaction.keys[item.keyIndex - 1], item.value);
  for (const item of transaction.spec.expectedSets) if (item.members.length) await redis.sadd(transaction.keys[item.keyIndex - 1], ...item.members);
  if (transaction.spec.indexBefore.length) await redis.sadd('sd:pvp:rooms:all', ...transaction.spec.indexBefore);
}

test('derives the exact stale PVP graph and redacted transaction aggregates', () => {
  const derived = plan();
  assert.equal(derived.activeRooms.length, 1);
  assert.equal(derived.activeMatches.length, 1);
  assert.equal(derived.membershipKeys.length, 2);
  assert.match(derived.beforeChecksum, /^[a-f0-9]{64}$/);
  const transaction = quarantineTransaction({ plan: derived, epoch: 9, operatorId: 'fixture-operator', quarantinedAtMs: quarantineNow, executingRuntimeCommit: runtimeCommit });
  assert.equal(transaction.spec.updates.length, 2);
  assert.equal(transaction.spec.archiveApplicationCommit, commit);
  assert.equal(transaction.spec.executingRuntimeCommit, runtimeCommit);
  assert.equal(transaction.spec.sourceInventoryVersion, 1);
  assert.equal(transaction.spec.executingInventoryVersion, 2);
  assert.equal(transaction.spec.restoreReportSha256, restoreEvidence.restoreReportSha256);
  assert.equal(JSON.parse(transaction.spec.updates[0].value).phase, 'CANCELED');
  assert.equal(JSON.parse(transaction.spec.updates[1].value).phase, 'ABORTED');
  assert.equal(JSON.stringify({ outcome: 'quarantined', afterChecksum: transaction.afterChecksum }).includes('room-1'), false);
  assert.match(QUARANTINE_STALE_PVP_LUA, /gate_not_closed/);
  assert.match(QUARANTINE_STALE_PVP_LUA, /epoch_changed/);
  assert.match(QUARANTINE_STALE_PVP_LUA, /cas_mismatch/);
});

test('active orphan matches fail closed without a canonical parent/player graph', () => {
  assert.throws(() => plan({ roomValue: null, matchValue: match({ roomId: 'missing-room' }), memberships: false, roomIndex: [] }), { code: 'ARCHIVE_GRAPH_INVALID' });
});

test('completion partial-write with cleared room matchId remains a valid target', () => {
  const derived = plan({ roomValue: room({ matchId: null }) });
  assert.equal(derived.activeMatches.length, 1);
  assert.equal(plan({ matchValue: match({ phase: 'ROUND_RESULT', completedAt: cutoffMs - 5_000 }) }).activeMatches.length, 1);
});

test('exact six-field legacy INIT match uses createdAt for staleness without relaxing modern schemas', () => {
  const legacy = {
    matchId: 'match-1', roomId: 'room-1', phase: 'INIT', createdAt: cutoffMs - 1,
    config: gameConfig(), players: { host: player('host-1'), guest: player('guest-1') },
  };
  assert.equal(plan({ matchValue: legacy }).activeMatches.length, 1);
  assert.throws(() => plan({ matchValue: { ...legacy, createdAt: cutoffMs + 1 } }), { code: 'PVP_NOT_STALE_OR_UNKNOWN' });
  assert.throws(() => plan({ matchValue: { ...legacy, unknown: true } }), { code: 'ARCHIVE_GRAPH_INVALID' });
});

test('COUNTDOWN room is a canonical active quarantine target', () => {
  assert.equal(plan({ roomValue: room({ phase: 'COUNTDOWN' }) }).activeRooms.length, 1);
  assert.throws(() => plan({ roomValue: room({ version: Number.MAX_SAFE_INTEGER }) }), { code: 'ARCHIVE_GRAPH_INVALID' });
});

test('legacy canonical terminal records are minimally validated, economically safe, and preserved exactly', () => {
  const terminalRoom = { roomId: 'legacy-room', phase: 'CANCELED', config: { betting: false }, escrow: { status: 'NONE' } };
  const terminalMatch = { matchId: 'legacy-match', phase: 'ABORTED' };
  const derived = plan({ extra: [
    stringRecord('sd:pvp:room:legacy-room', canonicalJson(terminalRoom)),
    stringRecord('sd:pvp:match:legacy-match', canonicalJson(terminalMatch)),
  ] });
  assert.equal(derived.expectedStrings.some(([key, value]) => key === 'sd:pvp:room:legacy-room' && value === canonicalJson(terminalRoom)), true);
  assert.equal(derived.expectedStrings.some(([key, value]) => key === 'sd:pvp:match:legacy-match' && value === canonicalJson(terminalMatch)), true);
  assert.throws(() => plan({ extra: [stringRecord('sd:pvp:room:legacy-room', canonicalJson({ ...terminalRoom, escrow: { status: 'HELD' } }))] }), { code: 'PVP_ECONOMIC_BLOCKER' });
});

for (const [label, mutate] of [
  ['betting', (value) => { value.config.betting = true; }],
  ['p1 coins', (value) => { value.config.p1Bet.coins = 1; }],
  ['p2 dolphins', (value) => { value.config.p2Bet.dolphins = 1; }],
  ['escrow held', (value) => { value.escrow = { status: 'HELD', escrowId: 'secret' }; }],
]) {
  test(`economic blocker: ${label}`, () => {
    const value = room(); mutate(value);
    assert.throws(() => plan({ roomValue: value }), { code: 'PVP_ECONOMIC_BLOCKER' });
  });
}

for (const [label, mutate] of [
  ['match betting', (value) => { value.config.betting = true; }],
  ['match coins', (value) => { value.config.p2Bet.coins = 1; }],
]) {
  test(`economic blocker: ${label}`, () => {
    const value = match(); mutate(value);
    assert.throws(() => plan({ matchValue: value }), { code: 'PVP_ECONOMIC_BLOCKER' });
  });
}

test('invalid membership/index relationships and pending entitlements fail closed', () => {
  assert.throws(() => plan({ memberships: false }), { code: 'ARCHIVE_GRAPH_INVALID' });
  assert.throws(() => plan({ roomIndex: [] }), { code: 'ARCHIVE_GRAPH_INVALID' });
  const invite = { inviteId: 'invite-1', roomId: 'room-1', fromUserId: 'host-1', fromLoginId: 'host-login', toUserId: 'other-1', toLoginId: 'other-login', status: 'PENDING', createdAt: cutoffMs - 1000, expiresAt: cutoffMs + 1, resolvedAt: null };
  assert.throws(() => plan({ extra: [stringRecord('sd:pvp:invite:invite-1', canonicalJson(invite))] }), { code: 'PVP_ENTITLEMENT_BLOCKER' });
  assert.throws(() => plan({ matchValue: match({ players: { host: player('wrong-host'), guest: player('guest-1') } }) }), { code: 'ARCHIVE_GRAPH_INVALID' });
  assert.doesNotThrow(() => plan({ matchValue: match({ players: { host: { ...player('host-1'), skinId: 'historical' }, guest: player('guest-1') }, config: { ...gameConfig(), powerUpMode: 'inventory' } }) }));
  assert.throws(() => plan({ roomValue: room({ matchId: 'missing-match' }) }), { code: 'ARCHIVE_GRAPH_INVALID' });
  assert.throws(() => plan({ matchValue: match({ roomId: 'wrong-room' }) }), { code: 'ARCHIVE_GRAPH_INVALID' });
  assert.throws(() => plan({ matchValue: match({ phase: 'MATCH_RESULT', players: { host: player('wrong-host'), guest: player('guest-1') } }) }), { code: 'ARCHIVE_GRAPH_INVALID' });
  const resolved = { ...invite, status: 'DECLINED', resolvedAt: cutoffMs - 500, expiresAt: cutoffMs - 100 };
  assert.throws(() => plan({ extra: [
    stringRecord('sd:pvp:invite:invite-1', canonicalJson(resolved)),
    setRecord('sd:pvp:user-invites:other-1', ['invite-1']),
  ] }), { code: 'ARCHIVE_GRAPH_INVALID' });
  assert.throws(() => plan({ extra: [stringRecord('sd:pvp:invite:invite-1', canonicalJson({ ...resolved, inviteId: 'wrong' }))] }), { code: 'ARCHIVE_GRAPH_INVALID' });
  assert.throws(() => plan({ extra: [stringRecord('sd:pvp:invite:invite-1', canonicalJson({ ...resolved, roomId: 'missing-room' }))] }), { code: 'ARCHIVE_GRAPH_INVALID' });
});

test('age, aliases, checksums, commit, and archive authentication evidence fail closed', () => {
  assert.throws(() => plan({ roomValue: room({ updatedAt: cutoffMs + 1 }) }), { code: 'PVP_NOT_STALE_OR_UNKNOWN' });
  assert.throws(() => plan({ matchValue: match({ phase: 'COMPLETED' }) }), { code: 'ARCHIVE_GRAPH_INVALID' });
  const fixture = openedFixture();
  assert.throws(() => deriveStalePvpQuarantinePlan({
    openedArchive: fixture.openedArchive, expectedArchiveSha256: 'b'.repeat(64), expectedManifestChecksum: fixture.manifest.manifestChecksum,
    expectedArchiveApplicationCommit: commit, restoreEvidence, cutoffMs,
  }), { code: 'ARCHIVE_SHA_MISMATCH' });
  assert.throws(() => deriveStalePvpQuarantinePlan({
    openedArchive: fixture.openedArchive, expectedArchiveSha256: archiveSha256, expectedManifestChecksum: fixture.manifest.manifestChecksum,
    expectedArchiveApplicationCommit: '5'.repeat(40), restoreEvidence, cutoffMs,
  }), { code: 'QUARANTINE_EVIDENCE_MISMATCH' });
});

test('restore report is FD-only, canonical, checksum-bound, and process-verified equal', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sd-restore-report-'));
  const reportPath = join(directory, 'report.json');
  const report = canonicalJson({ archiveSha256, captureId: 'capture-1', equal: true, manifestChecksum: 'c'.repeat(64), processVerified: true });
  writeFileSync(reportPath, report, { mode: 0o600 });
  const reportFd = openSync(reportPath, 'r');
  try {
    assert.deepEqual(verifyRestoreReportFromFd({ reportFd, expectedSha256: sha256(Buffer.from(report)), archiveSha256, manifestChecksum: 'c'.repeat(64), captureId: 'capture-1' }), {
      restoreReportSha256: sha256(Buffer.from(report)), restoreCaptureId: 'capture-1',
    });
    assert.throws(() => verifyRestoreReportFromFd({ reportFd, expectedSha256: 'd'.repeat(64), archiveSha256, manifestChecksum: 'c'.repeat(64), captureId: 'capture-1' }), { code: 'RESTORE_REPORT_MISMATCH' });
  } finally { closeSync(reportFd); rmSync(directory, { recursive: true, force: true }); }
});

test('code-owned Redis-time staleness rejects recent cutoff and future capture', () => {
  const derived = plan();
  assert.throws(() => quarantineTransaction({ plan: { ...derived, cutoffMs: quarantineNow - 1 }, epoch: 9, operatorId: 'fixture-operator', quarantinedAtMs: quarantineNow, executingRuntimeCommit: runtimeCommit }), { code: 'QUARANTINE_STALENESS_INVALID' });
  assert.throws(() => quarantineTransaction({ plan: { ...derived, capturedAtMs: quarantineNow + 1 }, epoch: 9, operatorId: 'fixture-operator', quarantinedAtMs: quarantineNow, executingRuntimeCommit: runtimeCommit }), { code: 'QUARANTINE_STALENESS_INVALID' });
});

test('quarantine timestamp is parsed only from reviewed Redis TIME Lua', async () => {
  assert.equal(await readQuarantineRedisTime({ eval: async () => ['1700000000', '123000'] }), 1_700_000_000_123);
  await assert.rejects(readQuarantineRedisTime({ eval: async () => ['bad', 'reply'] }), { code: 'QUARANTINE_REDIS_TIME_FAILED' });
});

test('transaction result is idempotent and provider ambiguity is redacted', async () => {
  const transaction = quarantineTransaction({ plan: plan(), epoch: 9, operatorId: 'fixture-operator', quarantinedAtMs: quarantineNow, executingRuntimeCommit: runtimeCommit });
  await assert.doesNotReject(executeQuarantineTransaction({ eval: async () => [1, 'quarantined'] }, transaction));
  assert.equal((await executeQuarantineTransaction({ eval: async () => [2, 'already_quarantined'] }, transaction)).outcome, 'already_quarantined');
  await assert.rejects(executeQuarantineTransaction({ eval: async () => { throw new Error('SECRET_ROOM_ID'); } }, transaction), (error) =>
    error.code === 'QUARANTINE_TRANSACTION_AMBIGUOUS' && !error.message.includes('SECRET'));
  await assert.rejects(executeQuarantineTransaction({ eval: async () => [0, 'cas_mismatch:SECRET'] }, transaction), (error) =>
    error.code === 'QUARANTINE_TRANSACTION_REJECTED' && !error.message.includes('SECRET'));
});

test('Lua transaction is atomic, idempotent, and leaves unrelated keys untouched', async () => {
  await withFixtureRedis(async (redis) => {
    const derived = plan();
    const transaction = quarantineTransaction({ plan: derived, epoch: 9, operatorId: 'fixture-operator', quarantinedAtMs: Date.now(), executingRuntimeCommit: runtimeCommit });
    await seedTransactionState(redis, transaction);
    await redis.set('unrelated:key', 'preserve-me');
    const adapter = { eval: (script, keys, args) => redis.eval(script, keys.length, ...keys, ...args) };
    assert.equal((await executeQuarantineTransaction(adapter, transaction)).outcome, 'quarantined');
    assert.equal(JSON.parse(await redis.get('sd:pvp:room:room-1')).phase, 'CANCELED');
    assert.equal(JSON.parse(await redis.get('sd:pvp:match:match-1')).phase, 'ABORTED');
    assert.equal(await redis.exists('sd:pvp:room-membership:host-1'), 0);
    assert.deepEqual(await redis.smembers('sd:pvp:rooms:all'), []);
    assert.equal(await redis.exists('sd:pvp:rooms:all'), 0);
    assert.equal(await redis.get('unrelated:key'), 'preserve-me');
    assert.equal((await executeQuarantineTransaction(adapter, transaction)).outcome, 'already_quarantined');
    const storedTimestamp = Number(await redis.hget(transaction.keys[4], 'quarantinedAtMs'));
    const rebuilt = quarantineTransaction({ plan: derived, epoch: 9, operatorId: 'fixture-operator', quarantinedAtMs: storedTimestamp, executingRuntimeCommit: runtimeCommit });
    assert.equal((await executeQuarantineTransaction(adapter, rebuilt)).outcome, 'already_quarantined');
  });
});

for (const [label, mutate] of [
  ['wrong epoch', async (redis) => redis.set('sd:migration:control:epoch', '10')],
  ['hard failure', async (redis) => redis.set('sd:migration:control:hard-failure', '1')],
  ['active lease', async (redis) => redis.zadd('sd:migration:control:leases', Date.now() + 60_000, 'lease')],
  ['unexpected PVP presence', async (redis) => redis.set('sd:pvp:presence:live-user', '1')],
  ['unexpected PVP websocket ticket', async (redis) => redis.set('sd:pvp:ws-ticket:live-user', '1')],
  ['unexpected PVP lobby index', async (redis) => redis.sadd('sd:pvp:lobby:online', 'live-user')],
  ['expiring durable target', async (redis) => redis.pexpire('sd:pvp:match:match-1', 60_000)],
]) {
  test(`Lua ${label} precondition makes no writes`, async () => {
    await withFixtureRedis(async (redis) => {
      const transaction = quarantineTransaction({ plan: plan(), epoch: 9, operatorId: 'fixture-operator', quarantinedAtMs: Date.now(), executingRuntimeCommit: runtimeCommit });
      await seedTransactionState(redis, transaction);
      await mutate(redis);
      const beforeRoom = await redis.get('sd:pvp:room:room-1');
      const adapter = { eval: (script, keys, args) => redis.eval(script, keys.length, ...keys, ...args) };
      await assert.rejects(executeQuarantineTransaction(adapter, transaction), { code: 'QUARANTINE_TRANSACTION_REJECTED' });
      assert.equal(await redis.get('sd:pvp:room:room-1'), beforeRoom);
      assert.equal(await redis.exists('sd:pvp:room-membership:host-1'), 1);
      assert.equal(await redis.exists(transaction.keys[4]), 0);
    });
  });
}

test('Lua CAS mismatch makes no partial writes', async () => {
  await withFixtureRedis(async (redis) => {
    const transaction = quarantineTransaction({ plan: plan(), epoch: 9, operatorId: 'fixture-operator', quarantinedAtMs: Date.now(), executingRuntimeCommit: runtimeCommit });
    await seedTransactionState(redis, transaction);
    await redis.set('sd:pvp:match:match-1', canonicalJson({ ...match(), phase: 'ROUND_RESULT' }));
    const beforeRoom = await redis.get('sd:pvp:room:room-1');
    const adapter = { eval: (script, keys, args) => redis.eval(script, keys.length, ...keys, ...args) };
    await assert.rejects(executeQuarantineTransaction(adapter, transaction), { code: 'QUARANTINE_TRANSACTION_REJECTED' });
    assert.equal(await redis.get('sd:pvp:room:room-1'), beforeRoom);
    assert.equal(await redis.exists('sd:pvp:room-membership:host-1'), 1);
  });
});
