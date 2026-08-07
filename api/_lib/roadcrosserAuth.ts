const productionBaseUrl = 'https://www.roadcrosser.com';
const opaque256 = /^[A-Za-z0-9_-]{43}$/;
const allowedPaths = new Set([
  '/api/internal/submarine-dash/tickets/consume',
  '/api/internal/submarine-dash/sessions/resolve',
  '/api/internal/submarine-dash/sessions/revoke',
  '/api/internal/submarine-dash/bootstrap',
]);

export type CanonicalSubmarineUser = {
  version: 'submarine-game-session-v1';
  externalUserId: string;
  loginId: string;
  expiresAt?: string;
  expiresInSeconds?: number;
};

export type ProtectedSubmarineBootstrap = {
  version: 'submarine-protected-bootstrap-v1';
  user: { externalUserId: string; loginId: string };
  inventory: {
    coins: number;
    dolphinSaved: number;
    dolphinPending: number;
    tube: { pieces: number; charges: number };
    skins: { owned: string[]; equipped: string | null };
  };
  streak: Record<string, unknown>;
  achievements: Record<string, unknown>;
  unreadInboxCount: number;
  stateVersion: number;
  readOnly: true;
};

function baseUrl() {
  const configured = process.env.SD_ROADCROSSER_INTERNAL_BASE_URL;
  if (!configured) return productionBaseUrl;
  if (configured === productionBaseUrl) return configured;
  if (process.env.NODE_ENV !== 'production' && /^http:\/\/(?:127\.0\.0\.1|localhost):[0-9]+$/.test(configured)) {
    return configured;
  }
  throw new Error('Roadcrosser internal base URL is invalid');
}

async function request(path: string, body: Record<string, string>) {
  if (!allowedPaths.has(path)) throw new Error('Roadcrosser internal path is forbidden');
  const credential = process.env.SD_ROADCROSSER_INTERNAL_AUTH_TOKEN;
  if (!credential || credential.length < 32) throw new Error('Roadcrosser internal client is not configured');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`${baseUrl()}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
      redirect: 'error',
    });
    const text = await response.text();
    if (text.length > 16 * 1024) throw new Error('Roadcrosser response is oversized');
    if (!response.ok) throw new Error('Roadcrosser canonical auth request failed');
    if (!text) return {};
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error('Roadcrosser canonical auth response is invalid');
    }
  } finally {
    clearTimeout(timeout);
  }
}

export async function consumeRoadcrosserTicket(ticket: string, stateChallenge: string) {
  const result = await request('/api/internal/submarine-dash/tickets/consume', { ticket, stateChallenge });
  if (
    result.version !== 'submarine-game-session-v1'
    || typeof result.externalUserId !== 'string'
    || typeof result.loginId !== 'string'
    || !opaque256.test(String(result.sessionToken || ''))
  ) throw new Error('Roadcrosser canonical auth response is invalid');
  return result as CanonicalSubmarineUser & { sessionToken: string };
}

export async function resolveRoadcrosserSession(sessionToken: string) {
  const result = await request('/api/internal/submarine-dash/sessions/resolve', { sessionToken });
  if (result.version !== 'submarine-game-session-v1' || typeof result.externalUserId !== 'string' || typeof result.loginId !== 'string') {
    throw new Error('Roadcrosser canonical auth response is invalid');
  }
  return result as CanonicalSubmarineUser;
}

export async function revokeRoadcrosserSession(sessionToken: string) {
  await request('/api/internal/submarine-dash/sessions/revoke', { sessionToken });
}

export async function readRoadcrosserProtectedBootstrap(sessionToken: string) {
  const result = await request('/api/internal/submarine-dash/bootstrap', { sessionToken });
  const user = result.user as Record<string, unknown> | undefined;
  if (
    result.version !== 'submarine-protected-bootstrap-v1'
    || result.readOnly !== true
    || !user
    || typeof user.externalUserId !== 'string'
    || typeof user.loginId !== 'string'
  ) {
    throw new Error('Roadcrosser protected bootstrap response is invalid');
  }
  return result as ProtectedSubmarineBootstrap;
}
