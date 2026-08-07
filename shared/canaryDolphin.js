export const DOLPHIN_CONTRACT_VERSION = 'dolphin-inventory-v1';
export function validateCanaryDolphinResponse(result, operation) {
  const saved = result?.inventory?.dolphinSaved;
  const versions = result?.keyVersions;
  if (result?.version !== 'submarine-write-v1' || result.contractVersion !== DOLPHIN_CONTRACT_VERSION
    || result.operation !== operation || typeof result.idempotent !== 'boolean' || typeof result.ok !== 'boolean'
    || (operation === 'import_dolphin' && result.ok !== true)
    || !Number.isSafeInteger(saved) || saved < 0 || !Number.isSafeInteger(result.stateVersion) || result.stateVersion <= 0
    || !Number.isSafeInteger(versions?.pending) || versions.pending <= 0
    || !Number.isSafeInteger(versions?.saved) || versions.saved <= 0
    || (versions.ledger !== undefined && (!Number.isSafeInteger(versions.ledger) || versions.ledger <= 0))
    || (versions.legacyGrant !== undefined && (!Number.isSafeInteger(versions.legacyGrant) || versions.legacyGrant <= 0))) {
    throw new Error('Roadcrosser canary dolphin response is invalid');
  }
  return result;
}
