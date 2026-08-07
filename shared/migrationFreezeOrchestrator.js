import { verifyDeployedRuntimeProbes } from './productionRuntimeProbe.js';
import { DEFAULT_LEASE_TTL_MS, leaseTtlMs } from './productionControls.js';

export const FREEZE_DRAIN_SAFETY_MARGIN_MS = 70_000;
export const DEFAULT_FREEZE_DRAIN_TIMEOUT_MS = DEFAULT_LEASE_TTL_MS + FREEZE_DRAIN_SAFETY_MARGIN_MS;
export const DEFAULT_FREEZE_POLL_INTERVAL_MS = 1_000;

const MIN_DRAIN_TIMEOUT_MS = 1_000;
const MAX_DRAIN_TIMEOUT_MS = 30 * 60_000;
const MIN_POLL_INTERVAL_MS = 50;
const MAX_POLL_INTERVAL_MS = 10_000;

export class MigrationFreezeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MigrationFreezeError';
    this.code = code;
  }
}

export function migrationControlErrorPayload(error) {
  if (error instanceof MigrationFreezeError) return { ok: false, code: error.code, message: error.message };
  return {
    ok: false,
    code: 'MIGRATION_CONTROL_FAILED',
    message: 'Migration control command failed. Inspect protected operator logs for details.',
  };
}

function boundedInteger(value, fallback, name, min, max) {
  const parsed = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new MigrationFreezeError('INVALID_FREEZE_TIMING', `${name} must be an integer between ${min} and ${max} milliseconds.`);
  }
  return parsed;
}

export function freezeTimingFromEnv(env = process.env) {
  const minimumForLease = leaseTtlMs(env) + FREEZE_DRAIN_SAFETY_MARGIN_MS;
  const timeoutMs = boundedInteger(
    env.SD_MIGRATION_FREEZE_DRAIN_TIMEOUT_MS,
    DEFAULT_FREEZE_DRAIN_TIMEOUT_MS,
    'SD_MIGRATION_FREEZE_DRAIN_TIMEOUT_MS',
    MIN_DRAIN_TIMEOUT_MS,
    MAX_DRAIN_TIMEOUT_MS,
  );
  const pollIntervalMs = boundedInteger(
    env.SD_MIGRATION_FREEZE_POLL_INTERVAL_MS,
    DEFAULT_FREEZE_POLL_INTERVAL_MS,
    'SD_MIGRATION_FREEZE_POLL_INTERVAL_MS',
    MIN_POLL_INTERVAL_MS,
    MAX_POLL_INTERVAL_MS,
  );
  if (pollIntervalMs > timeoutMs) {
    throw new MigrationFreezeError('INVALID_FREEZE_TIMING', 'SD_MIGRATION_FREEZE_POLL_INTERVAL_MS must not exceed the drain timeout.');
  }
  if (timeoutMs < minimumForLease) {
    throw new MigrationFreezeError('INVALID_FREEZE_TIMING', `SD_MIGRATION_FREEZE_DRAIN_TIMEOUT_MS must be at least ${minimumForLease}ms for the configured lease TTL and safety margin.`);
  }
  return { timeoutMs, pollIntervalMs };
}

function validateFreezeTiming(timeoutMs, pollIntervalMs, env) {
  const timeout = boundedInteger(timeoutMs, DEFAULT_FREEZE_DRAIN_TIMEOUT_MS, 'timeoutMs', MIN_DRAIN_TIMEOUT_MS, MAX_DRAIN_TIMEOUT_MS);
  const poll = boundedInteger(pollIntervalMs, DEFAULT_FREEZE_POLL_INTERVAL_MS, 'pollIntervalMs', MIN_POLL_INTERVAL_MS, MAX_POLL_INTERVAL_MS);
  if (poll > timeout) throw new MigrationFreezeError('INVALID_FREEZE_TIMING', 'pollIntervalMs must not exceed timeoutMs.');
  const minimumForLease = leaseTtlMs(env) + FREEZE_DRAIN_SAFETY_MARGIN_MS;
  if (timeout < minimumForLease) {
    throw new MigrationFreezeError('INVALID_FREEZE_TIMING', `timeoutMs must be at least ${minimumForLease}ms for the configured lease TTL and safety margin.`);
  }
  return { timeoutMs: timeout, pollIntervalMs: poll };
}

async function sanitizedBoundary(code, message, operation) {
  try {
    return await operation();
  } catch {
    throw new MigrationFreezeError(code, message);
  }
}

export function redactedPvpDrainStatus(status) {
  const activeRoomCount = Number(status?.activeRoomCount);
  const activeMatchCount = Number(status?.activeMatchCount);
  const countsDrained = activeRoomCount === 0 && activeMatchCount === 0;
  if (!Number.isSafeInteger(activeRoomCount) || activeRoomCount < 0 || !Number.isSafeInteger(activeMatchCount) || activeMatchCount < 0 || typeof status?.drained !== 'boolean' || status.drained !== countsDrained) {
    throw new MigrationFreezeError('INVALID_CONTROL_STATUS', 'PVP drain status is malformed.');
  }
  return {
    activeRoomCount,
    activeMatchCount,
    drained: status.drained,
  };
}

export function redactedMigrationGateStatus(status) {
  const activeLeases = Number(status?.activeLeases);
  const epoch = Number(status?.epoch);
  if (!['open', 'closed'].includes(status?.gate) || !Number.isSafeInteger(activeLeases) || activeLeases < 0 || !Number.isSafeInteger(epoch) || epoch < 1 || typeof status?.hardExpiredLease !== 'boolean') {
    throw new MigrationFreezeError('INVALID_CONTROL_STATUS', 'Mutation gate status is malformed.');
  }
  return {
    gate: status?.gate,
    epoch,
    activeLeases,
    hardExpiredLease: status.hardExpiredLease,
  };
}

function redactedCloseResult(result) {
  const activeLeases = Number(result?.activeLeases);
  const epoch = Number(result?.epoch);
  if (!Number.isSafeInteger(activeLeases) || activeLeases < 0 || !Number.isSafeInteger(epoch) || epoch < 1) {
    throw new MigrationFreezeError('INVALID_CONTROL_STATUS', 'Mutation gate close result is malformed.');
  }
  return { activeLeases, epoch };
}

function requireCallbacks(callbacks) {
  for (const [name, callback] of Object.entries(callbacks)) {
    if (typeof callback !== 'function') throw new TypeError(`${name} callback is required.`);
  }
}

async function initialStateAfterVerification({ verifiedRuntimeProbes, readStatus, readPvp }) {
  const gate = redactedMigrationGateStatus(await sanitizedBoundary('CONTROL_STATUS_READ_FAILED', 'Mutation gate status could not be read.', readStatus));
  if (gate.gate !== 'open') {
    throw new MigrationFreezeError('GATE_NOT_OPEN', 'Migration freeze requires the mutation gate to be open initially.');
  }
  if (gate.hardExpiredLease) {
    throw new MigrationFreezeError('HARD_EXPIRED_LEASE', 'Migration freeze is blocked by an expired-lease hard failure.');
  }
  const pvp = redactedPvpDrainStatus(await sanitizedBoundary('PVP_STATUS_READ_FAILED', 'PVP drain status could not be read.', readPvp));
  if (!pvp.drained) {
    throw new MigrationFreezeError('PVP_NOT_DRAINED', 'Migration freeze requires PVP rooms and matches to be drained before gate close.');
  }
  return { verifiedRuntimeProbes, gate, pvp };
}

export async function preflightMigrationFreeze({
  urls,
  expectedCommit,
  verifyRuntimeProbes = verifyDeployedRuntimeProbes,
  readStatus,
  readPvp,
}) {
  requireCallbacks({ verifyRuntimeProbes, readStatus, readPvp });
  const verifiedRuntimeProbes = await sanitizedBoundary(
    'RUNTIME_PROBE_VERIFICATION_FAILED',
    'Deployed runtime probe verification failed.',
    () => verifyRuntimeProbes({ urls, expectedCommit }),
  );
  const state = await initialStateAfterVerification({ verifiedRuntimeProbes, readStatus, readPvp });
  return { outcome: 'ready', ...state };
}

function assertClosedHealthy(status, expectedEpoch, code = 'FREEZE_STATE_INVALID') {
  const gate = redactedMigrationGateStatus(status);
  if (gate.gate !== 'closed') {
    throw new MigrationFreezeError(code, 'Freeze verification failed because the mutation gate is not closed.');
  }
  if (gate.hardExpiredLease) {
    throw new MigrationFreezeError('HARD_EXPIRED_LEASE_AFTER_CLOSE', 'Freeze remains closed because an expired-lease hard failure was detected.');
  }
  if (gate.epoch !== expectedEpoch) {
    throw new MigrationFreezeError('GATE_EPOCH_CHANGED', 'Freeze remains closed because the mutation gate epoch changed unexpectedly.');
  }
  return gate;
}

function assertConfirmedOpen(status, expectedEpoch) {
  const gate = redactedMigrationGateStatus(status);
  return gate.gate === 'open' && gate.epoch === expectedEpoch && gate.activeLeases === 0 && !gate.hardExpiredLease;
}

async function readGateBoundary(readStatus) {
  return sanitizedBoundary('CONTROL_STATUS_READ_FAILED', 'Mutation gate status could not be read.', readStatus);
}

async function classifyReopenState({ readStatus, closedEpoch, expectedOpenEpoch }) {
  try {
    const gate = redactedMigrationGateStatus(await readGateBoundary(readStatus));
    if (assertConfirmedOpen(gate, expectedOpenEpoch)) return 'open';
    if (gate.gate === 'closed' && gate.epoch === closedEpoch && gate.activeLeases === 0 && !gate.hardExpiredLease) return 'closed';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

export async function freezeMigration({
  urls,
  expectedCommit,
  timeoutMs,
  pollIntervalMs,
  timingEnv = process.env,
  verifyRuntimeProbes = verifyDeployedRuntimeProbes,
  readStatus,
  readPvp,
  closeGate,
  reopenGate,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
}) {
  requireCallbacks({ verifyRuntimeProbes, readStatus, readPvp, closeGate, reopenGate, sleep });
  const verifiedRuntimeProbes = await sanitizedBoundary(
    'RUNTIME_PROBE_VERIFICATION_FAILED',
    'Deployed runtime probe verification failed.',
    () => verifyRuntimeProbes({ urls, expectedCommit }),
  );
  const timing = timeoutMs === undefined && pollIntervalMs === undefined
    ? freezeTimingFromEnv(timingEnv)
    : validateFreezeTiming(timeoutMs, pollIntervalMs, timingEnv);
  const initial = await initialStateAfterVerification({ verifiedRuntimeProbes, readStatus, readPvp });

  const closeResult = redactedCloseResult(await sanitizedBoundary('GATE_CLOSE_FAILED', 'Mutation gate close failed.', closeGate));
  if (closeResult.epoch !== initial.gate.epoch) {
    throw new MigrationFreezeError('GATE_EPOCH_CHANGED', 'Freeze remains closed because the close result changed the mutation gate epoch unexpectedly.');
  }

  let elapsedMs = 0;
  let polls = 0;
  while (true) {
    polls += 1;
    const gate = assertClosedHealthy(await readGateBoundary(readStatus), initial.gate.epoch);
    if (gate.activeLeases === 0) {
      break;
    }
    if (elapsedMs >= timing.timeoutMs) {
      throw new MigrationFreezeError('LEASE_DRAIN_TIMEOUT', `Freeze remains closed after the ${timing.timeoutMs}ms lease-drain timeout.`);
    }
    const waitMs = Math.min(timing.pollIntervalMs, timing.timeoutMs - elapsedMs);
    await sanitizedBoundary('LEASE_DRAIN_WAIT_FAILED', 'Lease-drain polling wait failed.', () => sleep(waitMs));
    elapsedMs += waitMs;
  }

  const pvp = redactedPvpDrainStatus(await sanitizedBoundary('PVP_STATUS_READ_FAILED', 'PVP drain status could not be read.', readPvp));
  if (!pvp.drained) {
    const rollbackGate = assertClosedHealthy(await readGateBoundary(readStatus), initial.gate.epoch, 'POST_CLOSE_PVP_RACE_UNSAFE');
    if (rollbackGate.activeLeases !== 0) {
      throw new MigrationFreezeError('POST_CLOSE_PVP_RACE_UNSAFE', 'Post-close PVP activity was detected; the gate remains closed because rollback is not safe.');
    }
    const expectedOpenEpoch = Number.isSafeInteger(initial.gate.epoch + 1) ? initial.gate.epoch + 1 : null;
    if (expectedOpenEpoch === null) {
      throw new MigrationFreezeError('POST_CLOSE_PVP_RACE_UNSAFE', 'Post-close PVP activity was detected; the gate remains closed because a safe epoch transition cannot be represented.');
    }
    let reopenResult;
    let callbackFailed = false;
    try {
      reopenResult = await reopenGate();
    } catch {
      callbackFailed = true;
    }
    const reopenState = await classifyReopenState({ readStatus, closedEpoch: initial.gate.epoch, expectedOpenEpoch });
    if (reopenState === 'open') {
      const resultEpoch = Number(reopenResult?.epoch);
      const code = callbackFailed || resultEpoch !== expectedOpenEpoch
        ? 'POST_CLOSE_PVP_RACE_REOPENED_AFTER_AMBIGUOUS_RESULT'
        : 'POST_CLOSE_PVP_RACE_REOPENED';
      throw new MigrationFreezeError(code, 'Post-close PVP activity was detected; the gate is confirmed reopened and freeze failed.');
    }
    if (reopenState === 'closed') {
      throw new MigrationFreezeError('POST_CLOSE_PVP_RACE_REOPEN_FAILED_CLOSED', 'Post-close PVP activity was detected; the reopen did not complete and the gate is confirmed closed.');
    }
    throw new MigrationFreezeError('POST_CLOSE_PVP_RACE_REOPEN_STATE_UNKNOWN', 'Post-close PVP activity was detected; the gate state after the reopen attempt is unknown and must be verified.');
  }

  const finalGate = assertClosedHealthy(await readGateBoundary(readStatus), initial.gate.epoch);
  if (finalGate.activeLeases !== 0) {
    throw new MigrationFreezeError('LEASE_RACE_AFTER_DRAIN', 'Freeze remains closed because a lease appeared after the drain check.');
  }

  return {
    outcome: 'frozen',
    verifiedRuntimeProbes: initial.verifiedRuntimeProbes,
    gate: finalGate,
    pvp,
    drain: { polls, elapsedMs },
  };
}

export async function quarantineStalePvp({
  urls,
  expectedCommit,
  expectedEpoch,
  timeoutMs,
  pollIntervalMs,
  timingEnv = process.env,
  verifyRuntimeProbes = verifyDeployedRuntimeProbes,
  prepareEvidence,
  readStatus,
  readPvp,
  closeGate,
  executeTransaction,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
}) {
  requireCallbacks({ verifyRuntimeProbes, prepareEvidence, readStatus, readPvp, closeGate, executeTransaction, sleep });
  const verifiedRuntimeProbes = await sanitizedBoundary(
    'RUNTIME_PROBE_VERIFICATION_FAILED', 'Deployed runtime probe verification failed.',
    () => verifyRuntimeProbes({ urls, expectedCommit }),
  );
  const evidence = await sanitizedBoundary('QUARANTINE_EVIDENCE_INVALID', 'Stale-PVP quarantine evidence validation failed.', prepareEvidence);
  const timing = timeoutMs === undefined && pollIntervalMs === undefined
    ? freezeTimingFromEnv(timingEnv)
    : validateFreezeTiming(timeoutMs, pollIntervalMs, timingEnv);
  const initial = redactedMigrationGateStatus(await readGateBoundary(readStatus));
  if (initial.hardExpiredLease) throw new MigrationFreezeError('QUARANTINE_INITIAL_GATE_INVALID', 'Quarantine requires a gate without a hard-expired lease.');
  if (expectedEpoch !== undefined && initial.epoch !== expectedEpoch) throw new MigrationFreezeError('GATE_EPOCH_CHANGED', 'Quarantine expected epoch does not match the initial gate epoch.');
  if (initial.gate === 'open') {
    const closeResult = redactedCloseResult(await sanitizedBoundary('GATE_CLOSE_FAILED', 'Mutation gate close failed.', closeGate));
    if (closeResult.epoch !== initial.epoch) throw new MigrationFreezeError('GATE_EPOCH_CHANGED', 'Quarantine close changed the mutation gate epoch unexpectedly.');
  } else if (initial.gate !== 'closed' || expectedEpoch === undefined) {
    throw new MigrationFreezeError('QUARANTINE_INITIAL_GATE_INVALID', 'Closed-gate quarantine rerun requires the exact expected epoch.');
  }

  let elapsedMs = 0;
  let polls = 0;
  while (true) {
    polls += 1;
    const gate = assertClosedHealthy(await readGateBoundary(readStatus), initial.epoch);
    if (gate.activeLeases === 0) break;
    if (elapsedMs >= timing.timeoutMs) throw new MigrationFreezeError('LEASE_DRAIN_TIMEOUT', `Quarantine remains closed after the ${timing.timeoutMs}ms lease-drain timeout.`);
    const waitMs = Math.min(timing.pollIntervalMs, timing.timeoutMs - elapsedMs);
    await sanitizedBoundary('LEASE_DRAIN_WAIT_FAILED', 'Lease-drain polling wait failed.', () => sleep(waitMs));
    elapsedMs += waitMs;
  }
  const transaction = await sanitizedBoundary('QUARANTINE_TRANSACTION_FAILED', 'Stale-PVP quarantine transaction failed or is ambiguous.', () => executeTransaction({ evidence, epoch: initial.epoch }));
  const pvp = redactedPvpDrainStatus(await sanitizedBoundary('PVP_STATUS_READ_FAILED', 'PVP drain status could not be read.', readPvp));
  if (!pvp.drained) throw new MigrationFreezeError('QUARANTINE_POSTCHECK_FAILED', 'Quarantine remains closed because authoritative PVP state did not drain to zero.');
  const finalGate = assertClosedHealthy(await readGateBoundary(readStatus), initial.epoch);
  if (finalGate.activeLeases !== 0) throw new MigrationFreezeError('LEASE_RACE_AFTER_DRAIN', 'Quarantine remains closed because a lease appeared after the transaction.');
  return { outcome: transaction?.outcome ?? 'quarantined', verifiedRuntimeProbes, gate: finalGate, pvp, drain: { polls, elapsedMs } };
}

export async function verifyFrozenMigration({
  urls,
  expectedCommit,
  expectedEpoch,
  verifyRuntimeProbes = verifyDeployedRuntimeProbes,
  readStatus,
  readPvp,
}) {
  requireCallbacks({ verifyRuntimeProbes, readStatus, readPvp });
  const verifiedRuntimeProbes = await sanitizedBoundary(
    'RUNTIME_PROBE_VERIFICATION_FAILED', 'Deployed runtime probe verification failed.',
    () => verifyRuntimeProbes({ urls, expectedCommit }),
  );
  if (!Number.isSafeInteger(expectedEpoch) || expectedEpoch < 1) throw new MigrationFreezeError('INVALID_CONTROL_STATUS', 'An exact frozen gate epoch is required.');
  const initialGate = assertClosedHealthy(await readGateBoundary(readStatus), expectedEpoch);
  if (initialGate.activeLeases !== 0) throw new MigrationFreezeError('FROZEN_VERIFICATION_FAILED', 'Frozen verification requires zero active leases.');
  const pvp = redactedPvpDrainStatus(await sanitizedBoundary('PVP_STATUS_READ_FAILED', 'PVP drain status could not be read.', readPvp));
  if (!pvp.drained) throw new MigrationFreezeError('FROZEN_VERIFICATION_FAILED', 'Frozen verification requires zero active PVP rooms and matches.');
  const finalGate = assertClosedHealthy(await readGateBoundary(readStatus), expectedEpoch);
  if (finalGate.activeLeases !== 0) throw new MigrationFreezeError('FROZEN_VERIFICATION_FAILED', 'Frozen verification final check requires zero active leases.');
  return { outcome: 'frozen_verified', verifiedRuntimeProbes, gate: finalGate, pvp };
}
