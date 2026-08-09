import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';

const road = vi.hoisted(() => ({
  consume: vi.fn(), resolve: vi.fn(), revoke: vi.fn(), bootstrap: vi.fn(), equip: vi.fn(), purchase: vi.fn(),
  consumeDolphin: vi.fn(), importDolphin: vi.fn(),
  daily: vi.fn(), leaderboard: vi.fn(), achievementSummaries: vi.fn(), publishScore: vi.fn(), settleGameplay: vi.fn(),
}));
const redis = vi.hoisted(() => ({
  get: vi.fn(), set: vi.fn(), del: vi.fn(), incr: vi.fn(), expire: vi.fn(),
}));
const redisFactory = vi.hoisted(() => vi.fn(() => redis));

vi.mock('./roadcrosserAuth.js', () => ({
  consumeRoadcrosserTicket: road.consume,
  resolveRoadcrosserSession: road.resolve,
  revokeRoadcrosserSession: road.revoke,
  readRoadcrosserCanonicalBootstrap: road.bootstrap,
  equipRoadcrosserCanarySkin: road.equip,
  purchaseRoadcrosserCanarySkin: road.purchase,
  consumeRoadcrosserCanaryDolphin: road.consumeDolphin,
  importRoadcrosserCanaryDolphin: road.importDolphin,
  readRoadcrosserDailyMissions: road.daily,
  readRoadcrosserWeeklyLeaderboard: road.leaderboard,
  readRoadcrosserAchievementSummaries: road.achievementSummaries,
  publishRoadcrosserScore: road.publishScore,
  settleRoadcrosserGameplay: road.settleGameplay,
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
import { default as achievementsHandler } from '../achievements/index.js';
import { handler as achievementUsersHandler } from '../achievements/users.js';
import { createEquipSkinRoute, handler as equipSkinHandler, isSyntheticCanaryEquipRequest } from '../inventory/skin/equip.js';
import { createPurchaseSkinRoute, handler as purchaseSkinHandler, isSyntheticCanaryPurchaseRequest } from '../inventory/skin/purchase.js';
import { handler as consumeDolphinHandler, isSyntheticCanaryDolphinConsumeRequest } from '../inventory/dolphin/consume.js';
import { handler as importDolphinHandler, isSyntheticCanaryDolphinImportRequest } from '../inventory/dolphin/import.js';
import { createDailyMissionsRoute, handler as dailyMissionsHandler, isCanonicalDailyMissionsRequest } from '../missions/daily.js';
import { createMissionEventRoute, handler as missionEventHandler } from '../missions/event.js';
import { createWeeklyLeaderboardRoute, handler as weeklyLeaderboardHandler } from '../leaderboard/weekly.js';
import { handler as leaderboardHandler } from '../leaderboard.js';
import { MaintenanceFreezeError } from '../../shared/productionControls.js';
import { SKIN_CATALOG_VERSION } from '../../shared/canaryPurchase.js';
import { DOLPHIN_CONTRACT_VERSION } from '../../shared/canaryDolphin.js';

const opaque = (character: string) => character.repeat(43);

function request(method: string, options: { cookie?: string; origin?: string; site?: string; idempotencyKey?: string; runEvidenceId?: string; expectedExternalUserId?: string; body?: unknown } = {}) {
  return {
    method,
    body: options.body,
    headers: {
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.origin ? { origin: options.origin } : {}),
      ...(options.site ? { 'sec-fetch-site': options.site } : {}),
      ...(options.idempotencyKey ? { 'idempotency-key': options.idempotencyKey } : {}),
      ...(options.runEvidenceId ? { 'run-evidence-id': options.runEvidenceId } : {}),
      ...(options.expectedExternalUserId ? { 'expected-external-user-id': options.expectedExternalUserId } : {}),
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
  road.resolve.mockResolvedValue({version:'submarine-game-session-v1',externalUserId:'fixture',loginId:'fixture'});
  road.revoke.mockResolvedValue(undefined);
  road.equip.mockResolvedValue({
    version: 'submarine-write-v1', operation: 'equip_skin', idempotent: false,
    skins: { equipped: 'default' }, stateVersion: 2, keyVersion: 1,
  });
  road.purchase.mockResolvedValue({
    version: 'submarine-write-v1', operation: 'purchase_skin', idempotent: false,
    catalogVersion: SKIN_CATALOG_VERSION,
    skinId: 'gold', cost: 150, coins: 850,
    skins: { owned: ['default', 'gold'], equipped: 'default' },
    stateVersion: 3, keyVersions: { coins: 1, ownedSkins: 1 },
  });
  road.consumeDolphin.mockResolvedValue({
    version:'submarine-write-v1',contractVersion:DOLPHIN_CONTRACT_VERSION,operation:'consume_dolphin',idempotent:false,
    ok:true,inventory:{dolphinSaved:1},stateVersion:4,keyVersions:{pending:1,saved:1,ledger:1},
  });
  road.importDolphin.mockResolvedValue({
    version:'submarine-write-v1',contractVersion:DOLPHIN_CONTRACT_VERSION,operation:'import_dolphin',idempotent:false,
    ok:true,inventory:{dolphinSaved:3},stateVersion:4,keyVersions:{pending:1,saved:1,ledger:1},
  });
  road.daily.mockResolvedValue({version:'submarine-daily-missions-v1',readOnly:true,date:'2026-08-06',missions:[],
    user:{progress:{runs:0,oxygenCollected:0,maxScore:0,completedMissionIds:[]},streak:{},
      inventory:{coins:0,dolphinSaved:0,dolphinPending:0,tube:{pieces:0,charges:0},skins:{owned:[],equipped:null}}}});
  road.leaderboard.mockResolvedValue({version:'submarine-weekly-leaderboard-v1',currentWeekId:'2026-08-03',
    current:[{id:1,name:'Diver',userId:'diver',score:4321}],weeks:[{
      weekId:'2026-08-03',startDate:'2026-08-03',endDate:'2026-08-09',
      entries:[{id:1,name:'Diver',userId:'diver',score:4321}],createdAt:1,updatedAt:2,
    }]});
  road.publishScore.mockResolvedValue({version:'submarine-score-publication-v1',idempotent:false,
    entry:{id:7,name:'Diver',userId:'fixture',score:6404}});
  road.achievementSummaries.mockResolvedValue({fixture:{count:1,unlockedIds:['oxygen_master']}});
  road.settleGameplay.mockResolvedValue({version:'submarine-gameplay-settlement-v1',operation:'run_end',idempotent:false,
    acknowledgement:{externalUserId:'fixture'},
    date:'2026-08-09',progress:{runs:1,oxygenCollected:0,maxScore:1200,completedMissionIds:[],keptAt:null},
    rewards:null,coinsEarned:10,inventory:{coins:21,dolphinSaved:2,tube:{pieces:2,charges:1}},
    newAchievements:[],stateVersion:2});
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
  it('reads canonical achievement unlocks from Supabase bootstrap without opening Redis', async () => {
    const token=opaque('A');
    road.bootstrap.mockResolvedValue({
      version:'submarine-canonical-bootstrap-v2',user:{externalUserId:'user-fixture',loginId:'fixture'},
      inventory:{coins:0,dolphinSaved:0,dolphinPending:0,tube:{pieces:0,charges:0},skins:{owned:['default'],equipped:'default'}},
      streak:{},achievements:{unlocked:{perfect_platformer:1700000000000},progress:{}},unreadInboxCount:0,
      stateVersion:1,readOnly:false,readCapabilities:[],writeCapabilities:[],
    });
    const out=response();
    await achievementsHandler(request('GET',{cookie:`sd_roadcrosser_session=${token}`}),out.res);
    expect(out.state.status).toBe(200);
    expect(out.state.json.achievements.find((entry:any)=>entry.id==='perfect_platformer')).toMatchObject({
      unlocked:true,unlockedAt:1700000000000,
    });
    expect(road.bootstrap).toHaveBeenCalledWith(token);
    expect(redisFactory).not.toHaveBeenCalled();
  });
  it('hydrates canonical leaderboard achievement badges from Supabase without opening Redis', async () => {
    const token=opaque('H'); const out=response();
    await achievementUsersHandler(request('GET',{cookie:`sd_roadcrosser_session=${token}`}),out.res);
    expect(out.state.status).toBe(400);
    const req=request('GET',{cookie:`sd_roadcrosser_session=${token}`}) as any;
    req.query={loginIds:'fixture,FIXTURE'};
    const success=response(); await achievementUsersHandler(req,success.res);
    expect(success.state).toMatchObject({status:200,json:{users:{fixture:{count:1,
      achievements:[{id:'oxygen_master'}]}}}});
    expect(success.state.json.users.FIXTURE).toMatchObject({count:1,achievements:[{id:'oxygen_master'}]});
    expect(road.achievementSummaries).toHaveBeenCalledWith(token,['fixture','FIXTURE']);
    expect(redisFactory).not.toHaveBeenCalled();
  });
  it('routes canonical daily reads only under the exact default-off tuple and rejects mission mints without Redis', async () => {
    const token=opaque('M'); const exact={cookie:`sd_roadcrosser_session=${token}`,origin:'https://submarine-dash.roadcrosser.com'};
    expect(isCanonicalDailyMissionsRequest(request('GET',exact))).toBe(false);
    vi.stubEnv('SD_SUPABASE_DAILY_READ_ENABLED','true');
    expect(isCanonicalDailyMissionsRequest(request('GET',exact))).toBe(true);
    expect(isCanonicalDailyMissionsRequest(request('GET',{cookie:exact.cookie,site:'same-origin'}))).toBe(true);
    expect(isCanonicalDailyMissionsRequest(request('GET',{cookie:exact.cookie,site:'cross-site'}))).toBe(false);
    expect(isCanonicalDailyMissionsRequest(request('GET',{...exact,origin:'https://tiles.roadcrosser.com'}))).toBe(false);
    vi.stubEnv('SD_SUBMARINE_PUBLIC_ORIGIN','https://attacker.example');
    expect(isCanonicalDailyMissionsRequest(request('GET',{cookie:exact.cookie,origin:'https://attacker.example'}))).toBe(false);
    vi.stubEnv('SD_SUBMARINE_PUBLIC_ORIGIN','https://submarine-dash.roadcrosser.com');
    const out=response(); await dailyMissionsHandler(request('GET',exact),out.res);
    expect(out.state).toMatchObject({status:200,json:{date:'2026-08-06',missions:[]}});
    expect(road.daily).toHaveBeenCalledWith(token);
    const rejected=response(); await missionEventHandler(request('POST',{...exact,body:{type:'run_end',score:999999}}),rejected.res);
    expect(rejected.state.status).toBe(409);
    expect(redisFactory).not.toHaveBeenCalled();
  });
  it('bypasses the closed Redis gate only to read or reject canonical mission traffic', async () => {
    vi.stubEnv('SD_SUPABASE_DAILY_READ_ENABLED','true');
    const acquire=vi.fn(async()=>{throw new MaintenanceFreezeError();});
    const dependencies={flags:()=>({admissionGate:true}) as any,adapter:()=>({}) as any,acquire,event:vi.fn()};
    const token=opaque('R'); const exact={cookie:`sd_roadcrosser_session=${token}`,origin:'https://submarine-dash.roadcrosser.com'};
    const daily=response(); await createDailyMissionsRoute(dependencies)(request('GET',exact),daily.res);
    expect(daily.state.status).toBe(200);
    const event=response(); await createMissionEventRoute(dependencies)(request('POST',{...exact,body:{type:'run_end',score:999999}}),event.res);
    expect(event.state.status).toBe(409);
    expect(acquire).not.toHaveBeenCalled();
    vi.stubEnv('SD_SUPABASE_DAILY_READ_ENABLED','false');
    const disabled=response(); await createDailyMissionsRoute(dependencies)(request('GET',exact),disabled.res);
    expect(disabled.state.status).toBe(409);
    vi.stubEnv('SD_SUPABASE_DAILY_READ_ENABLED','true');
    const wrong=response(); await createDailyMissionsRoute(dependencies)(request('GET',{...exact,origin:'https://tiles.roadcrosser.com'}),wrong.res);
    expect(wrong.state.status).toBe(409);
    const crossSite=response(); await createDailyMissionsRoute(dependencies)(request('GET',{cookie:exact.cookie,site:'cross-site'}),crossSite.res);
    expect(crossSite.state.status).toBe(409);
    expect(acquire).not.toHaveBeenCalled();
    const legacy=response(); await createDailyMissionsRoute(dependencies)(request('GET',{cookie:`sd_session=${opaque('L')}`,origin:exact.origin}),legacy.res);
    expect(legacy.state.status).toBe(503);
    expect(acquire).toHaveBeenCalledTimes(1);
  });
  it('reads the Supabase weekly leaderboard for canonical sessions without opening Redis', async () => {
    const token=opaque('W');
    const out=response(); await weeklyLeaderboardHandler(request('GET',{cookie:`sd_roadcrosser_session=${token}`}),out.res);
    expect(out.state).toMatchObject({status:200,json:{currentWeekId:'2026-08-03',current:[{name:'Diver',score:4321}]}});
    expect(road.leaderboard).toHaveBeenCalledWith(token,52);
    expect(redisFactory).not.toHaveBeenCalled();

    const acquire=vi.fn(async()=>{throw new MaintenanceFreezeError();});
    const dependencies={flags:()=>({admissionGate:true}) as any,adapter:()=>({}) as any,acquire,event:vi.fn()};
    const bypassed=response(); await createWeeklyLeaderboardRoute(dependencies)(
      request('GET',{cookie:`sd_roadcrosser_session=${token}`}),bypassed.res);
    expect(bypassed.state.status).toBe(200);
    expect(acquire).not.toHaveBeenCalled();
  });
  it('publishes a canonical settled score by run evidence and never opens Redis', async () => {
    vi.stubEnv('SD_SUPABASE_GAMEPLAY_WRITES_ENABLED','true');
    const token=opaque('Q'); const idempotencyKey='97000000-0000-4000-8000-000000000031';
    const runEvidenceId='97000000-0000-4000-8000-000000000032';
    road.leaderboard.mockResolvedValueOnce({version:'submarine-weekly-leaderboard-v1',currentWeekId:'2026-08-03',
      current:[{id:7,name:'Diver',userId:'fixture',score:6404}],weeks:[]});
    const out=response(); await leaderboardHandler(request('POST',{cookie:`sd_roadcrosser_session=${token}`,
      origin:'https://submarine-dash.roadcrosser.com',body:{name:'Diver',score:1,skinId:'fake',idempotencyKey,runEvidenceId}}),out.res);
    expect(out.state).toMatchObject({status:200,json:{entry:{id:7,score:6404},rank:1}});
    expect(road.resolve).toHaveBeenCalledWith(token);
    expect(road.publishScore).toHaveBeenCalledWith(token,'fixture',idempotencyKey,runEvidenceId,'Diver');
    expect(road.leaderboard).toHaveBeenCalledWith(token,1);
    expect(redisFactory).not.toHaveBeenCalled();
  });
  it('settles enabled canonical gameplay with exact headers and never opens Redis', async () => {
    vi.stubEnv('SD_SUPABASE_GAMEPLAY_WRITES_ENABLED','true');
    const token=opaque('G'); const key='97000000-0000-4000-8000-000000000021';
    const run='97000000-0000-4000-8000-000000000022';
    const body={type:'run_end',score:1200,tubePieces:2,tubeCharges:1};
    const out=response(); await missionEventHandler(request('POST',{cookie:`sd_roadcrosser_session=${token}`,
      origin:'https://submarine-dash.roadcrosser.com',expectedExternalUserId:'fixture',idempotencyKey:key,runEvidenceId:run,body}),out.res);
    expect(out.state).toMatchObject({status:200,json:{operation:'run_end',coinsEarned:10}});
    expect(road.settleGameplay).toHaveBeenCalledWith(token,'fixture',key,run,body);
    expect(redisFactory).not.toHaveBeenCalled();
    const wrong=response(); await missionEventHandler(request('POST',{cookie:`sd_roadcrosser_session=${token}`,
      origin:'https://tiles.roadcrosser.com',idempotencyKey:key,runEvidenceId:run,body}),wrong.res);
    expect(wrong.state.status).toBe(403);
    expect(road.settleGameplay).toHaveBeenCalledTimes(1);
  });
  it('routes dolphin canary mutations only under the exact cookie, origin, flag, count, and idempotency contract', async () => {
    const token=opaque('D'); const key='97000000-0000-4000-8000-000000000009';
    const exact={cookie:`sd_roadcrosser_session=${token}`,origin:'https://submarine-dash.roadcrosser.com',idempotencyKey:key};
    expect(isSyntheticCanaryDolphinConsumeRequest(request('POST',exact))).toBe(false);
    vi.stubEnv('SD_SUPABASE_DOLPHIN_WRITE_CANARY_ENABLED','true');
    expect(isSyntheticCanaryDolphinConsumeRequest(request('POST',exact))).toBe(true);
    expect(isSyntheticCanaryDolphinImportRequest(request('POST',{...exact,body:{count:2}}))).toBe(true);
    expect(isSyntheticCanaryDolphinConsumeRequest(request('POST',{...exact,origin:'https://tiles.roadcrosser.com'}))).toBe(false);
    const consumed=response(); await consumeDolphinHandler(request('POST',exact),consumed.res);
    expect(consumed.state).toMatchObject({status:200,json:{ok:true,inventory:{dolphinSaved:1}}});
    expect(road.consumeDolphin).toHaveBeenCalledWith(token,key);
    const imported=response(); await importDolphinHandler(request('POST',{...exact,body:{count:2}}),imported.res);
    expect(imported.state.status).toBe(200); expect(road.importDolphin).toHaveBeenCalledWith(token,key,2);
    for (const count of ['2',-1,1.5,Number.MAX_SAFE_INTEGER+1]) {
      const invalid=response(); await importDolphinHandler(request('POST',{...exact,body:{count}}),invalid.res);
      expect(invalid.state.status).toBe(400);
    }
    expect(road.importDolphin).toHaveBeenCalledTimes(1);
    expect(redisFactory).not.toHaveBeenCalled();
  });
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
    expect(out.state).toMatchObject({ status: 303, redirect: 'https://www.roadcrosser.com/submarine-dash?connected=1' });
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
      version: 'submarine-canonical-bootstrap-v2', readOnly: true, readCapabilities: ['read_daily_missions'], writeCapabilities: [],
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

  it('routes only exact-origin enabled canonical purchase around the closed Redis gate', async () => {
    const token = opaque('C');
    const idempotencyKey = '96000000-0000-4000-8000-000000000003';
    const disabled = response();
    await purchaseSkinHandler(request('POST', {
      cookie: `sd_roadcrosser_session=${token}`, origin: 'https://submarine-dash.roadcrosser.com',
      idempotencyKey, body: { skinId: 'gold' },
    }), disabled.res);
    expect(disabled.state.status).toBe(409);
    vi.stubEnv('SD_SUPABASE_WRITE_CANARY_ENABLED', 'true');
    expect(isSyntheticCanaryPurchaseRequest(request('POST', {
      cookie: `sd_roadcrosser_session=${token}`, origin: 'https://submarine-dash.roadcrosser.com',
    }))).toBe(true);
    expect(isSyntheticCanaryPurchaseRequest(request('POST', {
      cookie: `sd_roadcrosser_session=${token}`, site: 'same-origin',
    }))).toBe(false);
    const inheritedCatalogKey = response();
    await purchaseSkinHandler(request('POST', {
      cookie: `sd_roadcrosser_session=${token}`, origin: 'https://submarine-dash.roadcrosser.com',
      idempotencyKey, body: { skinId: 'toString' },
    }), inheritedCatalogKey.res);
    expect(inheritedCatalogKey.state.status).toBe(400);
    expect(road.purchase).not.toHaveBeenCalled();
    const acquire = vi.fn(async () => { throw new MaintenanceFreezeError(); });
    const wrapped = createPurchaseSkinRoute({
      flags: () => ({ admissionGate: true }) as any,
      adapter: () => ({}) as any, acquire, event: vi.fn(),
    });
    const enabled = response();
    await wrapped(request('POST', {
      cookie: `sd_roadcrosser_session=${token}`, origin: 'https://submarine-dash.roadcrosser.com',
      idempotencyKey, body: { skinId: 'gold' },
    }), enabled.res);
    expect(enabled.state.status).toBe(200);
    expect(road.purchase).toHaveBeenCalledWith(token, idempotencyKey, 'gold');
    expect(redisFactory).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();

    for (const options of [
      { cookie: `sd_session=${opaque('L')}`, origin: 'https://submarine-dash.roadcrosser.com' },
      { cookie: `sd_roadcrosser_session=${token}`, origin: 'https://attacker.example' },
      { cookie: `sd_roadcrosser_session=${token}`, site: 'same-origin' },
    ]) {
      const blocked = response();
      await wrapped(request('POST', { ...options, idempotencyKey, body: { skinId: 'gold' } }), blocked.res);
      expect(blocked.state.status).toBe(503);
    }
  });

  it('preserves source-compatible purchase domain errors without Redis access', async () => {
    vi.stubEnv('SD_SUPABASE_WRITE_CANARY_ENABLED', 'true');
    const options = {
      cookie: `sd_roadcrosser_session=${opaque('C')}`,
      origin: 'https://submarine-dash.roadcrosser.com',
      idempotencyKey: '96000000-0000-4000-8000-000000000004',
      body: { skinId: 'gold' },
    };
    road.purchase.mockResolvedValueOnce({
      version: 'submarine-write-v1', operation: 'purchase_skin', catalogVersion: SKIN_CATALOG_VERSION,
      skinId: 'gold', rejected: 'already_owned',
    });
    const owned = response();
    await purchaseSkinHandler(request('POST', options), owned.res);
    expect(owned.state).toMatchObject({ status: 400, json: { error: 'Already owned' } });
    road.purchase.mockResolvedValueOnce({
      version: 'submarine-write-v1', operation: 'purchase_skin', catalogVersion: SKIN_CATALOG_VERSION, skinId: 'gold',
      rejected: 'insufficient_coins', required: 150, balance: 7,
    });
    const insufficient = response();
    await purchaseSkinHandler(request('POST', options), insufficient.res);
    expect(insufficient.state).toMatchObject({
      status: 400, json: { error: 'Insufficient coins', required: 150, balance: 7 },
    });
    expect(redisFactory).not.toHaveBeenCalled();
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
