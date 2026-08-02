import { Redis } from '@upstash/redis';
import { createControlledRedis, productionControlFlags } from '../../shared/productionControls.js';

let redisReadOnly: Redis | null = null;
let redisReadWrite: Redis | null = null;
let redisControlledReadWrite: Redis | null = null;

export class RedisConfigError extends Error {
  name = 'RedisConfigError';
}

export function getUpstashRedisClient(readOnly: boolean): Redis {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const writeToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  // Many deployments only set a single token. If read-only token is missing, fall back to the write token.
  const readToken = process.env.KV_REST_API_READ_ONLY_TOKEN || writeToken;
  const token = readOnly ? readToken : writeToken;

  if (!url) {
    throw new RedisConfigError(
      'Missing Redis URL. Set KV_REST_API_URL (Vercel KV) or UPSTASH_REDIS_REST_URL (Upstash).'
    );
  }
  if (!token) {
    throw new RedisConfigError(
      'Missing Redis token. Set KV_REST_API_TOKEN (Vercel KV) or UPSTASH_REDIS_REST_TOKEN (Upstash).'
    );
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
  if (!redisControlledReadWrite) {
    const adapter = {
      eval: (script: string, keys: string[], args: Array<string | number>) => redisReadWrite!.eval(script, keys, args),
    };
    redisControlledReadWrite = createControlledRedis(redisReadWrite, adapter, productionControlFlags()) as Redis;
  }
  return redisControlledReadWrite;
}

export function getRawUpstashRedisClient(): Redis {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new RedisConfigError('Missing writable Redis configuration.');
  if (!redisReadWrite) redisReadWrite = new Redis({ url, token });
  return redisReadWrite;
}

