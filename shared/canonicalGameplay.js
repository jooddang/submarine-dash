export const GAMEPLAY_CONTRACT_VERSION = 'submarine-gameplay-v1';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EVENT_CAPABILITIES = Object.freeze({
  run_end: 'settle_run_end',
  oxygen_collected: 'settle_oxygen_collected',
  pvp_result: 'settle_pvp_result',
});

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function safeInteger(value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

export function gameplayCapability(eventType) {
  return EVENT_CAPABILITIES[eventType] || null;
}

export function isCanonicalGameplayAdmission({ method, path = '/api/missions/event', origin,
  expectedOrigin, canonicalToken, enabled, allowedOrigin }) {
  return method === 'POST' && path === '/api/missions/event' && enabled && allowedOrigin
    && Boolean(canonicalToken) && origin === expectedOrigin;
}

export function canonicalGameplayRequest({ canonicalToken, idempotencyKey, runEvidenceId, event }) {
  if (!canonicalToken || !UUID.test(idempotencyKey || '') || !record(event) || !gameplayCapability(event.type)) {
    throw new Error('canonical gameplay request is invalid');
  }
  let payload;
  if (event.type === 'run_end') {
    if (!UUID.test(runEvidenceId || '') || !safeInteger(event.score, 0, 10_000_000)
      || !safeInteger(event.tubePieces, 0, 3) || !safeInteger(event.tubeCharges, 0, 3)) {
      throw new Error('canonical gameplay request is invalid');
    }
    payload = {
      score: event.score, tubePieces: event.tubePieces, tubeCharges: event.tubeCharges,
      deathCause: typeof event.deathCause === 'string' ? event.deathCause : null,
      perfectPlatformer: event.perfectPlatformer === true,
      allOxygenCollected: event.allOxygenCollected === true,
      urchinDodges: safeInteger(event.urchinDodges, 0, 100) ? event.urchinDodges : 0,
      swordfishCollected: event.swordfishCollected === true,
      swordfishDodged: event.swordfishDodged === true,
    };
  } else if (event.type === 'oxygen_collected') {
    if (event.count !== undefined && !safeInteger(event.count, 1, 100)) throw new Error('canonical gameplay request is invalid');
    payload = event.count === undefined ? {} : { count: event.count };
    runEvidenceId = null;
  } else {
    if (typeof event.won !== 'boolean') throw new Error('canonical gameplay request is invalid');
    payload = { won: event.won };
    runEvidenceId = null;
  }
  return { sessionToken: canonicalToken, idempotencyKey, runEvidenceId,
    eventType: event.type, payload, contractVersion: GAMEPLAY_CONTRACT_VERSION };
}

export function validateCanonicalGameplayResponse(value, operation) {
  const source = record(value);
  const inventory = record(source?.inventory);
  if (!source || source.version !== 'submarine-gameplay-settlement-v1' || source.operation !== operation
    || typeof source.idempotent !== 'boolean' || !inventory
    || !safeInteger(inventory.coins) || !safeInteger(inventory.dolphinSaved)
    || !safeInteger(source.stateVersion, 1) || !Array.isArray(source.newAchievements)
    || source.newAchievements.some((id) => typeof id !== 'string' || !/^[a-z0-9][a-z0-9_]{0,63}$/.test(id))) {
    throw new Error('canonical gameplay response is invalid');
  }
  if (operation === 'pvp_result') return source;
  const progress = record(source.progress);
  const tube = record(inventory.tube);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(source.date || '')) || !progress || !tube
    || !safeInteger(progress.runs) || !safeInteger(progress.oxygenCollected)
    || !safeInteger(progress.maxScore, 0, 10_000_000) || !Array.isArray(progress.completedMissionIds)
    || !safeInteger(source.coinsEarned) || !safeInteger(tube.pieces, 0, 3) || !safeInteger(tube.charges, 0, 3)) {
    throw new Error('canonical gameplay response is invalid');
  }
  return source;
}

export async function executeExpressCanonicalGameplay({ canonicalToken, idempotencyKey,
  runEvidenceId, event, roadcrosserRequest }) {
  const request = canonicalGameplayRequest({ canonicalToken, idempotencyKey, runEvidenceId, event });
  return validateCanonicalGameplayResponse(await roadcrosserRequest(
    '/api/internal/submarine-dash/mutations/settle-gameplay', request), event.type);
}
