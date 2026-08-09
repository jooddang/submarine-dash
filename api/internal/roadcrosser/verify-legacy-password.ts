import crypto from 'node:crypto';
import type { VercelRequest,VercelResponse } from '@vercel/node';
import { withProductionControl } from '../../_lib/productionControls.js';
import { getStrictUpstashRedisReadOnlyClient,RedisConfigError } from '../../_lib/redis.js';
import { keyLoginId,keyUser,verifyPassword,type UserRecord } from '../../_lib/auth.js';

export const config={runtime:'nodejs'};
const dummySalt=Buffer.alloc(16).toString('base64');
const dummyHash=Buffer.alloc(64).toString('base64');

function authorized(req:VercelRequest) {
  const expected=process.env.SD_ROADCROSSER_INTERNAL_AUTH_TOKEN;
  const header=Array.isArray(req.headers.authorization)?req.headers.authorization[0]:req.headers.authorization;
  const supplied=header?.startsWith('Bearer ')?header.slice(7):'';
  if (!expected || expected.length<32 || !supplied) return false;
  return crypto.timingSafeEqual(
    crypto.createHash('sha256').update(expected).digest(),
    crypto.createHash('sha256').update(supplied).digest(),
  );
}

function response(res:VercelResponse,status:number,body:Record<string,unknown>) {
  res.setHeader('Cache-Control','no-store, max-age=0');
  return res.status(status).json(body);
}

function legacyClaimEnabled() {
  const configuredExpiry=process.env.SD_LEGACY_CLAIM_EXPIRES_AT??'';
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(configuredExpiry)) return false;
  const expiresAt=Date.parse(configuredExpiry);
  return process.env.SD_LEGACY_CLAIM_ENABLED==='true' && Number.isFinite(expiresAt)
    && new Date(expiresAt).toISOString()===configuredExpiry && expiresAt>Date.now();
}

function legacyCredentialVerificationEnabled() {
  return process.env.SD_LEGACY_ROAD_LOGIN_ENABLED==='true' || legacyClaimEnabled();
}

export async function handler(req:VercelRequest,res:VercelResponse) {
  if (req.method!=='POST') return response(res,405,{error:'Method not allowed'});
  if (!legacyCredentialVerificationEnabled() || !authorized(req)) return response(res,401,{error:'Unauthorized'});
  const body=(req.body??{}) as {loginId?:unknown;password?:unknown};
  const loginId=typeof body.loginId==='string'?body.loginId.trim():'';
  const password=typeof body.password==='string'?body.password:'';
  if (!loginId || loginId.length>200 || !password || password.length>1024) return response(res,401,{error:'Invalid credentials'});
  try {
    const redis=getStrictUpstashRedisReadOnlyClient();
    const normalized=loginId.toLowerCase();
    const indexedUserId=await redis.get<unknown>(keyLoginId(normalized));
    const validIndex=typeof indexedUserId==='string' && indexedUserId.length>0 && indexedUserId.length<=200;
    const externalUserId=validIndex?indexedUserId:'__invalid__';
    const raw=await redis.get<UserRecord|string>(keyUser(externalUserId));
    let user:UserRecord|null=null;
    if (typeof raw==='string') {
      try { user=JSON.parse(raw) as UserRecord; } catch { user=null; }
    } else if (raw && typeof raw==='object') user=raw;
    const passwordMatches=await verifyPassword(password,
      typeof user?.passwordSalt==='string'?user.passwordSalt:dummySalt,
      typeof user?.passwordHash==='string'?user.passwordHash:dummyHash);
    if (!validIndex || !user || user.userId!==externalUserId || user.loginIdLower!==normalized
      || typeof user.loginId!=='string' || user.loginId.toLowerCase()!==normalized || !passwordMatches) {
      return response(res,401,{error:'Invalid credentials'});
    }
    return response(res,200,{verified:true,externalUserId});
  } catch (error) {
    if (error instanceof RedisConfigError) return response(res,503,{error:'Verifier unavailable'});
    return response(res,503,{error:'Verifier unavailable'});
  }
}

export default withProductionControl('api/internal/roadcrosser/verify-legacy-password.ts', handler);
