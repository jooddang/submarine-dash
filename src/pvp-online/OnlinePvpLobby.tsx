import React, { useEffect, useState, useRef, useCallback } from "react";
import type { OnlinePvpBootstrap, PvpPresenceUser, PvpInvite } from "./onlinePvpTypes";
import { onlinePvpAPI } from "../api";

const POLL_INTERVAL_MS = 3000;
const HEARTBEAT_INTERVAL_MS = 10000;

interface OnlinePvpLobbyProps {
  onBack: () => void;
  onCreateRoom: () => void;
  onJoinRoom: (roomId: string) => void;
}

export const OnlinePvpLobby: React.FC<OnlinePvpLobbyProps> = ({ onBack, onCreateRoom, onJoinRoom }) => {
  const [bootstrap, setBootstrap] = useState<OnlinePvpBootstrap | null>(null);
  const [lobbyUsers, setLobbyUsers] = useState<PvpPresenceUser[]>([]);
  const [openRooms, setOpenRooms] = useState<import('./onlinePvpTypes').OnlineRoom[]>([]);
  const [pendingInvites, setPendingInvites] = useState<PvpInvite[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [invitingUserId, setInvitingUserId] = useState<string | null>(null);
  const [joiningRoomId, setJoiningRoomId] = useState<string | null>(null);
  const [joinStatus, setJoinStatus] = useState<string | null>(null);
  const [activeRoomId, setActiveRoomId] = useState<string | null>(null);
  const enteredRef = useRef(false);

  // Register presence on mount, leave on unmount
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const data = await onlinePvpAPI.bootstrap();
        if (cancelled) return;
        setBootstrap(data);
        if (data.activeRoomSummary?.roomId) {
          onJoinRoom(data.activeRoomSummary.roomId);
          return;
        }
        // Only hosts should get invite-capable active room state from the lobby surface.
        if (
          data.activeRoomSummary &&
          data.activeRoomSummary.ownerUserId === data.user.userId &&
          (data.activeRoomSummary.phase === 'OPEN' || data.activeRoomSummary.phase === 'WAITING_FOR_INVITEE' || data.activeRoomSummary.phase === 'READY_CHECK')
        ) {
          setActiveRoomId(data.activeRoomSummary.roomId);
        } else {
          setActiveRoomId(null);
        }
        setLoading(false);

        await onlinePvpAPI.enterLobby();
        if (cancelled) return;
        enteredRef.current = true;

        const [lobby, inviteRes, openRoomRes] = await Promise.all([
          onlinePvpAPI.getLobby(),
          onlinePvpAPI.getPendingInvites(),
          onlinePvpAPI.getOpenRooms(),
        ]);
        if (!cancelled) {
          setLobbyUsers(lobby.users);
          setPendingInvites(inviteRes.invites);
          setOpenRooms(openRoomRes.rooms.filter(room => room.ownerUserId !== data.user.userId));
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load');
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      if (enteredRef.current) {
        onlinePvpAPI.leaveLobby().catch(() => undefined);
        enteredRef.current = false;
      }
    };
  }, [onJoinRoom]);

  // Poll lobby users and pending invites
  useEffect(() => {
    if (loading || error) return;
    const interval = setInterval(async () => {
      try {
        const [lobby, inviteRes, openRoomRes] = await Promise.all([
          onlinePvpAPI.getLobby(),
          onlinePvpAPI.getPendingInvites(),
          onlinePvpAPI.getOpenRooms(),
        ]);
        setLobbyUsers(lobby.users);
        setPendingInvites(inviteRes.invites);
        setOpenRooms(openRoomRes.rooms.filter(room => room.ownerUserId !== bootstrap?.user.userId));
      } catch {
        // silently ignore poll failures
      }
    }, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [loading, error]);

  // Heartbeat to keep presence alive
  useEffect(() => {
    if (!enteredRef.current) return;
    const interval = setInterval(() => {
      onlinePvpAPI.enterLobby().catch(() => undefined);
    }, HEARTBEAT_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [loading]);

  const handleBack = useCallback(() => {
    if (enteredRef.current) {
      onlinePvpAPI.leaveLobby().catch(() => undefined);
      enteredRef.current = false;
    }
    onBack();
  }, [onBack]);

  const handleInviteUser = useCallback(async (targetUserId: string, targetLoginId: string) => {
    if (!activeRoomId) return;
    setInvitingUserId(targetUserId);
    try {
      // Need room version — fetch room first
      const roomRes = await onlinePvpAPI.getRoom(activeRoomId) as { room: { version: number; ownerUserId?: string; phase?: string } };
      if (roomRes.room.ownerUserId !== bootstrap?.user.userId || (roomRes.room.phase !== 'OPEN' && roomRes.room.phase !== 'WAITING_FOR_INVITEE')) {
        setActiveRoomId(null);
        return;
      }
      await onlinePvpAPI.sendInvite(activeRoomId, roomRes.room.version, targetUserId, targetLoginId);
    } catch {
      setActiveRoomId(null);
    } finally {
      setInvitingUserId(null);
    }
  }, [activeRoomId, bootstrap?.user.userId]);

  const handleAcceptInvite = useCallback(async (invite: PvpInvite) => {
    try {
      const res = await onlinePvpAPI.acceptInvite(invite.inviteId);
      setPendingInvites(prev => prev.filter(i => i.inviteId !== invite.inviteId));
      onJoinRoom(res.room.roomId);
    } catch {
      // best effort
    }
  }, [onJoinRoom]);

  const handleDeclineInvite = useCallback(async (invite: PvpInvite) => {
    try {
      await onlinePvpAPI.declineInvite(invite.inviteId);
      setPendingInvites(prev => prev.filter(i => i.inviteId !== invite.inviteId));
    } catch {
      // best effort
    }
  }, []);

  const handleJoinOpenRoom = useCallback(async (roomId: string) => {
    if (!bootstrap) return;
    setJoinStatus(null);
    setJoiningRoomId(roomId);
    try {
      const res = await onlinePvpAPI.joinRoom(roomId, bootstrap.inventory.skins.equipped);
      onJoinRoom(res.room.roomId);
    } catch (err) {
      setJoinStatus(err instanceof Error ? err.message : 'Failed to join room');
    } finally {
      setJoiningRoomId(null);
    }
  }, [bootstrap, onJoinRoom]);

  const containerStyle: React.CSSProperties = {
    width: "100%", height: "100%", position: "relative",
    background: "linear-gradient(180deg, #000a1a 0%, #001428 40%, #002040 100%)",
    display: "flex", flexDirection: "column", alignItems: "center",
    fontFamily: "monospace", color: "white", overflow: "auto",
  };

  const btnStyle: React.CSSProperties = {
    padding: "14px 36px", fontSize: "1.1rem", fontWeight: 800,
    fontFamily: "monospace", background: "rgba(0, 180, 255, 0.25)",
    border: "2px solid rgba(0, 180, 255, 0.6)", borderRadius: 12,
    color: "white", cursor: "pointer", marginTop: 12,
  };

  const cardStyle: React.CSSProperties = {
    marginTop: 16, width: "90%", maxWidth: 500,
    background: "rgba(0, 50, 100, 0.2)", border: "1px solid rgba(0, 150, 255, 0.2)",
    borderRadius: 12, padding: "16px 20px",
  };

  const displayedOpenRooms = openRooms.filter(room => room.ownerUserId !== bootstrap?.user.userId);

  if (loading) {
    return (
      <div style={containerStyle}>
        <div style={{ marginTop: "30vh", fontSize: "1.2rem", opacity: 0.6 }}>Loading...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div style={containerStyle}>
        <div style={{ marginTop: "30vh", fontSize: "1rem", color: "#ff6666" }}>{error}</div>
        <button style={btnStyle} onClick={handleBack}>BACK</button>
      </div>
    );
  }

  return (
    <div style={containerStyle}>
      {/* Title */}
      <div style={{
        marginTop: "max(20px, 5vh)", fontSize: "clamp(28px, 6vw, 48px)",
        fontWeight: 900, color: "#00ccff",
        textShadow: "0 0 20px rgba(0, 204, 255, 0.4)",
      }}>
        ONLINE PVP
      </div>

      {/* User info bar */}
      {bootstrap && (
        <div style={{
          marginTop: 16, display: "flex", gap: 20, fontSize: "0.85rem",
          color: "#aaa", flexWrap: "wrap", justifyContent: "center",
        }}>
          <span>{bootstrap.user.loginId}</span>
          <span style={{ color: "#ffcc00" }}>{bootstrap.inventory.coins} coins</span>
          <span style={{ color: "#00bbff" }}>{bootstrap.inventory.dolphinSaved} dolphins</span>
          {bootstrap.inboxUnreadCount > 0 && (
            <span style={{ color: "#ff8844" }}>{bootstrap.inboxUnreadCount} unread</span>
          )}
        </div>
      )}

      {/* Pending invites banner */}
      {pendingInvites.length > 0 && (
        <div style={{
          ...cardStyle,
          border: "1px solid rgba(255, 200, 0, 0.4)",
          background: "rgba(80, 60, 0, 0.3)",
        }}>
          <div style={{ fontSize: "0.9rem", fontWeight: 700, color: "#ffcc00", marginBottom: 10 }}>
            PENDING INVITES ({pendingInvites.length})
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {pendingInvites.map(invite => (
              <div key={invite.inviteId} style={{
                display: "flex", justifyContent: "space-between", alignItems: "center",
                padding: "8px 12px", background: "rgba(80, 60, 0, 0.3)", borderRadius: 8,
              }}>
                <span style={{ fontSize: "0.85rem" }}>
                  From <strong>{invite.fromLoginId}</strong>
                </span>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    style={{
                      padding: "6px 14px", fontSize: "0.8rem", fontWeight: 700,
                      fontFamily: "monospace", background: "rgba(0, 200, 100, 0.3)",
                      border: "1px solid rgba(0, 200, 100, 0.5)", borderRadius: 8,
                      color: "white", cursor: "pointer",
                    }}
                    onClick={() => handleAcceptInvite(invite)}
                  >
                    ACCEPT
                  </button>
                  <button
                    style={{
                      padding: "6px 14px", fontSize: "0.8rem", fontWeight: 700,
                      fontFamily: "monospace", background: "rgba(200, 50, 50, 0.2)",
                      border: "1px solid rgba(200, 50, 50, 0.4)", borderRadius: 8,
                      color: "white", cursor: "pointer",
                    }}
                    onClick={() => handleDeclineInvite(invite)}
                  >
                    DECLINE
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Players Online */}
      <div style={cardStyle}>
        <div style={{ fontSize: "0.9rem", fontWeight: 700, color: "#4facfe", marginBottom: 12 }}>
          PLAYERS IN LOBBY ({lobbyUsers.length})
        </div>
        {lobbyUsers.length === 0 ? (
          <div style={{ fontSize: "0.8rem", color: "#666", textAlign: "center", padding: "20px 0" }}>
            No players online right now
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {lobbyUsers.slice(0, 20).map(u => (
              <div key={u.userId} style={{
                display: "flex", justifyContent: "space-between", alignItems: "center",
                padding: "8px 12px", background: "rgba(0, 80, 160, 0.15)", borderRadius: 8,
              }}>
                <span style={{ fontSize: "0.85rem" }}>{u.loginId}</span>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <span style={{ fontSize: "0.7rem", color: "#4facfe" }}>
                    {u.status === "IN_PVP_LOBBY" ? "In Lobby" : u.status}
                  </span>
                  {activeRoomId && u.userId !== bootstrap?.user.userId && u.status === "IN_PVP_LOBBY" && (
                    <button
                      disabled={invitingUserId === u.userId}
                      onClick={() => handleInviteUser(u.userId, u.loginId)}
                      style={{
                        padding: "4px 10px", fontSize: "0.7rem", fontWeight: 700,
                        fontFamily: "monospace", background: "rgba(0, 150, 255, 0.2)",
                        border: "1px solid rgba(0, 150, 255, 0.4)", borderRadius: 6,
                        color: "white", cursor: invitingUserId === u.userId ? "default" : "pointer",
                        opacity: invitingUserId === u.userId ? 0.5 : 1,
                      }}
                    >
                      {invitingUserId === u.userId ? '...' : 'INVITE'}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={cardStyle}>
        <div style={{ fontSize: "0.9rem", fontWeight: 700, color: "#4facfe", marginBottom: 12 }}>
          OPEN ROOMS ({displayedOpenRooms.length})
        </div>
        {displayedOpenRooms.length === 0 ? (
          <div style={{ fontSize: "0.8rem", color: "#666", textAlign: "center", padding: "20px 0" }}>
            No open rooms right now
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {displayedOpenRooms.slice(0, 20).map(room => (
              <div key={room.roomId} style={{
                display: "flex", justifyContent: "space-between", alignItems: "center",
                padding: "10px 12px", background: "rgba(0, 80, 160, 0.15)", borderRadius: 8,
              }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span style={{ fontSize: "0.85rem" }}>{room.slots.host.loginId}</span>
                  <span style={{ fontSize: "0.7rem", color: "#7fbfff" }}>
                    {room.config.format} · {room.config.powerUpMode}
                  </span>
                </div>
                <button
                  disabled={Boolean(bootstrap?.activeRoomSummary?.roomId) || joiningRoomId === room.roomId}
                  onClick={() => handleJoinOpenRoom(room.roomId)}
                  style={{
                    padding: "6px 14px", fontSize: "0.75rem", fontWeight: 700,
                    fontFamily: "monospace", background: "rgba(0, 150, 255, 0.2)",
                    border: "1px solid rgba(0, 150, 255, 0.4)", borderRadius: 6,
                    color: "white", cursor: joiningRoomId === room.roomId ? "default" : "pointer",
                    opacity: (bootstrap?.activeRoomSummary?.roomId || joiningRoomId === room.roomId) ? 0.5 : 1,
                  }}
                >
                  {joiningRoomId === room.roomId ? 'JOINING...' : 'JOIN'}
                </button>
              </div>
            ))}
          </div>
        )}
        {joinStatus && (
          <div style={{ marginTop: 10, fontSize: "0.75rem", color: "#ff8888" }}>
            {joinStatus}
          </div>
        )}
      </div>

      {/* Actions */}
      <button
        style={{ ...btnStyle, fontSize: "1.2rem", padding: "16px 48px" }}
        onClick={onCreateRoom}
      >
        CREATE ROOM
      </button>

      <button
        style={{ ...btnStyle, background: "rgba(100, 100, 100, 0.2)", border: "2px solid rgba(100, 100, 100, 0.4)" }}
        onClick={handleBack}
      >
        BACK
      </button>

      {/* Bottom spacer */}
      <div style={{ height: 40 }} />
    </div>
  );
};
