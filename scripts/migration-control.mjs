import { Redis } from '@upstash/redis';
import {
  activePvpDrainStatus,
  closeMutationGate,
  openMutationGate,
  readMutationGateStatus,
  reconcileExpiredLeaseHardFailure,
} from '../shared/productionControls.js';
import { freezeAfterRuntimeVerification } from '../shared/productionRuntimeProbe.js';

const command = process.argv[2] || 'status';
const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

if (!url || !token) {
  console.error('Writable Redis URL/token are required. No Redis command was sent.');
  process.exitCode = 2;
} else {
  const redis = new Redis({ url, token });
  const adapter = { eval: (script, keys, args) => redis.eval(script, keys, args) };

  if (command === 'status') {
    console.log(JSON.stringify({ gate: await readMutationGateStatus(adapter), pvp: await activePvpDrainStatus(redis) }, null, 2));
  } else if (command === 'freeze') {
    if (process.env.SD_MIGRATION_ADMISSION_GATE_ENABLED !== 'true') {
      throw new Error('Refusing a false freeze: SD_MIGRATION_ADMISSION_GATE_ENABLED must be true in every game runtime first.');
    }
    if (process.env.SD_MIGRATION_CONTROL_CONFIRM !== 'FREEZE') {
      throw new Error('Set SD_MIGRATION_CONTROL_CONFIRM=FREEZE to close the mutation gate.');
    }
    const probeUrls = (process.env.SD_MIGRATION_RUNTIME_PROBE_URLS || '').split(',').map((value) => value.trim()).filter(Boolean);
    const deployedCommit = process.env.SD_MIGRATION_EXPECTED_DEPLOYED_COMMIT;
    console.log(JSON.stringify(await freezeAfterRuntimeVerification({
      urls: probeUrls,
      expectedCommit: deployedCommit,
      closeGate: () => closeMutationGate(adapter),
    }), null, 2));
  } else if (command === 'reopen') {
    if (process.env.SD_MIGRATION_CONTROL_CONFIRM !== 'REOPEN') {
      throw new Error('Set SD_MIGRATION_CONTROL_CONFIRM=REOPEN to reopen the mutation gate.');
    }
    console.log(JSON.stringify(await openMutationGate(adapter), null, 2));
  } else if (command === 'reconcile-expired') {
    if (process.env.SD_MIGRATION_CONTROL_CONFIRM !== 'RECONCILE_EXPIRED') {
      throw new Error('Set SD_MIGRATION_CONTROL_CONFIRM=RECONCILE_EXPIRED to clear an expired-lease hard blocker.');
    }
    console.log(JSON.stringify(await reconcileExpiredLeaseHardFailure(adapter, {
      reconciliationReportSha256: process.env.SD_MIGRATION_RECONCILIATION_REPORT_SHA256,
      firstDurableManifestSha256: process.env.SD_MIGRATION_FIRST_DURABLE_MANIFEST_SHA256,
      secondDurableManifestSha256: process.env.SD_MIGRATION_SECOND_DURABLE_MANIFEST_SHA256,
      firstManifestCapturedAt: Number(process.env.SD_MIGRATION_FIRST_MANIFEST_CAPTURED_AT_MS),
      secondManifestCapturedAt: Number(process.env.SD_MIGRATION_SECOND_MANIFEST_CAPTURED_AT_MS),
      batchId: process.env.SD_MIGRATION_BATCH_ID,
      operatorId: process.env.SD_MIGRATION_OPERATOR_ID,
    }), null, 2));
  } else {
    throw new Error('Usage: node scripts/migration-control.mjs [status|freeze|reopen|reconcile-expired]');
  }
}
