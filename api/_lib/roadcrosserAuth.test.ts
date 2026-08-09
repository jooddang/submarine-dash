import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  consumeRoadcrosserTicket, consumeRoadcrosserCanaryDolphin, importRoadcrosserCanaryDolphin,
  equipRoadcrosserCanarySkin, purchaseRoadcrosserCanarySkin, readRoadcrosserCanonicalBootstrap,
  resolveRoadcrosserSession, revokeRoadcrosserSession, settleRoadcrosserGameplay,
} from './roadcrosserAuth.js';
import { SKIN_CATALOG_VERSION } from '../../shared/canaryPurchase.js';
import { DOLPHIN_CONTRACT_VERSION } from '../../shared/canaryDolphin.js';

const opaque = 'A'.repeat(43);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('Roadcrosser scoped internal client', () => {
  it('calls only the fixed consume route with a bounded credentialed POST', async () => {
    vi.stubEnv('SD_ROADCROSSER_INTERNAL_AUTH_TOKEN', 'fixture-internal-credential-value-1234567890');
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      version: 'submarine-game-session-v1', externalUserId: 'fixture', loginId: 'fixture', sessionToken: opaque,
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await consumeRoadcrosserTicket(opaque, opaque);
    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toBe('https://www.roadcrosser.com/api/internal/submarine-dash/tickets/consume');
    expect(request.method).toBe('POST');
    expect(request.redirect).toBe('error');
    expect(JSON.parse(request.body)).toEqual({ ticket: opaque, stateChallenge: opaque });
    expect(request.headers.authorization).toMatch(/^Bearer /);
  });

  it('uses distinct fixed session resolve and revoke capabilities', async () => {
    vi.stubEnv('SD_ROADCROSSER_INTERNAL_AUTH_TOKEN', 'fixture-internal-credential-value-1234567890');
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/sessions/revoke')) return Promise.resolve(new Response(null, { status: 204 }));
      if (url.endsWith('/bootstrap')) {
        return Promise.resolve(new Response(JSON.stringify({
          version: 'submarine-canonical-bootstrap-v2', readOnly: true, readCapabilities: ['read_daily_missions'], writeCapabilities: [],
          user: { externalUserId: 'fixture', loginId: 'fixture' },
        }), { status: 200 }));
      }
      if (url.endsWith('/mutations/equip-skin')) {
        return Promise.resolve(new Response(JSON.stringify({
          version: 'submarine-write-v1', operation: 'equip_skin', idempotent: false,
          skins: { equipped: 'default' }, stateVersion: 2, keyVersion: 1,
        }), { status: 200 }));
      }
      if (url.endsWith('/mutations/purchase-skin')) {
        return Promise.resolve(new Response(JSON.stringify({
          version: 'submarine-write-v1', operation: 'purchase_skin', idempotent: false,
          catalogVersion: SKIN_CATALOG_VERSION,
          skinId: 'gold', cost: 150, coins: 850,
          skins: { owned: ['default', 'gold'], equipped: 'default' },
          stateVersion: 3, keyVersions: { coins: 1, ownedSkins: 1 },
        }), { status: 200 }));
      }
      if (url.endsWith('/mutations/consume-dolphin') || url.endsWith('/mutations/import-dolphin')) {
        const operation = url.endsWith('/consume-dolphin') ? 'consume_dolphin' : 'import_dolphin';
        return Promise.resolve(new Response(JSON.stringify({
          version: 'submarine-write-v1', contractVersion: DOLPHIN_CONTRACT_VERSION,
          operation, idempotent: false, ok: true, inventory: { dolphinSaved: 2 }, stateVersion: 4,
          keyVersions: { pending: 1, saved: 2, ledger: 3 },
        }), { status: 200 }));
      }
      if (url.endsWith('/mutations/settle-gameplay')) return Promise.resolve(new Response(JSON.stringify({
        version:'submarine-gameplay-settlement-v1',operation:'run_end',idempotent:false,date:'2026-08-09',
        progress:{runs:1,oxygenCollected:0,maxScore:1200,completedMissionIds:[],keptAt:null},rewards:null,coinsEarned:10,
        inventory:{coins:10,dolphinSaved:0,tube:{pieces:2,charges:1}},newAchievements:[],stateVersion:2,
      }),{status:200}));
      return Promise.resolve(new Response(JSON.stringify({
        version: 'submarine-game-session-v1', externalUserId: 'fixture', loginId: 'fixture',
      }), { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);
    await resolveRoadcrosserSession(opaque);
    await revokeRoadcrosserSession(opaque);
    await readRoadcrosserCanonicalBootstrap(opaque);
    await equipRoadcrosserCanarySkin(opaque, '97000000-0000-4000-8000-000000000001', 'default');
    await purchaseRoadcrosserCanarySkin(opaque, '97000000-0000-4000-8000-000000000002', 'gold');
    await consumeRoadcrosserCanaryDolphin(opaque, '97000000-0000-4000-8000-000000000003');
    await importRoadcrosserCanaryDolphin(opaque, '97000000-0000-4000-8000-000000000004', 2);
    await settleRoadcrosserGameplay(opaque,'97000000-0000-4000-8000-000000000005',
      '97000000-0000-4000-8000-000000000006',{type:'run_end',score:1200,tubePieces:2,tubeCharges:1});
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://www.roadcrosser.com/api/internal/submarine-dash/sessions/resolve',
      'https://www.roadcrosser.com/api/internal/submarine-dash/sessions/revoke',
      'https://www.roadcrosser.com/api/internal/submarine-dash/bootstrap',
      'https://www.roadcrosser.com/api/internal/submarine-dash/mutations/equip-skin',
      'https://www.roadcrosser.com/api/internal/submarine-dash/mutations/purchase-skin',
      'https://www.roadcrosser.com/api/internal/submarine-dash/mutations/consume-dolphin',
      'https://www.roadcrosser.com/api/internal/submarine-dash/mutations/import-dolphin',
      'https://www.roadcrosser.com/api/internal/submarine-dash/mutations/settle-gameplay',
    ]);
    expect(JSON.parse(fetchMock.mock.calls[4][1].body)).toMatchObject({ catalogVersion: SKIN_CATALOG_VERSION });
    expect(JSON.parse(fetchMock.mock.calls[5][1].body)).toEqual({
      sessionToken: opaque, idempotencyKey: '97000000-0000-4000-8000-000000000003', contractVersion: DOLPHIN_CONTRACT_VERSION,
    });
    expect(JSON.parse(fetchMock.mock.calls[6][1].body)).toEqual({
      sessionToken: opaque, idempotencyKey: '97000000-0000-4000-8000-000000000004', count: 2,
      contractVersion: DOLPHIN_CONTRACT_VERSION,
    });
  });

  it('rejects remote overrides and redacts central failures', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('SD_ROADCROSSER_INTERNAL_BASE_URL', 'https://attacker.example');
    vi.stubEnv('SD_ROADCROSSER_INTERNAL_AUTH_TOKEN', 'fixture-internal-credential-value-1234567890');
    await expect(resolveRoadcrosserSession(opaque)).rejects.toThrow('base URL is invalid');

    vi.stubEnv('SD_ROADCROSSER_INTERNAL_BASE_URL', 'http://localhost:3999');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('private upstream detail', { status: 401 })));
    await expect(resolveRoadcrosserSession(opaque)).rejects.toThrow('canonical auth request failed');
  });
});
