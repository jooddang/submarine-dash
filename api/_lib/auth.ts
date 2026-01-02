import crypto from 'node:crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getUpstashRedisClient } from './redis';

export const KEY_PREFIX = 'sd:';
export const SESSION_COOKIE_NAME = 'sd_session';
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
  res.setHeader('Set-Cookie', cookie);
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
  res.setHeader('Set-Cookie', cookie);
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
  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE_NAME];
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
    return JSON.parse(raw) as UserRecord;
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
  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE_NAME];
  if (!token) return;
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


