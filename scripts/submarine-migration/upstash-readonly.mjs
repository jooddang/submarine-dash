const COMMANDS = new Set(['SCAN', 'TYPE', 'GET', 'LRANGE', 'SMEMBERS', 'HGETALL', 'ZRANGE', 'PTTL']);

function ascii(argument) {
  return Buffer.isBuffer(argument) ? argument.toString('ascii') : String(argument);
}

export function validateReadCommand(command) {
  if (!Array.isArray(command) || !COMMANDS.has(ascii(command[0]).toUpperCase())) throw new Error('forbidden Redis command');
  const name = ascii(command[0]).toUpperCase();
  const args = command.slice(1);
  const oneKey = ['TYPE', 'GET', 'SMEMBERS', 'HGETALL', 'PTTL'].includes(name) && args.length === 1;
  const lrange = name === 'LRANGE' && args.length === 3 && ascii(args[1]) === '0' && ascii(args[2]) === '-1';
  const zrange = name === 'ZRANGE' && args.length === 4 && ascii(args[1]) === '0' && ascii(args[2]) === '-1' && ascii(args[3]).toUpperCase() === 'WITHSCORES';
  const scan = name === 'SCAN' && args.length === 5 && /^\d+$/.test(ascii(args[0])) && ascii(args[1]).toUpperCase() === 'MATCH' && ascii(args[2]) === '*' && ascii(args[3]).toUpperCase() === 'COUNT' && /^[1-9]\d*$/.test(ascii(args[4]));
  if (!(oneKey || lrange || zrange || scan)) throw new Error(`forbidden ${name} grammar`);
  return [name, ...args];
}

function pathBytes(argument) {
  return [...Buffer.from(argument)].map((byte) => `%${byte.toString(16).padStart(2, '0').toUpperCase()}`).join('');
}

function decodeBase64Result(value) {
  if (value === null || typeof value === 'number') return value;
  if (typeof value === 'string') {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error('Upstash returned invalid base64');
    const decoded = Buffer.from(value, 'base64');
    if (decoded.toString('base64') !== value) throw new Error('Upstash returned non-canonical base64');
    return decoded;
  }
  if (Array.isArray(value)) return value.map(decodeBase64Result);
  throw new Error('Upstash returned an unexpected result shape');
}

export class ReadOnlyUpstashClient {
  constructor({ endpoint, readOnlyToken, fetchImpl = globalThis.fetch, allowFixtureEndpoint = false }) {
    const parsed = new URL(endpoint);
    const injectedFixtureTransport = allowFixtureEndpoint && fetchImpl !== globalThis.fetch;
    const pinnedProductionEndpoint = parsed.protocol === 'https:' && parsed.hostname.toLowerCase().endsWith('.upstash.io');
    if ((!pinnedProductionEndpoint && !injectedFixtureTransport) ||
        (injectedFixtureTransport && !['http:', 'https:'].includes(parsed.protocol)) ||
        parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname !== '' && parsed.pathname !== '/')) {
      throw new Error('invalid Upstash REST endpoint');
    }
    if (typeof readOnlyToken !== 'string' || readOnlyToken.length < 8) throw new Error('dedicated read-only token is required');
    if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is required');
    this.endpoint = endpoint.replace(/\/$/, '');
    this.token = readOnlyToken;
    this.fetch = fetchImpl;
  }

  async execute(command) {
    const validated = validateReadCommand(command);
    const url = `${this.endpoint}/${validated.map(pathBytes).join('/')}`;
    const response = await this.fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.token}`, 'Upstash-Encoding': 'base64' },
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Upstash read failed with HTTP ${response.status}`);
    const body = await response.json();
    if (!body || Object.keys(body).length !== 1 || !Object.hasOwn(body, 'result')) throw new Error('Upstash read returned an invalid envelope');
    return decodeBase64Result(body.result);
  }
}
