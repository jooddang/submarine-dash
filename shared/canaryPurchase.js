export const SKIN_COSTS = Object.freeze({
  default: 0,
  gold: 150,
  golden: 150,
  ocean_blue: 150,
  coral_red: 150,
  neon_green: 150,
  royal_purple: 150,
  whale: 1000,
  orca: 1000,
  scary_orca: 5000,
  octopus: 5000,
  jellyfish: 5000,
  mystical_fish: 20000,
  kraken: 20000,
});

export const SKIN_CATALOG_VERSION = 'sha256:fe9ff52e984a7b15c3c17fe9633ffa9cc98d113850b08c2c8eda9f12f61faf1f';

export function canonicalSkinCatalogString(catalog = SKIN_COSTS) {
  return Object.entries(catalog)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([skinId, cost]) => `${skinId}:${cost}`)
    .join('|');
}

export function validateCanaryPurchaseResponse(result, skinId) {
  const expectedCost = Object.hasOwn(SKIN_COSTS, skinId) ? SKIN_COSTS[skinId] : undefined;
  if (result?.version !== 'submarine-write-v1' || result.operation !== 'purchase_skin'
    || result.catalogVersion !== SKIN_CATALOG_VERSION
    || result.skinId !== skinId || expectedCost === undefined) {
    throw new Error('Roadcrosser canary purchase response is invalid');
  }
  if (result.rejected === 'already_owned') return result;
  if (result.rejected === 'insufficient_coins') {
    if (result.required !== expectedCost || typeof result.balance !== 'number'
      || !Number.isSafeInteger(result.balance) || result.balance < 0) {
      throw new Error('Roadcrosser canary purchase response is invalid');
    }
    return result;
  }
  const skins = result.skins;
  const owned = skins?.owned;
  if (result.rejected !== undefined
    || typeof result.idempotent !== 'boolean' || result.cost !== expectedCost
    || typeof result.coins !== 'number' || !Number.isSafeInteger(result.coins) || result.coins < 0
    || !skins || !Array.isArray(owned) || !owned.every((value) => typeof value === 'string')
    || !owned.includes(skinId) || new Set(owned).size !== owned.length
    || owned.some((value, index) => index > 0 && owned[index - 1] > value)
    || typeof skins.equipped !== 'string'
    || typeof result.stateVersion !== 'number' || !Number.isSafeInteger(result.stateVersion) || result.stateVersion <= 0
    || typeof result.keyVersions?.coins !== 'number' || !Number.isSafeInteger(result.keyVersions.coins)
    || result.keyVersions.coins <= 0
    || typeof result.keyVersions?.ownedSkins !== 'number' || !Number.isSafeInteger(result.keyVersions.ownedSkins)
    || result.keyVersions.ownedSkins <= 0) {
    throw new Error('Roadcrosser canary purchase response is invalid');
  }
  return result;
}
