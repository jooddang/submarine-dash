import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  consumeRoadcrosserTicket, readRoadcrosserProtectedBootstrap, resolveRoadcrosserSession, revokeRoadcrosserSession,
} from './roadcrosserAuth.js';

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
          version: 'submarine-protected-bootstrap-v1', readOnly: true,
          user: { externalUserId: 'fixture', loginId: 'fixture' },
        }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({
        version: 'submarine-game-session-v1', externalUserId: 'fixture', loginId: 'fixture',
      }), { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);
    await resolveRoadcrosserSession(opaque);
    await revokeRoadcrosserSession(opaque);
    await readRoadcrosserProtectedBootstrap(opaque);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://www.roadcrosser.com/api/internal/submarine-dash/sessions/resolve',
      'https://www.roadcrosser.com/api/internal/submarine-dash/sessions/revoke',
      'https://www.roadcrosser.com/api/internal/submarine-dash/bootstrap',
    ]);
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
