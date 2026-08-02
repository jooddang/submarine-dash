import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import Redis from 'ioredis';
import {
  acquireMutationLease,
  closeMutationGate,
  CONTROL_KEYS,
  DEFAULT_LEASE_TTL_MS,
  openMutationGate,
  readMutationGateStatus,
  reconcileExpiredLeaseHardFailure,
} from './productionControls.js';

let redis;
let server;
let temporaryDirectory;

function findRedisServer() {
  try {
    return execFileSync('which', ['redis-server'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

async function waitForRedis(socketPath) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = new Redis({ path: socketPath, lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false });
    try {
      await candidate.connect();
      await candidate.ping();
      return candidate;
    } catch {
      candidate.disconnect();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error('Temporary Redis server did not become ready.');
}

async function redisNowMs(client) {
  const [seconds, microseconds] = await client.time();
  return (Number(seconds) * 1_000) + Math.floor(Number(microseconds) / 1_000);
}

afterEach(async () => {
  if (redis) {
    await redis.shutdown('NOSAVE').catch(() => undefined);
    redis.disconnect();
  }
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await Promise.race([once(server, 'exit'), new Promise((resolve) => setTimeout(resolve, 1_000))]);
  }
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
  redis = undefined;
  server = undefined;
  temporaryDirectory = undefined;
});

const redisServerPath = findRedisServer();

describe.skipIf(!redisServerPath)('production controls against real Redis Lua', () => {
  it('uses a fresh hard-failure timestamp and blocks immediate reconciliation in cycle two', async () => {
    temporaryDirectory = mkdtempSync('/tmp/submarine-controls-');
    const socketPath = `${temporaryDirectory}/redis.sock`;
    server = spawn(redisServerPath, [
      '--port', '0',
      '--unixsocket', socketPath,
      '--unixsocketperm', '700',
      '--save', '',
      '--appendonly', 'no',
      '--dir', temporaryDirectory,
    ], { stdio: 'ignore' });
    redis = await waitForRedis(socketPath);
    const adapter = { eval: (script, keys, args) => redis.eval(script, keys.length, ...keys, ...args.map(String)) };
    const digest = 'a'.repeat(64);
    const report = 'b'.repeat(64);

    await acquireMutationLease(adapter, 'real-cycle-1', 30);
    await closeMutationGate(adapter);
    await new Promise((resolve) => setTimeout(resolve, 45));
    await readMutationGateStatus(adapter);
    const firstHardFailureAt = Number(await redis.get(CONTROL_KEYS.hardFailureAt));

    const immediateCapture = await redisNowMs(redis);
    await expect(reconcileExpiredLeaseHardFailure(adapter, {
      reconciliationReportSha256: report,
      firstDurableManifestSha256: digest,
      secondDurableManifestSha256: digest,
      firstManifestCapturedAt: immediateCapture,
      secondManifestCapturedAt: immediateCapture,
      batchId: 'real-cycle-1',
      operatorId: 'test-operator',
    })).rejects.toThrow('quarantine_incomplete');

    // Advance only the trusted Redis anchors in this isolated test database so
    // the test does not sleep for the production 930-second quarantine.
    const firstReconcileNow = await redisNowMs(redis);
    const elapsedAnchor = firstReconcileNow - DEFAULT_LEASE_TTL_MS - 1;
    await redis.mset(CONTROL_KEYS.hardFailureAt, elapsedAnchor, CONTROL_KEYS.closedAt, elapsedAnchor);
    await reconcileExpiredLeaseHardFailure(adapter, {
      reconciliationReportSha256: report,
      firstDurableManifestSha256: digest,
      secondDurableManifestSha256: digest,
      firstManifestCapturedAt: firstReconcileNow,
      secondManifestCapturedAt: firstReconcileNow,
      batchId: 'real-cycle-1',
      operatorId: 'test-operator',
    });
    expect(await redis.exists(CONTROL_KEYS.hardFailureAt)).toBe(0);
    expect(await redis.llen(CONTROL_KEYS.reconciliations)).toBe(1);
    await openMutationGate(adapter);

    await acquireMutationLease(adapter, 'real-cycle-2', 30);
    await closeMutationGate(adapter);
    await new Promise((resolve) => setTimeout(resolve, 45));
    await readMutationGateStatus(adapter);
    const secondHardFailureAt = Number(await redis.get(CONTROL_KEYS.hardFailureAt));
    expect(secondHardFailureAt).toBeGreaterThan(firstHardFailureAt);

    const secondImmediateCapture = await redisNowMs(redis);
    await expect(reconcileExpiredLeaseHardFailure(adapter, {
      reconciliationReportSha256: report,
      firstDurableManifestSha256: digest,
      secondDurableManifestSha256: digest,
      firstManifestCapturedAt: secondImmediateCapture,
      secondManifestCapturedAt: secondImmediateCapture,
      batchId: 'real-cycle-2',
      operatorId: 'test-operator',
    })).rejects.toThrow('quarantine_incomplete');
    expect(await redis.llen(CONTROL_KEYS.reconciliations)).toBe(1);
  }, 10_000);
});
