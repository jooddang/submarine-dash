import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';

const road = vi.hoisted(() => ({
  consume: vi.fn(), revoke: vi.fn(), bootstrap: vi.fn(), equip: vi.fn(),
}));
const redis = vi.hoisted(() => ({
  get: vi.fn(), set: vi.fn(), del: vi.fn(), incr: vi.fn(), expire: vi.fn(),
}));
const redisFactory = vi.hoisted(() => vi.fn(() => redis));

vi.mock('./roadcrosserAuth.js', () => ({
  consumeRoadcrosserTicket: road.consume,
  revokeRoadcrosserSession: road.revoke,
  readRoadcrosserCanonicalBootstrap: road.bootstrap,
  equipRoadcrosserCanarySkin: road.equip,
}));
vi.mock('./redis.js', () => ({
  getUpstashRedisClient: redisFactory,
  RedisConfigError: class RedisConfigError extends Error {},
}));

import { handler as startHandler } from '../auth/roadcrosser/start.js';
import { handler as callbackHandler } from '../auth/roadcrosser/callback.js';
import { handler as loginHandler } from '../auth/login.js';
import { handler as logoutHandler } from '../auth/logout.js';
import { handler as meHandler } from '../auth/me.js';
import { createEquipSkinRoute, handler as equipSkinHandler, isSyntheticCanaryEquipRequest } from '../inventory/skin/equip.js';
import { MaintenanceFreezeError } from '../../shared/productionControls.js';

const opaque = (character: string) => character.repeat(43);

function request(method: string, options: { cookie?: string; origin?: string; site?: string; idempotencyKey?: string; body?: unknown } = {}) {
  return {
    method,
    body: options.body,
    headers: {
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.origin ? { origin: options.origin } : {}),
      ...(options.site ? { 'sec-fetch-site': options.site } : {}),
      ...(options.idempotencyKey ? { 'idempotency-key': options.idempotencyKey } : {}),
    },
  } as unknown as VercelRequest;
}

function response() {
  const headers = new Map<string, string | string[]>();
  const state: { status?: number; json?: unknown; redirect?: string; ended?: boolean } = {};
  const res = {
    getHeader: (name: string) => headers.get(name),
    setHeader: (name: string, value: string | string[]) => { headers.set(name, value); },
    status(code: number) { state.status = code; return res; },
    json(value: unknown) { state.json = value; return res; },
    redirect(code: number, location: string) { state.status = code; state.redirect = location; return res; },
    end() { state.ended = true; return res; },
  };
  return { res: res as unknown as VercelResponse, headers, state };
}

function mockValidLegacyCredentials() {
  const salt = Buffer.alloc(16, 3);
  const password = 'fixture-password';
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  redis.get.mockImplementation(async (key: string) => key.startsWith('sd:loginId:') ? 'user-1' : {
    userId: 'user-1', loginId: 'Fixture', loginIdLower: 'fixture', passwordSalt: salt.toString('base64'),
    passwordHash: hash.toString('base64'), createdAt: 1, refCode: 'ref',
  });
  return password;
}

beforeEach(() => {
  vi.stubEnv('SD_CANONICAL_AUTH_TICKETS_ENABLED', 'true');
  vi.stubEnv('SD_ROADCROSSER_INTERNAL_AUTH_TOKEN', 'fixture-internal-token-with-32-characters');
  road.consume.mockResolvedValue({ sessionToken: opaque('N') });
  road.revoke.mockResolvedValue(undefined);
  road.equip.mockResolvedValue({
    version: 'submarine-write-v1', operation: 'equip_skin', idempotent: false,
    skins: { equipped: 'default' }, stateVersion: 2, keyVersion: 1,
  });
  redis.del.mockResolvedValue(1);
  redis.set.mockResolvedValue('OK');
  redis.incr.mockResolvedValue(1);
  redis.expire.mockResolvedValue(1);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe('canonical auth handlers', () => {
  it('starts with a host-only state cookie and a challenge-only redirect', async () => {
    const out = response();
    await startHandler(request('GET'), out.res);
    expect(out.state.status).toBe(303);
    expect(out.state.redirect).toMatch(/^https:\/\/www\.roadcrosser\.com\/games\/submarine-dash\/connect\?stateChallenge=[A-Za-z0-9_-]{43}$/);
    expect(out.state.redirect).not.toContain('ticket');
    const cookies = out.headers.get('Set-Cookie') as string[];
    expect(cookies[0]).toMatch(/^sd_rc_state=[A-Za-z0-9_-]{43};/);
    expect(cookies[0]).toContain('Path=/api/auth/roadcrosser/callback');
    expect(out.headers.get('Cache-Control')).toBe('no-store');
  });

  it('converges two stale cookies to canonical after consume and ordered cleanup', async () => {
    const events: string[] = [];
    redis.del.mockImplementation(async () => { events.push('delete-legacy'); return 1; });
    road.revoke.mockImplementation(async (token: string) => { events.push(`revoke-${token[0]}`); });
    const out = response();
    await callbackHandler(request('POST', {
      origin: 'https://www.roadcrosser.com',
      cookie: `sd_rc_state=${opaque('S')}; sd_session=${opaque('L')}; sd_roadcrosser_session=${opaque('O')}`,
      body: { ticket: opaque('T') },
    }), out.res);
    expect(events).toEqual(['delete-legacy', 'revoke-O']);
    expect(out.state).toMatchObject({ status: 303, redirect: '/' });
    const cookies = out.headers.get('Set-Cookie') as string[];
    expect(cookies.some((value) => value.startsWith(`sd_roadcrosser_session=${opaque('N')}`))).toBe(true);
    expect(cookies.some((value) => value.startsWith('sd_session=;'))).toBe(true);
    expect(cookies.some((value) => value.startsWith('sd_rc_state=;'))).toBe(true);
  });

  it('preserves old cookies and revokes the consumed session when legacy cleanup fails', async () => {
    redis.del.mockRejectedValue(new Error('fixture redis unavailable'));
    const out = response();
    await callbackHandler(request('POST', {
      origin: 'https://www.roadcrosser.com',
      cookie: `sd_rc_state=${opaque('S')}; sd_session=${opaque('L')}; sd_roadcrosser_session=${opaque('O')}`,
      body: { ticket: opaque('T') },
    }), out.res);
    expect(out.state.status).toBe(503);
    expect(road.revoke).toHaveBeenCalledTimes(1);
    expect(road.revoke).toHaveBeenCalledWith(opaque('N'));
    expect(out.headers.get('Set-Cookie')).toBeUndefined();
  });

  it('preserves old cookies and revokes the consumed session when old canonical revocation fails', async () => {
    road.revoke.mockImplementation(async (token: string) => {
      if (token === opaque('O')) throw new Error('fixture revoke failed');
    });
    const out = response();
    await callbackHandler(request('POST', {
      origin: 'https://www.roadcrosser.com',
      cookie: `sd_rc_state=${opaque('S')}; sd_session=${opaque('L')}; sd_roadcrosser_session=${opaque('O')}`,
      body: { ticket: opaque('T') },
    }), out.res);
    expect(out.state.status).toBe(503);
    expect(road.revoke.mock.calls.map(([token]) => token)).toEqual([opaque('O'), opaque('N')]);
    expect(out.headers.get('Set-Cookie')).toBeUndefined();
  });

  it('does not alter existing cookies when ticket consumption fails', async () => {
    road.consume.mockRejectedValue(new Error('invalid ticket'));
    const out = response();
    await callbackHandler(request('POST', {
      origin: 'https://www.roadcrosser.com', cookie: `sd_rc_state=${opaque('S')}; sd_session=${opaque('L')}`,
      body: { ticket: opaque('T') },
    }), out.res);
    expect(out.state.status).toBe(401);
    expect(redis.del).not.toHaveBeenCalled();
    expect(road.revoke).not.toHaveBeenCalled();
    expect(out.headers.get('Set-Cookie')).toBeUndefined();
  });

  it('fails legacy login closed when canonical revocation fails', async () => {
    const password = mockValidLegacyCredentials();
    road.revoke.mockRejectedValue(new Error('fixture revoke failed'));
    const out = response();
    await loginHandler(request('POST', {
      site: 'same-origin', cookie: `sd_roadcrosser_session=${opaque('O')}`, body: { loginId: 'Fixture', password },
    }), out.res);
    expect(out.state.status).toBe(503);
    expect(redis.set).not.toHaveBeenCalled();
    expect(out.headers.get('Set-Cookie')).toBeUndefined();
  });

  it('rejects sibling-origin legacy login before Redis or canonical revocation', async () => {
    const out = response();
    await loginHandler(request('POST', {
      origin: 'https://tiles.roadcrosser.com',
      cookie: `sd_roadcrosser_session=${opaque('O')}`,
      body: { loginId: 'Fixture', password: 'fixture-password' },
    }), out.res);
    expect(out.state.status).toBe(403);
    expect(redisFactory).not.toHaveBeenCalled();
    expect(road.revoke).not.toHaveBeenCalled();
    expect(out.headers.get('Set-Cookie')).toBeUndefined();
  });

  it('successful canonical-to-legacy transition clears canonical and sets only the new legacy session', async () => {
    const password = mockValidLegacyCredentials();
    const out = response();
    await loginHandler(request('POST', {
      site: 'same-origin',
      cookie: `sd_roadcrosser_session=${opaque('O')}; sd_session=${opaque('L')}`,
      body: { loginId: 'Fixture', password },
    }), out.res);
    expect(out.state.status).toBe(200);
    expect(road.revoke).toHaveBeenCalledWith(opaque('O'));
    const cookies = out.headers.get('Set-Cookie') as string[];
    expect(cookies.some((value) => value.startsWith('sd_roadcrosser_session=;'))).toBe(true);
    expect(cookies.some((value) => value.startsWith('sd_session=sess_'))).toBe(true);
  });

  it('legacy session creation failure after canonical revocation fails closed without a new auth cookie', async () => {
    const password = mockValidLegacyCredentials();
    redis.set.mockRejectedValue(new Error('fixture redis write unavailable'));
    const out = response();
    await loginHandler(request('POST', {
      site: 'same-origin', cookie: `sd_roadcrosser_session=${opaque('O')}`,
      body: { loginId: 'Fixture', password },
    }), out.res);
    expect(out.state.status).toBe(500);
    expect(road.revoke).toHaveBeenCalledWith(opaque('O'));
    const cookies = out.headers.get('Set-Cookie') as string[];
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatch(/^sd_roadcrosser_session=;/);
  });

  it('serves canonical read-only bootstrap without touching Redis', async () => {
    road.bootstrap.mockResolvedValue({
      version: 'submarine-canonical-bootstrap-v2', readOnly: true, writeCapabilities: [],
      user: { externalUserId: 'protected-user', loginId: 'Protected' },
      inventory: { coins: 1, dolphinSaved: 2, dolphinPending: 0, tube: { pieces: 0, charges: 0 }, skins: { owned: ['default'], equipped: 'default' } },
      streak: {}, achievements: {}, unreadInboxCount: 0, stateVersion: 1,
    });
    const out = response();
    await meHandler(request('GET', { cookie: `sd_roadcrosser_session=${opaque('C')}` }), out.res);
    expect(out.state.status).toBe(200);
    expect(out.state.json).toMatchObject({ canonical: true, readOnly: true, user: { userId: 'protected-user' } });
    expect(redisFactory).not.toHaveBeenCalled();
  });

  it('keeps canonical writes default-off, then routes enabled equip through Roadcrosser without Redis', async () => {
    const token = opaque('C');
    const idempotencyKey = '96000000-0000-4000-8000-000000000001';
    const disabled = response();
    await equipSkinHandler(request('POST', {
      cookie: `sd_roadcrosser_session=${token}`, origin: 'https://submarine-dash.roadcrosser.com',
      idempotencyKey, body: { skinId: 'default' },
    }), disabled.res);
    expect(disabled.state.status).toBe(409);
    expect(road.equip).not.toHaveBeenCalled();

    vi.stubEnv('SD_SUPABASE_WRITE_CANARY_ENABLED', 'true');
    expect(isSyntheticCanaryEquipRequest(request('POST', {
      cookie: `sd_roadcrosser_session=${token}`, origin: 'https://submarine-dash.roadcrosser.com',
    }))).toBe(true);
    expect(isSyntheticCanaryEquipRequest(request('POST', {
      cookie: `sd_roadcrosser_session=${token}`, origin: 'https://attacker.example',
    }))).toBe(false);
    expect(isSyntheticCanaryEquipRequest(request('POST', {
      cookie: `sd_roadcrosser_session=${token}`, site: 'same-origin',
    }))).toBe(false);
    expect(isSyntheticCanaryEquipRequest(request('POST', {
      cookie: `sd_session=${token}`, origin: 'https://submarine-dash.roadcrosser.com',
    }))).toBe(false);
    const enabled = response();
    await equipSkinHandler(request('POST', {
      cookie: `sd_roadcrosser_session=${token}`, origin: 'https://submarine-dash.roadcrosser.com',
      idempotencyKey, body: { skinId: 'default' },
    }), enabled.res);
    expect(enabled.state.status).toBe(200);
    expect(road.equip).toHaveBeenCalledWith(token, idempotencyKey, 'default');
    expect(redisFactory).not.toHaveBeenCalled();
  });

  it('bypasses a closed Redis gate only for the real enabled canonical equip predicate', async () => {
    vi.stubEnv('SD_SUPABASE_WRITE_CANARY_ENABLED', 'true');
    const acquire = vi.fn(async () => { throw new MaintenanceFreezeError(); });
    const wrapped = createEquipSkinRoute({
      flags: () => ({ admissionGate: true }) as any,
      adapter: () => ({}) as any, acquire, event: vi.fn(),
    });
    const idempotencyKey = '96000000-0000-4000-8000-000000000002';
    const allowed = response();
    await wrapped(request('POST', {
      cookie: `sd_roadcrosser_session=${opaque('C')}`, origin: 'https://submarine-dash.roadcrosser.com',
      idempotencyKey, body: { skinId: 'default' },
    }), allowed.res);
    expect(allowed.state.status).toBe(200);
    expect(acquire).not.toHaveBeenCalled();

    for (const options of [
      { cookie: `sd_session=${opaque('L')}`, origin: 'https://submarine-dash.roadcrosser.com' },
      { cookie: `sd_roadcrosser_session=${opaque('C')}`, origin: 'https://attacker.example' },
      { origin: 'https://submarine-dash.roadcrosser.com' },
    ]) {
      const blocked = response();
      await wrapped(request('POST', { ...options, idempotencyKey, body: { skinId: 'default' } }), blocked.res);
      expect(blocked.state.status).toBe(503);
    }
    vi.stubEnv('SD_SUPABASE_WRITE_CANARY_ENABLED', 'false');
    const disabled = response();
    await wrapped(request('POST', {
      cookie: `sd_roadcrosser_session=${opaque('C')}`, origin: 'https://submarine-dash.roadcrosser.com',
      idempotencyKey, body: { skinId: 'default' },
    }), disabled.res);
    expect(disabled.state.status).toBe(503);
    expect(acquire).toHaveBeenCalledTimes(4);
  });

  it('cannot reactivate a stale legacy cookie after canonical expiry', async () => {
    road.bootstrap.mockRejectedValue(new Error('expired canonical session'));
    const out = response();
    await meHandler(request('GET', {
      cookie: `sd_roadcrosser_session=${opaque('C')}; sd_session=${opaque('L')}`,
    }), out.res);
    expect(out.state).toMatchObject({ status: 200, json: { user: null } });
    const cookies = out.headers.get('Set-Cookie') as string[];
    expect(cookies.some((value) => value.startsWith('sd_roadcrosser_session=;'))).toBe(true);
    expect(cookies.some((value) => value.startsWith('sd_session=;'))).toBe(true);
    expect(redisFactory).not.toHaveBeenCalled();
  });

  it('requires exact Origin or same-origin fetch metadata for logout', async () => {
    const forbidden = response();
    await logoutHandler(request('POST', { origin: 'https://attacker.example' }), forbidden.res);
    expect(forbidden.state.status).toBe(403);
    const allowed = response();
    await logoutHandler(request('POST', { site: 'same-origin' }), allowed.res);
    expect(allowed.state.status).toBe(200);
  });
});
