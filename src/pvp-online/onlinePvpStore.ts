import type { PvpPresenceUser, OnlineRoom, PvpInvite } from './onlinePvpTypes';

export type OnlinePvpState = {
  connectionStatus: 'disconnected' | 'connecting' | 'connected';
  currentUser: { userId: string; loginId: string } | null;
  lobbyUsers: PvpPresenceUser[];
  currentRoom: OnlineRoom | null;
  pendingInvites: PvpInvite[];
  inboxUnreadCount: number;
  error: string | null;
};

export const initialOnlinePvpState: OnlinePvpState = {
  connectionStatus: 'disconnected',
  currentUser: null,
  lobbyUsers: [],
  currentRoom: null,
  pendingInvites: [],
  inboxUnreadCount: 0,
  error: null,
};
