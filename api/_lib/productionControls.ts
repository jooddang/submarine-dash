import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  acquireMutationLease,
  MaintenanceFreezeError,
  productionControlFlags,
  redactedMigrationEvent,
  releaseMutationLease,
  runWithMutationLease,
  startMutationLeaseRenewal,
  renewMutationLease,
} from '../../shared/productionControls.js';
import { requiresDurableAdmission, routeClassification } from '../../shared/productionRouteInventory.js';
import { getRawUpstashRedisClient } from './redis.js';

type Handler = (req: VercelRequest, res: VercelResponse) => unknown | Promise<unknown>;

type ControlDependencies = {
  flags?: typeof productionControlFlags;
  adapter?: typeof redisAdapter;
  acquire?: typeof acquireMutationLease;
  renew?: typeof renewMutationLease;
  release?: typeof releaseMutationLease;
  run?: typeof runWithMutationLease;
  event?: typeof redactedMigrationEvent;
};

function redisAdapter() {
  const redis = getRawUpstashRedisClient();
  return {
    eval: (script: string, keys: string[], args: Array<string | number>) => redis.eval(script, keys, args),
  };
}

export function withProductionControl(routeFile: string, handler: Handler, dependencies: ControlDependencies = {}): Handler {
  const getFlags = dependencies.flags ?? productionControlFlags;
  const getAdapter = dependencies.adapter ?? redisAdapter;
  const acquire = dependencies.acquire ?? acquireMutationLease;
  const renew = dependencies.renew ?? renewMutationLease;
  const release = dependencies.release ?? releaseMutationLease;
  const run = dependencies.run ?? runWithMutationLease;
  const event = dependencies.event ?? redactedMigrationEvent;
  return async (req, res) => {
    const classification = routeClassification(routeFile, req.method);
    const flags = getFlags();
    if (!flags.admissionGate || !requiresDurableAdmission(classification)) return handler(req, res);

    const startedAt = Date.now();
    let lease;
    try {
      lease = await acquire(getAdapter(), `${req.method}:${routeFile}`);
    } catch (error) {
      if (error instanceof MaintenanceFreezeError) {
        res.setHeader('Retry-After', '30');
        event({ event: 'mutation_rejected', phase: 0, route: routeFile, outcome: 'maintenance' });
        return res.status(503).json({
          error: error.code,
          message: 'Game progress is temporarily paused for maintenance. Please retry shortly.',
          retryable: true,
        });
      }
      throw error;
    }

    const renewal = startMutationLeaseRenewal(lease, {
      renew,
      onExpired: () => event({ event: 'lease_expired', phase: 0, route: routeFile, outcome: 'blocked' }),
      onError: () => event({ event: 'lease_renewal_failed', phase: 0, route: routeFile, outcome: 'blocked' }),
    });

    try {
      return await run(lease, () => handler(req, res));
    } finally {
      await renewal.stop();
      await release(lease).catch(() => {
        event({ event: 'lease_release_failed', phase: 0, route: routeFile, durationMs: Date.now() - startedAt, outcome: 'blocked' });
      });
    }
  };
}
