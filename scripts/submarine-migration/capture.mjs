import { canonicalJson, sha256 } from './canonical.mjs';
import { base64, buildManifest, classifyKey, normalizeValue } from './manifest.mjs';

const VALUE_COMMAND = Object.freeze({
  string: (key) => ['GET', key],
  list: (key) => ['LRANGE', key, '0', '-1'],
  set: (key) => ['SMEMBERS', key],
  hash: (key) => ['HGETALL', key],
  zset: (key) => ['ZRANGE', key, '0', '-1', 'WITHSCORES'],
});

async function observe(client, key, specification, clock) {
  const observedAt = new Date(clock()).toISOString();
  const typeBytes = await client.execute(['TYPE', key]);
  const type = Buffer.from(typeBytes).toString('ascii');
  if (type === 'none') return { exists: false, observedAt };
  if (!Object.hasOwn(VALUE_COMMAND, type)) throw new Error(`unsupported or missing Redis type: ${type}`);
  const pttl = await client.execute(['PTTL', key]);
  if (pttl === -2) return { exists: false, observedAt, typeObserved: type };
  if (!Number.isInteger(pttl) || pttl < -1 || (specification.ttl === 'durable' && pttl !== -1)) {
    throw new Error('Redis TTL violates the reviewed key-family specification');
  }
  const record = { exists: true, key: base64(key), type, pttl, ttlClassification: specification.ttl === 'foreign' ? (pttl === -1 ? 'durable' : 'ephemeral') : specification.ttl, capturedAt: observedAt };
  if (specification.classification === 'foreign') return { ...record, foreignMetadata: true };
  const value = normalizeValue(type, await client.execute(VALUE_COMMAND[type](key)));
  if (type !== 'string' && Object.values(value)[0].length === 0) throw new Error('Redis cannot persist an empty collection key');
  return { ...record, value };
}

export async function scanRawKeys(client, count = 1000) {
  let cursor = '0';
  const seenCursors = new Set();
  const unique = new Map();
  do {
    const result = await client.execute(['SCAN', cursor, 'MATCH', '*', 'COUNT', String(count)]);
    if (!Array.isArray(result) || result.length !== 2 || !Array.isArray(result[1])) throw new Error('SCAN returned an invalid result');
    cursor = Buffer.from(result[0]).toString('ascii');
    if (!/^\d+$/.test(cursor)) throw new Error('SCAN returned an invalid cursor');
    if (cursor !== '0' && seenCursors.has(cursor)) throw new Error('SCAN cursor repeated before completion');
    seenCursors.add(cursor);
    for (const key of result[1]) unique.set(Buffer.from(key).toString('base64'), Buffer.from(key));
  } while (cursor !== '0');
  return [...unique.values()];
}

export async function captureManifest({ client, capturedAt, sourceDatabaseId, captureId, applicationCommit, scanCount = 1000, clock = Date.now }) {
  const keys = await scanRawKeys(client, scanCount);
  const records = [];
  const skippedEphemeral = [];
  const foreignChurn = [];
  for (const key of keys) {
    const keyClassification = classifyKey(key);
    const { classification } = keyClassification;
    if (classification === 'unknown') throw new Error('unknown Submarine key family blocks capture');
    const specification = classification === 'foreign' ? { classification, ttl: 'foreign' } : keyClassification;
    const first = await observe(client, key, specification, clock);
    if (!first.exists) {
      if (classification === 'foreign') foreignChurn.push({ keyChecksum: sha256(key), observedAt: first.observedAt, reason: 'disappeared-before-first-observation', typeObserved: first.typeObserved || null });
      else if (specification.ttl === 'ephemeral') skippedEphemeral.push({ keyChecksum: sha256(key), observedAt: first.observedAt, reason: 'absent-at-first-observation' });
      else throw new Error('durable Redis key disappeared during capture');
      continue;
    }
    const second = await observe(client, key, specification, clock);
    if (!second.exists) {
      if (classification === 'foreign') {
        foreignChurn.push({ keyChecksum: sha256(key), observedAt: second.observedAt, reason: 'disappeared-between-observations', typeObserved: second.typeObserved || first.type });
        records.push(first);
      } else if (specification.ttl === 'ephemeral') {
        skippedEphemeral.push({
          keyChecksum: sha256(key), reason: 'absent-at-final-observation',
          observations: [
            { observedAt: first.capturedAt, pttl: first.pttl, type: first.type, valueChecksum: sha256(Buffer.from(canonicalJson(first.value))) },
            { observedAt: second.observedAt, exists: false },
          ],
        });
      } else throw new Error('durable Redis key disappeared during capture');
      continue;
    }
    const { pttl: firstPttl, ...stableFirst } = first;
    const { pttl: secondPttl, ...stableSecond } = second;
    delete stableFirst.capturedAt;
    delete stableSecond.capturedAt;
    const changed = canonicalJson(stableFirst) !== canonicalJson(stableSecond);
    if (specification.ttl === 'durable' && changed) {
      throw new Error('Redis key changed during read-only capture');
    }
    if (specification.ttl === 'ephemeral') {
      first.observations = [first, second].map((observation) => ({ observedAt: observation.capturedAt, pttl: observation.pttl, valueChecksum: sha256(Buffer.from(canonicalJson(observation.value))) }));
      first.churned = changed;
    }
    if (classification === 'foreign' && changed) foreignChurn.push({ keyChecksum: sha256(key), observedAt: second.capturedAt, reason: 'metadata-changed-between-observations', typeObserved: second.type });
    records.push(first);
  }
  return buildManifest({ records, capturedAt, sourceDatabaseId, captureId, applicationCommit, skippedEphemeral, foreignChurn });
}
