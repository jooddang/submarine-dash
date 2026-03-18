// All TypeScript types for online PvP client-side state.
import type { PvpRoundResult, PvpPlayerState } from "../pvp/pvpTypes";

export type PresenceStatus = "OFFLINE" | "ONLINE" | "IN_PVP_LOBBY" | "IN_ROOM" | "IN_MATCH";

export type PvpPresenceUser = {
  userId: string;
  loginId: string;
  status: PresenceStatus;
  enteredLobbyAt: number | null;
};

export type InviteStatus = "PENDING" | "ACCEPTED" | "DECLINED" | "EXPIRED" | "CANCELED";

export type PvpInvite = {
  inviteId: string;
  fromUserId: string;
  fromLoginId: string;
  toUserId: string;
  toLoginId: string;
  roomId: string;
  createdAt: number;
  expiresAt: number;
  status: InviteStatus;
};

export type RoomPhase =
  | "OPEN" | "WAITING_FOR_INVITEE" | "READY_CHECK" | "LOCKED"
  | "COUNTDOWN" | "IN_MATCH" | "CANCELED" | "COMPLETED";

export type RoomSlot = {
  userId: string;
  loginId: string;
  connected: boolean;
  ready: boolean;
  skinId: string;
};

export type RoomConfig = {
  format: "single" | "bo3" | "bo5";
  powerUpMode: "inventory" | "earned" | "none" | "score_attack";
  betting: boolean;
  p1Bet: { coins: number; dolphins: number; tubePieces: number };
  p2Bet: { coins: number; dolphins: number; tubePieces: number };
};

export type OnlineRoom = {
  roomId: string;
  ownerUserId: string;
  phase: RoomPhase;
  version: number;
  config: RoomConfig;
  slots: {
    host: RoomSlot;
    guest: RoomSlot | null;
  };
  pendingInviteId: string | null;
  matchId: string | null;
  escrow: { status: string; escrowId?: string };
};

export type MatchPhase = "INIT" | "COUNTDOWN" | "PLAYING" | "ROUND_RESULT" | "MATCH_RESULT" | "ABORTED";

export type OnlineMatch = {
  matchId: string;
  roomId: string;
  phase: MatchPhase;
  createdAt: number;
  updatedAt?: number;
  seed?: number;
  countdownStartedAt?: number;
  config: RoomConfig;
  players: {
    host: RoomSlot;
    guest: RoomSlot | null;
  };
  series?: {
    roundsPlayed: number;
    p1Wins: number;
    p2Wins: number;
    roundsNeeded: number;
    currentRound: number;
    roundResults: PvpRoundResult[];
  };
  snapshot?: {
    tick: number;
    phase: MatchPhase;
    countdownValue: number;
    p1: Omit<PvpPlayerState, "rng">;
    p2: Omit<PvpPlayerState, "rng">;
    roundResult: PvpRoundResult | null;
  } | null;
  inputs?: {
    host: Array<{ seq: number; action: "down" | "up"; at: number }>;
    guest: Array<{ seq: number; action: "down" | "up"; at: number }>;
  };
  winnerSlot?: 1 | 2 | null;
  completedAt?: number | null;
};

export type WsEnvelope<T = unknown> = {
  event: string;
  requestId?: string;
  ts: number;
  payload: T;
};

export type InboxItem = {
  inboxId: string;
  type: string;
  createdAt: number;
  readAt: number | null;
  actorUserId: string;
  actorLoginId: string;
  roomId: string | null;
  matchId: string | null;
  payload: Record<string, unknown>;
};

export type OnlinePvpBootstrap = {
  user: { userId: string; loginId: string; refCode: string };
  inventory: {
    coins: number;
    dolphinSaved: number;
    tube: { pieces: number; charges: number };
    skins: { owned: string[]; equipped: string };
  };
  inboxUnreadCount: number;
  activeRoomSummary: OnlineRoom | null;
};
