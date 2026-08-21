import { createHash } from 'node:crypto';

export const ROUTE_CLASS = Object.freeze({
  READ_ONLY: 'read-only',
  DURABLE_MUTATION: 'durable-mutation',
  EPHEMERAL_MUTATION: 'ephemeral-mutation',
  GET_SIDE_EFFECT: 'get-with-side-effect',
});

const route = (file, methods, keyFamilies, local = true) => ({ file, methods, keyFamilies, local });

// Production Vercel functions are authoritative. Keep this list explicit so a new
// api/** function cannot silently bypass migration controls.
export const PRODUCTION_ROUTE_INVENTORY = Object.freeze([
  route('api/achievements/index.ts', { GET: ROUTE_CLASS.READ_ONLY }, ['sd:user:*:achievements']),
  route('api/achievements/users.ts', { GET: ROUTE_CLASS.READ_ONLY }, ['sd:loginId:*', 'sd:user:*:achievements']),
  route('api/auth/change-password.ts', { POST: ROUTE_CLASS.DURABLE_MUTATION }, ['sd:user:*', 'sd:session:*', 'sd:rl:*']),
  route('api/auth/login.ts', { POST: ROUTE_CLASS.EPHEMERAL_MUTATION }, ['sd:user:*', 'sd:loginId:*', 'sd:session:*', 'sd:rl:*']),
  route('api/auth/logout.ts', { POST: ROUTE_CLASS.EPHEMERAL_MUTATION }, ['sd:session:*']),
  route('api/auth/me.ts', { GET: ROUTE_CLASS.GET_SIDE_EFFECT }, ['sd:reward:*', 'sd:user:*:dolphin:*', 'sd:user:*:coins', 'sd:user:*:tube', 'sd:user:*:skins:*']),
  route('api/auth/register.ts', { POST: ROUTE_CLASS.DURABLE_MUTATION }, ['sd:user:*', 'sd:loginId:*', 'sd:session:*', 'sd:rl:*']),
  route('api/auth/roadcrosser/callback.ts', { POST: ROUTE_CLASS.EPHEMERAL_MUTATION }, []),
  route('api/auth/roadcrosser/start.ts', { GET: ROUTE_CLASS.EPHEMERAL_MUTATION }, []),
  route('api/game-events.ts', { POST: ROUTE_CLASS.EPHEMERAL_MUTATION }, []),
  route('api/health.ts', { GET: ROUTE_CLASS.READ_ONLY }, []),
  route('api/internal/roadcrosser/verify-legacy-password.ts', { POST: ROUTE_CLASS.READ_ONLY }, ['sd:loginId:*', 'sd:user:*'], false),
  route('api/inventory/dolphin/consume.ts', { POST: ROUTE_CLASS.DURABLE_MUTATION }, ['sd:user:*:dolphin:*']),
  route('api/inventory/dolphin/import.ts', { POST: ROUTE_CLASS.DURABLE_MUTATION }, ['sd:user:*:dolphin:*']),
  route('api/inventory/skin/equip.ts', { POST: ROUTE_CLASS.DURABLE_MUTATION }, ['sd:user:*:skins:*']),
  route('api/inventory/skin/purchase.ts', { POST: ROUTE_CLASS.DURABLE_MUTATION }, ['sd:user:*:coins', 'sd:user:*:skins:*']),
  route('api/leaderboard.ts', { GET: ROUTE_CLASS.GET_SIDE_EFFECT, POST: ROUTE_CLASS.DURABLE_MUTATION, DELETE: ROUTE_CLASS.DURABLE_MUTATION }, ['submarine-dash:leaderboard', 'submarine-dash:leaderboards:weekly:v1']),
  route('api/leaderboard/weekly.ts', { GET: ROUTE_CLASS.GET_SIDE_EFFECT }, ['submarine-dash:leaderboard', 'submarine-dash:leaderboards:weekly:v1']),
  route('api/missions/daily.ts', { GET: ROUTE_CLASS.GET_SIDE_EFFECT }, ['sd:missions:daily:*', 'sd:user:*:daily:*', 'sd:user:*:streak', 'sd:user:*:dolphin:*']),
  route('api/missions/event.ts', { POST: ROUTE_CLASS.DURABLE_MUTATION }, ['sd:missions:daily:*', 'sd:user:*:daily:*', 'sd:user:*:streak', 'sd:user:*:achievements', 'sd:user:*:coins', 'sd:user:*:dolphin:*']),
  route('api/pvp-online/bootstrap.ts', { GET: ROUTE_CLASS.GET_SIDE_EFFECT }, ['sd:pvp:room-membership:*', 'sd:user:*', 'sd:inbox:*']),
  route('api/pvp-online/inbox.ts', { GET: ROUTE_CLASS.READ_ONLY }, ['sd:inbox:*', 'sd:inbox:unread:*']),
  route('api/pvp-online/inbox/[id]/read.ts', { POST: ROUTE_CLASS.DURABLE_MUTATION }, ['sd:inbox:*', 'sd:inbox:unread:*']),
  route('api/pvp-online/inbox/read-all.ts', { POST: ROUTE_CLASS.DURABLE_MUTATION }, ['sd:inbox:*', 'sd:inbox:unread:*']),
  route('api/pvp-online/invites/accept.ts', { POST: ROUTE_CLASS.DURABLE_MUTATION }, ['sd:pvp:invite:*', 'sd:pvp:user-invites:*', 'sd:pvp:room:*', 'sd:pvp:room-membership:*']),
  route('api/pvp-online/invites/cancel.ts', { POST: ROUTE_CLASS.DURABLE_MUTATION }, ['sd:pvp:invite:*', 'sd:pvp:user-invites:*', 'sd:pvp:room:*']),
  route('api/pvp-online/invites/decline.ts', { POST: ROUTE_CLASS.DURABLE_MUTATION }, ['sd:pvp:invite:*', 'sd:pvp:user-invites:*', 'sd:pvp:room:*']),
  route('api/pvp-online/invites/pending.ts', { GET: ROUTE_CLASS.GET_SIDE_EFFECT }, ['sd:pvp:invite:*', 'sd:pvp:user-invites:*']),
  route('api/pvp-online/invites/send.ts', { POST: ROUTE_CLASS.DURABLE_MUTATION }, ['sd:pvp:invite:*', 'sd:pvp:user-invites:*', 'sd:pvp:room:*']),
  route('api/pvp-online/lobby.ts', { GET: ROUTE_CLASS.EPHEMERAL_MUTATION }, ['sd:pvp:presence:*', 'sd:pvp:lobby:online']),
  route('api/pvp-online/lobby/enter.ts', { POST: ROUTE_CLASS.EPHEMERAL_MUTATION }, ['sd:pvp:presence:*', 'sd:pvp:lobby:online']),
  route('api/pvp-online/lobby/leave.ts', { POST: ROUTE_CLASS.EPHEMERAL_MUTATION }, ['sd:pvp:presence:*', 'sd:pvp:lobby:online']),
  route('api/pvp-online/lobby/rooms.ts', { GET: ROUTE_CLASS.GET_SIDE_EFFECT }, ['sd:pvp:rooms:all', 'sd:pvp:room:*']),
  route('api/pvp-online/matches/[matchId].ts', { GET: ROUTE_CLASS.READ_ONLY }, ['sd:pvp:match:*']),
  route('api/pvp-online/matches/[matchId]/input.ts', { POST: ROUTE_CLASS.DURABLE_MUTATION }, ['sd:pvp:match:*']),
  route('api/pvp-online/matches/[matchId]/state.ts', { POST: ROUTE_CLASS.DURABLE_MUTATION }, ['sd:pvp:match:*', 'sd:pvp:room:*']),
  route('api/pvp-online/rooms/[roomId].ts', { GET: ROUTE_CLASS.READ_ONLY }, ['sd:pvp:room:*']),
  route('api/pvp-online/rooms/cancel.ts', { POST: ROUTE_CLASS.DURABLE_MUTATION }, ['sd:pvp:room:*', 'sd:pvp:room-membership:*', 'sd:pvp:rooms:all']),
  route('api/pvp-online/rooms/config.ts', { POST: ROUTE_CLASS.DURABLE_MUTATION }, ['sd:pvp:room:*']),
  route('api/pvp-online/rooms/create.ts', { POST: ROUTE_CLASS.DURABLE_MUTATION }, ['sd:pvp:room:*', 'sd:pvp:room-membership:*', 'sd:pvp:rooms:all']),
  route('api/pvp-online/rooms/join.ts', { POST: ROUTE_CLASS.DURABLE_MUTATION }, ['sd:pvp:room:*', 'sd:pvp:room-membership:*']),
  route('api/pvp-online/rooms/leave.ts', { POST: ROUTE_CLASS.DURABLE_MUTATION }, ['sd:pvp:room:*', 'sd:pvp:room-membership:*', 'sd:pvp:rooms:all']),
  route('api/pvp-online/rooms/list.ts', { GET: ROUTE_CLASS.GET_SIDE_EFFECT }, ['sd:pvp:rooms:all', 'sd:pvp:room:*']),
  route('api/pvp-online/rooms/ready.ts', { POST: ROUTE_CLASS.DURABLE_MUTATION }, ['sd:pvp:room:*', 'sd:pvp:match:*']),
  route('api/pvp-online/rooms/skin.ts', { POST: ROUTE_CLASS.DURABLE_MUTATION }, ['sd:pvp:room:*', 'sd:user:*:skins:*']),
  route('api/pvp-online/ws-ticket.ts', { POST: ROUTE_CLASS.EPHEMERAL_MUTATION }, ['sd:pvp:ws-ticket:*']),
  route('api/pvp/settle-bet.ts', { POST: ROUTE_CLASS.DURABLE_MUTATION }, ['sd:user:*:coins', 'sd:user:*:dolphin:*', 'sd:user:*:tube']),
]);

export const ROUTE_INVENTORY_VERSION = 3;
export const PRODUCTION_KEY_FAMILIES = Object.freeze([...new Set(
  PRODUCTION_ROUTE_INVENTORY.flatMap((entry) => entry.keyFamilies),
)].sort());

const keySpec = (id, pattern, ttl, sources, routeFamilies = []) => Object.freeze({ id, pattern, ttl, sources, routeFamilies });

// Preservation patterns are deliberately narrower than route-level families.
// `{segment}` never crosses `:`; `{opaque}` is reserved for the rate-limit key,
// whose builder includes IP addresses and other intentionally multi-colon text.
export const SUBMARINE_PRESERVATION_KEY_SPECS = Object.freeze([
  keySpec('legacy-leaderboard', 'submarine-dash:leaderboard', 'durable', ['api/_lib/weeklyLeaderboard.ts', 'backend/src/server.js'], ['submarine-dash:leaderboard']),
  keySpec('weekly-leaderboards', 'submarine-dash:leaderboards:weekly:v1', 'durable', ['api/_lib/weeklyLeaderboard.ts', 'backend/src/server.js'], ['submarine-dash:leaderboards:weekly:v1']),
  keySpec('login-index', 'sd:loginId:{opaque}', 'durable', ['api/_lib/auth.ts', 'backend/src/server.js'], ['sd:loginId:*']),
  keySpec('user-record', 'sd:user:{segment}', 'durable', ['api/_lib/auth.ts', 'backend/src/server.js'], ['sd:user:*']),
  keySpec('session', 'sd:session:{segment}', 'ephemeral', ['api/_lib/auth.ts', 'backend/src/server.js'], ['sd:session:*']),
  keySpec('rate-limit', 'sd:rl:{opaque}', 'ephemeral', ['api/_lib/auth.ts', 'backend/src/server.js'], ['sd:rl:*']),
  keySpec('weekly-reward-claim', 'sd:reward:weeklyWinnerDolphin:claimed:{segment}', 'durable', ['api/_lib/weeklyLeaderboard.ts', 'backend/src/server.js'], ['sd:reward:*']),
  keySpec('legacy-dolphin-grant', 'sd:reward:dolphin:grant:{segment}', 'durable', ['api/_lib/dolphinInventory.ts', 'backend/src/server.js'], ['sd:reward:*']),
  keySpec('dolphin-saved', 'sd:user:{segment}:dolphin:saved', 'durable', ['api/_lib/dolphinInventory.ts', 'backend/src/server.js'], ['sd:user:*:dolphin:*']),
  keySpec('dolphin-pending', 'sd:user:{segment}:dolphin:pending', 'durable', ['api/_lib/dolphinInventory.ts', 'backend/src/server.js'], ['sd:user:*:dolphin:*']),
  keySpec('dolphin-ledger', 'sd:user:{segment}:dolphin:ledger', 'durable', ['api/_lib/dolphinInventory.ts', 'backend/src/server.js'], ['sd:user:*:dolphin:*']),
  keySpec('dolphin-streak-award', 'sd:user:{segment}:reward:dolphin:streak:lastAwarded', 'durable', ['api/_lib/dolphinInventory.ts', 'backend/src/server.js']),
  keySpec('coin-balance', 'sd:user:{segment}:coins', 'durable', ['api/_lib/coinInventory.ts', 'backend/src/server.js'], ['sd:user:*:coins']),
  keySpec('coin-ledger', 'sd:user:{segment}:coin:ledger', 'durable', ['api/_lib/coinInventory.ts', 'backend/src/server.js']),
  keySpec('tube-state', 'sd:user:{segment}:tube', 'durable', ['api/_lib/tubeInventory.ts', 'backend/src/server.js'], ['sd:user:*:tube']),
  keySpec('skins-owned', 'sd:user:{segment}:skins:owned', 'durable', ['api/_lib/skinInventory.ts', 'backend/src/server.js'], ['sd:user:*:skins:*']),
  keySpec('skin-equipped', 'sd:user:{segment}:skins:equipped', 'durable', ['api/_lib/skinInventory.ts', 'backend/src/server.js'], ['sd:user:*:skins:*']),
  keySpec('achievements', 'sd:user:{segment}:achievements', 'durable', ['api/_lib/achievements.ts', 'backend/src/server.js'], ['sd:user:*:achievements']),
  keySpec('daily-missions', 'sd:missions:daily:{segment}', 'durable', ['api/missions/daily.ts', 'api/missions/event.ts', 'backend/src/server.js'], ['sd:missions:daily:*']),
  keySpec('user-daily', 'sd:user:{segment}:daily:{segment}', 'durable', ['api/missions/daily.ts', 'api/missions/event.ts', 'backend/src/server.js'], ['sd:user:*:daily:*']),
  keySpec('user-streak', 'sd:user:{segment}:streak', 'durable', ['api/missions/daily.ts', 'api/missions/event.ts', 'backend/src/server.js'], ['sd:user:*:streak']),
  keySpec('inbox', 'sd:inbox:{segment}', 'durable', ['api/_lib/pvpOnlineInbox.ts', 'backend/src/server.js'], ['sd:inbox:*']),
  keySpec('inbox-unread', 'sd:inbox:unread:{segment}', 'durable', ['api/_lib/pvpOnlineInbox.ts', 'backend/src/server.js'], ['sd:inbox:unread:*']),
  keySpec('pvp-invite', 'sd:pvp:invite:{segment}', 'durable', ['api/_lib/pvpOnlineInvites.ts', 'backend/src/server.js'], ['sd:pvp:invite:*']),
  keySpec('pvp-user-invites', 'sd:pvp:user-invites:{segment}', 'durable', ['api/_lib/pvpOnlineInvites.ts', 'backend/src/server.js'], ['sd:pvp:user-invites:*']),
  keySpec('pvp-room', 'sd:pvp:room:{segment}', 'durable', ['api/_lib/pvpOnlineRooms.ts', 'backend/src/server.js'], ['sd:pvp:room:*']),
  keySpec('pvp-room-membership', 'sd:pvp:room-membership:{segment}', 'durable', ['api/_lib/pvpOnlineRooms.ts', 'api/_lib/pvpOnlinePresence.ts', 'backend/src/server.js'], ['sd:pvp:room-membership:*']),
  keySpec('pvp-room-index', 'sd:pvp:rooms:all', 'durable', ['api/_lib/pvpOnlineRooms.ts', 'backend/src/server.js'], ['sd:pvp:rooms:all']),
  keySpec('pvp-match', 'sd:pvp:match:{segment}', 'durable', ['api/_lib/pvpOnlineRooms.ts', 'backend/src/server.js'], ['sd:pvp:match:*']),
  keySpec('pvp-presence', 'sd:pvp:presence:{segment}', 'ephemeral', ['api/_lib/pvpOnlinePresence.ts', 'backend/src/server.js'], ['sd:pvp:presence:*']),
  keySpec('pvp-lobby-index', 'sd:pvp:lobby:online', 'ephemeral', ['api/_lib/pvpOnlinePresence.ts', 'backend/src/server.js', 'shared/productionControls.js'], ['sd:pvp:lobby:online']),
  keySpec('pvp-ws-ticket', 'sd:pvp:ws-ticket:{segment}', 'ephemeral', ['api/_lib/pvpOnlineAuth.ts', 'backend/src/server.js'], ['sd:pvp:ws-ticket:*']),
  ...['gate', 'epoch', 'fence', 'leases', 'expired-leases', 'hard-failure', 'hard-failure-at', 'closed-at', 'max-lease-ttl-ms', 'mutation-count', 'reconciliations'].map((suffix) =>
    keySpec(`migration-control-${suffix}`, `sd:migration:control:${suffix}`, 'durable', ['shared/productionControls.js'])),
  keySpec('migration-control-stale-pvp-audit', 'sd:migration:control:stale-pvp-audit:{segment}', 'durable', ['scripts/submarine-migration/stale-pvp-quarantine.mjs']),
  keySpec('migration-control-lease', 'sd:migration:control:lease:{segment}', 'ephemeral', ['shared/productionControls.js']),
]);
export const ROUTE_INVENTORY_DIGEST = createHash('sha256')
  .update(JSON.stringify({ routes: PRODUCTION_ROUTE_INVENTORY, preservation: SUBMARINE_PRESERVATION_KEY_SPECS }))
  .digest('hex');

export const ROUTE_BY_FILE = new Map(PRODUCTION_ROUTE_INVENTORY.map((entry) => [entry.file, entry]));

export function routeClassification(file, method) {
  return ROUTE_BY_FILE.get(file)?.methods?.[String(method || '').toUpperCase()] ?? null;
}

export function requiresDurableAdmission(classification) {
  return classification === ROUTE_CLASS.DURABLE_MUTATION || classification === ROUTE_CLASS.GET_SIDE_EFFECT;
}

export function routeFileToPath(file) {
  return ('/' + file.replace(/\.ts$/, '').replace(/\/index$/, ''))
    .replace(/\[[^/]+\]/g, ':parameter');
}

function pathPattern(file) {
  const escaped = routeFileToPath(file).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('^' + escaped.replace(/:parameter/g, '[^/]+') + '$');
}

const LOCAL_ROUTE_PATTERNS = PRODUCTION_ROUTE_INVENTORY
  .filter((entry) => entry.local)
  .map((entry) => ({ entry, pattern: pathPattern(entry.file) }));

export function localRouteClassification(path, method) {
  const normalizedMethod = String(method || '').toUpperCase();
  const match = LOCAL_ROUTE_PATTERNS.find(({ entry, pattern }) => pattern.test(path) && entry.methods[normalizedMethod]);
  return match?.entry.methods?.[normalizedMethod] ?? null;
}
