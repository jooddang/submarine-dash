import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_LEASE_TTL_MS } from './productionControls.js';
import {
  DEFAULT_FREEZE_DRAIN_TIMEOUT_MS,
  FREEZE_DRAIN_SAFETY_MARGIN_MS,
  freezeMigration,
  freezeTimingFromEnv,
  migrationControlErrorPayload,
  preflightMigrationFreeze,
  quarantineStalePvp,
  verifyFrozenMigration,
} from './migrationFreezeOrchestrator.js';

const commit = '3065c4defce45314ae166922f64df60136d25c88';
const urls = ['https://submarine-dash.roadcrosser.com/api/health'];
const probes = [{ origin: 'https://submarine-dash.roadcrosser.com', deployedCommit: commit, routeInventoryDigest: 'a'.repeat(64) }];
const open = { gate: 'open', epoch: 4, activeLeases: 2, hardExpiredLease: false };
const closed = (activeLeases = 0, override = {}) => ({ gate: 'closed', epoch: 4, activeLeases, hardExpiredLease: false, ...override });
const reopened = { gate: 'open', epoch: 5, activeLeases: 0, hardExpiredLease: false };
const drained = { activeRoomCount: 0, activeMatchCount: 0, activeRooms: ['must-not-leak'], drained: true };
const timingEnv = { SD_MIGRATION_LEASE_TTL_MS: '30000' };

function callbacks(override = {}) {
  return {
    urls,
    expectedCommit: commit,
    timeoutMs: 100_000,
    pollIntervalMs: 10_000,
    timingEnv,
    verifyRuntimeProbes: vi.fn(async () => probes),
    readStatus: vi.fn(async () => open),
    readPvp: vi.fn(async () => drained),
    closeGate: vi.fn(async () => ({ activeLeases: 2, epoch: 4 })),
    reopenGate: vi.fn(async () => ({ epoch: 5 })),
    sleep: vi.fn(async () => {}),
    ...override,
  };
}

describe('migration freeze orchestration', () => {
  it('keeps preflight non-closing and returns exact redacted output', async () => {
    const options = callbacks();
    await expect(preflightMigrationFreeze(options)).resolves.toEqual({
      outcome: 'ready',
      verifiedRuntimeProbes: probes,
      gate: { gate: 'open', epoch: 4, activeLeases: 2, hardExpiredLease: false },
      pvp: { activeRoomCount: 0, activeMatchCount: 0, drained: true },
    });
    expect(options.closeGate).not.toHaveBeenCalled();
    expect(JSON.stringify(await preflightMigrationFreeze(options))).not.toContain('must-not-leak');
  });

  it.each([
    ['probe failure', { verifyRuntimeProbes: vi.fn(async () => { throw new Error('probe mismatch'); }) }, 'probe verification failed'],
    ['initially closed gate', { readStatus: vi.fn(async () => closed()) }, 'open initially'],
    ['hard-expired lease', { readStatus: vi.fn(async () => ({ ...open, hardExpiredLease: true })) }, 'hard failure'],
    ['active PVP', { readPvp: vi.fn(async () => ({ activeRoomCount: 1, activeMatchCount: 0, activeRooms: ['secret-room-id'], drained: false })) }, 'PVP rooms'],
  ])('does not close on %s', async (_label, override, message) => {
    const options = callbacks(override);
    await expect(freezeMigration(options)).rejects.toThrow(message);
    expect(options.closeGate).not.toHaveBeenCalled();
  });

  it('closes, polls to zero leases, rechecks PVP, and returns exact success output', async () => {
    const options = callbacks({
      readStatus: vi.fn()
        .mockResolvedValueOnce(open)
        .mockResolvedValueOnce(closed(2))
        .mockResolvedValueOnce(closed(1))
        .mockResolvedValueOnce(closed(0))
        .mockResolvedValueOnce(closed(0)),
    });
    await expect(freezeMigration(options)).resolves.toEqual({
      outcome: 'frozen',
      verifiedRuntimeProbes: probes,
      gate: { gate: 'closed', epoch: 4, activeLeases: 0, hardExpiredLease: false },
      pvp: { activeRoomCount: 0, activeMatchCount: 0, drained: true },
      drain: { polls: 3, elapsedMs: 20_000 },
    });
    expect(options.closeGate).toHaveBeenCalledOnce();
    expect(options.reopenGate).not.toHaveBeenCalled();
  });

  it('times out fail-closed without attempting reopen', async () => {
    const options = callbacks({
      timeoutMs: 100_000,
      pollIntervalMs: 10_000,
      readStatus: vi.fn(async () => open).mockResolvedValueOnce(open).mockImplementation(async () => closed(1)),
    });
    await expect(freezeMigration(options)).rejects.toMatchObject({ code: 'LEASE_DRAIN_TIMEOUT' });
    expect(options.closeGate).toHaveBeenCalledOnce();
    expect(options.reopenGate).not.toHaveBeenCalled();
  });

  it('keeps a hard failure after close closed', async () => {
    const options = callbacks({
      readStatus: vi.fn().mockResolvedValueOnce(open).mockResolvedValueOnce(closed(1, { hardExpiredLease: true })),
    });
    await expect(freezeMigration(options)).rejects.toMatchObject({ code: 'HARD_EXPIRED_LEASE_AFTER_CLOSE' });
    expect(options.reopenGate).not.toHaveBeenCalled();
  });

  it('safely reopens and fails when PVP races after close', async () => {
    const options = callbacks({
      readStatus: vi.fn().mockResolvedValueOnce(open).mockResolvedValueOnce(closed()).mockResolvedValueOnce(closed()),
      readPvp: vi.fn().mockResolvedValueOnce(drained).mockResolvedValueOnce({ activeRoomCount: 1, activeMatchCount: 1, activeRooms: ['secret-room-id'], drained: false }),
    });
    options.readStatus.mockResolvedValueOnce(reopened);
    await expect(freezeMigration(options)).rejects.toMatchObject({ code: 'POST_CLOSE_PVP_RACE_REOPENED' });
    expect(options.reopenGate).toHaveBeenCalledOnce();
  });

  it('does not reopen a post-close PVP race when leases make rollback unsafe', async () => {
    const options = callbacks({
      readStatus: vi.fn().mockResolvedValueOnce(open).mockResolvedValueOnce(closed()).mockResolvedValueOnce(closed(1)),
      readPvp: vi.fn().mockResolvedValueOnce(drained).mockResolvedValueOnce({ activeRoomCount: 1, activeMatchCount: 0, drained: false }),
    });
    await expect(freezeMigration(options)).rejects.toMatchObject({ code: 'POST_CLOSE_PVP_RACE_UNSAFE' });
    expect(options.reopenGate).not.toHaveBeenCalled();
  });

  it('reports reopen failure and leaves the gate closed', async () => {
    const options = callbacks({
      readStatus: vi.fn().mockResolvedValueOnce(open).mockResolvedValueOnce(closed()).mockResolvedValueOnce(closed()).mockResolvedValueOnce(closed()),
      readPvp: vi.fn().mockResolvedValueOnce(drained).mockResolvedValueOnce({ activeRoomCount: 1, activeMatchCount: 0, drained: false }),
      reopenGate: vi.fn(async () => { throw new Error('redis unavailable for secret-room-id'); }),
    });
    await expect(freezeMigration(options)).rejects.toMatchObject({
      code: 'POST_CLOSE_PVP_RACE_REOPEN_FAILED_CLOSED',
      message: expect.not.stringContaining('secret-room-id'),
    });
    expect(options.reopenGate).toHaveBeenCalledOnce();
  });

  it('validates bounds and keeps the default drain timeout above the lease TTL', async () => {
    expect(DEFAULT_FREEZE_DRAIN_TIMEOUT_MS).toBe(DEFAULT_LEASE_TTL_MS + FREEZE_DRAIN_SAFETY_MARGIN_MS);
    expect(freezeTimingFromEnv({})).toEqual({ timeoutMs: DEFAULT_FREEZE_DRAIN_TIMEOUT_MS, pollIntervalMs: 1_000 });
    expect(() => freezeTimingFromEnv({ SD_MIGRATION_LEASE_TTL_MS: '1000000', SD_MIGRATION_FREEZE_DRAIN_TIMEOUT_MS: '1000000' })).toThrow('at least 1070000ms');
    expect(() => freezeTimingFromEnv({ SD_MIGRATION_FREEZE_DRAIN_TIMEOUT_MS: '1800001' })).toThrow('between');
    expect(() => freezeTimingFromEnv({ SD_MIGRATION_FREEZE_POLL_INTERVAL_MS: '49' })).toThrow('between');
    await expect(freezeMigration(callbacks({ timeoutMs: 100_000, pollIntervalMs: 100_001 }))).rejects.toMatchObject({ code: 'INVALID_FREEZE_TIMING' });
  });

  it('verifies runtime identity before rejecting invalid timing or reading control state', async () => {
    const options = callbacks({ timeoutMs: 99_999, pollIntervalMs: 100 });
    await expect(freezeMigration(options)).rejects.toMatchObject({ code: 'INVALID_FREEZE_TIMING' });
    expect(options.verifyRuntimeProbes).toHaveBeenCalledOnce();
    expect(options.readStatus).not.toHaveBeenCalled();
    expect(options.readPvp).not.toHaveBeenCalled();
    expect(options.closeGate).not.toHaveBeenCalled();
  });

  it('rejects inconsistent drained booleans before close', async () => {
    const options = callbacks({ readPvp: vi.fn(async () => ({ activeRoomCount: 1, activeMatchCount: 0, drained: true })) });
    await expect(freezeMigration(options)).rejects.toMatchObject({ code: 'INVALID_CONTROL_STATUS' });
    expect(options.closeGate).not.toHaveBeenCalled();
  });

  it('rejects unsafe epochs as malformed control state', async () => {
    const options = callbacks({ readStatus: vi.fn(async () => ({ ...open, epoch: Number.MAX_SAFE_INTEGER + 1 })) });
    await expect(freezeMigration(options)).rejects.toMatchObject({ code: 'INVALID_CONTROL_STATUS' });
    expect(options.closeGate).not.toHaveBeenCalled();
  });

  it('enforces the production lease floor for explicit timing arguments', async () => {
    const options = callbacks({ timingEnv: {}, timeoutMs: 100_000, pollIntervalMs: 10_000 });
    await expect(freezeMigration(options)).rejects.toMatchObject({ code: 'INVALID_FREEZE_TIMING' });
    expect(options.verifyRuntimeProbes).toHaveBeenCalledOnce();
    expect(options.readStatus).not.toHaveBeenCalled();
  });

  it.each([
    ['close result', { closeGate: vi.fn(async () => ({ activeLeases: 2, epoch: 5 })) }],
    ['poll', { readStatus: vi.fn().mockResolvedValueOnce(open).mockResolvedValueOnce(closed(1, { epoch: 5 })) }],
    ['final', {
      readStatus: vi.fn().mockResolvedValueOnce(open).mockResolvedValueOnce(closed()).mockResolvedValueOnce(closed(0, { epoch: 5 })),
    }],
  ])('fails closed when epoch changes at %s', async (_label, override) => {
    const options = callbacks(override);
    await expect(freezeMigration(options)).rejects.toMatchObject({ code: 'GATE_EPOCH_CHANGED' });
    expect(options.reopenGate).not.toHaveBeenCalled();
  });

  it('distinguishes an ambiguous reopen callback that actually opened the gate', async () => {
    const options = callbacks({
      readStatus: vi.fn().mockResolvedValueOnce(open).mockResolvedValueOnce(closed()).mockResolvedValueOnce(closed()).mockResolvedValueOnce(reopened),
      readPvp: vi.fn().mockResolvedValueOnce(drained).mockResolvedValueOnce({ activeRoomCount: 1, activeMatchCount: 0, drained: false }),
      reopenGate: vi.fn(async () => { throw new Error('secret upstream payload'); }),
    });
    await expect(freezeMigration(options)).rejects.toMatchObject({ code: 'POST_CLOSE_PVP_RACE_REOPENED_AFTER_AMBIGUOUS_RESULT' });
  });

  it('reports unknown rather than claiming closed when reopen verification fails', async () => {
    const options = callbacks({
      readStatus: vi.fn().mockResolvedValueOnce(open).mockResolvedValueOnce(closed()).mockResolvedValueOnce(closed()).mockRejectedValueOnce(new Error('secret status payload')),
      readPvp: vi.fn().mockResolvedValueOnce(drained).mockResolvedValueOnce({ activeRoomCount: 1, activeMatchCount: 0, drained: false }),
      reopenGate: vi.fn(async () => { throw new Error('secret reopen payload'); }),
    });
    await expect(freezeMigration(options)).rejects.toMatchObject({
      code: 'POST_CLOSE_PVP_RACE_REOPEN_STATE_UNKNOWN',
      message: expect.not.stringContaining('secret'),
    });
  });

  it.each([
    ['probe', { verifyRuntimeProbes: vi.fn(async () => { throw new Error('SECRET_PROBE_PAYLOAD'); }) }, 'RUNTIME_PROBE_VERIFICATION_FAILED'],
    ['gate read', { readStatus: vi.fn(async () => { throw new Error('SECRET_REDIS_PAYLOAD'); }) }, 'CONTROL_STATUS_READ_FAILED'],
    ['PVP read', { readPvp: vi.fn(async () => { throw new Error('SECRET_ROOM_ID'); }) }, 'PVP_STATUS_READ_FAILED'],
    ['gate close', { closeGate: vi.fn(async () => { throw new Error('SECRET_CLOSE_REPLY'); }) }, 'GATE_CLOSE_FAILED'],
  ])('redacts raw %s boundary errors', async (_label, override, code) => {
    const options = callbacks(override);
    const error = await freezeMigration(options).catch((caught) => caught);
    expect(error).toMatchObject({ code });
    expect(error.message).not.toContain('SECRET');
  });

  it('redacts non-allowlisted CLI boundary failures and preserves safe operator errors', () => {
    expect(migrationControlErrorPayload(new Error('SECRET_UPSTREAM_JSON_PAYLOAD'))).toEqual({
      ok: false,
      code: 'MIGRATION_CONTROL_FAILED',
      message: 'Migration control command failed. Inspect protected operator logs for details.',
    });
    expect(JSON.stringify(migrationControlErrorPayload(new Error('SECRET_UPSTREAM_JSON_PAYLOAD')))).not.toContain('SECRET');
    expect(migrationControlErrorPayload(new Error('{"roomId":"SECRET_ROOM"}'))).not.toHaveProperty('roomId');
  });
});

describe('stale PVP quarantine orchestration', () => {
  function quarantineCallbacks(override = {}) {
    return {
      urls, expectedCommit: commit, expectedEpoch: 4,
      timeoutMs: 100_000, pollIntervalMs: 10_000, timingEnv,
      verifyRuntimeProbes: vi.fn(async () => probes),
      prepareEvidence: vi.fn(async () => ({ archiveSha256: 'a'.repeat(64) })),
      readStatus: vi.fn().mockResolvedValueOnce(open).mockResolvedValueOnce(closed(2)).mockResolvedValueOnce(closed()).mockResolvedValueOnce(closed()),
      readPvp: vi.fn(async () => drained),
      closeGate: vi.fn(async () => ({ activeLeases: 2, epoch: 4 })),
      executeTransaction: vi.fn(async () => ({ outcome: 'quarantined' })),
      sleep: vi.fn(async () => {}),
      ...override,
    };
  }

  it('verifies probes, closes despite stale PVP, drains leases, transacts, and stays closed', async () => {
    const options = quarantineCallbacks();
    await expect(quarantineStalePvp(options)).resolves.toEqual({
      outcome: 'quarantined', verifiedRuntimeProbes: probes,
      gate: { gate: 'closed', epoch: 4, activeLeases: 0, hardExpiredLease: false },
      pvp: { activeRoomCount: 0, activeMatchCount: 0, drained: true },
      drain: { polls: 2, elapsedMs: 10_000 },
    });
    expect(options.verifyRuntimeProbes.mock.invocationCallOrder[0]).toBeLessThan(options.prepareEvidence.mock.invocationCallOrder[0]);
    expect(options.closeGate).toHaveBeenCalledOnce();
  });

  it('does not close when archive evidence validation fails', async () => {
    const options = quarantineCallbacks({ prepareEvidence: vi.fn(async () => { throw new Error('SECRET_ARCHIVE_DATA'); }) });
    const error = await quarantineStalePvp(options).catch((caught) => caught);
    expect(error).toMatchObject({ code: 'QUARANTINE_EVIDENCE_INVALID', message: expect.not.stringContaining('SECRET') });
    expect(options.closeGate).not.toHaveBeenCalled();
  });

  it('supports an idempotent audit/after-state rerun on the already-closed exact epoch', async () => {
    const options = quarantineCallbacks({
      readStatus: vi.fn().mockResolvedValueOnce(closed()).mockResolvedValueOnce(closed()).mockResolvedValueOnce(closed()),
      executeTransaction: vi.fn(async () => ({ outcome: 'already_quarantined' })),
    });
    await expect(quarantineStalePvp(options)).resolves.toMatchObject({ outcome: 'already_quarantined', gate: { gate: 'closed', epoch: 4 } });
    expect(options.closeGate).not.toHaveBeenCalled();
  });

  it.each([
    ['epoch drift', { readStatus: vi.fn().mockResolvedValueOnce(open).mockResolvedValueOnce(closed(1, { epoch: 5 })) }, 'GATE_EPOCH_CHANGED'],
    ['hard failure', { readStatus: vi.fn().mockResolvedValueOnce(open).mockResolvedValueOnce(closed(1, { hardExpiredLease: true })) }, 'HARD_EXPIRED_LEASE_AFTER_CLOSE'],
    ['transaction ambiguity', { executeTransaction: vi.fn(async () => { throw new Error('SECRET_REDIS_REPLY'); }) }, 'QUARANTINE_TRANSACTION_FAILED'],
    ['postcheck race', { readPvp: vi.fn(async () => ({ activeRoomCount: 1, activeMatchCount: 0, drained: false })) }, 'QUARANTINE_POSTCHECK_FAILED'],
  ])('fails closed on %s without any reopen surface', async (_label, override, code) => {
    const options = quarantineCallbacks(override);
    await expect(quarantineStalePvp(options)).rejects.toMatchObject({ code });
    expect(options).not.toHaveProperty('reopenGate');
  });

  it('verifies an already-closed pinned epoch without reopening', async () => {
    await expect(verifyFrozenMigration({
      urls, expectedCommit: commit, expectedEpoch: 4,
      verifyRuntimeProbes: vi.fn(async () => probes), readStatus: vi.fn(async () => closed()), readPvp: vi.fn(async () => drained),
    })).resolves.toEqual({
      outcome: 'frozen_verified', verifiedRuntimeProbes: probes,
      gate: { gate: 'closed', epoch: 4, activeLeases: 0, hardExpiredLease: false },
      pvp: { activeRoomCount: 0, activeMatchCount: 0, drained: true },
    });
  });

  it('fails verify-frozen when the final post-PVP gate re-read gains a lease', async () => {
    await expect(verifyFrozenMigration({
      urls, expectedCommit: commit, expectedEpoch: 4,
      verifyRuntimeProbes: vi.fn(async () => probes),
      readStatus: vi.fn().mockResolvedValueOnce(closed()).mockResolvedValueOnce(closed(1)),
      readPvp: vi.fn(async () => drained),
    })).rejects.toMatchObject({ code: 'FROZEN_VERIFICATION_FAILED' });
  });
});
