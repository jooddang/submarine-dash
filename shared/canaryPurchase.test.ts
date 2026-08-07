import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import {
  canonicalSkinCatalogString, SKIN_CATALOG_VERSION, SKIN_COSTS, validateCanaryPurchaseResponse,
} from './canaryPurchase.js';

const validResult = {
  version: 'submarine-write-v1', operation: 'purchase_skin', idempotent: false,
  catalogVersion: SKIN_CATALOG_VERSION,
  skinId: 'gold', cost: 150, coins: 850,
  skins: { owned: ['default', 'gold'], equipped: 'default' },
  stateVersion: 2, keyVersions: { coins: 1, ownedSkins: 1 },
};

describe('shared canary purchase contract', () => {
  it('keeps one complete catalog and accepts the exact response', () => {
    expect(Object.keys(SKIN_COSTS)).toContain('kraken');
    expect(Object.hasOwn(SKIN_COSTS, 'toString')).toBe(false);
    expect(`sha256:${crypto.createHash('sha256').update(canonicalSkinCatalogString()).digest('hex')}`)
      .toBe(SKIN_CATALOG_VERSION);
    expect(validateCanaryPurchaseResponse(validResult, 'gold')).toBe(validResult);
  });

  it('accepts only source-compatible owned and insufficient rejections', () => {
    expect(validateCanaryPurchaseResponse({
      version: 'submarine-write-v1', operation: 'purchase_skin', catalogVersion: SKIN_CATALOG_VERSION,
      skinId: 'gold', rejected: 'already_owned',
    }, 'gold')).toMatchObject({ rejected: 'already_owned' });
    expect(validateCanaryPurchaseResponse({
      version: 'submarine-write-v1', operation: 'purchase_skin', catalogVersion: SKIN_CATALOG_VERSION, skinId: 'gold',
      rejected: 'insufficient_coins', required: 150, balance: 7,
    }, 'gold')).toMatchObject({ rejected: 'insufficient_coins', balance: 7 });
    expect(() => validateCanaryPurchaseResponse({
      version: 'submarine-write-v1', operation: 'purchase_skin', catalogVersion: SKIN_CATALOG_VERSION, skinId: 'gold',
      rejected: 'insufficient_coins', required: 1, balance: 7,
    }, 'gold')).toThrow('Roadcrosser canary purchase response is invalid');
    expect(() => validateCanaryPurchaseResponse({
      version: 'submarine-write-v1', operation: 'purchase_skin', catalogVersion: SKIN_CATALOG_VERSION,
      skinId: 'toString', rejected: 'already_owned',
    }, 'toString')).toThrow('Roadcrosser canary purchase response is invalid');
  });

  it.each([
    ['wrong operation', { operation: 'equip_skin' }],
    ['wrong cost', { cost: 151 }],
    ['negative coins', { coins: -1 }],
    ['unsorted ownership', { skins: { owned: ['gold', 'default'], equipped: 'default' } }],
    ['duplicate ownership', { skins: { owned: ['default', 'gold', 'gold'], equipped: 'default' } }],
    ['missing purchased skin', { skins: { owned: ['default'], equipped: 'default' } }],
    ['zero state version', { stateVersion: 0 }],
    ['negative state version', { stateVersion: -1 }],
    ['zero coin key version', { keyVersions: { coins: 0, ownedSkins: 1 } }],
    ['negative owned key version', { keyVersions: { coins: 1, ownedSkins: -1 } }],
    ['invalid coin key version', { keyVersions: { coins: 1.5, ownedSkins: 1 } }],
    ['invalid owned key version', { keyVersions: { coins: 1, ownedSkins: Number.MAX_SAFE_INTEGER + 1 } }],
  ])('rejects %s', (_name, patch) => {
    expect(() => validateCanaryPurchaseResponse({ ...validResult, ...patch }, 'gold'))
      .toThrow('Roadcrosser canary purchase response is invalid');
  });

  it('rejects a catalog version mismatch before accepting any result shape', () => {
    expect(() => validateCanaryPurchaseResponse({ ...validResult, catalogVersion: 'sha256:stale' }, 'gold'))
      .toThrow('Roadcrosser canary purchase response is invalid');
  });
});
