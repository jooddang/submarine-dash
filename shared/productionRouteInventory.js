import { createHash } from 'node:crypto';

export const ROUTE_CLASS = Object.freeze({
  READ_ONLY: 'read-only',
  DURABLE_MUTATION: 'durable-mutation',
  EPHEMERAL_MUTATION: 'ephemeral-mutation',
  GET_SIDE_EFFECT: 'get-with-side-effect',
});

const route = (file, methods, keyFamilies) => ({ file, methods, keyFamilies });

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
  route('api/health.ts', { GET: ROUTE_CLASS.READ_ONLY }, []),
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

export const ROUTE_INVENTORY_VERSION = 1;
export const ROUTE_INVENTORY_DIGEST = createHash('sha256')
  .update(JSON.stringify(PRODUCTION_ROUTE_INVENTORY))
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

const LOCAL_ROUTE_PATTERNS = PRODUCTION_ROUTE_INVENTORY.map((entry) => ({ entry, pattern: pathPattern(entry.file) }));

export function localRouteClassification(path, method) {
  const normalizedMethod = String(method || '').toUpperCase();
  const match = LOCAL_ROUTE_PATTERNS.find(({ entry, pattern }) => pattern.test(path) && entry.methods[normalizedMethod]);
  return match?.entry.methods?.[normalizedMethod] ?? null;
}
