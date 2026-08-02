import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export const DEFAULT_LEASE_TTL_MS = 930_000;

export const CONTROL_KEYS = Object.freeze({
  gate: 'sd:migration:control:gate',
  epoch: 'sd:migration:control:epoch',
  fence: 'sd:migration:control:fence',
  leases: 'sd:migration:control:leases',
  leasePrefix: 'sd:migration:control:lease:',
  expired: 'sd:migration:control:expired-leases',
  hardFailure: 'sd:migration:control:hard-failure',
  hardFailureAt: 'sd:migration:control:hard-failure-at',
  closedAt: 'sd:migration:control:closed-at',
  maxLeaseTtlMs: 'sd:migration:control:max-lease-ttl-ms',
  mutationCounter: 'sd:migration:control:mutation-count',
  reconciliations: 'sd:migration:control:reconciliations',
});

export const ACQUIRE_LEASE_LUA = `
local now = redis.call('TIME')
local now_ms = (tonumber(now[1]) * 1000) + math.floor(tonumber(now[2]) / 1000)
local expired = redis.call('ZRANGEBYSCORE', KEYS[3], '-inf', now_ms)
for _, request_id in ipairs(expired) do
  redis.call('LPUSH', KEYS[5], request_id)
  redis.call('DEL', ARGV[4] .. request_id)
end
if #expired > 0 then
  redis.call('SET', KEYS[6], '1')
  redis.call('SET', KEYS[7], now_ms, 'NX')
  redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', now_ms)
end
local gate = redis.call('GET', KEYS[1]) or 'open'
local epoch = tonumber(redis.call('GET', KEYS[2]) or '1')
if gate ~= 'open' then return {0, gate, epoch, #expired} end
local fence = redis.call('INCR', KEYS[4])
local expires_at = now_ms + tonumber(ARGV[2])
local max_ttl = tonumber(redis.call('GET', KEYS[8]) or '0')
if tonumber(ARGV[2]) > max_ttl then redis.call('SET', KEYS[8], ARGV[2]) end
local lease_key = ARGV[4] .. ARGV[1]
redis.call('HSET', lease_key, 'epoch', epoch, 'fence', fence, 'expiresAt', expires_at, 'route', ARGV[3])
redis.call('PEXPIRE', lease_key, tonumber(ARGV[2]))
redis.call('ZADD', KEYS[3], expires_at, ARGV[1])
return {1, epoch, fence, expires_at, #expired}
`;

export const RENEW_LEASE_LUA = `
local now = redis.call('TIME')
local now_ms = (tonumber(now[1]) * 1000) + math.floor(tonumber(now[2]) / 1000)
local epoch = redis.call('HGET', KEYS[1], 'epoch')
local fence = redis.call('HGET', KEYS[1], 'fence')
local expires_at = tonumber(redis.call('HGET', KEYS[1], 'expiresAt') or '0')
if not epoch or epoch ~= ARGV[1] or fence ~= ARGV[2] or expires_at <= now_ms then
  redis.call('LPUSH', KEYS[3], ARGV[3])
  redis.call('SET', KEYS[4], '1')
  redis.call('SET', KEYS[6], now_ms, 'NX')
  redis.call('ZREM', KEYS[2], ARGV[3])
  redis.call('DEL', KEYS[1])
  return {0, 'expired'}
end
local current_epoch = redis.call('GET', KEYS[5]) or '1'
if current_epoch ~= epoch then return {0, 'stale_epoch'} end
local next_expiry = now_ms + tonumber(ARGV[4])
redis.call('HSET', KEYS[1], 'expiresAt', next_expiry)
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[4]))
redis.call('ZADD', KEYS[2], next_expiry, ARGV[3])
return {1, next_expiry}
`;

export const RELEASE_LEASE_LUA = `
local epoch = redis.call('HGET', KEYS[1], 'epoch')
local fence = redis.call('HGET', KEYS[1], 'fence')
if epoch == ARGV[1] and fence == ARGV[2] then
  redis.call('DEL', KEYS[1])
  redis.call('ZREM', KEYS[2], ARGV[3])
  return 1
end
return 0
`;

export const GUARDED_WRITE_LUA = `
local now = redis.call('TIME')
local now_ms = (tonumber(now[1]) * 1000) + math.floor(tonumber(now[2]) / 1000)
local epoch = redis.call('HGET', KEYS[1], 'epoch')
local fence = redis.call('HGET', KEYS[1], 'fence')
local expires_at = tonumber(redis.call('HGET', KEYS[1], 'expiresAt') or '0')
if not epoch or epoch ~= ARGV[1] or fence ~= ARGV[2] or expires_at <= now_ms then
  redis.call('LPUSH', KEYS[3], ARGV[3])
  redis.call('SET', KEYS[4], '1')
  redis.call('SET', KEYS[7], now_ms, 'NX')
  redis.call('ZREM', KEYS[2], ARGV[3])
  redis.call('DEL', KEYS[1])
  return redis.error_reply('SD_LEASE_EXPIRED')
end
local current_epoch = redis.call('GET', KEYS[5]) or '1'
if current_epoch ~= epoch then return redis.error_reply('SD_STALE_FENCE') end
local command = {}
for i = 4, #ARGV do command[#command + 1] = ARGV[i] end
local result = redis.call(unpack(command))
redis.call('INCR', KEYS[6])
return result
`;

export const CLOSE_GATE_LUA = `
local now = redis.call('TIME')
local now_ms = (tonumber(now[1]) * 1000) + math.floor(tonumber(now[2]) / 1000)
local expired = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', now_ms)
for _, request_id in ipairs(expired) do
  redis.call('LPUSH', KEYS[3], request_id)
  redis.call('DEL', ARGV[1] .. request_id)
end
if #expired > 0 then
  redis.call('SET', KEYS[4], '1')
  redis.call('SET', KEYS[6], now_ms, 'NX')
end
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now_ms)
redis.call('SET', KEYS[1], 'closed')
redis.call('SET', KEYS[7], now_ms)
return {redis.call('ZCARD', KEYS[2]), #expired, redis.call('GET', KEYS[5]) or '1'}
`;

export const OPEN_GATE_LUA = `
local now = redis.call('TIME')
local now_ms = (tonumber(now[1]) * 1000) + math.floor(tonumber(now[2]) / 1000)
local expired = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', now_ms)
for _, request_id in ipairs(expired) do
  redis.call('LPUSH', KEYS[4], request_id)
  redis.call('DEL', ARGV[1] .. request_id)
end
if #expired > 0 then
  redis.call('SET', KEYS[5], '1')
  redis.call('SET', KEYS[6], now_ms, 'NX')
end
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now_ms)
if tonumber(redis.call('ZCARD', KEYS[2])) > 0 then return {0, 'active_leases', #expired} end
if redis.call('GET', KEYS[5]) == '1' then return {0, 'hard_failure', #expired} end
if not redis.call('GET', KEYS[1]) then redis.call('SET', KEYS[1], '1') end
local epoch = redis.call('INCR', KEYS[1])
redis.call('SET', KEYS[3], 'open')
return {1, epoch, #expired}
`;

export const READ_CONTROL_STATE_LUA = `
local now = redis.call('TIME')
local now_ms = (tonumber(now[1]) * 1000) + math.floor(tonumber(now[2]) / 1000)
local expired = redis.call('ZRANGEBYSCORE', KEYS[3], '-inf', now_ms)
for _, request_id in ipairs(expired) do
  redis.call('LPUSH', KEYS[4], request_id)
  redis.call('DEL', ARGV[1] .. request_id)
end
if #expired > 0 then
  redis.call('SET', KEYS[5], '1')
  redis.call('SET', KEYS[7], now_ms, 'NX')
end
redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', now_ms)
return {
  redis.call('GET', KEYS[1]) or 'open',
  redis.call('GET', KEYS[2]) or '1',
  redis.call('ZCARD', KEYS[3]),
  redis.call('GET', KEYS[5]) or '0',
  redis.call('GET', KEYS[6]) or '0',
  #expired
}
`;

export const RECONCILE_HARD_FAILURE_LUA = `
local now = redis.call('TIME')
local now_ms = (tonumber(now[1]) * 1000) + math.floor(tonumber(now[2]) / 1000)
if (redis.call('GET', KEYS[1]) or 'open') ~= 'closed' then return {0, 'gate_not_closed'} end
if tonumber(redis.call('ZCARD', KEYS[2])) ~= 0 then return {0, 'active_leases'} end
if redis.call('GET', KEYS[3]) ~= '1' then return {0, 'no_hard_failure'} end
local hard_failure_at = tonumber(redis.call('GET', KEYS[5]) or '0')
local closed_at = tonumber(redis.call('GET', KEYS[6]) or '0')
if hard_failure_at == 0 or closed_at == 0 then return {0, 'missing_redis_time_anchor'} end
local quarantine_anchor = math.max(hard_failure_at, closed_at)
local required_ms = math.max(${DEFAULT_LEASE_TTL_MS}, tonumber(redis.call('GET', KEYS[7]) or '0'))
local elapsed_ms = now_ms - quarantine_anchor
if elapsed_ms < required_ms then return {0, 'quarantine_incomplete', required_ms - elapsed_ms} end
if ARGV[2] ~= ARGV[3] then return {0, 'manifests_differ'} end
local first_manifest_captured_at = tonumber(ARGV[4])
local second_manifest_captured_at = tonumber(ARGV[5])
local earliest_manifest_at = quarantine_anchor + required_ms
if first_manifest_captured_at < earliest_manifest_at or second_manifest_captured_at < first_manifest_captured_at then
  return {0, 'manifest_capture_order_invalid'}
end
if first_manifest_captured_at > now_ms or second_manifest_captured_at > now_ms then return {0, 'manifest_capture_in_future'} end
local audit = cjson.encode({
  reconciledAt = now_ms,
  quarantineAnchor = quarantine_anchor,
  requiredQuarantineMs = required_ms,
  reconciliationReportSha256 = ARGV[1],
  durableManifestSha256 = ARGV[2],
  firstManifestCapturedAt = first_manifest_captured_at,
  secondManifestCapturedAt = second_manifest_captured_at,
  batchId = ARGV[6],
  operatorId = ARGV[7]
})
redis.call('LPUSH', KEYS[4], audit)
redis.call('DEL', KEYS[3])
redis.call('DEL', KEYS[5])
return {1, now_ms}
`;

const leaseStorage = new AsyncLocalStorage();
const WRITE_COMMANDS = new Set(['set', 'del', 'incr', 'decr', 'incrby', 'decrby', 'lpush', 'rpush', 'ltrim', 'lset', 'sadd', 'srem', 'expire', 'zadd', 'hset', 'hdel']);
const EPHEMERAL_PREFIXES = ['sd:session:', 'sd:rl:', 'sd:pvp:presence:', 'sd:pvp:ws-ticket:'];
const EPHEMERAL_EXACT = new Set(['sd:pvp:lobby:online']);

export class MaintenanceFreezeError extends Error {
  constructor() {
    super('Durable writes are temporarily paused for maintenance.');
    this.name = 'MaintenanceFreezeError';
    this.code = 'MAINTENANCE_WRITE_FREEZE';
  }
}

export class LeaseFenceError extends Error {
  constructor(message = 'A live fenced mutation lease is required.') {
    super(message);
    this.name = 'LeaseFenceError';
    this.code = 'MUTATION_LEASE_INVALID';
  }
}

export function productionControlFlags(env = process.env) {
  return Object.freeze({
    legacyStorage: env.SD_LEGACY_STORAGE_ENABLED !== 'false',
    supabaseShadowVerification: env.SD_SUPABASE_SHADOW_VERIFY === 'true',
    admissionGate: env.SD_MIGRATION_ADMISSION_GATE_ENABLED === 'true',
    canonicalAuthTickets: env.SD_CANONICAL_AUTH_TICKETS_ENABLED === 'true',
    protectedAccountCanary: env.SD_PROTECTED_ACCOUNT_CANARY_ENABLED === 'true',
    rollbackMode: env.SD_MIGRATION_ROLLBACK_MODE === 'true',
  });
}

export function leaseTtlMs(env = process.env) {
  const configured = Number.parseInt(env.SD_MIGRATION_LEASE_TTL_MS || '', 10);
  return Number.isFinite(configured) && configured >= 30_000 ? configured : DEFAULT_LEASE_TTL_MS;
}

export function isDurableRedisKey(key) {
  const text = String(key ?? '');
  if (text.startsWith('sd:migration:control:')) return false;
  if (EPHEMERAL_EXACT.has(text)) return false;
  return !EPHEMERAL_PREFIXES.some((prefix) => text.startsWith(prefix));
}

export function redisCommandKeys(command, args) {
  if (command === 'del') return args;
  return args.length ? [args[0]] : [];
}

function serializeCommand(command, args) {
  const output = [command.toUpperCase()];
  for (const arg of args) {
    if (arg && typeof arg === 'object' && !Array.isArray(arg)) {
      if (arg.ex !== undefined) output.push('EX', String(arg.ex));
      if (arg.px !== undefined) output.push('PX', String(arg.px));
      if (arg.nx) output.push('NX');
      if (arg.xx) output.push('XX');
      continue;
    }
    output.push(String(arg));
  }
  return output;
}

export function currentMutationLease() {
  return leaseStorage.getStore() ?? null;
}

export async function acquireMutationLease(adapter, route, ttlMs = leaseTtlMs()) {
  const requestId = randomUUID();
  const result = await adapter.eval(ACQUIRE_LEASE_LUA,
    [CONTROL_KEYS.gate, CONTROL_KEYS.epoch, CONTROL_KEYS.leases, CONTROL_KEYS.fence, CONTROL_KEYS.expired, CONTROL_KEYS.hardFailure, CONTROL_KEYS.hardFailureAt, CONTROL_KEYS.maxLeaseTtlMs],
    [requestId, ttlMs, route, CONTROL_KEYS.leasePrefix]);
  if (Number(result?.[0]) !== 1) throw new MaintenanceFreezeError();
  return { requestId, route, epoch: String(result[1]), fence: String(result[2]), expiresAt: Number(result[3]), ttlMs, adapter, valid: true };
}

export async function renewMutationLease(lease) {
  const result = await lease.adapter.eval(RENEW_LEASE_LUA,
    [CONTROL_KEYS.leasePrefix + lease.requestId, CONTROL_KEYS.leases, CONTROL_KEYS.expired, CONTROL_KEYS.hardFailure, CONTROL_KEYS.epoch, CONTROL_KEYS.hardFailureAt],
    [lease.epoch, lease.fence, lease.requestId, lease.ttlMs]);
  lease.valid = Number(result?.[0]) === 1;
  if (lease.valid) lease.expiresAt = Number(result[1]);
  return lease.valid;
}

export function startMutationLeaseRenewal(lease, options = {}) {
  const renew = options.renew ?? renewMutationLease;
  const onExpired = options.onExpired ?? (() => {});
  const onError = options.onError ?? (() => {});
  const intervalMs = options.intervalMs ?? Math.max(10_000, Math.floor(lease.ttlMs / 3));
  let stopping = false;
  let inFlight = null;

  const renewNow = () => {
    if (stopping) return Promise.resolve(null);
    if (inFlight) return inFlight;
    const operation = Promise.resolve()
      .then(() => renew(lease))
      .then((renewed) => {
        if (!renewed) onExpired();
        return renewed;
      })
      .catch((error) => {
        lease.valid = false;
        onError(error);
        return false;
      });
    inFlight = operation;
    void operation.finally(() => {
      if (inFlight === operation) inFlight = null;
    });
    return operation;
  };

  const timer = setInterval(() => {
    void renewNow();
  }, intervalMs);
  timer.unref?.();

  return {
    renewNow,
    async stop() {
      if (!stopping) {
        stopping = true;
        clearInterval(timer);
      }
      await inFlight;
    },
  };
}

export async function releaseMutationLease(lease) {
  lease.valid = false;
  return lease.adapter.eval(RELEASE_LEASE_LUA,
    [CONTROL_KEYS.leasePrefix + lease.requestId, CONTROL_KEYS.leases],
    [lease.epoch, lease.fence, lease.requestId]);
}

export async function runWithMutationLease(lease, operation) {
  return leaseStorage.run(lease, operation);
}

export async function closeMutationGate(adapter) {
  const result = await adapter.eval(CLOSE_GATE_LUA,
    [CONTROL_KEYS.gate, CONTROL_KEYS.leases, CONTROL_KEYS.expired, CONTROL_KEYS.hardFailure, CONTROL_KEYS.epoch, CONTROL_KEYS.hardFailureAt, CONTROL_KEYS.closedAt],
    [CONTROL_KEYS.leasePrefix]);
  return { activeLeases: Number(result[0]), expiredLeases: Number(result[1]), epoch: Number(result[2]) };
}

export async function openMutationGate(adapter) {
  const result = await adapter.eval(OPEN_GATE_LUA,
    [CONTROL_KEYS.epoch, CONTROL_KEYS.leases, CONTROL_KEYS.gate, CONTROL_KEYS.expired, CONTROL_KEYS.hardFailure, CONTROL_KEYS.hardFailureAt],
    [CONTROL_KEYS.leasePrefix]);
  if (Number(result[0]) !== 1) throw new LeaseFenceError(`Cannot reopen mutation gate: ${String(result[1])}.`);
  return { epoch: Number(result[1]) };
}

export async function readMutationGateStatus(adapter) {
  const result = await adapter.eval(READ_CONTROL_STATE_LUA,
    [CONTROL_KEYS.gate, CONTROL_KEYS.epoch, CONTROL_KEYS.leases, CONTROL_KEYS.expired, CONTROL_KEYS.hardFailure, CONTROL_KEYS.mutationCounter, CONTROL_KEYS.hardFailureAt],
    [CONTROL_KEYS.leasePrefix]);
  return {
    gate: String(result[0]),
    epoch: Number(result[1]),
    activeLeases: Number(result[2]),
    hardExpiredLease: String(result[3]) === '1',
    mutationCount: Number(result[4]),
    expiredLeasesSwept: Number(result[5]),
  };
}

function requireSha256(value, field) {
  if (!/^[a-f0-9]{64}$/.test(String(value))) throw new TypeError(`${field} must be a lowercase SHA-256 hex digest.`);
}

export async function reconcileExpiredLeaseHardFailure(adapter, evidence) {
  requireSha256(evidence.reconciliationReportSha256, 'reconciliationReportSha256');
  requireSha256(evidence.firstDurableManifestSha256, 'firstDurableManifestSha256');
  requireSha256(evidence.secondDurableManifestSha256, 'secondDurableManifestSha256');
  for (const field of ['firstManifestCapturedAt', 'secondManifestCapturedAt']) {
    if (!Number.isSafeInteger(evidence[field]) || evidence[field] < 0) throw new TypeError(`${field} must be a non-negative millisecond timestamp.`);
  }
  if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(String(evidence.batchId || '')) || !/^[a-zA-Z0-9._:@-]{1,128}$/.test(String(evidence.operatorId || ''))) {
    throw new TypeError('batchId and operatorId must be bounded audit identifiers.');
  }
  const result = await adapter.eval(RECONCILE_HARD_FAILURE_LUA,
    [CONTROL_KEYS.gate, CONTROL_KEYS.leases, CONTROL_KEYS.hardFailure, CONTROL_KEYS.reconciliations, CONTROL_KEYS.hardFailureAt, CONTROL_KEYS.closedAt, CONTROL_KEYS.maxLeaseTtlMs],
    [
      evidence.reconciliationReportSha256,
      evidence.firstDurableManifestSha256,
      evidence.secondDurableManifestSha256,
      evidence.firstManifestCapturedAt,
      evidence.secondManifestCapturedAt,
      evidence.batchId,
      evidence.operatorId,
    ]);
  if (Number(result[0]) !== 1) throw new LeaseFenceError(`Hard-failure reconciliation rejected: ${String(result[1])}.`);
  return { reconciledAt: Number(result[1]) };
}

export async function activePvpDrainStatus(redis) {
  const roomIds = await redis.smembers('sd:pvp:rooms:all');
  const activeRooms = [];
  const activeMatches = [];
  for (const roomId of roomIds) {
    const raw = await redis.get('sd:pvp:room:' + roomId);
    if (!raw) continue;
    const room = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const roomPhase = String(room?.phase || room?.status || 'UNKNOWN').toUpperCase();
    const roomIsTerminal = ['CANCELED', 'CANCELLED', 'CLOSED', 'COMPLETED', 'FINISHED'].includes(roomPhase);
    if (!roomIsTerminal) activeRooms.push(String(roomId));
    if (room?.matchId && !roomIsTerminal) {
      const matchRaw = await redis.get('sd:pvp:match:' + room.matchId);
      const match = matchRaw ? (typeof matchRaw === 'string' ? JSON.parse(matchRaw) : matchRaw) : null;
      const matchPhase = String(match?.phase || match?.status || 'UNKNOWN').toUpperCase();
      if (!['CANCELED', 'CANCELLED', 'COMPLETED', 'FINISHED'].includes(matchPhase)) activeMatches.push(String(room.matchId));
    }
  }
  return { activeRoomCount: activeRooms.length, activeMatchCount: new Set(activeMatches).size, activeRooms, drained: activeRooms.length === 0 && activeMatches.length === 0 };
}

export function createControlledRedis(rawRedis, adapter, flags = productionControlFlags()) {
  if (!flags.admissionGate) return rawRedis;
  return new Proxy(rawRedis, {
    get(target, property, receiver) {
      if (typeof property !== 'string' || !WRITE_COMMANDS.has(property)) {
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return async (...args) => {
        const keys = redisCommandKeys(property, args);
        if (!keys.some(isDurableRedisKey)) return target[property](...args);
        const lease = currentMutationLease();
        if (!lease?.valid) throw new LeaseFenceError();
        try {
          return await adapter.eval(GUARDED_WRITE_LUA,
            [CONTROL_KEYS.leasePrefix + lease.requestId, CONTROL_KEYS.leases, CONTROL_KEYS.expired, CONTROL_KEYS.hardFailure, CONTROL_KEYS.epoch, CONTROL_KEYS.mutationCounter, CONTROL_KEYS.hardFailureAt],
            [lease.epoch, lease.fence, lease.requestId, ...serializeCommand(property, args)]);
        } catch (error) {
          if (/SD_LEASE_EXPIRED|SD_STALE_FENCE/.test(String(error?.message || error))) lease.valid = false;
          throw error;
        }
      };
    },
  });
}

export function redactedMigrationEvent(event, logger = console) {
  const allowed = ['event', 'batchId', 'phase', 'sourceCommit', 'destinationCommit', 'route', 'count', 'durationMs', 'outcome', 'reasonCode'];
  const redacted = {};
  for (const key of allowed) {
    const value = event[key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') redacted[key] = value;
  }
  logger.info(JSON.stringify({ scope: 'submarine-dash-migration', ...redacted }));
}
