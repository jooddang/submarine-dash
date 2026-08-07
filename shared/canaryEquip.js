export function validateCanaryEquipResponse(result, skinId) {
  const skins = result?.skins;
  if (result?.version !== 'submarine-write-v1' || result.operation !== 'equip_skin'
    || typeof result.idempotent !== 'boolean' || !skins || skins.equipped !== skinId
    || typeof result.stateVersion !== 'number' || !Number.isSafeInteger(result.stateVersion)
    || typeof result.keyVersion !== 'number' || !Number.isSafeInteger(result.keyVersion)) {
    throw new Error('Roadcrosser canary mutation response is invalid');
  }
  return result;
}
