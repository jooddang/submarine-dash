import { createHash } from 'node:crypto';
import { fstatSync, readSync } from 'node:fs';
import { canonicalJson, sha256 } from './canonical.mjs';
import { classifyKey, recordChecksum, validateRecord } from './manifest.mjs';
import { ROUTE_INVENTORY_DIGEST, ROUTE_INVENTORY_VERSION } from '../../shared/productionRouteInventory.js';

const ROOM_TERMINAL = new Set(['CANCELED', 'COMPLETED']);
const MATCH_TERMINAL = new Set(['MATCH_RESULT', 'ABORTED']);
const ACTIVE_ROOM_PHASES = new Set(['OPEN', 'WAITING_FOR_INVITEE', 'READY_CHECK', 'LOCKED', 'COUNTDOWN', 'IN_MATCH']);
const ACTIVE_MATCH_PHASES = new Set(['INIT', 'COUNTDOWN', 'PLAYING', 'ROUND_RESULT']);
export const QUARANTINE_MIN_STALE_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const PRE_CLEANUP_INVENTORY = Object.freeze({ version: 1, digest: '4ffffefd9507fb1aa010158d9f9ba7fd21c8aeba80aa09d4b1cd13cffcb902e9' });

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function raw(encoded) {
  if (typeof encoded !== 'string') fail('ARCHIVE_MANIFEST_INVALID', 'Archive manifest contains invalid binary framing.');
  const value = Buffer.from(encoded, 'base64');
  if (value.toString('base64') !== encoded) fail('ARCHIVE_MANIFEST_INVALID', 'Archive manifest contains invalid binary framing.');
  return value;
}

function textKey(record) {
  const value = raw(record.key);
  const text = value.toString('utf8');
  if (!Buffer.from(text).equals(value)) fail('ARCHIVE_GRAPH_INVALID', 'Archive PVP graph contains a non-text key.');
  return text;
}

function stringValue(record, label) {
  if (record?.type !== 'string' || record.pttl !== -1) fail('ARCHIVE_GRAPH_INVALID', `${label} must be one durable string record.`);
  return raw(record.value.data).toString('utf8');
}

function jsonValue(record, label) {
  try {
    const value = JSON.parse(stringValue(record, label));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    fail('ARCHIVE_GRAPH_INVALID', `${label} is not one canonical object record.`);
  }
}

function setValues(record, label) {
  if (record?.type !== 'set' || record.pttl !== -1) fail('ARCHIVE_GRAPH_INVALID', `${label} must be one durable set record.`);
  return record.value.members.map((item) => raw(item).toString('utf8'));
}

function exactZeroBet(value) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === 'coins,dolphins,tubePieces' &&
    value.coins === 0 && value.dolphins === 0 && value.tubePieces === 0;
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function validateNoUnknownEconomicFields(value, allowed, label) {
  const pattern = /(bet|escrow|reward|payout|entitlement|stake|wager|prize|credit|balance)/i;
  const walk = (item, path = '') => {
    if (!item || typeof item !== 'object') return;
    for (const [key, child] of Object.entries(item)) {
      const next = path ? `${path}.${key}` : key;
      if (pattern.test(key) && !allowed.has(next)) fail('PVP_ECONOMIC_BLOCKER', `${label} contains an unreviewed economic or entitlement field.`);
      walk(child, next);
    }
  };
  walk(value);
}

function validateZeroEconomics(value, requireEscrow) {
  if (value.config?.betting !== false || !exactZeroBet(value.config?.p1Bet) || !exactZeroBet(value.config?.p2Bet) ||
      (requireEscrow && canonicalJson(value.escrow) !== '{"status":"NONE"}')) {
    fail('PVP_ECONOMIC_BLOCKER', 'Archived PVP state contains betting, escrow, or entitlement exposure.');
  }
}

function validateEconomicsWherePresent(value, requireEscrow, label) {
  validateNoUnknownEconomicFields(value, new Set([
    'config.betting', 'config.p1Bet', 'config.p1Bet.coins', 'config.p1Bet.dolphins', 'config.p1Bet.tubePieces',
    'config.p2Bet', 'config.p2Bet.coins', 'config.p2Bet.dolphins', 'config.p2Bet.tubePieces', 'escrow', 'escrow.status',
  ]), label);
  if (value.config?.betting !== undefined && value.config.betting !== false) fail('PVP_ECONOMIC_BLOCKER', `${label} contains betting exposure.`);
  if (value.config?.p1Bet !== undefined && !exactZeroBet(value.config.p1Bet)) fail('PVP_ECONOMIC_BLOCKER', `${label} contains nonzero or malformed P1 betting exposure.`);
  if (value.config?.p2Bet !== undefined && !exactZeroBet(value.config.p2Bet)) fail('PVP_ECONOMIC_BLOCKER', `${label} contains nonzero or malformed P2 betting exposure.`);
  if (requireEscrow && value.escrow !== undefined && canonicalJson(value.escrow) !== '{"status":"NONE"}') {
    fail('PVP_ECONOMIC_BLOCKER', `${label} contains escrow exposure.`);
  }
}

function readRegularFd(fd, label, maxBytes) {
  if (!Number.isInteger(fd) || fd < 0) fail('QUARANTINE_FD_INPUT_INVALID', `${label} must be supplied through an already-open file descriptor.`);
  const metadata = fstatSync(fd);
  if (!metadata.isFile() || !Number.isSafeInteger(metadata.size) || metadata.size < 1 || metadata.size > maxBytes) fail('QUARANTINE_FD_INPUT_INVALID', `${label} descriptor is invalid.`);
  const bytes = Buffer.alloc(metadata.size);
  let offset = 0;
  while (offset < bytes.length) {
    const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
    if (count <= 0) fail('QUARANTINE_FD_INPUT_INVALID', `${label} descriptor ended early.`);
    offset += count;
  }
  return bytes;
}

export function verifyRestoreReportFromFd({ reportFd, expectedSha256, archiveSha256, manifestChecksum, captureId }) {
  if (!/^[a-f0-9]{64}$/.test(expectedSha256 || '')) fail('RESTORE_REPORT_INVALID', 'Restore report checksum is invalid.');
  const bytes = readRegularFd(reportFd, 'Restore report', 4 * 1024 * 1024);
  try {
    if (sha256(bytes) !== expectedSha256) fail('RESTORE_REPORT_MISMATCH', 'Restore report checksum does not match approved evidence.');
    let report;
    try { report = JSON.parse(bytes.toString('utf8')); } catch { fail('RESTORE_REPORT_INVALID', 'Restore report is not canonical JSON.'); }
    if (bytes.toString('utf8') !== canonicalJson(report) || report.archiveSha256 !== archiveSha256 || report.manifestChecksum !== manifestChecksum ||
        report.captureId !== captureId || report.processVerified !== true || report.equal !== true) {
      fail('RESTORE_REPORT_MISMATCH', 'Restore report does not bind the approved archive and verified equal restore.');
    }
    return { restoreReportSha256: expectedSha256, restoreCaptureId: captureId };
  } finally { bytes.fill(0); }
}

function recordMap(manifest) {
  const map = new Map();
  for (const record of manifest.records ?? []) {
    try { validateRecord(record); } catch { fail('ARCHIVE_MANIFEST_INVALID', 'Archive manifest record validation failed.'); }
    if (record.checksum !== recordChecksum(record)) fail('ARCHIVE_MANIFEST_INVALID', 'Archive manifest record checksum validation failed.');
    const key = textKey(record);
    if (map.has(key)) fail('ARCHIVE_MANIFEST_INVALID', 'Archive manifest contains a duplicate key.');
    map.set(key, record);
  }
  return map;
}

function aggregateChecksum(entries) {
  return sha256(Buffer.from(canonicalJson(entries.map(([key, value]) => ({
    keyChecksum: sha256(Buffer.from(key)), valueChecksum: sha256(Buffer.from(value)),
  })).sort((a, b) => a.keyChecksum.localeCompare(b.keyChecksum)))));
}

export function deriveStalePvpQuarantinePlan({
  openedArchive,
  expectedArchiveSha256,
  expectedManifestChecksum,
  expectedArchiveApplicationCommit,
  expectedSourceInventory = PRE_CLEANUP_INVENTORY,
  restoreEvidence,
  cutoffMs,
}) {
  if (!/^[a-f0-9]{64}$/.test(expectedArchiveSha256 || '') || openedArchive?.archiveSha256 !== expectedArchiveSha256) fail('ARCHIVE_SHA_MISMATCH', 'Sealed archive checksum does not match the approved artifact.');
  if (!/^[a-f0-9]{64}$/.test(expectedManifestChecksum || '') || !/^[a-f0-9]{40}$/.test(expectedArchiveApplicationCommit || '') ||
      !Number.isSafeInteger(cutoffMs) || cutoffMs < 0 || expectedSourceInventory?.version !== PRE_CLEANUP_INVENTORY.version || expectedSourceInventory?.digest !== PRE_CLEANUP_INVENTORY.digest ||
      !/^[a-f0-9]{64}$/.test(restoreEvidence?.restoreReportSha256 || '') || typeof restoreEvidence?.restoreCaptureId !== 'string') fail('QUARANTINE_EVIDENCE_INVALID', 'Quarantine evidence parameters are invalid.');
  let manifest;
  try { manifest = JSON.parse(openedArchive.plaintext.toString('utf8')); } catch { fail('ARCHIVE_MANIFEST_INVALID', 'Authenticated archive plaintext is not a manifest.'); }
  if (openedArchive.plaintext.toString('utf8') !== canonicalJson(manifest)) fail('ARCHIVE_MANIFEST_INVALID', 'Authenticated archive manifest is not canonical.');
  const core = { ...manifest }; delete core.manifestChecksum;
  if (manifest.manifestChecksum !== expectedManifestChecksum || sha256(Buffer.from(canonicalJson(core))) !== expectedManifestChecksum || manifest.applicationCommit !== expectedArchiveApplicationCommit ||
      openedArchive.header?.captureId !== manifest.captureId || openedArchive.header?.sourceDatabaseId !== manifest.sourceDatabaseId || openedArchive.header?.manifestVersion !== manifest.version ||
      restoreEvidence.restoreCaptureId !== manifest.captureId || manifest.routeInventoryVersion !== expectedSourceInventory.version || manifest.routeInventoryDigest !== expectedSourceInventory.digest) {
    fail('QUARANTINE_EVIDENCE_MISMATCH', 'Archive header, manifest, commit, or checksum does not match approved evidence.');
  }
  if (!Number.isFinite(Date.parse(manifest.capturedAt)) || Date.parse(manifest.capturedAt) < cutoffMs) fail('QUARANTINE_CUTOFF_INVALID', 'Archive capture predates the approved stale-state cutoff.');
  const records = recordMap(manifest);
  let priorKey = null;
  for (const record of manifest.records) {
    const key = raw(record.key);
    const classification = classifyKey(key);
    if (classification.classification !== 'submarine-owned' || classification.family !== record.family || (priorKey && Buffer.compare(priorKey, key) >= 0)) fail('ARCHIVE_MANIFEST_INVALID', 'Archive manifest key classification or ordering is invalid.');
    priorKey = key;
  }
  if ([...records.keys()].some((key) => key.startsWith('sd:pvp:escrow:'))) fail('PVP_ECONOMIC_BLOCKER', 'Archived PVP state contains escrow keys.');

  const rooms = new Map();
  const matches = new Map();
  const memberships = new Map();
  const invites = new Map();
  let roomIndex = [];
  for (const [key, record] of records) {
    if (key === 'sd:pvp:rooms:all') roomIndex = setValues(record, 'PVP room index');
    else if (key.startsWith('sd:pvp:room:')) rooms.set(key.slice(12), { key, record, value: jsonValue(record, 'PVP room') });
    else if (key.startsWith('sd:pvp:match:')) matches.set(key.slice(13), { key, record, value: jsonValue(record, 'PVP match') });
    else if (key.startsWith('sd:pvp:room-membership:')) memberships.set(key.slice(23), { key, record, roomId: stringValue(record, 'PVP membership') });
    else if (key.startsWith('sd:pvp:invite:')) invites.set(key.slice(14), jsonValue(record, 'PVP invite'));
  }

  const activeRooms = new Map();
  for (const [roomId, item] of rooms) {
    const room = item.value;
    const validSlot = (slot) => slot && typeof slot.userId === 'string' && typeof slot.loginId === 'string' && typeof slot.skinId === 'string' && typeof slot.connected === 'boolean' && typeof slot.ready === 'boolean';
    if (room.roomId !== roomId || ![...ROOM_TERMINAL, ...ACTIVE_ROOM_PHASES].includes(room.phase)) fail('ARCHIVE_GRAPH_INVALID', 'Archived PVP room identity or phase is invalid.');
    validateEconomicsWherePresent(room, true, 'Archived PVP room');
    if (ROOM_TERMINAL.has(room.phase)) continue;
    if (!exactKeys(room, ['roomId', 'ownerUserId', 'phase', 'version', 'config', 'slots', 'pendingInviteId', 'matchId', 'escrow', 'createdAt', 'updatedAt']) ||
        !exactKeys(room.config, ['format', 'powerUpMode', 'betting', 'p1Bet', 'p2Bet']) || !exactKeys(room.escrow, ['status']) ||
        !exactKeys(room.slots, ['host', 'guest']) || !exactKeys(room.slots?.host, ['userId', 'loginId', 'skinId', 'connected', 'ready']) ||
        (room.slots?.guest !== null && !exactKeys(room.slots?.guest, ['userId', 'loginId', 'skinId', 'connected', 'ready'])) ||
        !Number.isSafeInteger(room.version) || room.version < 0 || room.version >= Number.MAX_SAFE_INTEGER || !Number.isSafeInteger(room.createdAt) || !Number.isSafeInteger(room.updatedAt) || room.updatedAt < room.createdAt ||
        typeof room.ownerUserId !== 'string' || !validSlot(room.slots?.host) || room.ownerUserId !== room.slots.host.userId || (room.slots.guest !== null && !validSlot(room.slots.guest)) ||
        !['single', 'bo3', 'bo5'].includes(room.config?.format) || !['inventory', 'earned', 'none', 'score_attack'].includes(room.config?.powerUpMode) ||
        (room.pendingInviteId !== null && typeof room.pendingInviteId !== 'string') || (room.matchId !== null && typeof room.matchId !== 'string')) fail('ARCHIVE_GRAPH_INVALID', 'Archived PVP room schema is invalid.');
    if (room.updatedAt > cutoffMs) fail('PVP_NOT_STALE_OR_UNKNOWN', 'Archived PVP room is not safely stale.');
    validateZeroEconomics(room, true);
    activeRooms.set(roomId, item);
  }

  const activeMatches = new Map();
  for (const [matchId, item] of matches) {
    const match = item.value;
    if (match.matchId !== matchId || ![...MATCH_TERMINAL, ...ACTIVE_MATCH_PHASES].includes(match.phase)) fail('ARCHIVE_GRAPH_INVALID', 'Archived PVP match identity or phase is invalid.');
    validateEconomicsWherePresent(match, false, 'Archived PVP match');
    if (MATCH_TERMINAL.has(match.phase)) continue;
    const legacyInit = match.phase === 'INIT' && exactKeys(match, ['matchId', 'roomId', 'phase', 'createdAt', 'config', 'players']);
    const modern = exactKeys(match, ['matchId', 'roomId', 'phase', 'createdAt', 'updatedAt', 'seed', 'countdownStartedAt', 'config', 'players', 'inputs', 'snapshot', 'winnerSlot', 'completedAt', 'series']);
    if ((!legacyInit && !modern) || !exactKeys(match.config, ['format', 'powerUpMode', 'betting', 'p1Bet', 'p2Bet']) || !exactKeys(match.players, ['host', 'guest']) ||
        !exactKeys(match.players?.host, ['userId', 'loginId', 'skinId', 'connected', 'ready']) || !exactKeys(match.players?.guest, ['userId', 'loginId', 'skinId', 'connected', 'ready']) ||
        !Number.isSafeInteger(match.createdAt) || (modern && (!Number.isSafeInteger(match.updatedAt) || match.updatedAt < match.createdAt)) ||
        typeof match.roomId !== 'string' || typeof match.players?.host?.userId !== 'string' || typeof match.players?.guest?.userId !== 'string') fail('ARCHIVE_GRAPH_INVALID', 'Archived PVP match schema is invalid.');
    if ((legacyInit ? match.createdAt : match.updatedAt) > cutoffMs) fail('PVP_NOT_STALE_OR_UNKNOWN', 'Archived PVP match is not safely stale.');
    validateZeroEconomics(match, false);
    activeMatches.set(matchId, item);
    const linkedRoom = rooms.get(match.roomId)?.value;
    if (!linkedRoom || (linkedRoom.matchId !== null && linkedRoom.matchId !== matchId) ||
        linkedRoom.slots?.host?.userId !== match.players.host.userId || linkedRoom.slots?.guest?.userId !== match.players.guest.userId) {
      fail('ARCHIVE_GRAPH_INVALID', 'Archived PVP room, player, and match relationships conflict.');
    }
  }

  for (const [roomId, { value: room }] of activeRooms) {
    if (room.matchId === null) continue;
    const linkedMatch = matches.get(room.matchId)?.value;
    if (!linkedMatch || linkedMatch.roomId !== roomId || linkedMatch.players?.host?.userId !== room.slots.host.userId || linkedMatch.players?.guest?.userId !== room.slots.guest?.userId) {
      fail('ARCHIVE_GRAPH_INVALID', 'Archived active room match reference is missing or conflicts.');
    }
    validateEconomicsWherePresent(linkedMatch, false, 'Archived referenced PVP match');
  }

  const expectedIndex = [...activeRooms.keys()].sort();
  if (canonicalJson([...new Set(roomIndex)].sort()) !== canonicalJson(expectedIndex) || roomIndex.length !== new Set(roomIndex).size) fail('ARCHIVE_GRAPH_INVALID', 'Archived PVP room index is inconsistent.');
  const expectedMemberships = new Map();
  for (const [roomId, { value: room }] of activeRooms) {
    for (const slot of [room.slots.host, room.slots.guest].filter(Boolean)) {
      if (expectedMemberships.has(slot.userId)) fail('ARCHIVE_GRAPH_INVALID', 'Archived PVP user belongs to multiple active rooms.');
      expectedMemberships.set(slot.userId, roomId);
    }
    if (room.pendingInviteId !== null) {
      const invite = invites.get(room.pendingInviteId);
      if (!invite || invite.roomId !== roomId) fail('ARCHIVE_GRAPH_INVALID', 'Archived PVP pending invite relationship is invalid.');
    }
  }
  if (memberships.size !== expectedMemberships.size || [...memberships].some(([userId, item]) => expectedMemberships.get(userId) !== item.roomId)) fail('ARCHIVE_GRAPH_INVALID', 'Archived PVP membership graph is inconsistent.');
  const expectedInviteIndexes = new Map();
  for (const [inviteId, invite] of invites) {
    if (!exactKeys(invite, ['inviteId', 'roomId', 'fromUserId', 'fromLoginId', 'toUserId', 'toLoginId', 'status', 'createdAt', 'expiresAt', 'resolvedAt']) ||
        invite.inviteId !== inviteId || typeof invite.roomId !== 'string' || typeof invite.fromUserId !== 'string' || typeof invite.fromLoginId !== 'string' ||
        typeof invite.toUserId !== 'string' || typeof invite.toLoginId !== 'string' || invite.fromUserId === invite.toUserId ||
        !['PENDING', 'ACCEPTED', 'DECLINED', 'CANCELED', 'EXPIRED'].includes(invite.status) || !Number.isSafeInteger(invite.createdAt) || !Number.isSafeInteger(invite.expiresAt) || invite.expiresAt < invite.createdAt ||
        (invite.resolvedAt !== null && !Number.isSafeInteger(invite.resolvedAt)) || (invite.status === 'PENDING' && invite.resolvedAt !== null) ||
        (invite.status !== 'PENDING' && !Number.isSafeInteger(invite.resolvedAt)) || !rooms.has(invite.roomId)) fail('ARCHIVE_GRAPH_INVALID', 'Archived PVP invite schema or room relationship is invalid.');
    if (invite.status === 'PENDING' && invite.expiresAt > cutoffMs) {
      if (!expectedInviteIndexes.has(invite.toUserId)) expectedInviteIndexes.set(invite.toUserId, []);
      expectedInviteIndexes.get(invite.toUserId).push(inviteId);
      fail('PVP_ENTITLEMENT_BLOCKER', 'Archived PVP state contains an unresolved invite entitlement.');
    }
  }
  const actualInviteIndexes = new Map();
  for (const [key, record] of records) if (key.startsWith('sd:pvp:user-invites:')) actualInviteIndexes.set(key.slice(20), setValues(record, 'PVP invite index').sort());
  const indexedUsers = new Set([...actualInviteIndexes.keys(), ...expectedInviteIndexes.keys()]);
  for (const userId of indexedUsers) {
    if (canonicalJson(actualInviteIndexes.get(userId) ?? []) !== canonicalJson((expectedInviteIndexes.get(userId) ?? []).sort())) fail('ARCHIVE_GRAPH_INVALID', 'Archived PVP invite index is inconsistent.');
  }
  if (activeRooms.size === 0 && activeMatches.size === 0) fail('NO_STALE_PVP_TARGETS', 'Archive contains no active PVP targets to quarantine.');

  const expectedStrings = [];
  const expectedSets = [];
  const graphRecords = [...records].filter(([key]) => key === 'sd:pvp:rooms:all' ||
    ['sd:pvp:room:', 'sd:pvp:match:', 'sd:pvp:room-membership:', 'sd:pvp:invite:', 'sd:pvp:user-invites:'].some((prefix) => key.startsWith(prefix)));
  for (const item of [...rooms.values(), ...matches.values(), ...memberships.values()]) {
    expectedStrings.push([item.key, stringValue(item.record, 'PVP graph record')]);
  }
  for (const [key, record] of records) {
    if (key.startsWith('sd:pvp:invite:')) expectedStrings.push([key, stringValue(record, 'PVP invite graph record')]);
    if (key.startsWith('sd:pvp:user-invites:')) expectedSets.push([key, setValues(record, 'PVP invite index')]);
  }
  return {
    archiveSha256: expectedArchiveSha256, manifestChecksum: expectedManifestChecksum, archiveApplicationCommit: expectedArchiveApplicationCommit,
    sourceInventoryVersion: expectedSourceInventory.version, sourceInventoryDigest: expectedSourceInventory.digest,
    restoreReportSha256: restoreEvidence.restoreReportSha256, restoreCaptureId: restoreEvidence.restoreCaptureId,
    capturedAtMs: Date.parse(manifest.capturedAt), cutoffMs,
    roomIndexMembers: expectedIndex,
    expectedStrings, expectedSets, expectedKeys: graphRecords.map(([key]) => key).sort(),
    activeRooms: [...activeRooms].map(([roomId, item]) => ({ roomId, key: item.key, value: item.value })),
    activeMatches: [...activeMatches].map(([matchId, item]) => ({ matchId, key: item.key, value: item.value })),
    membershipKeys: [...memberships.values()].map((item) => item.key),
    beforeChecksum: aggregateChecksum([
      ...expectedStrings.map(([key, value]) => [key, `pttl:-1|string:${value}`]),
      ...expectedSets.map(([key, members]) => [key, `pttl:-1|set:${canonicalJson([...members].sort())}`]),
      ['sd:pvp:rooms:all', `pttl:-1|set:${canonicalJson(expectedIndex)}`],
    ]),
  };
}

export const QUARANTINE_STALE_PVP_LUA = `
local spec = cjson.decode(ARGV[1])
if (redis.call('GET', KEYS[1]) or 'open') ~= 'closed' then return {0, 'gate_not_closed'} end
if tostring(redis.call('GET', KEYS[2]) or '1') ~= tostring(spec.epoch) then return {0, 'epoch_changed'} end
if tonumber(redis.call('ZCARD', KEYS[3])) ~= 0 then return {0, 'active_leases'} end
if redis.call('GET', KEYS[4]) == '1' then return {0, 'hard_failure'} end
local existing = redis.call('HGET', KEYS[5], 'outcome')
if existing then
  if existing == 'quarantined' and redis.call('HGET', KEYS[5], 'afterChecksum') == spec.afterChecksum and
     redis.call('HGET', KEYS[5], 'archiveSha256') == spec.archiveSha256 and redis.call('HGET', KEYS[5], 'manifestChecksum') == spec.manifestChecksum and
     redis.call('HGET', KEYS[5], 'epoch') == tostring(spec.epoch) and redis.call('HGET', KEYS[5], 'archiveApplicationCommit') == spec.archiveApplicationCommit and
     redis.call('HGET', KEYS[5], 'executingRuntimeCommit') == spec.executingRuntimeCommit and
     redis.call('HGET', KEYS[5], 'sourceInventoryVersion') == tostring(spec.sourceInventoryVersion) and redis.call('HGET', KEYS[5], 'sourceInventoryDigest') == spec.sourceInventoryDigest and
     redis.call('HGET', KEYS[5], 'executingInventoryVersion') == tostring(spec.executingInventoryVersion) and redis.call('HGET', KEYS[5], 'executingInventoryDigest') == spec.executingInventoryDigest and
     redis.call('HGET', KEYS[5], 'restoreReportSha256') == spec.restoreReportSha256 and redis.call('HGET', KEYS[5], 'restoreCaptureId') == spec.restoreCaptureId and
     redis.call('HGET', KEYS[5], 'beforeChecksum') == spec.beforeChecksum and redis.call('HGET', KEYS[5], 'cutoffMs') == tostring(spec.cutoffMs) and
     redis.call('HGET', KEYS[5], 'roomCount') == tostring(spec.roomCount) and redis.call('HGET', KEYS[5], 'matchCount') == tostring(spec.matchCount) and
     redis.call('HGET', KEYS[5], 'operatorId') == spec.operatorId and redis.call('HGET', KEYS[5], 'quarantinedAtMs') == tostring(spec.quarantinedAtMs) then
    for _, item in ipairs(spec.updates) do if redis.call('TYPE', KEYS[item.keyIndex]).ok ~= 'string' or redis.call('PTTL', KEYS[item.keyIndex]) ~= -1 or redis.call('GET', KEYS[item.keyIndex]) ~= item.value then return {0, 'idempotent_after_state_mismatch'} end end
    for _, key_index in ipairs(spec.deleteKeyIndexes) do if redis.call('EXISTS', KEYS[key_index]) ~= 0 then return {0, 'idempotent_after_state_mismatch'} end end
    if redis.call('EXISTS', KEYS[6]) ~= 0 then return {0, 'idempotent_room_index_not_absent'} end
    local changed = {}
    for _, item in ipairs(spec.updates) do changed[item.keyIndex] = true end
    for _, key_index in ipairs(spec.deleteKeyIndexes) do changed[key_index] = true end
    for _, item in ipairs(spec.expectedStrings) do if not changed[item.keyIndex] and (redis.call('TYPE', KEYS[item.keyIndex]).ok ~= 'string' or redis.call('PTTL', KEYS[item.keyIndex]) ~= -1 or redis.call('GET', KEYS[item.keyIndex]) ~= item.value) then return {0, 'idempotent_unchanged_state_mismatch'} end end
    for _, item in ipairs(spec.expectedSets) do
      if redis.call('TYPE', KEYS[item.keyIndex]).ok ~= 'set' or redis.call('PTTL', KEYS[item.keyIndex]) ~= -1 or tonumber(redis.call('SCARD', KEYS[item.keyIndex])) ~= #item.members then return {0, 'idempotent_unchanged_state_mismatch'} end
      for _, member in ipairs(item.members) do if redis.call('SISMEMBER', KEYS[item.keyIndex], member) ~= 1 then return {0, 'idempotent_unchanged_state_mismatch'} end end
    end
    local expected_after = {}
    for _, key in ipairs(spec.expectedAfterKeys) do expected_after[key] = true end
    local cursor_after = '0'
    repeat
      local page_after = redis.call('SCAN', cursor_after, 'MATCH', 'sd:pvp:*', 'COUNT', 1000)
      cursor_after = tostring(page_after[1])
      for _, key in ipairs(page_after[2]) do if not expected_after[key] then return {0, 'idempotent_unexpected_pvp_key'} end end
    until cursor_after == '0'
    return {2, 'already_quarantined'}
  end
  return {0, 'audit_conflict'}
end
local now = redis.call('TIME')
local now_ms = (tonumber(now[1]) * 1000) + math.floor(tonumber(now[2]) / 1000)
if math.abs(now_ms - tonumber(spec.quarantinedAtMs)) > 60000 then return {0, 'operator_time_out_of_bounds'} end
if tonumber(spec.capturedAtMs) > now_ms then return {0, 'archive_capture_in_future'} end
if tonumber(spec.cutoffMs) > now_ms - tonumber(spec.minStaleAgeMs) then return {0, 'cutoff_too_recent'} end
local expected_key_set = {}
for _, key in ipairs(spec.expectedKeys) do expected_key_set[key] = true end
local seen_key_set = {}
local cursor = '0'
local scan_pages = 0
repeat
  scan_pages = scan_pages + 1
  if scan_pages > 10000 then return {0, 'pvp_scan_page_limit'} end
  local page = redis.call('SCAN', cursor, 'MATCH', 'sd:pvp:*', 'COUNT', 1000)
  cursor = tostring(page[1])
  for _, key in ipairs(page[2]) do if not expected_key_set[key] then return {0, 'unexpected_pvp_key'} else seen_key_set[key] = true end end
until cursor == '0'
for _, key in ipairs(spec.expectedKeys) do if not seen_key_set[key] then return {0, 'missing_pvp_key'} end end
for _, item in ipairs(spec.expectedStrings) do
  if redis.call('TYPE', KEYS[item.keyIndex]).ok ~= 'string' or redis.call('PTTL', KEYS[item.keyIndex]) ~= -1 or redis.call('GET', KEYS[item.keyIndex]) ~= item.value then return {0, 'cas_mismatch'} end
end
for _, item in ipairs(spec.expectedSets) do
  if redis.call('TYPE', KEYS[item.keyIndex]).ok ~= 'set' or redis.call('PTTL', KEYS[item.keyIndex]) ~= -1 or tonumber(redis.call('SCARD', KEYS[item.keyIndex])) ~= #item.members then return {0, 'cas_mismatch'} end
  for _, member in ipairs(item.members) do if redis.call('SISMEMBER', KEYS[item.keyIndex], member) ~= 1 then return {0, 'cas_mismatch'} end end
end
if redis.call('TYPE', KEYS[6]).ok ~= 'set' or redis.call('PTTL', KEYS[6]) ~= -1 or tonumber(redis.call('SCARD', KEYS[6])) ~= #spec.indexBefore then return {0, 'index_mismatch'} end
for _, room_id in ipairs(spec.indexBefore) do if redis.call('SISMEMBER', KEYS[6], room_id) ~= 1 then return {0, 'index_mismatch'} end end
for _, item in ipairs(spec.updates) do redis.call('SET', KEYS[item.keyIndex], item.value) end
for _, key_index in ipairs(spec.deleteKeyIndexes) do redis.call('DEL', KEYS[key_index]) end
for _, room_id in ipairs(spec.indexBefore) do redis.call('SREM', KEYS[6], room_id) end
redis.call('HSET', KEYS[5],
  'archiveSha256', spec.archiveSha256, 'manifestChecksum', spec.manifestChecksum,
  'beforeChecksum', spec.beforeChecksum, 'afterChecksum', spec.afterChecksum,
  'roomCount', tostring(spec.roomCount), 'matchCount', tostring(spec.matchCount),
  'cutoffMs', tostring(spec.cutoffMs), 'epoch', tostring(spec.epoch),
  'archiveApplicationCommit', spec.archiveApplicationCommit, 'executingRuntimeCommit', spec.executingRuntimeCommit,
  'sourceInventoryVersion', tostring(spec.sourceInventoryVersion), 'sourceInventoryDigest', spec.sourceInventoryDigest,
  'executingInventoryVersion', tostring(spec.executingInventoryVersion), 'executingInventoryDigest', spec.executingInventoryDigest,
  'restoreReportSha256', spec.restoreReportSha256, 'restoreCaptureId', spec.restoreCaptureId, 'operatorId', spec.operatorId,
  'quarantinedAtMs', tostring(spec.quarantinedAtMs), 'recordedAtMs', tostring(now_ms), 'outcome', 'quarantined')
return {1, 'quarantined', now_ms}
`;

export function quarantineAuditKey(archiveSha256) {
  if (!/^[a-f0-9]{64}$/.test(archiveSha256 || '')) fail('QUARANTINE_EVIDENCE_INVALID', 'Archive checksum is invalid.');
  return `sd:migration:control:stale-pvp-audit:${archiveSha256}`;
}

export function quarantineTransaction({ plan, epoch, operatorId, quarantinedAtMs, executingRuntimeCommit }) {
  if (!Number.isSafeInteger(epoch) || epoch < 1 || !Number.isSafeInteger(quarantinedAtMs) || !/^[a-f0-9]{40}$/.test(executingRuntimeCommit || '') ||
      !/^[A-Za-z0-9._:@-]{1,128}$/.test(operatorId || '')) fail('QUARANTINE_OPERATOR_INPUT_INVALID', 'Quarantine operator input is invalid.');
  if (plan.capturedAtMs > quarantinedAtMs || plan.cutoffMs > quarantinedAtMs - QUARANTINE_MIN_STALE_AGE_MS) fail('QUARANTINE_STALENESS_INVALID', 'Archive timestamps or cutoff do not satisfy the code-owned stale-age policy.');
  const keys = ['sd:migration:control:gate', 'sd:migration:control:epoch', 'sd:migration:control:leases', 'sd:migration:control:hard-failure',
    quarantineAuditKey(plan.archiveSha256), 'sd:pvp:rooms:all'];
  const keyIndex = new Map(keys.map((key, index) => [key, index + 1]));
  const indexFor = (key) => {
    if (!keyIndex.has(key)) { keys.push(key); keyIndex.set(key, keys.length); }
    return keyIndex.get(key);
  };
  const updates = [];
  const updatedValues = new Map();
  for (const room of plan.activeRooms) {
    const value = canonicalJson({ ...room.value, phase: 'CANCELED', version: room.value.version + 1, updatedAt: quarantinedAtMs, pendingInviteId: null, matchId: null });
    updates.push({ keyIndex: indexFor(room.key), value }); updatedValues.set(room.key, value);
  }
  for (const match of plan.activeMatches) {
    const value = canonicalJson({ ...match.value, phase: 'ABORTED', updatedAt: quarantinedAtMs, abortedAt: quarantinedAtMs });
    updates.push({ keyIndex: indexFor(match.key), value }); updatedValues.set(match.key, value);
  }
  const expectedStrings = plan.expectedStrings.map(([key, value]) => ({ keyIndex: indexFor(key), value }));
  const expectedSets = plan.expectedSets.map(([key, members]) => ({ keyIndex: indexFor(key), members }));
  const deleteKeyIndexes = plan.membershipKeys.map(indexFor);
  const membershipSet = new Set(plan.membershipKeys);
  const expectedAfterKeys = plan.expectedKeys.filter((key) => !membershipSet.has(key));
  const afterGraph = [
    ...plan.expectedStrings.map(([key, value]) => [key, membershipSet.has(key) ? '<absent>' : `pttl:-1|string:${updatedValues.get(key) ?? value}`]),
    ...plan.expectedSets.map(([key, members]) => [key, `pttl:-1|set:${canonicalJson([...members].sort())}`]),
    ['sd:pvp:rooms:all', '<absent>'],
  ];
  const afterChecksum = aggregateChecksum(afterGraph);
  return {
    keys,
    spec: {
      epoch, quarantinedAtMs, operatorId, updates, expectedStrings, expectedSets, expectedKeys: plan.expectedKeys, expectedAfterKeys,
      deleteKeyIndexes, indexBefore: plan.roomIndexMembers,
      archiveSha256: plan.archiveSha256, manifestChecksum: plan.manifestChecksum, beforeChecksum: plan.beforeChecksum, afterChecksum,
      roomCount: plan.activeRooms.length, matchCount: plan.activeMatches.length, cutoffMs: plan.cutoffMs, capturedAtMs: plan.capturedAtMs,
      minStaleAgeMs: QUARANTINE_MIN_STALE_AGE_MS, archiveApplicationCommit: plan.archiveApplicationCommit, executingRuntimeCommit,
      sourceInventoryVersion: plan.sourceInventoryVersion, sourceInventoryDigest: plan.sourceInventoryDigest,
      executingInventoryVersion: ROUTE_INVENTORY_VERSION, executingInventoryDigest: ROUTE_INVENTORY_DIGEST,
      restoreReportSha256: plan.restoreReportSha256, restoreCaptureId: plan.restoreCaptureId,
    },
    afterChecksum,
  };
}

export const QUARANTINE_REDIS_TIME_LUA = `
local now = redis.call('TIME')
return {now[1], now[2]}
`;

export async function readQuarantineRedisTime(adapter) {
  let result;
  try { result = await adapter.eval(QUARANTINE_REDIS_TIME_LUA, [], []); }
  catch { fail('QUARANTINE_REDIS_TIME_FAILED', 'Redis time could not be read; no quarantine transaction was attempted.'); }
  const seconds = Number(result?.[0]);
  const microseconds = Number(result?.[1]);
  const milliseconds = (seconds * 1000) + Math.floor(microseconds / 1000);
  if (!Number.isSafeInteger(seconds) || seconds < 0 || !Number.isSafeInteger(microseconds) || microseconds < 0 || microseconds > 999999 || !Number.isSafeInteger(milliseconds)) {
    fail('QUARANTINE_REDIS_TIME_FAILED', 'Redis time response is invalid; no quarantine transaction was attempted.');
  }
  return milliseconds;
}

export async function executeQuarantineTransaction(adapter, transaction) {
  let result;
  try { result = await adapter.eval(QUARANTINE_STALE_PVP_LUA, transaction.keys, [canonicalJson(transaction.spec)]); }
  catch { fail('QUARANTINE_TRANSACTION_AMBIGUOUS', 'Quarantine transaction result is ambiguous; keep the gate closed and verify state.'); }
  if (Number(result?.[0]) === 1) return { outcome: 'quarantined', afterChecksum: transaction.afterChecksum };
  if (Number(result?.[0]) === 2) return { outcome: 'already_quarantined', afterChecksum: transaction.afterChecksum };
  fail('QUARANTINE_TRANSACTION_REJECTED', 'Quarantine transaction rejected its atomic preconditions; the gate remains closed.');
}
