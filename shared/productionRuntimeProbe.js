import { productionControlFlags } from './productionControls.js';
import { ROUTE_INVENTORY_DIGEST, ROUTE_INVENTORY_VERSION } from './productionRouteInventory.js';

export function productionRuntimeProbe(env = process.env) {
  return Object.freeze({
    schemaVersion: 1,
    admissionGateEnabled: productionControlFlags(env).admissionGate,
    routeInventoryVersion: ROUTE_INVENTORY_VERSION,
    routeInventoryDigest: ROUTE_INVENTORY_DIGEST,
    deployedCommit: env.VERCEL_GIT_COMMIT_SHA || env.SD_DEPLOYED_COMMIT || 'unknown',
  });
}

export async function verifyDeployedRuntimeProbes({ urls, expectedCommit, fetchImpl = fetch, timeoutMs = 5_000 }) {
  if (!Array.isArray(urls) || urls.length === 0) throw new Error('At least one deployed runtime probe URL is required.');
  if (!/^[a-f0-9]{40}$/i.test(String(expectedCommit || ''))) throw new Error('An exact 40-character deployed commit SHA is required.');
  const expected = productionRuntimeProbe({ SD_MIGRATION_ADMISSION_GATE_ENABLED: 'true', SD_DEPLOYED_COMMIT: expectedCommit });
  const results = [];
  for (const url of urls) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') throw new Error(`Runtime probe must use HTTPS: ${url}`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref?.();
    try {
      const response = await fetchImpl(parsed, { method: 'GET', redirect: 'error', signal: controller.signal, headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error(`Runtime probe returned HTTP ${response.status}: ${parsed.origin}`);
      const probe = (await response.json())?.migrationControl;
      if (!probe?.admissionGateEnabled) throw new Error(`Admission gate is not enabled: ${parsed.origin}`);
      if (probe.routeInventoryVersion !== expected.routeInventoryVersion || probe.routeInventoryDigest !== expected.routeInventoryDigest) {
        throw new Error(`Route inventory mismatch: ${parsed.origin}`);
      }
      if (probe.deployedCommit !== expectedCommit) throw new Error(`Deployed commit mismatch: ${parsed.origin}`);
      results.push({ origin: parsed.origin, deployedCommit: probe.deployedCommit, routeInventoryDigest: probe.routeInventoryDigest });
    } finally {
      clearTimeout(timeout);
    }
  }
  return results;
}

export async function freezeAfterRuntimeVerification({ urls, expectedCommit, closeGate, fetchImpl = fetch, timeoutMs = 5_000 }) {
  if (typeof closeGate !== 'function') throw new TypeError('closeGate callback is required.');
  const verifiedRuntimeProbes = await verifyDeployedRuntimeProbes({ urls, expectedCommit, fetchImpl, timeoutMs });
  const gate = await closeGate();
  return { verifiedRuntimeProbes, gate };
}
