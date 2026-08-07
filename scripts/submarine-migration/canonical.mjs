import { createHash } from 'node:crypto';

export function canonicalJson(value) {
  if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('canonical JSON rejects non-finite numbers');
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value !== 'object') throw new TypeError('canonical JSON supports only JSON values');
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function compareBytes(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

export function lengthPrefixed(bytes) {
  const payload = Buffer.from(bytes);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length);
  return Buffer.concat([length, payload]);
}
