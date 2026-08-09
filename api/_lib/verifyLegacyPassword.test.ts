import crypto from 'node:crypto';
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import type { VercelRequest,VercelResponse } from '@vercel/node';

const redis=vi.hoisted(()=>({get:vi.fn(),set:vi.fn(),del:vi.fn(),incr:vi.fn(),expire:vi.fn()}));
const redisFactory=vi.hoisted(()=>vi.fn(()=>redis));
vi.mock('./redis.js',()=>({
  getStrictUpstashRedisReadOnlyClient:redisFactory,
  RedisConfigError:class RedisConfigError extends Error {},
}));
vi.mock('./productionControls.js',()=>({withProductionControl:(_file:string,handler:unknown)=>handler}));

import { handler } from '../internal/roadcrosser/verify-legacy-password.js';

function request(body:unknown,token='v'.repeat(32)) {
  return {method:'POST',body,headers:{authorization:`Bearer ${token}`}} as unknown as VercelRequest;
}
function response() {
  const state:{status?:number;json?:unknown}={}; const headers=new Map<string,string>();
  const res={setHeader:(key:string,value:string)=>headers.set(key,value),status(code:number){state.status=code;return res;},json(value:unknown){state.json=value;return res;}};
  return {res:res as unknown as VercelResponse,state,headers};
}

beforeEach(()=>{
  vi.stubEnv('SD_LEGACY_CLAIM_ENABLED','true');
  vi.stubEnv('SD_LEGACY_ROAD_LOGIN_ENABLED','false');
  vi.stubEnv('SD_LEGACY_CLAIM_EXPIRES_AT','2999-01-01T00:00:00.000Z');
  vi.stubEnv('SD_ROADCROSSER_INTERNAL_AUTH_TOKEN','v'.repeat(32));
});
afterEach(()=>{vi.clearAllMocks();vi.unstubAllEnvs();});

describe('read-only legacy password verifier',()=>{
  it('performs exactly two reads and verifies the legacy scrypt contract without Redis writes',async()=>{
    const salt=Buffer.alloc(16,7); const password='old-password';
    const hash=crypto.scryptSync(password,salt,64,{N:16384,r:8,p:1});
    redis.get.mockResolvedValueOnce('user-generic').mockResolvedValueOnce({
      userId:'user-generic',loginId:'Generic',loginIdLower:'generic',passwordSalt:salt.toString('base64'),
      passwordHash:hash.toString('base64'),createdAt:1,refCode:'ref',
    });
    const output=response(); await handler(request({loginId:' Generic ',password}),output.res);
    expect(output.state).toEqual({status:200,json:{verified:true,externalUserId:'user-generic'}});
    expect(redisFactory).toHaveBeenCalledOnce();
    expect(redis.get.mock.calls.map(([key])=>key)).toEqual(['sd:loginId:generic','sd:user:user-generic']);
    expect(redis.set).not.toHaveBeenCalled(); expect(redis.del).not.toHaveBeenCalled();
    expect(redis.incr).not.toHaveBeenCalled(); expect(redis.expire).not.toHaveBeenCalled();
    expect(output.headers.get('Cache-Control')).toContain('no-store');
  });

  it('returns one redacted invalid response for unknown, malformed, mismatched, and wrong credentials',async()=>{
    for (const prepare of [
      ()=>redis.get.mockResolvedValueOnce(null),
      ()=>redis.get.mockResolvedValueOnce('user-1').mockResolvedValueOnce('{broken'),
      ()=>redis.get.mockResolvedValueOnce('user-1').mockResolvedValueOnce({userId:'other',loginId:'User',loginIdLower:'user'}),
    ]) {
      prepare(); const output=response(); await handler(request({loginId:'User',password:'wrong'}),output.res);
      expect(output.state).toEqual({status:401,json:{error:'Invalid credentials'}});
      expect(redis.get).toHaveBeenCalledTimes(2); redis.get.mockReset();
    }
  });

  it('permits the same read-only verifier for Roadcrosser login while generic claim stays off',async()=>{
    vi.stubEnv('SD_LEGACY_CLAIM_ENABLED','false');
    vi.stubEnv('SD_LEGACY_ROAD_LOGIN_ENABLED','true');
    const salt=Buffer.alloc(16,9); const password='protected-password';
    const hash=crypto.scryptSync(password,salt,64,{N:16384,r:8,p:1});
    redis.get.mockResolvedValueOnce('user-jooddang').mockResolvedValueOnce({
      userId:'user-jooddang',loginId:'JoodDang',loginIdLower:'jooddang',
      passwordSalt:salt.toString('base64'),passwordHash:hash.toString('base64'),createdAt:1,refCode:'ref',
    });
    const output=response(); await handler(request({loginId:'jooddang',password}),output.res);
    expect(output.state).toEqual({status:200,json:{verified:true,externalUserId:'user-jooddang'}});
    expect(redis.get).toHaveBeenCalledTimes(2);
    expect(redis.set).not.toHaveBeenCalled(); expect(redis.del).not.toHaveBeenCalled();
  });

  it('rejects disabled, unauthenticated, and non-POST requests before Redis access',async()=>{
    vi.stubEnv('SD_LEGACY_CLAIM_ENABLED','false');
    vi.stubEnv('SD_LEGACY_ROAD_LOGIN_ENABLED','false');
    let output=response(); await handler(request({loginId:'x',password:'y'}),output.res); expect(output.state.status).toBe(401);
    vi.stubEnv('SD_LEGACY_CLAIM_ENABLED','true');
    output=response(); await handler(request({loginId:'x',password:'y'},'wrong'),output.res); expect(output.state.status).toBe(401);
    vi.stubEnv('SD_LEGACY_CLAIM_EXPIRES_AT','2000-01-01T00:00:00.000Z');
    output=response(); await handler(request({loginId:'x',password:'y'}),output.res); expect(output.state.status).toBe(401);
    vi.stubEnv('SD_LEGACY_CLAIM_EXPIRES_AT','2999-02-30T00:00:00.000Z');
    output=response(); await handler(request({loginId:'x',password:'y'}),output.res); expect(output.state.status).toBe(401);
    vi.stubEnv('SD_LEGACY_CLAIM_EXPIRES_AT','2999-01-01T00:00:00.000Z');
    output=response(); await handler({method:'GET',headers:{}} as unknown as VercelRequest,output.res); expect(output.state.status).toBe(405);
    expect(redisFactory).not.toHaveBeenCalled(); expect(redis.get).not.toHaveBeenCalled();
  });
});
