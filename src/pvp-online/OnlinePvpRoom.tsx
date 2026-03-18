import React, { useEffect, useState, useRef, useCallback } from 'react';
import type { OnlineRoom, RoomConfig } from './onlinePvpTypes';
import { onlinePvpAPI } from '../api';

const POLL_INTERVAL_MS = 3000;

interface Props {
  roomId: string | null;
  onBackToLobby: () => void;
  onRoomResolved: (roomId: string) => void;
  onMatchStart: (roomId: string, matchId: string) => void;
}

const DEFAULT_CONFIG: RoomConfig = {
  format: 'single',
  powerUpMode: 'earned',
  betting: false,
  p1Bet: { coins: 0, dolphins: 0, tubePieces: 0 },
  p2Bet: { coins: 0, dolphins: 0, tubePieces: 0 },
};

export const OnlinePvpRoom: React.FC<Props> = ({ roomId, onBackToLobby, onRoomResolved, onMatchStart }) => {
  const [room, setRoom] = useState<OnlineRoom | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [myUserId, setMyUserId] = useState<string | null>(null);
  const [inviteTarget, setInviteTarget] = useState('');
  const [inviteStatus, setInviteStatus] = useState<string | null>(null);
  const currentRoomIdRef = useRef<string | null>(roomId);
  const latestRoomRef = useRef<OnlineRoom | null>(null);
  const skipLeaveOnUnmountRef = useRef(false);

  const syncRoom = useCallback((nextRoom: OnlineRoom) => {
    currentRoomIdRef.current = nextRoom.roomId;
    latestRoomRef.current = nextRoom;
    setRoom(nextRoom);
    if (roomId === null) {
      onRoomResolved(nextRoom.roomId);
    }
    if (nextRoom.phase === 'IN_MATCH' && nextRoom.matchId) {
      skipLeaveOnUnmountRef.current = true;
      onMatchStart(nextRoom.roomId, nextRoom.matchId);
    }
  }, [onMatchStart, onRoomResolved, roomId]);

  // Initial load: create or fetch room
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        // Get current user from bootstrap
        const bootstrap = await onlinePvpAPI.bootstrap();
        if (cancelled) return;
        setMyUserId(bootstrap.user.userId);

        let fetchedRoom: OnlineRoom;
        if (roomId === null) {
          const res = await onlinePvpAPI.createRoom(DEFAULT_CONFIG, bootstrap.inventory.skins.equipped);
          if (cancelled) return;
          fetchedRoom = res.room;
        } else {
          const res = await onlinePvpAPI.getRoom(roomId) as { room: OnlineRoom };
          if (cancelled) return;
          fetchedRoom = res.room;
        }
        syncRoom(fetchedRoom);
        setLoading(false);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load room');
          setLoading(false);
        }
      }
    })();

    return () => { cancelled = true; };
  }, [roomId, syncRoom]);

  useEffect(() => {
    latestRoomRef.current = room;
  }, [room]);

  // Poll room state; trigger onMatchStart when room reaches IN_MATCH phase
  useEffect(() => {
    if (loading || error || !currentRoomIdRef.current) return;
    const interval = setInterval(async () => {
      try {
        const res = await onlinePvpAPI.getRoom(currentRoomIdRef.current!) as { room: OnlineRoom };
        syncRoom(res.room);
        if (res.room.phase === 'CANCELED' || res.room.phase === 'COMPLETED') {
          skipLeaveOnUnmountRef.current = true;
          clearInterval(interval);
          onBackToLobby();
        }
      } catch (pollError) {
        if (pollError instanceof Error && pollError.message.includes('(404)')) {
          skipLeaveOnUnmountRef.current = true;
          clearInterval(interval);
          onBackToLobby();
        }
      }
    }, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [loading, error, onBackToLobby, syncRoom]);

  useEffect(() => {
    return () => {
      if (skipLeaveOnUnmountRef.current) return;
      const liveRoom = latestRoomRef.current;
      if (!liveRoom) return;
      if (liveRoom.phase === 'CANCELED' || liveRoom.phase === 'COMPLETED') return;
      onlinePvpAPI.leaveRoom(liveRoom.roomId, liveRoom.version).catch(() => undefined);
    };
  }, []);

  const handleExitToLobby = useCallback(async () => {
    const liveRoom = latestRoomRef.current;
    skipLeaveOnUnmountRef.current = true;
    if (!liveRoom) return onBackToLobby();
    try {
      await onlinePvpAPI.leaveRoom(liveRoom.roomId, liveRoom.version);
    } catch {
      // best effort
    }
    onBackToLobby();
  }, [onBackToLobby]);

  const handleSetReady = useCallback(async (ready: boolean) => {
    if (!room) return;
    try {
      const res = await onlinePvpAPI.setReady(room.roomId, room.version, ready);
      syncRoom(res.room);
      setError(null);
    } catch (err) {
      try {
        const latest = await onlinePvpAPI.getRoom(room.roomId) as { room: OnlineRoom };
        syncRoom(latest.room);

        if (
          err instanceof Error &&
          err.message.includes('(409)') &&
          latest.room.phase === 'READY_CHECK'
        ) {
          const latestIsHost = latest.room.ownerUserId === myUserId;
          const latestMySlot = latestIsHost ? latest.room.slots.host : latest.room.slots.guest;
          if (latestMySlot && latestMySlot.ready !== ready) {
            const retry = await onlinePvpAPI.setReady(latest.room.roomId, latest.room.version, ready);
            syncRoom(retry.room);
            setError(null);
            return;
          }
        }
      } catch {
        // ignore refresh failure
      }
      setError(err instanceof Error ? err.message : 'Failed to set ready');
    }
  }, [myUserId, room, syncRoom]);

  const handleUpdateConfig = useCallback(async (patch: Partial<RoomConfig>) => {
    if (!room) return;
    try {
      const res = await onlinePvpAPI.updateRoomConfig(room.roomId, room.version, { ...room.config, ...patch });
      syncRoom(res.room);
    } catch (err) {
      try {
        const latest = await onlinePvpAPI.getRoom(room.roomId) as { room: OnlineRoom };
        syncRoom(latest.room);
      } catch {
        // ignore refresh failure
      }
      setError(err instanceof Error ? err.message : 'Failed to update config');
    }
  }, [room, syncRoom]);

  const handleSendInvite = useCallback(async () => {
    if (!room || !inviteTarget.trim()) return;
    setInviteStatus('Sending...');
    try {
      await onlinePvpAPI.sendInvite(room.roomId, room.version, undefined, inviteTarget.trim());
      setInviteStatus('Invite sent!');
      setInviteTarget('');
      // Refresh room
      const res = await onlinePvpAPI.getRoom(room.roomId) as { room: OnlineRoom };
      syncRoom(res.room);
    } catch (err) {
      setInviteStatus(err instanceof Error ? err.message : 'Failed to send invite');
    }
  }, [room, inviteTarget, syncRoom]);

  // Styles
  const containerStyle: React.CSSProperties = {
    width: '100%', height: '100%', position: 'relative',
    background: 'linear-gradient(180deg, #000a1a 0%, #001428 40%, #002040 100%)',
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    fontFamily: 'monospace', color: 'white', overflow: 'auto',
  };

  const cardStyle: React.CSSProperties = {
    width: '90%', maxWidth: 500,
    background: 'rgba(0, 50, 100, 0.2)', border: '1px solid rgba(0, 150, 255, 0.2)',
    borderRadius: 12, padding: '16px 20px', marginTop: 16,
  };

  const btnStyle: React.CSSProperties = {
    padding: '12px 28px', fontSize: '1rem', fontWeight: 800,
    fontFamily: 'monospace', background: 'rgba(0, 180, 255, 0.25)',
    border: '2px solid rgba(0, 180, 255, 0.6)', borderRadius: 12,
    color: 'white', cursor: 'pointer',
  };

  const dangerBtnStyle: React.CSSProperties = {
    ...btnStyle,
    background: 'rgba(200, 50, 50, 0.25)',
    border: '2px solid rgba(200, 50, 50, 0.5)',
  };

  const grayBtnStyle: React.CSSProperties = {
    ...btnStyle,
    background: 'rgba(100, 100, 100, 0.2)',
    border: '2px solid rgba(100, 100, 100, 0.4)',
  };

  if (loading) {
    return (
      <div style={containerStyle}>
        <div style={{ marginTop: '30vh', fontSize: '1.2rem', opacity: 0.6 }}>
          {roomId === null ? 'Creating room...' : 'Loading room...'}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div style={containerStyle}>
        <div style={{ marginTop: '30vh', fontSize: '1rem', color: '#ff6666' }}>{error}</div>
        <button style={{ ...grayBtnStyle, marginTop: 16 }} onClick={handleExitToLobby}>BACK</button>
      </div>
    );
  }

  if (!room) return null;

  const isHost = room.ownerUserId === myUserId;
  const mySlot = isHost ? room.slots.host : room.slots.guest;
  const canReady = room.phase === 'READY_CHECK' && room.slots.guest !== null;
  const canInvite = isHost && (room.phase === 'OPEN' || room.phase === 'WAITING_FOR_INVITEE');

  return (
    <div style={containerStyle}>
      {/* Title */}
      <div style={{
        marginTop: 'max(20px, 5vh)', fontSize: 'clamp(24px, 5vw, 40px)',
        fontWeight: 900, color: '#00ccff',
        textShadow: '0 0 20px rgba(0, 204, 255, 0.4)',
      }}>
        ROOM
      </div>

      {/* Phase badge */}
      <div style={{
        marginTop: 8, fontSize: '0.8rem', color: '#4facfe',
        background: 'rgba(0, 80, 200, 0.2)', padding: '4px 14px', borderRadius: 20,
        border: '1px solid rgba(0, 150, 255, 0.3)',
      }}>
        {room.phase === 'OPEN' && 'Waiting for opponent...'}
        {room.phase === 'WAITING_FOR_INVITEE' && 'Invite sent, waiting for response...'}
        {room.phase === 'READY_CHECK' && 'READY CHECK'}
        {room.phase === 'LOCKED' && 'Starting match...'}
        {room.phase === 'COUNTDOWN' && 'Starting match...'}
        {room.phase === 'IN_MATCH' && 'In Match'}
        {room.phase === 'CANCELED' && 'Room Canceled'}
        {room.phase === 'COMPLETED' && 'Match Complete'}
        {!['OPEN','WAITING_FOR_INVITEE','READY_CHECK','LOCKED','COUNTDOWN','IN_MATCH','CANCELED','COMPLETED'].includes(room.phase) && room.phase}
      </div>

      {/* Config section (host editable) */}
      <div style={cardStyle}>
        <div style={{ fontSize: '0.9rem', fontWeight: 700, color: '#4facfe', marginBottom: 12 }}>
          ROOM CONFIG
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {/* Format */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '0.85rem', color: '#aaa' }}>Format</span>
            {isHost ? (
              <select
                value={room.config.format}
                onChange={e => handleUpdateConfig({ format: e.target.value as RoomConfig['format'] })}
                style={{
                  background: 'rgba(0, 80, 160, 0.4)', border: '1px solid rgba(0, 150, 255, 0.4)',
                  color: 'white', borderRadius: 6, padding: '4px 8px', fontFamily: 'monospace', fontSize: '0.8rem',
                }}
              >
                <option value="single">Single</option>
                <option value="bo3">Best of 3</option>
                <option value="bo5">Best of 5</option>
              </select>
            ) : (
              <span style={{ fontSize: '0.85rem' }}>{room.config.format}</span>
            )}
          </div>
          {/* Power-up mode */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '0.85rem', color: '#aaa' }}>Power-ups</span>
            {isHost ? (
              <select
                value={room.config.powerUpMode}
                onChange={e => handleUpdateConfig({ powerUpMode: e.target.value as RoomConfig['powerUpMode'] })}
                style={{
                  background: 'rgba(0, 80, 160, 0.4)', border: '1px solid rgba(0, 150, 255, 0.4)',
                  color: 'white', borderRadius: 6, padding: '4px 8px', fontFamily: 'monospace', fontSize: '0.8rem',
                }}
              >
                <option value="earned">Earned</option>
                <option value="inventory">Inventory</option>
                <option value="none">None</option>
                <option value="score_attack">Score Attack</option>
              </select>
            ) : (
              <span style={{ fontSize: '0.85rem' }}>{room.config.powerUpMode}</span>
            )}
          </div>
        </div>
      </div>

      {/* Player slots */}
      <div style={cardStyle}>
        <div style={{ fontSize: '0.9rem', fontWeight: 700, color: '#4facfe', marginBottom: 12 }}>
          PLAYERS
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {/* Host slot */}
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            padding: '10px 14px', background: 'rgba(0, 80, 160, 0.2)', borderRadius: 8,
            border: '1px solid rgba(0, 150, 255, 0.2)',
          }}>
            <div>
              <span style={{ fontSize: '0.7rem', color: '#4facfe', marginRight: 8 }}>HOST</span>
              <span style={{ fontSize: '0.9rem' }}>{room.slots.host.loginId}</span>
            </div>
            <span style={{ fontSize: '0.8rem', color: room.slots.host.ready ? '#44ff88' : '#888' }}>
              {room.slots.host.ready ? 'READY' : 'NOT READY'}
            </span>
          </div>
          {/* Guest slot */}
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            padding: '10px 14px', background: 'rgba(0, 80, 160, 0.15)', borderRadius: 8,
            border: '1px solid rgba(0, 150, 255, 0.15)',
          }}>
            {room.slots.guest ? (
              <>
                <div>
                  <span style={{ fontSize: '0.7rem', color: '#aaa', marginRight: 8 }}>GUEST</span>
                  <span style={{ fontSize: '0.9rem' }}>{room.slots.guest.loginId}</span>
                </div>
                <span style={{ fontSize: '0.8rem', color: room.slots.guest.ready ? '#44ff88' : '#888' }}>
                  {room.slots.guest.ready ? 'READY' : 'NOT READY'}
                </span>
              </>
            ) : (
              <span style={{ fontSize: '0.85rem', color: '#555', fontStyle: 'italic' }}>
                Waiting for guest...
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Invite section (host only, when room is open) */}
      {canInvite && (
        <div style={cardStyle}>
          <div style={{ fontSize: '0.9rem', fontWeight: 700, color: '#4facfe', marginBottom: 12 }}>
            INVITE PLAYER
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              type="text"
              value={inviteTarget}
              onChange={e => setInviteTarget(e.target.value)}
              placeholder="Enter login ID..."
              style={{
                flex: 1, background: 'rgba(0, 50, 100, 0.4)', border: '1px solid rgba(0, 150, 255, 0.4)',
                color: 'white', borderRadius: 8, padding: '8px 12px',
                fontFamily: 'monospace', fontSize: '0.85rem',
              }}
            />
            <button
              style={{ ...btnStyle, padding: '8px 18px', fontSize: '0.85rem' }}
              onClick={handleSendInvite}
              disabled={!inviteTarget.trim()}
            >
              INVITE
            </button>
          </div>
          {inviteStatus && (
            <div style={{ marginTop: 8, fontSize: '0.8rem', color: inviteStatus.includes('Failed') || inviteStatus.includes('failed') ? '#ff6666' : '#44ff88' }}>
              {inviteStatus}
            </div>
          )}
        </div>
      )}

      {/* Action buttons */}
      <div style={{ display: 'flex', gap: 12, marginTop: 20, flexWrap: 'wrap', justifyContent: 'center' }}>
        {canReady && mySlot && (
          <button
            style={{ ...btnStyle, background: mySlot.ready ? 'rgba(50, 200, 100, 0.25)' : 'rgba(0, 180, 255, 0.25)' }}
            onClick={() => handleSetReady(!mySlot.ready)}
          >
            {mySlot.ready ? 'UNREADY' : 'READY'}
          </button>
        )}
        <button style={dangerBtnStyle} onClick={handleExitToLobby}>
          BACK TO LOBBY
        </button>
      </div>
      <div style={{ marginTop: 10, fontSize: '0.75rem', color: '#999' }}>
        Backing out of this room closes it for both players.
      </div>

      {/* Bottom spacer */}
      <div style={{ height: 40 }} />
    </div>
  );
};
