import { describe, expect, it, vi } from 'vitest';
import {
  ACQUIRE_LEASE_LUA,
  acquireMutationLease,
  activePvpDrainStatus,
  CLOSE_GATE_LUA,
  closeMutationGate,
  CONTROL_KEYS,
  createControlledRedis,
  DEFAULT_LEASE_TTL_MS,
  GUARDED_WRITE_LUA,
  LeaseFenceError,
  MaintenanceFreezeError,
  OPEN_GATE_LUA,
  openMutationGate,
  productionControlFlags,
  READ_CONTROL_STATE_LUA,
  RECONCILE_HARD_FAILURE_LUA,
  reconcileExpiredLeaseHardFailure,
  readMutationGateStatus,
  redactedMigrationEvent,
  RELEASE_LEASE_LUA,
  releaseMutationLease,
  RENEW_LEASE_LUA,
  renewMutationLease,
  runWithMutationLease,
} from './productionControls.js';

class FakeRedis {
  constructor() {
    this.now = 1_000;
    this.gate = 'open';
    this.epoch = 1;
    this.fence = 0;
    this.leases = new Map();
    this.values = new Map();
    this.expired = [];
    this.hardFailure = false;
    this.hardFailureAt = null;
    this.closedAt = null;
    this.maxLeaseTtlMs = 0;
    this.mutationCount = 0;
    this.reconciliations = [];
  }

  adapter = { eval: (script, keys, args) => this.evalScript(script, keys, args) };

  expireLeases() {
    let count = 0;
    for (const [requestId, lease] of this.leases) {
      if (lease.expiresAt <= this.now) {
        this.expired.push(requestId);
        this.hardFailure = true;
        this.hardFailureAt ??= this.now;
        this.leases.delete(requestId);
        count += 1;
      }
    }
    return count;
  }

  async evalScript(script, _keys, args) {
    if (script === ACQUIRE_LEASE_LUA) {
      this.expireLeases();
      if (this.gate !== 'open') return [0, this.gate, this.epoch, 0];
      const [requestId, ttlMs, route] = args;
      const lease = { requestId, route, epoch: this.epoch, fence: ++this.fence, expiresAt: this.now + Number(ttlMs) };
      this.maxLeaseTtlMs = Math.max(this.maxLeaseTtlMs, Number(ttlMs));
      this.leases.set(requestId, lease);
      return [1, lease.epoch, lease.fence, lease.expiresAt, 0];
    }
    if (script === RENEW_LEASE_LUA) {
      this.expireLeases();
      const [epoch, fence, requestId, ttlMs] = args;
      const lease = this.leases.get(requestId);
      if (!lease || String(lease.epoch) !== String(epoch) || String(lease.fence) !== String(fence)) return [0, 'expired'];
      if (lease.epoch !== this.epoch) return [0, 'stale_epoch'];
      lease.expiresAt = this.now + Number(ttlMs);
      return [1, lease.expiresAt];
    }
    if (script === RELEASE_LEASE_LUA) {
      const requestId = args[2];
      const existed = this.leases.delete(requestId);
      return existed ? 1 : 0;
    }
    if (script === GUARDED_WRITE_LUA) {
      this.expireLeases();
      const [epoch, fence, requestId, command, key, ...commandArgs] = args;
      const lease = this.leases.get(requestId);
      if (!lease || String(lease.epoch) !== String(epoch) || String(lease.fence) !== String(fence)) throw new Error('SD_LEASE_EXPIRED');
      if (lease.epoch !== this.epoch) throw new Error('SD_STALE_FENCE');
      if (command === 'SET') this.values.set(String(key), String(commandArgs[0]));
      if (command === 'DEL') this.values.delete(String(key));
      this.mutationCount += 1;
      return 'OK';
    }
    if (script === CLOSE_GATE_LUA) {
      this.expireLeases();
      this.gate = 'closed';
      this.closedAt = this.now;
      return [this.leases.size, this.expired.length, this.epoch];
    }
    if (script === OPEN_GATE_LUA) {
      this.expireLeases();
      if (this.leases.size) return [0, 'active_leases'];
      if (this.hardFailure) return [0, 'hard_failure'];
      this.epoch = (this.epoch ?? 1) + 1;
      this.gate = 'open';
      return [1, this.epoch];
    }
    if (script === READ_CONTROL_STATE_LUA) {
      const swept = this.expireLeases();
      return [this.gate, this.epoch ?? 1, this.leases.size, this.hardFailure ? 1 : 0, this.mutationCount, swept];
    }
    if (script === RECONCILE_HARD_FAILURE_LUA) {
      if (this.gate !== 'closed') return [0, 'gate_not_closed'];
      if (this.leases.size) return [0, 'active_leases'];
      if (!this.hardFailure) return [0, 'no_hard_failure'];
      if (this.hardFailureAt === null || this.closedAt === null) return [0, 'missing_redis_time_anchor'];
      const [report, first, second, firstCapturedAt, secondCapturedAt, batchId, operatorId] = args;
      const anchor = Math.max(this.hardFailureAt, this.closedAt);
      const required = Math.max(DEFAULT_LEASE_TTL_MS, this.maxLeaseTtlMs);
      if (this.now - anchor < required) return [0, 'quarantine_incomplete'];
      if (first !== second) return [0, 'manifests_differ'];
      if (Number(firstCapturedAt) < anchor + required || Number(secondCapturedAt) < Number(firstCapturedAt)) return [0, 'manifest_capture_order_invalid'];
      if (Number(firstCapturedAt) > this.now || Number(secondCapturedAt) > this.now) return [0, 'manifest_capture_in_future'];
      this.reconciliations.push({ report, first, firstCapturedAt, secondCapturedAt, batchId, operatorId });
      this.hardFailure = false;
      this.hardFailureAt = null;
      return [1, this.now];
    }
    throw new Error('unknown script');
  }

  async set(key, value) {
    this.values.set(String(key), String(value));
    return 'OK';
  }
}

const enabled = { admissionGate: true };

describe('distributed production controls', () => {
  it('atomically closes admission while allowing an already fenced request to drain', async () => {
    const fake = new FakeRedis();
    const controlled = createControlledRedis(fake, fake.adapter, enabled);
    const lease = await acquireMutationLease(fake.adapter, 'POST:api/missions/event.ts', 60_000);

    expect(await closeMutationGate(fake.adapter)).toMatchObject({ activeLeases: 1 });
    await expect(acquireMutationLease(fake.adapter, 'POST:api/leaderboard.ts', 60_000)).rejects.toBeInstanceOf(MaintenanceFreezeError);
    await runWithMutationLease(lease, () => controlled.set('sd:user:u1:coins', '10'));
    expect(fake.values.get('sd:user:u1:coins')).toBe('10');

    await releaseMutationLease(lease);
    await openMutationGate(fake.adapter);
    expect(await readMutationGateStatus(fake.adapter)).toMatchObject({ gate: 'open', epoch: 2, activeLeases: 0, mutationCount: 1 });
  });

  it('turns an expired lease into a hard blocker and prevents the durable commit', async () => {
    const fake = new FakeRedis();
    const controlled = createControlledRedis(fake, fake.adapter, enabled);
    const lease = await acquireMutationLease(fake.adapter, 'POST:api/auth/register.ts', 100);
    fake.now += 101;

    await expect(runWithMutationLease(lease, () => controlled.set('sd:user:u1', 'secret-payload'))).rejects.toThrow('SD_LEASE_EXPIRED');
    expect(fake.values.has('sd:user:u1')).toBe(false);
    expect(await readMutationGateStatus(fake.adapter)).toMatchObject({ hardExpiredLease: true, activeLeases: 0 });
  });

  it('atomically sweeps expiration during status and blocks reopen until audited reconciliation', async () => {
    const fake = new FakeRedis();
    const lease = await acquireMutationLease(fake.adapter, 'POST:api/auth/register.ts', 100);
    await closeMutationGate(fake.adapter);
    fake.now += 101;

    expect(await readMutationGateStatus(fake.adapter)).toMatchObject({ activeLeases: 0, hardExpiredLease: true, expiredLeasesSwept: 1 });
    expect(fake.leases.has(lease.requestId)).toBe(false);
    await expect(openMutationGate(fake.adapter)).rejects.toThrow('hard_failure');

    const digest = 'a'.repeat(64);
    await expect(reconcileExpiredLeaseHardFailure(fake.adapter, {
      reconciliationReportSha256: 'b'.repeat(64),
      firstDurableManifestSha256: digest,
      secondDurableManifestSha256: digest,
      firstManifestCapturedAt: fake.now,
      secondManifestCapturedAt: fake.now,
      batchId: 'batch-1',
      operatorId: 'operator-1',
    })).rejects.toThrow('quarantine_incomplete');

    fake.now += DEFAULT_LEASE_TTL_MS;
    await expect(reconcileExpiredLeaseHardFailure(fake.adapter, {
      reconciliationReportSha256: 'b'.repeat(64),
      firstDurableManifestSha256: digest,
      secondDurableManifestSha256: digest,
      firstManifestCapturedAt: fake.now - 1,
      secondManifestCapturedAt: fake.now,
      batchId: 'batch-1',
      operatorId: 'operator-1',
    })).rejects.toThrow('manifest_capture_order_invalid');
    await expect(reconcileExpiredLeaseHardFailure(fake.adapter, {
      reconciliationReportSha256: 'b'.repeat(64),
      firstDurableManifestSha256: digest,
      secondDurableManifestSha256: digest,
      firstManifestCapturedAt: fake.now + 1,
      secondManifestCapturedAt: fake.now + 1,
      batchId: 'batch-1',
      operatorId: 'operator-1',
    })).rejects.toThrow('manifest_capture_in_future');
    await reconcileExpiredLeaseHardFailure(fake.adapter, {
      reconciliationReportSha256: 'b'.repeat(64),
      firstDurableManifestSha256: digest,
      secondDurableManifestSha256: digest,
      firstManifestCapturedAt: fake.now,
      secondManifestCapturedAt: fake.now,
      batchId: 'batch-1',
      operatorId: 'operator-1',
    });
    expect(fake.reconciliations).toHaveLength(1);
    expect(await openMutationGate(fake.adapter)).toEqual({ epoch: 2 });
  });

  it('extends the Redis-time quarantine to the largest admitted lease TTL', async () => {
    const fake = new FakeRedis();
    const largerTtl = DEFAULT_LEASE_TTL_MS + 10_000;
    await acquireMutationLease(fake.adapter, 'POST:api/missions/event.ts', largerTtl);
    await closeMutationGate(fake.adapter);
    fake.now += largerTtl + 1;
    await readMutationGateStatus(fake.adapter);
    const digest = 'c'.repeat(64);
    fake.now += DEFAULT_LEASE_TTL_MS;
    await expect(reconcileExpiredLeaseHardFailure(fake.adapter, {
      reconciliationReportSha256: 'd'.repeat(64),
      firstDurableManifestSha256: digest,
      secondDurableManifestSha256: digest,
      firstManifestCapturedAt: fake.now,
      secondManifestCapturedAt: fake.now,
      batchId: 'batch-large',
      operatorId: 'operator-1',
    })).rejects.toThrow('quarantine_incomplete');
    fake.now += 10_000;
    await expect(reconcileExpiredLeaseHardFailure(fake.adapter, {
      reconciliationReportSha256: 'd'.repeat(64),
      firstDurableManifestSha256: digest,
      secondDurableManifestSha256: digest,
      firstManifestCapturedAt: fake.now,
      secondManifestCapturedAt: fake.now,
      batchId: 'batch-large',
      operatorId: 'operator-1',
    })).resolves.toMatchObject({ reconciledAt: fake.now });
  });

  it('records a fresh hard-failure anchor for a second reconciled expiry cycle', async () => {
    const fake = new FakeRedis();
    const digest = 'e'.repeat(64);
    const evidence = () => ({
      reconciliationReportSha256: 'f'.repeat(64),
      firstDurableManifestSha256: digest,
      secondDurableManifestSha256: digest,
      firstManifestCapturedAt: fake.now,
      secondManifestCapturedAt: fake.now,
      batchId: 'batch-cycle',
      operatorId: 'operator-1',
    });

    await acquireMutationLease(fake.adapter, 'cycle-1', 100);
    await closeMutationGate(fake.adapter);
    fake.now += 101;
    await readMutationGateStatus(fake.adapter);
    const firstHardFailureAt = fake.hardFailureAt;
    fake.now += DEFAULT_LEASE_TTL_MS;
    await reconcileExpiredLeaseHardFailure(fake.adapter, evidence());
    expect(fake.hardFailureAt).toBeNull();
    await openMutationGate(fake.adapter);

    fake.now += 10;
    await acquireMutationLease(fake.adapter, 'cycle-2', 100);
    await closeMutationGate(fake.adapter);
    fake.now += 101;
    await readMutationGateStatus(fake.adapter);
    expect(fake.hardFailureAt).toBeGreaterThan(firstHardFailureAt);
    await expect(reconcileExpiredLeaseHardFailure(fake.adapter, evidence())).rejects.toThrow('quarantine_incomplete');
  });

  it('advances a missing default epoch from one to two on first reopen', async () => {
    const fake = new FakeRedis();
    fake.epoch = null;
    fake.gate = 'closed';
    await expect(openMutationGate(fake.adapter)).resolves.toEqual({ epoch: 2 });
  });

  it('renews a live lease without changing its epoch or fence', async () => {
    const fake = new FakeRedis();
    const lease = await acquireMutationLease(fake.adapter, 'POST:api/missions/event.ts', 100);
    const fence = lease.fence;
    fake.now += 80;
    expect(await renewMutationLease(lease)).toBe(true);
    expect(lease.fence).toBe(fence);
    fake.now += 80;
    const controlled = createControlledRedis(fake, fake.adapter, enabled);
    await runWithMutationLease(lease, () => controlled.set('sd:user:u1:daily:2026-08-02', '{}'));
    expect(fake.mutationCount).toBe(1);
  });

  it('rejects durable writes without a fenced lease but permits classified ephemeral writes', async () => {
    const fake = new FakeRedis();
    const controlled = createControlledRedis(fake, fake.adapter, enabled);
    await expect(controlled.set('sd:user:u1:coins', '1')).rejects.toBeInstanceOf(LeaseFenceError);
    await expect(controlled.set('sd:session:opaque-token', 'u1')).resolves.toBe('OK');
  });

  it('uses room phase and treats CANCELED and COMPLETED PVP records as drained', async () => {
    const records = new Map([
      ['sd:pvp:room:canceled', JSON.stringify({ phase: 'CANCELED', matchId: 'old-1' })],
      ['sd:pvp:room:completed', JSON.stringify({ phase: 'COMPLETED', matchId: 'old-2' })],
      ['sd:pvp:room:active', JSON.stringify({ phase: 'IN_MATCH', matchId: 'match-1' })],
      ['sd:pvp:match:old-1', JSON.stringify({ phase: 'ABORTED' })],
      ['sd:pvp:match:old-2', JSON.stringify({ phase: 'MATCH_RESULT' })],
      ['sd:pvp:match:match-1', JSON.stringify({ phase: 'MATCH_RESULT' })],
    ]);
    const redis = {
      smembers: async () => ['canceled', 'completed', 'active'],
      get: async (key) => records.get(key) ?? null,
      scan: async () => ['0', [...records.keys()].filter((key) => key.startsWith('sd:pvp:match:'))],
    };
    expect(await activePvpDrainStatus(redis)).toEqual({
      activeRoomCount: 1,
      activeMatchCount: 0,
      activeRooms: ['active'],
      drained: false,
    });
  });

  it.each([
    ['active', JSON.stringify({ phase: 'IN_MATCH' }), 1],
    ['unknown', JSON.stringify({ unexpected: true }), 1],
    ['missing', null, 1],
    ['terminal', JSON.stringify({ phase: 'MATCH_RESULT' }), 0],
  ])('checks a terminal room referenced %s match independently', async (_label, matchRecord, activeMatchCount) => {
    const redis = {
      smembers: async () => ['terminal-room'],
      get: async (key) => key === 'sd:pvp:room:terminal-room'
        ? JSON.stringify({ phase: 'COMPLETED', matchId: 'referenced-match' })
        : matchRecord,
      scan: async () => ['0', matchRecord ? ['sd:pvp:match:referenced-match'] : []],
    };
    expect(await activePvpDrainStatus(redis)).toEqual({
      activeRoomCount: 0,
      activeMatchCount,
      activeRooms: [],
      drained: activeMatchCount === 0,
    });
  });

  it.each(['CANCELLED', 'CLOSED', 'FINISHED'])('does not treat unsupported room phase %s as terminal', async (phase) => {
    const redis = {
      smembers: async () => ['room-1'],
      scan: async () => ['0', []],
      get: async () => JSON.stringify({ phase, matchId: null }),
    };
    expect(await activePvpDrainStatus(redis)).toMatchObject({ activeRoomCount: 1, drained: false });
  });

  it.each(['CANCELED', 'CANCELLED', 'CLOSED', 'COMPLETED', 'FINISHED'])('does not treat unsupported match phase %s as terminal', async (phase) => {
    const redis = {
      smembers: async () => [],
      scan: async () => ['0', ['sd:pvp:match:unsupported']],
      get: async () => JSON.stringify({ phase }),
    };
    expect(await activePvpDrainStatus(redis)).toMatchObject({ activeMatchCount: 1, drained: false });
  });

  it('discovers an active orphan match outside the room index', async () => {
    const redis = {
      smembers: async () => [],
      scan: async () => ['0', ['sd:pvp:match:orphan-active']],
      get: async () => JSON.stringify({ phase: 'PLAYING' }),
    };
    expect(await activePvpDrainStatus(redis)).toEqual({ activeRoomCount: 0, activeMatchCount: 1, activeRooms: [], drained: false });
  });

  it('catches completion partial-write after room matchId is cleared but before match terminal write', async () => {
    const records = new Map([
      ['sd:pvp:room:room-1', JSON.stringify({ phase: 'READY_CHECK', matchId: null })],
      ['sd:pvp:match:partial', JSON.stringify({ phase: 'ROUND_RESULT' })],
    ]);
    const redis = {
      smembers: async () => ['room-1'],
      scan: async () => ['0', ['sd:pvp:match:partial']],
      get: async (key) => records.get(key) ?? null,
    };
    expect(await activePvpDrainStatus(redis)).toMatchObject({ activeMatchCount: 1, drained: false });
  });

  it.each(['MATCH_RESULT', 'ABORTED'])('treats an orphan %s record as terminal', async (phase) => {
    const redis = {
      smembers: async () => [],
      scan: async () => ['0', ['sd:pvp:match:orphan-terminal']],
      get: async () => JSON.stringify({ phase, completedAt: 123 }),
    };
    expect(await activePvpDrainStatus(redis)).toEqual({ activeRoomCount: 0, activeMatchCount: 0, activeRooms: [], drained: true });
  });

  it('scans every cursor page and stops only at cursor zero', async () => {
    const scan = vi.fn()
      .mockResolvedValueOnce(['17', ['sd:pvp:match:terminal']])
      .mockResolvedValueOnce(['42', []])
      .mockResolvedValueOnce(['0', ['sd:pvp:match:active']]);
    const redis = {
      smembers: async () => [],
      scan,
      get: async (key) => JSON.stringify({ phase: key.endsWith(':terminal') ? 'MATCH_RESULT' : 'PLAYING' }),
    };
    expect(await activePvpDrainStatus(redis)).toMatchObject({ activeMatchCount: 1, drained: false });
    expect(scan.mock.calls).toEqual([
      ['0', { match: 'sd:pvp:match:*', count: 1_000 }],
      ['17', { match: 'sd:pvp:match:*', count: 1_000 }],
      ['42', { match: 'sd:pvp:match:*', count: 1_000 }],
    ]);
  });

  it('deduplicates a match found by both room reference and SCAN', async () => {
    const get = vi.fn(async (key) => key.startsWith('sd:pvp:room:')
      ? JSON.stringify({ phase: 'IN_MATCH', matchId: 'same-match' })
      : JSON.stringify({ phase: 'PLAYING' }));
    const redis = {
      smembers: async () => ['room-1'],
      scan: async () => ['0', ['sd:pvp:match:same-match', 'sd:pvp:match:same-match']],
      get,
    };
    expect(await activePvpDrainStatus(redis)).toMatchObject({ activeRoomCount: 1, activeMatchCount: 1, drained: false });
    expect(get.mock.calls.filter(([key]) => key === 'sd:pvp:match:same-match')).toHaveLength(1);
  });

  it.each([
    ['malformed match JSON', {
      smembers: async () => [], scan: async () => ['0', ['sd:pvp:match:broken']], get: async () => '{not-json',
    }],
    ['provider scan failure', {
      smembers: async () => [], scan: async () => { throw new Error('provider payload'); }, get: vi.fn(),
    }],
    ['malformed scan page', {
      smembers: async () => [], scan: async () => ['not-a-cursor', []], get: vi.fn(),
    }],
    ['non-progressing cursor', {
      smembers: async () => [], scan: vi.fn().mockResolvedValueOnce(['7', []]).mockResolvedValueOnce(['7', []]), get: vi.fn(),
    }],
  ])('fails closed on %s', async (_label, redis) => {
    await expect(activePvpDrainStatus(redis)).rejects.toThrow();
  });

  it('defaults every rollout flag off except legacy storage', () => {
    expect(productionControlFlags({})).toEqual({
      legacyStorage: true,
      supabaseShadowVerification: false,
      admissionGate: false,
      canonicalAuthTickets: false,
      protectedAccountCanary: false,
      rollbackMode: false,
    });
  });

  it('emits only allowlisted structured fields', () => {
    const info = vi.fn();
    redactedMigrationEvent({ event: 'verify', phase: 0, outcome: 'ok', password: 'never', token: 'never', payload: { player: 'never' } }, { info });
    expect(info).toHaveBeenCalledOnce();
    expect(info.mock.calls[0][0]).toBe('{"scope":"submarine-dash-migration","event":"verify","phase":0,"outcome":"ok"}');
  });
});
