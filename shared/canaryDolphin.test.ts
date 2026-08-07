import { describe, expect, it } from 'vitest';
import { DOLPHIN_CONTRACT_VERSION, validateCanaryDolphinResponse } from './canaryDolphin.js';

const valid = {
  version: 'submarine-write-v1', contractVersion: DOLPHIN_CONTRACT_VERSION,
  operation: 'consume_dolphin', idempotent: false, ok: true,
  inventory: { dolphinSaved: 4 }, stateVersion: 3,
  keyVersions: { pending: 2, saved: 3, ledger: 4, legacyGrant: 1 },
};

describe('shared canary dolphin contract', () => {
  it('accepts the bounded exact response shape', () => {
    expect(validateCanaryDolphinResponse(valid, 'consume_dolphin')).toBe(valid);
    expect(validateCanaryDolphinResponse({ ...valid, operation: 'import_dolphin' }, 'import_dolphin'))
      .toMatchObject({ operation: 'import_dolphin' });
  });

  it('rejects an impossible failed import while retaining consume depletion responses', () => {
    expect(() => validateCanaryDolphinResponse({ ...valid, operation: 'import_dolphin', ok: false }, 'import_dolphin'))
      .toThrow('Roadcrosser canary dolphin response is invalid');
    expect(validateCanaryDolphinResponse({ ...valid, ok: false }, 'consume_dolphin')).toMatchObject({ ok: false });
  });

  it.each([
    ['version', { version: 'stale' }], ['contract', { contractVersion: 'stale' }],
    ['operation', { operation: 'import_dolphin' }], ['saved negative', { inventory: { dolphinSaved: -1 } }],
    ['saved fractional', { inventory: { dolphinSaved: 1.5 } }], ['state zero', { stateVersion: 0 }],
    ['pending zero', { keyVersions: { ...valid.keyVersions, pending: 0 } }],
    ['saved key unsafe', { keyVersions: { ...valid.keyVersions, saved: Number.MAX_SAFE_INTEGER + 1 } }],
    ['ledger fractional', { keyVersions: { ...valid.keyVersions, ledger: 1.5 } }],
    ['grant negative', { keyVersions: { ...valid.keyVersions, legacyGrant: -1 } }],
  ])('rejects %s', (_name, patch) => {
    expect(() => validateCanaryDolphinResponse({ ...valid, ...patch }, 'consume_dolphin'))
      .toThrow('Roadcrosser canary dolphin response is invalid');
  });
});
