import { Redis } from '@upstash/redis';

let redisReadOnly: Redis | null = null;
let redisReadWrite: Redis | null = null;

export function getUpstashRedisClient(readOnly: boolean): Redis {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const writeToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  // Many deployments only set a single token. If read-only token is missing, fall back to the write token.
  const readToken = process.env.KV_REST_API_READ_ONLY_TOKEN || writeToken;
  const token = readOnly ? readToken : writeToken;

  if (!url) {
    throw new Error('KV_REST_API_URL (or UPSTASH_REDIS_REST_URL) environment variable is not set');
  }
  if (!token) {
    throw new Error('KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_TOKEN) environment variable is not set');
  }

  if (readOnly) {
    if (!redisReadOnly) {
      redisReadOnly = new Redis({ url, token });
    }
    return redisReadOnly;
  }

  if (!redisReadWrite) {
    redisReadWrite = new Redis({ url, token });
  }
  return redisReadWrite;
}


