import crypto from 'node:crypto';
import { getUpstashRedisClient } from './redis.js';
import { getRoomSnapshot, isValidPhaseTransition } from './pvpOnlineRooms.js';

const INVITE_PREFIX = 'sd:pvp:invite:';
const USER_INVITES_PREFIX = 'sd:pvp:user-invites:';
const ROOM_PREFIX = 'sd:pvp:room:';
const MEMBERSHIP_PREFIX = 'sd:pvp:room-membership:';
const INVITE_TTL_MS = 60_000; // 60 seconds

export type OnlineInvite = {
  inviteId: string;
  roomId: string;
  fromUserId: string;
  fromLoginId: string;
  toUserId: string;
  toLoginId: string;
  status: 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'CANCELED' | 'EXPIRED';
  createdAt: number;
  expiresAt: number;
  resolvedAt: number | null;
};

export type InviteMutationResult =
  | { ok: true; invite: OnlineInvite }
  | { ok: false; error: string };

function inviteKey(inviteId: string) {
  return INVITE_PREFIX + inviteId;
}

function userInvitesKey(userId: string) {
  return USER_INVITES_PREFIX + userId;
}

function roomKey(roomId: string) {
  return ROOM_PREFIX + roomId;
}

function membershipKey(userId: string) {
  return MEMBERSHIP_PREFIX + userId;
}

export async function getInviteSnapshot(inviteId: string): Promise<OnlineInvite | null> {
  const redis = getUpstashRedisClient(true);
  const raw = await redis.get<string>(inviteKey(inviteId));
  if (!raw) return null;
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

export async function getUserPendingInvites(userId: string): Promise<OnlineInvite[]> {
  const redis = getUpstashRedisClient(true);
  const inviteIds = await redis.smembers(userInvitesKey(userId));
  if (!inviteIds || inviteIds.length === 0) return [];

  const now = Date.now();
  const results: OnlineInvite[] = [];
  const stale: string[] = [];

  for (const id of inviteIds) {
    const raw = await redis.get<string>(inviteKey(id));
    if (!raw) {
      stale.push(id);
      continue;
    }
    try {
      const invite: OnlineInvite = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (invite.status === 'PENDING' && invite.expiresAt > now) {
        results.push(invite);
      } else {
        stale.push(id);
      }
    } catch {
      stale.push(id);
    }
  }

  if (stale.length > 0) {
    const rw = getUpstashRedisClient(false);
    for (const id of stale) {
      await rw.srem(userInvitesKey(userId), id);
    }
  }

  return results;
}

export async function sendInvite(
  fromUserId: string,
  fromLoginId: string,
  toUserId: string,
  toLoginId: string,
  roomId: string,
  expectedRoomVersion: number
): Promise<InviteMutationResult> {
  const redis = getUpstashRedisClient(false);

  // Load and validate room
  const roomRaw = await redis.get<string>(roomKey(roomId));
  if (!roomRaw) return { ok: false, error: 'ROOM_NOT_FOUND' };

  let room: Awaited<ReturnType<typeof getRoomSnapshot>>;
  try {
    room = typeof roomRaw === 'string' ? JSON.parse(roomRaw) : roomRaw;
  } catch {
    return { ok: false, error: 'ROOM_PARSE_ERROR' };
  }
  if (!room) return { ok: false, error: 'ROOM_NOT_FOUND' };

  if (room.version !== expectedRoomVersion) {
    return { ok: false, error: 'ROOM_VERSION_CONFLICT' };
  }

  if (room.ownerUserId !== fromUserId) {
    return { ok: false, error: 'NOT_HOST' };
  }

  if (!isValidPhaseTransition(room.phase, 'WAITING_FOR_INVITEE')) {
    return { ok: false, error: 'INVALID_PHASE_TRANSITION' };
  }

  if (room.slots.guest !== null) {
    return { ok: false, error: 'ROOM_FULL' };
  }

  const now = Date.now();
  const inviteId = 'inv_' + crypto.randomBytes(8).toString('hex');

  const invite: OnlineInvite = {
    inviteId,
    roomId,
    fromUserId,
    fromLoginId,
    toUserId,
    toLoginId,
    status: 'PENDING',
    createdAt: now,
    expiresAt: now + INVITE_TTL_MS,
    resolvedAt: null,
  };

  // Update room: set pendingInviteId, transition phase, increment version
  room.pendingInviteId = inviteId;
  room.phase = 'WAITING_FOR_INVITEE';
  room.updatedAt = now;
  room.version += 1;

  await redis.set(inviteKey(inviteId), JSON.stringify(invite));
  await redis.sadd(userInvitesKey(toUserId), inviteId);
  await redis.set(roomKey(roomId), JSON.stringify(room));

  return { ok: true, invite };
}

export async function acceptInvite(
  inviteId: string,
  callerUserId: string,
  callerLoginId: string,
  callerSkinId: string
): Promise<InviteMutationResult> {
  const redis = getUpstashRedisClient(false);

  // Load invite
  const inviteRaw = await redis.get<string>(inviteKey(inviteId));
  if (!inviteRaw) return { ok: false, error: 'INVITE_NOT_FOUND' };

  let invite: OnlineInvite;
  try {
    invite = typeof inviteRaw === 'string' ? JSON.parse(inviteRaw) : inviteRaw;
  } catch {
    return { ok: false, error: 'INVITE_PARSE_ERROR' };
  }

  if (invite.status !== 'PENDING') {
    return { ok: false, error: 'INVITE_NOT_PENDING' };
  }

  if (invite.toUserId !== callerUserId) {
    return { ok: false, error: 'NOT_INVITE_TARGET' };
  }

  const now = Date.now();
  if (invite.expiresAt <= now) {
    return { ok: false, error: 'INVITE_EXPIRED' };
  }

  // Load room
  const roomRaw = await redis.get<string>(roomKey(invite.roomId));
  if (!roomRaw) return { ok: false, error: 'ROOM_NOT_FOUND' };

  let room: Awaited<ReturnType<typeof getRoomSnapshot>>;
  try {
    room = typeof roomRaw === 'string' ? JSON.parse(roomRaw) : roomRaw;
  } catch {
    return { ok: false, error: 'ROOM_PARSE_ERROR' };
  }
  if (!room) return { ok: false, error: 'ROOM_NOT_FOUND' };

  if (room.slots.guest !== null) {
    return { ok: false, error: 'ROOM_FULL' };
  }

  if (!isValidPhaseTransition(room.phase, 'READY_CHECK')) {
    return { ok: false, error: 'INVALID_PHASE_TRANSITION' };
  }

  // Atomic: update invite, assign guest, transition room phase
  invite.status = 'ACCEPTED';
  invite.resolvedAt = now;

  room.slots.guest = {
    userId: callerUserId,
    loginId: callerLoginId,
    connected: true,
    ready: false,
    skinId: callerSkinId,
  };
  room.phase = 'READY_CHECK';
  room.pendingInviteId = null;
  room.updatedAt = now;
  room.version += 1;

  await redis.set(inviteKey(inviteId), JSON.stringify(invite));
  await redis.set(roomKey(invite.roomId), JSON.stringify(room));
  await redis.set(membershipKey(callerUserId), invite.roomId);
  await redis.srem(userInvitesKey(callerUserId), inviteId);

  return { ok: true, invite };
}

export async function declineInvite(
  inviteId: string,
  callerUserId: string
): Promise<InviteMutationResult> {
  const redis = getUpstashRedisClient(false);

  const inviteRaw = await redis.get<string>(inviteKey(inviteId));
  if (!inviteRaw) return { ok: false, error: 'INVITE_NOT_FOUND' };

  let invite: OnlineInvite;
  try {
    invite = typeof inviteRaw === 'string' ? JSON.parse(inviteRaw) : inviteRaw;
  } catch {
    return { ok: false, error: 'INVITE_PARSE_ERROR' };
  }

  if (invite.status !== 'PENDING') {
    return { ok: false, error: 'INVITE_NOT_PENDING' };
  }

  if (invite.toUserId !== callerUserId) {
    return { ok: false, error: 'NOT_INVITE_TARGET' };
  }

  const now = Date.now();
  invite.status = 'DECLINED';
  invite.resolvedAt = now;

  // Revert room phase to OPEN, clear pendingInviteId
  const roomRaw = await redis.get<string>(roomKey(invite.roomId));
  if (roomRaw) {
    try {
      const room = typeof roomRaw === 'string' ? JSON.parse(roomRaw) : roomRaw;
      if (room && room.phase === 'WAITING_FOR_INVITEE') {
        room.phase = 'OPEN';
        room.pendingInviteId = null;
        room.updatedAt = now;
        room.version += 1;
        await redis.set(roomKey(invite.roomId), JSON.stringify(room));
      }
    } catch {
      // best-effort room revert
    }
  }

  await redis.set(inviteKey(inviteId), JSON.stringify(invite));
  await redis.srem(userInvitesKey(callerUserId), inviteId);

  return { ok: true, invite };
}

export async function cancelInvite(
  inviteId: string,
  callerUserId: string
): Promise<InviteMutationResult> {
  const redis = getUpstashRedisClient(false);

  const inviteRaw = await redis.get<string>(inviteKey(inviteId));
  if (!inviteRaw) return { ok: false, error: 'INVITE_NOT_FOUND' };

  let invite: OnlineInvite;
  try {
    invite = typeof inviteRaw === 'string' ? JSON.parse(inviteRaw) : inviteRaw;
  } catch {
    return { ok: false, error: 'INVITE_PARSE_ERROR' };
  }

  if (invite.status !== 'PENDING') {
    return { ok: false, error: 'INVITE_NOT_PENDING' };
  }

  if (invite.fromUserId !== callerUserId) {
    return { ok: false, error: 'NOT_INVITE_SENDER' };
  }

  const now = Date.now();
  invite.status = 'CANCELED';
  invite.resolvedAt = now;

  // Revert room phase to OPEN, clear pendingInviteId
  const roomRaw = await redis.get<string>(roomKey(invite.roomId));
  if (roomRaw) {
    try {
      const room = typeof roomRaw === 'string' ? JSON.parse(roomRaw) : roomRaw;
      if (room && room.phase === 'WAITING_FOR_INVITEE') {
        room.phase = 'OPEN';
        room.pendingInviteId = null;
        room.updatedAt = now;
        room.version += 1;
        await redis.set(roomKey(invite.roomId), JSON.stringify(room));
      }
    } catch {
      // best-effort room revert
    }
  }

  await redis.set(inviteKey(inviteId), JSON.stringify(invite));
  await redis.srem(userInvitesKey(invite.toUserId), inviteId);

  return { ok: true, invite };
}
