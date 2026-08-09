import { validateCanaryEquipResponse } from '../../shared/canaryEquip.js';
import { SKIN_CATALOG_VERSION, validateCanaryPurchaseResponse } from '../../shared/canaryPurchase.js';
import { DOLPHIN_CONTRACT_VERSION, validateCanaryDolphinResponse } from '../../shared/canaryDolphin.js';
import { validateCanonicalDailyMissions } from '../../shared/canonicalDailyMissions.js';
import { canonicalGameplayRequest, validateCanonicalGameplayResponse } from '../../shared/canonicalGameplay.js';

const productionBaseUrl = 'https://www.roadcrosser.com';
const opaque256 = /^[A-Za-z0-9_-]{43}$/;
const allowedPaths = new Set([
  '/api/internal/submarine-dash/tickets/consume',
  '/api/internal/submarine-dash/sessions/resolve',
  '/api/internal/submarine-dash/sessions/revoke',
  '/api/internal/submarine-dash/bootstrap',
  '/api/internal/submarine-dash/mutations/equip-skin',
  '/api/internal/submarine-dash/mutations/purchase-skin',
  '/api/internal/submarine-dash/mutations/consume-dolphin',
  '/api/internal/submarine-dash/mutations/import-dolphin',
  '/api/internal/submarine-dash/daily-missions',
  '/api/internal/submarine-dash/mutations/settle-gameplay',
]);

export type CanonicalSubmarineUser = {
  version: 'submarine-game-session-v1';
  externalUserId: string;
  loginId: string;
  expiresAt?: string;
  expiresInSeconds?: number;
};

export type CanonicalSubmarineBootstrap = {
  version: 'submarine-canonical-bootstrap-v2';
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
  readOnly: boolean;
  readCapabilities: string[];
  writeCapabilities: string[];
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

async function request(path: string, body: Record<string, unknown>) {
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

export async function readRoadcrosserCanonicalBootstrap(sessionToken: string) {
  const result = await request('/api/internal/submarine-dash/bootstrap', { sessionToken });
  const user = result.user as Record<string, unknown> | undefined;
  if (
    result.version !== 'submarine-canonical-bootstrap-v2'
    || typeof result.readOnly !== 'boolean'
    || !Array.isArray(result.readCapabilities)
    || result.readCapabilities.some((capability) => capability !== 'read_daily_missions')
    || !Array.isArray(result.writeCapabilities)
    || result.writeCapabilities.some((capability) => ![
      'equip_skin', 'purchase_skin', 'consume_dolphin', 'import_dolphin',
      'settle_run_end', 'settle_oxygen_collected', 'settle_pvp_result',
    ].includes(String(capability)))
    || !user
    || typeof user.externalUserId !== 'string'
    || typeof user.loginId !== 'string'
  ) {
    throw new Error('Roadcrosser protected bootstrap response is invalid');
  }
  return result as CanonicalSubmarineBootstrap;
}

export async function equipRoadcrosserCanarySkin(sessionToken: string, idempotencyKey: string, skinId: string) {
  const result = await request('/api/internal/submarine-dash/mutations/equip-skin', { sessionToken, idempotencyKey, skinId });
  return validateCanaryEquipResponse(result, skinId);
}

export async function purchaseRoadcrosserCanarySkin(sessionToken: string, idempotencyKey: string, skinId: string) {
  const result = await request('/api/internal/submarine-dash/mutations/purchase-skin', {
    sessionToken, idempotencyKey, skinId, catalogVersion: SKIN_CATALOG_VERSION,
  });
  return validateCanaryPurchaseResponse(result, skinId);
}

export async function consumeRoadcrosserCanaryDolphin(sessionToken: string, idempotencyKey: string) {
  const result = await request('/api/internal/submarine-dash/mutations/consume-dolphin', {
    sessionToken, idempotencyKey, contractVersion: DOLPHIN_CONTRACT_VERSION,
  });
  return validateCanaryDolphinResponse(result, 'consume_dolphin');
}

export async function importRoadcrosserCanaryDolphin(sessionToken: string, idempotencyKey: string, count: number) {
  const result = await request('/api/internal/submarine-dash/mutations/import-dolphin', {
    sessionToken, idempotencyKey, count, contractVersion: DOLPHIN_CONTRACT_VERSION,
  });
  return validateCanaryDolphinResponse(result, 'import_dolphin');
}

export async function readRoadcrosserDailyMissions(sessionToken: string) {
  return validateCanonicalDailyMissions(await request('/api/internal/submarine-dash/daily-missions', { sessionToken }));
}

export async function settleRoadcrosserGameplay(sessionToken: string, expectedExternalUserId: string, idempotencyKey: string,
  runEvidenceId: string | null, event: Record<string, unknown>) {
  const body = canonicalGameplayRequest({ canonicalToken: sessionToken, expectedExternalUserId, idempotencyKey, runEvidenceId, event });
  return validateCanonicalGameplayResponse(
    await request('/api/internal/submarine-dash/mutations/settle-gameplay', body), String(event.type),
  );
}
