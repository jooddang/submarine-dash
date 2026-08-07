import { createHash } from 'node:crypto';
import { PRODUCTION_KEY_FAMILIES, ROUTE_INVENTORY_DIGEST, ROUTE_INVENTORY_VERSION, SUBMARINE_PRESERVATION_KEY_SPECS } from '../../shared/productionRouteInventory.js';
import { canonicalJson, compareBytes, lengthPrefixed, sha256 } from './canonical.mjs';

export const MANIFEST_VERSION = 'sd-manifest-v1';
export const PROTECTED_LOGINS = Object.freeze(['jooddang', 'oceanlord']);

function compilePattern(pattern) {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replaceAll('\\{segment\\}', '[^:]+').replaceAll('\\{opaque\\}', '.+')}$`);
}

const familyMatchers = SUBMARINE_PRESERVATION_KEY_SPECS.map((spec) => ({ ...spec, matcher: compilePattern(spec.pattern) }));
const uncoveredRouteFamilies = PRODUCTION_KEY_FAMILIES.filter((family) =>
  !SUBMARINE_PRESERVATION_KEY_SPECS.some((spec) => spec.routeFamilies.includes(family)));
if (uncoveredRouteFamilies.length) throw new Error('preservation inventory does not cover every production route family');

export function classifyKey(key) {
  const bytes = Buffer.from(key);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) return { classification: 'unknown', family: null };
  const match = familyMatchers.find(({ matcher }) => matcher.test(text));
  if (match) return { classification: 'submarine-owned', family: match.id, ttl: match.ttl };
  if (text.startsWith('sd:') || text.startsWith('submarine-dash:')) return { classification: 'unknown', family: null };
  return { classification: 'foreign', family: null };
}

function b64(bytes) { return Buffer.from(bytes).toString('base64'); }
function raw(encoded) {
  if (typeof encoded !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error('manifest contains invalid base64');
  const decoded = Buffer.from(encoded, 'base64');
  if (decoded.toString('base64') !== encoded) throw new Error('manifest contains non-canonical base64');
  return decoded;
}

export function validateRecord(record) {
  raw(record.key);
  if (!['string', 'list', 'set', 'hash', 'zset'].includes(record.type) || !Number.isInteger(record.pttl)) throw new Error('manifest record shape is invalid');
  if (record.foreignMetadata === true) return record;
  if (!record.value || typeof record.value !== 'object' || Array.isArray(record.value)) throw new Error('manifest record value shape is invalid');
  if (record.type === 'string') {
    if (Object.keys(record.value).join() !== 'data') throw new Error('string record shape is invalid');
    raw(record.value.data);
  }
  if (record.type === 'list' || record.type === 'set') {
    const field = record.type === 'list' ? 'items' : 'members';
    if (Object.keys(record.value).join() !== field || !Array.isArray(record.value[field])) throw new Error(`${record.type} record shape is invalid`);
    record.value[field].forEach(raw);
  }
  if (record.type === 'hash' || record.type === 'zset') {
    if (Object.keys(record.value).join() !== 'pairs' || !Array.isArray(record.value.pairs)) throw new Error(`${record.type} record shape is invalid`);
    record.value.pairs.forEach((pair) => {
      if (!pair || typeof pair !== 'object' || Array.isArray(pair)) throw new Error(`${record.type} pair shape is invalid`);
      if (record.type === 'hash') { if (Object.keys(pair).sort().join() !== 'field,value') throw new Error('hash pair shape is invalid'); raw(pair.field); raw(pair.value); }
      else { if (Object.keys(pair).sort().join() !== 'member,score') throw new Error('zset pair shape is invalid'); raw(pair.member); raw(pair.score); }
    });
  }
  return record;
}

export function normalizeValue(type, result) {
  if (type === 'string') return { data: b64(result) };
  if (type === 'list') return { items: result.map(b64) };
  if (type === 'set') return { members: result.map(Buffer.from).sort(compareBytes).map(b64) };
  if (type === 'hash') {
    if (result.length % 2) throw new Error('hash response has an odd field/value count');
    const pairs = [];
    for (let index = 0; index < result.length; index += 2) pairs.push({ field: b64(result[index]), value: b64(result[index + 1]) });
    pairs.sort((left, right) => compareBytes(raw(left.field), raw(right.field)));
    if (pairs.some((pair, index) => index && pair.field === pairs[index - 1].field)) throw new Error('hash response contains duplicate fields');
    return { pairs };
  }
  if (type === 'zset') {
    if (result.length % 2) throw new Error('zset response has an odd member/score count');
    const pairs = [];
    for (let index = 0; index < result.length; index += 2) pairs.push({ member: b64(result[index]), score: b64(result[index + 1]) });
    pairs.sort((left, right) => compareBytes(raw(left.member), raw(right.member)));
    if (pairs.some((pair, index) => index && pair.member === pairs[index - 1].member)) throw new Error('zset response contains duplicate members');
    return { pairs };
  }
  throw new Error(`unsupported Redis type: ${type}`);
}

function valueParts(record) {
  const value = record.value;
  if (record.type === 'string') return [lengthPrefixed(raw(value.data))];
  if (record.type === 'list') return value.items.flatMap((item, index) => [lengthPrefixed(Buffer.from(String(index))), lengthPrefixed(raw(item))]);
  if (record.type === 'set') return value.members.map((member) => lengthPrefixed(raw(member)));
  if (record.type === 'hash') return value.pairs.flatMap(({ field, value: item }) => [lengthPrefixed(raw(field)), lengthPrefixed(raw(item))]);
  if (record.type === 'zset') return value.pairs.flatMap(({ member, score }) => [lengthPrefixed(raw(member)), lengthPrefixed(raw(score))]);
  throw new Error('unsupported record type');
}

export function recordChecksum(record) {
  validateRecord(record);
  const frame = Buffer.concat([
    lengthPrefixed(raw(record.key)), lengthPrefixed(Buffer.from(record.type)),
    lengthPrefixed(Buffer.from(String(record.pttl))), ...valueParts(record),
  ]);
  return sha256(frame);
}

function jsonString(record) {
  if (record?.type !== 'string') return null;
  try { return JSON.parse(raw(record.value.data).toString('utf8')); } catch { return null; }
}

function leaderboardAssociations(records, normalizedLogin) {
  const associations = [];
  for (const record of records) {
    const key = raw(record.key).toString('utf8');
    if (!key.startsWith('submarine-dash:leaderboard')) continue;
    const document = jsonString(record);
    const weeks = document?.weeks && typeof document.weeks === 'object' ? document.weeks : { legacy: { entries: Array.isArray(document) ? document : [] } };
    for (const [weekId, week] of Object.entries(weeks)) {
      const entries = Array.isArray(week?.entries) ? week.entries : [];
      entries.forEach((entry, sourceIndex) => {
        const originalLoginId = typeof entry?.userId === 'string' ? entry.userId : typeof entry?.loginId === 'string' ? entry.loginId : '';
        if (originalLoginId.toLowerCase() !== normalizedLogin) return;
        associations.push({ weekId, sourceIndex, originalLoginId, entryChecksum: sha256(Buffer.from(canonicalJson(entry))) });
      });
    }
  }
  return associations.sort((left, right) => left.weekId.localeCompare(right.weekId) || left.sourceIndex - right.sourceIndex);
}

const VALUE_LINK_FIELDS = Object.freeze({
  'pvp-room': new Set(['ownerUserId', 'userId']),
  'pvp-match': new Set(['userId']),
  'pvp-invite': new Set(['fromUserId', 'toUserId']),
});

function jsonHasLinkedUser(value, userId, permittedFields) {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((item) => jsonHasLinkedUser(item, userId, permittedFields));
  return Object.entries(value).some(([field, item]) =>
    (permittedFields.has(field) && item === userId) || jsonHasLinkedUser(item, userId, permittedFields));
}

function collectionHasExactMember(record, userId) {
  const expected = Buffer.from(userId);
  if (record.type === 'list') return record.value.items.some((item) => raw(item).equals(expected));
  if (record.type === 'set') return record.value.members.some((item) => raw(item).equals(expected));
  if (record.type === 'zset') return record.value.pairs.some(({ member }) => raw(member).equals(expected));
  if (record.type === 'hash') return record.value.pairs.some(({ field, value }) => raw(field).equals(expected) || raw(value).equals(expected));
  return false;
}

function valueLinksUser(record, userId) {
  const permittedFields = VALUE_LINK_FIELDS[record.family];
  if (permittedFields && jsonHasLinkedUser(jsonString(record), userId, permittedFields)) return true;
  return record.family.startsWith('pvp-') && record.type !== 'string' && collectionHasExactMember(record, userId);
}

function protectedAccount(records, login) {
  const indexKey = Buffer.from(`sd:loginId:${login}`);
  const index = records.find((record) => raw(record.key).equals(indexKey));
  if (!index || index.type !== 'string') throw new Error(`protected login index is missing: ${login}`);
  const userId = raw(index.value.data);
  const userKey = Buffer.concat([Buffer.from('sd:user:'), userId]);
  const user = records.find((record) => raw(record.key).equals(userKey));
  const userDocument = jsonString(user);
  if (!user || !userDocument || typeof userDocument.loginId !== 'string' || userDocument.loginId.toLowerCase() !== login ||
      typeof userDocument.userId !== 'string' || !Buffer.from(userDocument.userId).equals(userId)) {
    throw new Error(`protected user association is invalid: ${login}`);
  }
  const associated = records.filter((record) => {
    const key = raw(record.key);
    return key.equals(indexKey) || key.equals(userKey) || key.toString('utf8').split(':').includes(userDocument.userId) || valueLinksUser(record, userDocument.userId);
  });
  const leaderboard = leaderboardAssociations(records, login);
  if (leaderboard.length === 0) throw new Error(`protected leaderboard association is missing: ${login}`);
  const durableAssociated = associated.filter((record) => record.ttlClassification === 'durable');
  const ephemeralAssociated = associated.filter((record) => record.ttlClassification === 'ephemeral');
  const checksums = durableAssociated.map(recordChecksum).sort();
  return {
    originalLoginId: userDocument.loginId,
    loginIndexChecksum: recordChecksum(index),
    userRecordChecksum: recordChecksum(user),
    associatedRecordCount: associated.length,
    durableAssociatedRecordCount: durableAssociated.length,
    ephemeralAssociatedRecordCount: ephemeralAssociated.length,
    associatedRecordsChecksum: sha256(Buffer.from(checksums.join('\n'))),
    leaderboardAssociationCount: leaderboard.length,
    leaderboardAssociations: leaderboard,
    leaderboardChecksum: sha256(Buffer.from(canonicalJson(leaderboard))),
  };
}

export function buildManifest({ records, capturedAt, sourceDatabaseId, captureId, applicationCommit, skippedEphemeral = [], foreignChurn = [], verifierVersion = 'phase1a-fixture-v1' }) {
  if (!/^[0-9a-f]{40}$/.test(applicationCommit || '')) throw new Error('manifest requires the exact application commit');
  const sorted = records.map(validateRecord).sort((left, right) => compareBytes(raw(left.key), raw(right.key)) || left.type.localeCompare(right.type));
  const unknown = sorted.filter((record) => classifyKey(raw(record.key)).classification === 'unknown');
  if (unknown.length) throw new Error(`unknown Submarine key family blocks sealing (${unknown.length})`);
  const owned = sorted.filter((record) => classifyKey(raw(record.key)).classification === 'submarine-owned').map((record) => {
    const classification = classifyKey(raw(record.key));
    return { ...record, family: classification.family, checksum: recordChecksum(record) };
  });
  const foreign = sorted.filter((record) => classifyKey(raw(record.key)).classification === 'foreign');
  const protectedAccounts = Object.fromEntries(PROTECTED_LOGINS.map((login) => [login, protectedAccount(owned, login)]));
  const validatedSkippedEphemeral = skippedEphemeral.map((entry) => {
    if (!/^[0-9a-f]{64}$/.test(entry.keyChecksum || '') || !['absent-at-first-observation', 'absent-at-final-observation'].includes(entry.reason)) throw new Error('skipped ephemeral evidence is invalid');
    if (entry.reason === 'absent-at-final-observation') {
      if (Object.keys(entry).sort().join() !== 'keyChecksum,observations,reason' || !Array.isArray(entry.observations) || entry.observations.length !== 2 ||
          Object.keys(entry.observations[0] || {}).sort().join() !== 'observedAt,pttl,type,valueChecksum' ||
          Object.keys(entry.observations[1] || {}).sort().join() !== 'exists,observedAt' || entry.observations[1]?.exists !== false ||
          !Number.isInteger(entry.observations[0]?.pttl) || !['string', 'list', 'set', 'hash', 'zset'].includes(entry.observations[0]?.type) ||
          !/^[0-9a-f]{64}$/.test(entry.observations[0]?.valueChecksum || '') ||
          ![entry.observations[0]?.observedAt, entry.observations[1]?.observedAt].every((value) => typeof value === 'string' && Number.isFinite(Date.parse(value)))) throw new Error('final absence evidence is invalid');
    } else if (Object.keys(entry).sort().join() !== 'keyChecksum,observedAt,reason' || typeof entry.observedAt !== 'string' || !Number.isFinite(Date.parse(entry.observedAt))) throw new Error('first absence evidence is invalid');
    return entry;
  }).sort((left, right) => left.keyChecksum.localeCompare(right.keyChecksum));
  const manifestCore = {
    version: MANIFEST_VERSION, captureId, capturedAt, sourceDatabaseId, applicationCommit, verifierVersion,
    routeInventoryVersion: ROUTE_INVENTORY_VERSION, routeInventoryDigest: ROUTE_INVENTORY_DIGEST,
    records: owned,
    foreign: foreign.map((record) => ({
      type: record.type,
      checksum: sha256(Buffer.concat([lengthPrefixed(raw(record.key)), lengthPrefixed(Buffer.from(record.type)), lengthPrefixed(Buffer.from(String(record.pttl)))])),
    })),
    skippedEphemeral: validatedSkippedEphemeral,
    foreignChurn: [...foreignChurn].sort((left, right) => left.keyChecksum.localeCompare(right.keyChecksum) || left.observedAt.localeCompare(right.observedAt)),
    protectedAccounts,
  };
  return { ...manifestCore, manifestChecksum: sha256(Buffer.from(canonicalJson(manifestCore))) };
}

function projectedRemaining(record, commonSnapshotAt) {
  if (record.pttl < 0) return record.pttl;
  return Math.max(0, Date.parse(record.capturedAt) + record.pttl - Date.parse(commonSnapshotAt));
}

export function compareManifestSnapshots(first, second, { commonSnapshotAt, ttlToleranceMs = 1000, ephemeralValuePolicy = 'allow-churn' } = {}) {
  if (!commonSnapshotAt || !Number.isFinite(Date.parse(commonSnapshotAt)) || !Number.isInteger(ttlToleranceMs) || ttlToleranceMs < 0 || !['allow-churn', 'exact-live'].includes(ephemeralValuePolicy)) throw new Error('snapshot comparison options are invalid');
  const select = (manifest, ttl) => new Map(manifest.records.filter((record) => record.ttlClassification === ttl).map((record) => [record.key, record]));
  const firstDurable = select(first, 'durable');
  const secondDurable = select(second, 'durable');
  const durableKeys = new Set([...firstDurable.keys(), ...secondDurable.keys()]);
  const durableMismatches = [...durableKeys].filter((key) => !firstDurable.has(key) || !secondDurable.has(key) || recordChecksum(firstDurable.get(key)) !== recordChecksum(secondDurable.get(key))).length;
  const firstEphemeral = select(first, 'ephemeral');
  const secondEphemeral = select(second, 'ephemeral');
  const ephemeralKeys = new Set([...firstEphemeral.keys(), ...secondEphemeral.keys()]);
  let ephemeralMismatches = 0;
  let expiredSkips = 0;
  let requiredAbsenceMismatches = 0;
  for (const key of ephemeralKeys) {
    const left = firstEphemeral.get(key);
    const right = secondEphemeral.get(key);
    const leftRemaining = left ? projectedRemaining(left, commonSnapshotAt) : 0;
    const rightRemaining = right ? projectedRemaining(right, commonSnapshotAt) : 0;
    if (ephemeralValuePolicy === 'exact-live') {
      if (left && leftRemaining === 0) {
        if (!right || rightRemaining === 0) expiredSkips += 1;
        else ephemeralMismatches += 1;
        continue;
      }
      if (!left || !right || rightRemaining === 0 || left.type !== right.type || canonicalJson(left.value) !== canonicalJson(right.value) || Math.abs(leftRemaining - rightRemaining) > ttlToleranceMs) ephemeralMismatches += 1;
      continue;
    }
    if ((!left || !right) && leftRemaining === 0 && rightRemaining === 0) { expiredSkips += 1; continue; }
    if (!left || !right || left.type !== right.type || Math.abs(leftRemaining - rightRemaining) > ttlToleranceMs) ephemeralMismatches += 1;
  }
  if (ephemeralValuePolicy === 'exact-live') {
    const restoredKeyChecksums = new Set(second.records.map((record) => sha256(raw(record.key))));
    for (const skipped of first.skippedEphemeral || []) {
      if (restoredKeyChecksums.has(skipped.keyChecksum)) requiredAbsenceMismatches += 1;
    }
    ephemeralMismatches += requiredAbsenceMismatches;
  }
  return {
    equal: durableMismatches === 0 && ephemeralMismatches === 0,
    durable: { count: durableKeys.size, mismatches: durableMismatches },
    ephemeral: { count: ephemeralKeys.size, mismatches: ephemeralMismatches, expiredSkips, requiredAbsenceCount: (first.skippedEphemeral || []).length, requiredAbsenceMismatches, ttlToleranceMs, valuePolicy: ephemeralValuePolicy },
  };
}

export function verifyProtectedInvariants(manifest, expectedProtected) {
  for (const login of PROTECTED_LOGINS) {
    if (canonicalJson(manifest.protectedAccounts?.[login]) !== canonicalJson(expectedProtected?.[login])) throw new Error(`protected account invariant changed: ${login}`);
  }
}

export function redactedManifest(manifest, ciphertextChecksum) {
  const familyTotals = {};
  const typeTotals = {};
  for (const record of manifest.records) {
    familyTotals[record.family] = (familyTotals[record.family] || 0) + 1;
    typeTotals[record.type] = (typeTotals[record.type] || 0) + 1;
  }
  return {
    archiveVersion: 'sd-archive-v1', manifestVersion: MANIFEST_VERSION,
    recordCount: manifest.records.length, foreignCount: manifest.foreign.length,
    skippedEphemeralCount: manifest.skippedEphemeral.length,
    skippedEphemeralChecksum: sha256(Buffer.from(canonicalJson(manifest.skippedEphemeral))),
    familyTotals, typeTotals, ciphertextChecksum,
    protectedChecksums: PROTECTED_LOGINS.map((login) => ({
      associatedRecordCount: manifest.protectedAccounts[login].associatedRecordCount,
      leaderboardAssociationCount: manifest.protectedAccounts[login].leaderboardAssociationCount,
      checksum: sha256(Buffer.from(canonicalJson(manifest.protectedAccounts[login]))),
    })),
  };
}

export function base64(value) { return b64(value); }
