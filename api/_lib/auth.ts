import crypto from 'node:crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getUpstashRedisClient } from './redis.js';

export const KEY_PREFIX = 'sd:';
export const SESSION_COOKIE_NAME = 'sd_session';
export const CANONICAL_SESSION_COOKIE_NAME = 'sd_roadcrosser_session';
export const ROAD_CROSSER_STATE_COOKIE_NAME = 'sd_rc_state';
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

export type UserRecord = {
  userId: string;
  loginId: string;
  loginIdLower: string;
  passwordHash: string; // base64
  passwordSalt: string; // base64
  createdAt: number; // epoch ms
  refCode: string;
};

function base64Url(bytes: Buffer) {
  return bytes
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

export function generateId(prefix: string) {
  return `${prefix}_${base64Url(crypto.randomBytes(16))}`;
}

export function generateRefCode() {
  // Short & URL-safe, enough entropy for a small project
  return base64Url(crypto.randomBytes(6));
}

export async function hashPassword(password: string) {
  const salt = crypto.randomBytes(16);
  const hash = await new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey as Buffer);
    });
  });
  return { saltB64: salt.toString('base64'), hashB64: hash.toString('base64') };
}

export async function verifyPassword(password: string, saltB64: string, hashB64: string) {
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey as Buffer);
    });
  });
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

export function parseCookies(req: VercelRequest): Record<string, string> {
  const header = req.headers.cookie;
  if (!header) return {};
  const out: Record<string, string> = {};
  const parts = header.split(/;\s*/g);
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    out[k] = decodeURIComponent(v);
  }
  return out;
}

export function setSessionCookie(res: VercelResponse, sessionToken: string) {
  const cookie = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionToken)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Secure',
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ].join('; ');
  appendCookie(res, cookie);
}

export function clearSessionCookie(res: VercelResponse) {
  const cookie = [
    `${SESSION_COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Secure',
    'Max-Age=0',
  ].join('; ');
  appendCookie(res, cookie);
}

function appendCookie(res: VercelResponse, cookie: string) {
  const current = res.getHeader('Set-Cookie');
  const cookies = Array.isArray(current) ? current : current ? [String(current)] : [];
  res.setHeader('Set-Cookie', [...cookies, cookie]);
}

export function setCanonicalSessionCookie(res: VercelResponse, token: string) {
  appendCookie(res, [
    `${CANONICAL_SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/', 'HttpOnly', 'SameSite=Lax', 'Secure', `Max-Age=${SESSION_TTL_SECONDS}`,
  ].join('; '));
}

export function clearCanonicalSessionCookie(res: VercelResponse) {
  appendCookie(res, [
    `${CANONICAL_SESSION_COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Secure', 'Max-Age=0',
  ].join('; '));
}

export function setRoadcrosserStateCookie(res: VercelResponse, state: string) {
  appendCookie(res, [
    `${ROAD_CROSSER_STATE_COOKIE_NAME}=${encodeURIComponent(state)}`,
    'Path=/api/auth/roadcrosser/callback', 'HttpOnly', 'SameSite=None', 'Secure', 'Max-Age=300',
  ].join('; '));
}

export function clearRoadcrosserStateCookie(res: VercelResponse) {
  appendCookie(res, [
    `${ROAD_CROSSER_STATE_COOKIE_NAME}=`,
    'Path=/api/auth/roadcrosser/callback', 'HttpOnly', 'SameSite=None', 'Secure', 'Max-Age=0',
  ].join('; '));
}

export function getCanonicalSessionToken(req: VercelRequest) {
  return parseCookies(req)[CANONICAL_SESSION_COOKIE_NAME] || null;
}

export function getLegacySessionToken(req: VercelRequest) {
  return parseCookies(req)[SESSION_COOKIE_NAME] || null;
}

export function isAllowedSubmarineMutationOrigin(req: VercelRequest) {
  const expected = process.env.SD_SUBMARINE_PUBLIC_ORIGIN || 'https://submarine-dash.roadcrosser.com';
  if (
    expected !== 'https://submarine-dash.roadcrosser.com'
    && !(process.env.NODE_ENV !== 'production' && /^http:\/\/(?:localhost|127\.0\.0\.1):[0-9]+$/.test(expected))
  ) return false;
  const origin = Array.isArray(req.headers.origin) ? req.headers.origin[0] : req.headers.origin;
  if (origin) {
    if (origin === expected) return true;
    const host = Array.isArray(req.headers.host) ? req.headers.host[0] : req.headers.host;
    const forwardedProto = req.headers['x-forwarded-proto'];
    const protocol = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto || 'http';
    return process.env.NODE_ENV !== 'production'
      && /^http:\/\/(?:localhost|127\.0\.0\.1):[0-9]+$/.test(origin)
      && Boolean(host)
      && origin === `${protocol}://${host}`;
  }
  const site = req.headers['sec-fetch-site'];
  return (Array.isArray(site) ? site[0] : site) === 'same-origin';
}

export function getRoadcrosserState(req: VercelRequest) {
  return parseCookies(req)[ROAD_CROSSER_STATE_COOKIE_NAME] || null;
}

export function keyLoginId(loginIdLower: string) {
  return `${KEY_PREFIX}loginId:${loginIdLower}`;
}
export function keyUser(userId: string) {
  return `${KEY_PREFIX}user:${userId}`;
}
export function keySession(token: string) {
  return `${KEY_PREFIX}session:${token}`;
}

export async function getUserIdForSession(req: VercelRequest): Promise<string | null> {
  // Canonical and legacy credentials are separate authorities. Once a canonical
  // cookie is present, a dormant legacy cookie must never authorize Redis.
  if (getCanonicalSessionToken(req)) return null;
  const token = getLegacySessionToken(req);
  if (!token) return null;
  const redis = getUpstashRedisClient(true);
  const userId = await redis.get<string>(keySession(token));
  return userId || null;
}

export async function getUser(userId: string): Promise<UserRecord | null> {
  const redis = getUpstashRedisClient(true);
  const raw = await redis.get(keyUser(userId));
  if (!raw) return null;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as UserRecord;
    } catch {
      return null;
    }
  }
  return raw as UserRecord;
}

export async function setUser(user: UserRecord) {
  const redis = getUpstashRedisClient(false);
  await redis.set(keyUser(user.userId), JSON.stringify(user));
  await redis.set(keyLoginId(user.loginIdLower), user.userId);
}

export async function createSession(res: VercelResponse, userId: string) {
  const redis = getUpstashRedisClient(false);
  const token = generateId('sess');
  await redis.set(keySession(token), userId, { ex: SESSION_TTL_SECONDS });
  setSessionCookie(res, token);
  return token;
}

export async function deleteSession(req: VercelRequest) {
  const token = getLegacySessionToken(req);
  if (!token) return;
  await deleteLegacySessionToken(token);
}

export async function deleteLegacySessionToken(token: string) {
  const redis = getUpstashRedisClient(false);
  await redis.del(keySession(token));
}

export async function isRateLimited(key: string, limit: number, windowSeconds: number) {
  const redis = getUpstashRedisClient(false);
  const k = `${KEY_PREFIX}rl:${key}`;
  const count = await redis.incr(k);
  if (count === 1) {
    await redis.expire(k, windowSeconds);
  }
  return count > limit;
}
