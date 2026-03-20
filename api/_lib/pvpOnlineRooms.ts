import crypto from 'node:crypto';
import { getUpstashRedisClient } from './redis.js';

const ROOM_PREFIX = 'sd:pvp:room:';
const MEMBERSHIP_PREFIX = 'sd:pvp:room-membership:';
const ROOM_INDEX_KEY = 'sd:pvp:rooms:all';

export type OnlineRoom = {
  roomId: string;
  ownerUserId: string;
  phase: string;
  version: number;
  config: {
    format: string;
    powerUpMode: string;
    betting: boolean;
    p1Bet: { coins: number; dolphins: number; tubePieces: number };
    p2Bet: { coins: number; dolphins: number; tubePieces: number };
  };
  slots: {
    host: { userId: string; loginId: string; connected: boolean; ready: boolean; skinId: string };
    guest: { userId: string; loginId: string; connected: boolean; ready: boolean; skinId: string } | null;
  };
  pendingInviteId: string | null;
  matchId: string | null;
  escrow: { status: string; escrowId?: string };
  createdAt: number;
  updatedAt: number;
};

export type RoomMutationResult =
  | { ok: true; room: OnlineRoom }
  | { ok: false; error: string };

export type RoomConfigInput = OnlineRoom['config'];

const DEFAULT_ROOM_CONFIG: RoomConfigInput = {
  format: 'single',
  powerUpMode: 'earned',
  betting: false,
  p1Bet: { coins: 0, dolphins: 0, tubePieces: 0 },
  p2Bet: { coins: 0, dolphins: 0, tubePieces: 0 },
};

// Valid phase transitions
const VALID_TRANSITIONS: Record<string, string[]> = {
  OPEN: ['WAITING_FOR_INVITEE', 'CANCELED'],
  WAITING_FOR_INVITEE: ['OPEN', 'READY_CHECK', 'CANCELED'],
  READY_CHECK: ['OPEN', 'LOCKED', 'IN_MATCH', 'CANCELED'],
};

export function isValidPhaseTransition(from: string, to: string): boolean {
  return (VALID_TRANSITIONS[from] ?? []).includes(to);
}

function roomKey(roomId: string) {
  return ROOM_PREFIX + roomId;
}

function membershipKey(userId: string) {
  return MEMBERSHIP_PREFIX + userId;
}

function normalizeRoomConfig(config: unknown): RoomConfigInput {
  const input = (config && typeof config === 'object') ? config as Partial<RoomConfigInput> : {};
  const format = input.format === 'bo3' || input.format === 'bo5' || input.format === 'single'
    ? input.format
    : DEFAULT_ROOM_CONFIG.format;
  const powerUpMode =
    input.powerUpMode === 'inventory' ||
    input.powerUpMode === 'earned' ||
    input.powerUpMode === 'none' ||
    input.powerUpMode === 'score_attack'
      ? input.powerUpMode
      : DEFAULT_ROOM_CONFIG.powerUpMode;
  const sanitizeBet = (bet: unknown) => {
    const raw = (bet && typeof bet === 'object') ? bet as Partial<RoomConfigInput['p1Bet']> : {};
    return {
      coins: Math.max(0, Math.floor(raw.coins ?? 0)),
      dolphins: Math.max(0, Math.floor(raw.dolphins ?? 0)),
      tubePieces: Math.max(0, Math.floor(raw.tubePieces ?? 0)),
    };
  };

  return {
    format,
    powerUpMode,
    betting: Boolean(input.betting),
    p1Bet: sanitizeBet(input.p1Bet),
    p2Bet: sanitizeBet(input.p2Bet),
  };
}

export async function getRoomSnapshot(roomId: string): Promise<OnlineRoom | null> {
  const redis = getUpstashRedisClient(true);
  const raw = await redis.get<string>(roomKey(roomId));
  if (!raw) return null;
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

export async function getUserRoomMembership(userId: string): Promise<string | null> {
  const redis = getUpstashRedisClient(true);
  const roomId = await redis.get<string>(membershipKey(userId));
  if (!roomId) return null;

  const room = await getRoomSnapshot(roomId);
  if (room && room.phase !== 'CANCELED' && room.phase !== 'COMPLETED') {
    return roomId;
  }

  const rw = getUpstashRedisClient(false);
  await rw.del(membershipKey(userId));
  return null;
}

export async function createRoom(
  hostUserId: string,
  hostLoginId: string,
  hostSkinId: string,
  config?: unknown
): Promise<RoomMutationResult> {
  const redis = getUpstashRedisClient(false);

  // Reject if user is already in a room
  const existing = await getUserRoomMembership(hostUserId);
  if (existing) {
    return { ok: false, error: 'ALREADY_IN_ROOM' };
  }

  const roomId = 'room_' + crypto.randomBytes(8).toString('hex');
  const now = Date.now();

  const room: OnlineRoom = {
    roomId,
    ownerUserId: hostUserId,
    phase: 'OPEN',
    version: 1,
    config: normalizeRoomConfig(config),
    slots: {
      host: { userId: hostUserId, loginId: hostLoginId, connected: true, ready: false, skinId: hostSkinId },
      guest: null,
    },
    pendingInviteId: null,
    matchId: null,
    escrow: { status: 'NONE' },
    createdAt: now,
    updatedAt: now,
  };

  await redis.set(roomKey(roomId), JSON.stringify(room));
  await redis.set(membershipKey(hostUserId), roomId);
  await redis.sadd(ROOM_INDEX_KEY, roomId);

  return { ok: true, room };
}

export async function listJoinableRooms(): Promise<OnlineRoom[]> {
  const redis = getUpstashRedisClient(true);
  const roomIds = await redis.smembers(ROOM_INDEX_KEY);
  if (!roomIds || roomIds.length === 0) return [];

  const results: OnlineRoom[] = [];
  const stale: string[] = [];

  for (const roomId of roomIds) {
    const room = await getRoomSnapshot(roomId);
    if (!room) {
      stale.push(roomId);
      continue;
    }
    if (room.phase === 'OPEN' && room.slots.guest === null) {
      results.push(room);
      continue;
    }
    if (room.phase === 'CANCELED' || room.phase === 'COMPLETED') {
      stale.push(roomId);
    }
  }

  if (stale.length > 0) {
    const rw = getUpstashRedisClient(false);
    for (const roomId of stale) {
      await rw.srem(ROOM_INDEX_KEY, roomId);
    }
  }

  results.sort((a, b) => b.createdAt - a.createdAt);
  return results;
}

export async function joinRoom(
  userId: string,
  loginId: string,
  skinId: string,
  roomId: string,
): Promise<RoomMutationResult> {
  const redis = getUpstashRedisClient(false);

  const existing = await getUserRoomMembership(userId);
  if (existing) return { ok: false, error: 'ALREADY_IN_ROOM' };

  const raw = await redis.get<string>(roomKey(roomId));
  if (!raw) return { ok: false, error: 'ROOM_NOT_FOUND' };

  let room: OnlineRoom;
  try {
    room = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return { ok: false, error: 'ROOM_PARSE_ERROR' };
  }

  if (room.phase !== 'OPEN') return { ok: false, error: 'INVALID_PHASE' };
  if (room.slots.guest !== null) return { ok: false, error: 'ROOM_FULL' };
  if (room.ownerUserId === userId) return { ok: false, error: 'ALREADY_HOST' };

  room.slots.guest = { userId, loginId, connected: true, ready: false, skinId };
  room.phase = 'READY_CHECK';
  room.pendingInviteId = null;
  room.updatedAt = Date.now();
  room.version += 1;

  await redis.set(roomKey(roomId), JSON.stringify(room));
  await redis.set(membershipKey(userId), roomId);
  return { ok: true, room };
}

export async function updateRoomConfig(
  userId: string,
  roomId: string,
  config: unknown,
  expectedVersion: number
): Promise<RoomMutationResult> {
  const redis = getUpstashRedisClient(false);

  const raw = await redis.get<string>(roomKey(roomId));
  if (!raw) return { ok: false, error: 'ROOM_NOT_FOUND' };

  let room: OnlineRoom;
  try {
    room = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return { ok: false, error: 'ROOM_PARSE_ERROR' };
  }

  if (room.version !== expectedVersion) {
    return { ok: false, error: 'ROOM_VERSION_CONFLICT' };
  }

  if (room.ownerUserId !== userId) {
    return { ok: false, error: 'NOT_HOST' };
  }

  if (room.phase !== 'OPEN' && room.phase !== 'READY_CHECK' && room.phase !== 'WAITING_FOR_INVITEE') {
    return { ok: false, error: 'INVALID_PHASE' };
  }

  room.config = normalizeRoomConfig(config);
  room.slots.host.ready = false;
  if (room.slots.guest) {
    room.slots.guest.ready = false;
  }
  room.updatedAt = Date.now();
  room.version += 1;

  await redis.set(roomKey(roomId), JSON.stringify(room));
  return { ok: true, room };
}

export async function leaveRoom(userId: string, roomId: string): Promise<RoomMutationResult> {
  const redis = getUpstashRedisClient(false);

  const raw = await redis.get<string>(roomKey(roomId));
  if (!raw) return { ok: false, error: 'ROOM_NOT_FOUND' };

  let room: OnlineRoom;
  try {
    room = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return { ok: false, error: 'ROOM_PARSE_ERROR' };
  }

  const isHost = room.slots.host.userId === userId;
  const isGuest = room.slots.guest?.userId === userId;

  if (!isHost && !isGuest) {
    return { ok: false, error: 'NOT_IN_ROOM' };
  }

  const now = Date.now();

  room.phase = 'CANCELED';
  room.updatedAt = now;
  room.version += 1;
  await redis.set(roomKey(roomId), JSON.stringify(room));
  await redis.del(membershipKey(room.slots.host.userId));
  if (room.slots.guest) {
    await redis.del(membershipKey(room.slots.guest.userId));
  }
  await redis.srem(ROOM_INDEX_KEY, roomId);

  return { ok: true, room };
}

export async function setReadyState(
  userId: string,
  roomId: string,
  ready: boolean,
  expectedVersion: number
): Promise<RoomMutationResult> {
  const redis = getUpstashRedisClient(false);

  const raw = await redis.get<string>(roomKey(roomId));
  if (!raw) return { ok: false, error: 'ROOM_NOT_FOUND' };

  let room: OnlineRoom;
  try {
    room = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return { ok: false, error: 'ROOM_PARSE_ERROR' };
  }

  if (room.version !== expectedVersion) {
    return { ok: false, error: 'ROOM_VERSION_CONFLICT' };
  }

  if (room.phase !== 'READY_CHECK') {
    return { ok: false, error: 'INVALID_PHASE' };
  }

  const isHost = room.slots.host.userId === userId;
  const isGuest = room.slots.guest?.userId === userId;

  if (!isHost && !isGuest) {
    return { ok: false, error: 'NOT_IN_ROOM' };
  }

  if (isHost) {
    room.slots.host.ready = ready;
  } else if (isGuest && room.slots.guest) {
    room.slots.guest.ready = ready;
  }

  // Alpha start path: once both players are ready, transition directly into match.
  if (room.slots.host.ready && room.slots.guest?.ready) {
    room.phase = 'IN_MATCH';
    room.matchId = room.matchId || `match_${crypto.randomBytes(8).toString('hex')}`;
    const now = Date.now();
    await redis.set(`sd:pvp:match:${room.matchId}`, JSON.stringify({
      matchId: room.matchId,
      roomId,
      phase: 'COUNTDOWN',
      createdAt: now,
      updatedAt: now,
      seed: Math.floor(Math.random() * 2147483647),
      countdownStartedAt: now,
      config: room.config,
      players: {
        host: room.slots.host,
        guest: room.slots.guest,
      },
      inputs: { host: [], guest: [] },
      snapshot: null,
      winnerSlot: null,
      completedAt: null,
      series: {
        roundsPlayed: 0,
        p1Wins: 0,
        p2Wins: 0,
        roundsNeeded: room.config.format === 'bo5' ? 3 : room.config.format === 'bo3' ? 2 : 1,
        currentRound: 1,
        roundResults: [],
      },
    }));
  }

  room.updatedAt = Date.now();
  room.version += 1;

  await redis.set(roomKey(roomId), JSON.stringify(room));

  return { ok: true, room };
}

export async function updateRoomSkin(
  userId: string,
  roomId: string,
  skinId: string,
  expectedVersion: number
): Promise<RoomMutationResult> {
  const redis = getUpstashRedisClient(false);

  const raw = await redis.get<string>(roomKey(roomId));
  if (!raw) return { ok: false, error: 'ROOM_NOT_FOUND' };

  let room: OnlineRoom;
  try {
    room = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return { ok: false, error: 'ROOM_PARSE_ERROR' };
  }

  if (room.version !== expectedVersion) {
    return { ok: false, error: 'ROOM_VERSION_CONFLICT' };
  }

  if (room.phase !== 'OPEN' && room.phase !== 'READY_CHECK' && room.phase !== 'WAITING_FOR_INVITEE') {
    return { ok: false, error: 'INVALID_PHASE' };
  }

  const isHost = room.slots.host.userId === userId;
  const isGuest = room.slots.guest?.userId === userId;
  if (!isHost && !isGuest) return { ok: false, error: 'NOT_IN_ROOM' };

  if (isHost) {
    room.slots.host.skinId = skinId;
  } else if (isGuest && room.slots.guest) {
    room.slots.guest.skinId = skinId;
  }

  room.updatedAt = Date.now();
  room.version += 1;

  await redis.set(roomKey(roomId), JSON.stringify(room));
  return { ok: true, room };
}

export async function cancelRoom(
  userId: string,
  roomId: string,
  expectedVersion: number
): Promise<RoomMutationResult> {
  const redis = getUpstashRedisClient(false);

  const raw = await redis.get<string>(roomKey(roomId));
  if (!raw) return { ok: false, error: 'ROOM_NOT_FOUND' };

  let room: OnlineRoom;
  try {
    room = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return { ok: false, error: 'ROOM_PARSE_ERROR' };
  }

  if (room.version !== expectedVersion) {
    return { ok: false, error: 'ROOM_VERSION_CONFLICT' };
  }

  if (room.ownerUserId !== userId) {
    return { ok: false, error: 'NOT_HOST' };
  }

  if (!isValidPhaseTransition(room.phase, 'CANCELED')) {
    return { ok: false, error: 'INVALID_PHASE_TRANSITION' };
  }

  room.phase = 'CANCELED';
  room.updatedAt = Date.now();
  room.version += 1;

  await redis.set(roomKey(roomId), JSON.stringify(room));
  await redis.del(membershipKey(room.slots.host.userId));
  if (room.slots.guest) {
    await redis.del(membershipKey(room.slots.guest.userId));
  }
  await redis.srem(ROOM_INDEX_KEY, roomId);

  return { ok: true, room };
}
