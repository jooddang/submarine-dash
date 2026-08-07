import { Redis } from '@upstash/redis';
import {
  activePvpDrainStatus,
  closeMutationGate,
  openMutationGate,
  readMutationGateStatus,
  reconcileExpiredLeaseHardFailure,
} from '../shared/productionControls.js';
import {
  freezeMigration,
  MigrationFreezeError,
  migrationControlErrorPayload,
  preflightMigrationFreeze,
  redactedMigrationGateStatus,
  redactedPvpDrainStatus,
} from '../shared/migrationFreezeOrchestrator.js';

const command = process.argv[2] || 'status';
const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

async function main() {
  if (!url || !token) throw new MigrationFreezeError('REDIS_CONFIGURATION_REQUIRED', 'Redis URL/token are required. No Redis command was sent.');
  const redis = new Redis({ url, token });
  const adapter = { eval: (script, keys, args) => redis.eval(script, keys, args) };
  const readStatus = () => readMutationGateStatus(adapter);
  const readPvp = () => activePvpDrainStatus(redis);
  const probeUrls = (process.env.SD_MIGRATION_RUNTIME_PROBE_URLS || '').split(',').map((value) => value.trim()).filter(Boolean);
  const expectedCommit = process.env.SD_MIGRATION_EXPECTED_DEPLOYED_COMMIT;

  if (command === 'status') {
    console.log(JSON.stringify({ gate: redactedMigrationGateStatus(await readStatus()), pvp: redactedPvpDrainStatus(await readPvp()) }, null, 2));
  } else if (command === 'preflight' || command === 'freeze') {
    if (process.env.SD_MIGRATION_ADMISSION_GATE_ENABLED !== 'true') {
      throw new MigrationFreezeError('ADMISSION_GATE_FLAG_REQUIRED', 'SD_MIGRATION_ADMISSION_GATE_ENABLED must be true in every game runtime first.');
    }
    if (command === 'preflight') {
      console.log(JSON.stringify(await preflightMigrationFreeze({ urls: probeUrls, expectedCommit, readStatus, readPvp }), null, 2));
    } else {
      if (process.env.SD_MIGRATION_CONTROL_CONFIRM !== 'FREEZE') {
        throw new MigrationFreezeError('FREEZE_CONFIRMATION_REQUIRED', 'Set SD_MIGRATION_CONTROL_CONFIRM=FREEZE to close the mutation gate.');
      }
      console.log(JSON.stringify(await freezeMigration({
        urls: probeUrls,
        expectedCommit,
        readStatus,
        readPvp,
        closeGate: () => closeMutationGate(adapter),
        reopenGate: () => openMutationGate(adapter),
      }), null, 2));
    }
  } else if (command === 'reopen') {
    if (process.env.SD_MIGRATION_CONTROL_CONFIRM !== 'REOPEN') {
      throw new MigrationFreezeError('REOPEN_CONFIRMATION_REQUIRED', 'Set SD_MIGRATION_CONTROL_CONFIRM=REOPEN to reopen the mutation gate.');
    }
    console.log(JSON.stringify(await openMutationGate(adapter), null, 2));
  } else if (command === 'reconcile-expired') {
    if (process.env.SD_MIGRATION_CONTROL_CONFIRM !== 'RECONCILE_EXPIRED') {
      throw new MigrationFreezeError('RECONCILE_CONFIRMATION_REQUIRED', 'Set SD_MIGRATION_CONTROL_CONFIRM=RECONCILE_EXPIRED to clear an expired-lease hard blocker.');
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
    throw new MigrationFreezeError('INVALID_MIGRATION_CONTROL_COMMAND', 'Usage: node scripts/migration-control.mjs [status|preflight|freeze|reopen|reconcile-expired]');
  }
}

main().catch((error) => {
  console.error(JSON.stringify(migrationControlErrorPayload(error)));
  process.exitCode = 1;
});
