import { describe, expect, it } from 'vitest';
import { validateCanaryEquipResponse } from './canaryEquip.js';

const validResult = {
  version: 'submarine-write-v1',
  operation: 'equip_skin',
  idempotent: false,
  skins: { equipped: 'default' },
  stateVersion: 2,
  keyVersion: 1,
};

describe('shared canary equip response validation', () => {
  it('accepts the exact write contract used by both runtimes', () => {
    expect(validateCanaryEquipResponse(validResult, 'default')).toBe(validResult);
  });

  it.each([
    ['wrong version', { version: 'submarine-write-v2' }],
    ['wrong operation', { operation: 'purchase_skin' }],
    ['non-boolean replay marker', { idempotent: 'false' }],
    ['wrong equipped skin', { skins: { equipped: 'other' } }],
    ['missing skin envelope', { skins: undefined }],
    ['fractional state version', { stateVersion: 2.5 }],
    ['unsafe state version', { stateVersion: Number.MAX_SAFE_INTEGER + 1 }],
    ['fractional key version', { keyVersion: 1.5 }],
    ['unsafe key version', { keyVersion: Number.MAX_SAFE_INTEGER + 1 }],
  ])('rejects %s', (_name, patch) => {
    expect(() => validateCanaryEquipResponse({ ...validResult, ...patch }, 'default'))
      .toThrow('Roadcrosser canary mutation response is invalid');
  });
});
