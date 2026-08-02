import { describe, expect, it, vi } from 'vitest';
import { ROUTE_INVENTORY_DIGEST, ROUTE_INVENTORY_VERSION } from './productionRouteInventory.js';
import { freezeAfterRuntimeVerification, productionRuntimeProbe, verifyDeployedRuntimeProbes } from './productionRuntimeProbe.js';

const commit = '3065c4defce45314ae166922f64df60136d25c88';

function responseWith(probe) {
  return { ok: true, status: 200, json: async () => ({ migrationControl: probe }) };
}

describe('deployed production runtime probe', () => {
  it('exposes only safe control state and immutable deployment identity', () => {
    expect(productionRuntimeProbe({
      SD_MIGRATION_ADMISSION_GATE_ENABLED: 'true',
      VERCEL_GIT_COMMIT_SHA: commit,
      UPSTASH_REDIS_REST_TOKEN: 'must-not-leak',
    })).toEqual({
      schemaVersion: 1,
      admissionGateEnabled: true,
      routeInventoryVersion: ROUTE_INVENTORY_VERSION,
      routeInventoryDigest: ROUTE_INVENTORY_DIGEST,
      deployedCommit: commit,
    });
  });

  it('verifies all deployed probes without making a real network call', async () => {
    const probe = productionRuntimeProbe({ SD_MIGRATION_ADMISSION_GATE_ENABLED: 'true', SD_DEPLOYED_COMMIT: commit });
    const fetchImpl = vi.fn(async () => responseWith(probe));
    await expect(verifyDeployedRuntimeProbes({
      urls: ['https://submarine-dash.roadcrosser.com/api/health', 'https://canary.example.com/api/health'],
      expectedCommit: commit,
      fetchImpl,
    })).resolves.toHaveLength(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['disabled gate', { admissionGateEnabled: false }],
    ['inventory mismatch', { routeInventoryDigest: '0'.repeat(64) }],
    ['commit mismatch', { deployedCommit: 'deadbeef' }],
  ])('blocks freeze on %s', async (_label, override) => {
    const probe = { ...productionRuntimeProbe({ SD_MIGRATION_ADMISSION_GATE_ENABLED: 'true', SD_DEPLOYED_COMMIT: commit }), ...override };
    await expect(verifyDeployedRuntimeProbes({
      urls: ['https://submarine-dash.roadcrosser.com/api/health'],
      expectedCommit: commit,
      fetchImpl: async () => responseWith(probe),
    })).rejects.toThrow();
  });

  it('rejects missing probes and non-HTTPS targets before fetch', async () => {
    await expect(verifyDeployedRuntimeProbes({ urls: [], expectedCommit: commit, fetchImpl: vi.fn() })).rejects.toThrow('At least one');
    await expect(verifyDeployedRuntimeProbes({ urls: ['https://example.com/api/health'], expectedCommit: '3065c4d', fetchImpl: vi.fn() })).rejects.toThrow('40-character');
    await expect(verifyDeployedRuntimeProbes({ urls: ['http://localhost/api/health'], expectedCommit: commit, fetchImpl: vi.fn() })).rejects.toThrow('HTTPS');
  });

  it('never closes the gate when a deployed probe fails verification', async () => {
    const closeGate = vi.fn();
    const disabled = productionRuntimeProbe({ SD_MIGRATION_ADMISSION_GATE_ENABLED: 'false', SD_DEPLOYED_COMMIT: commit });
    await expect(freezeAfterRuntimeVerification({
      urls: ['https://submarine-dash.roadcrosser.com/api/health'],
      expectedCommit: commit,
      fetchImpl: async () => responseWith(disabled),
      closeGate,
    })).rejects.toThrow('not enabled');
    expect(closeGate).not.toHaveBeenCalled();
  });
});
