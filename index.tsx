import React, { useState, useCallback, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { DeepDiveGame } from "./src/Game";
import { PvpLobby } from "./src/pvp/PvpLobby";
import { PvpGame } from "./src/pvp/PvpGame";
import { OnlinePvpLobby } from "./src/pvp-online/OnlinePvpLobby";
import { OnlinePvpRoom } from "./src/pvp-online/OnlinePvpRoom";
import { OnlinePvpMatch } from "./src/pvp-online/OnlinePvpMatch";
import type { PvpMatchConfig, PvpMatchState } from "./src/pvp/pvpTypes";
import type { PvpInvite } from "./src/pvp-online/onlinePvpTypes";
import { OnlineInvitePopup } from "./src/components/UIOverlays";
import { onlinePvpAPI, pvpAPI } from "./src/api";

// Add global styles for animations
const styleSheet = document.createElement("style");
styleSheet.innerText = `
@keyframes pulse {
  0% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.7; transform: scale(0.95); }
  100% { opacity: 1; transform: scale(1); }
}
`;
document.head.appendChild(styleSheet);

type AppMode = "game" | "pvp_lobby" | "pvp_playing" | "pvp_online_lobby" | "pvp_online_room" | "pvp_online_match";

type OnlineHashRoute =
  | { mode: "pvp_online_lobby"; roomId: null; matchId: null }
  | { mode: "pvp_online_room"; roomId: string | null; matchId: null }
  | { mode: "pvp_online_match"; roomId: string | null; matchId: string };

function parseOnlineHashRoute(hash: string): OnlineHashRoute | null {
  const normalized = hash.startsWith('#') ? hash.slice(1) : hash;
  const parts = normalized.split('/').filter(Boolean);

  if (parts[0] !== 'pvp-online') return null;
  if (parts[1] === 'lobby') {
    return { mode: 'pvp_online_lobby', roomId: null, matchId: null };
  }
  if (parts[1] === 'room') {
    if (parts[2] === 'new') {
      return { mode: 'pvp_online_room', roomId: null, matchId: null };
    }
    if (parts[2]) {
      return { mode: 'pvp_online_room', roomId: decodeURIComponent(parts[2]), matchId: null };
    }
  }
  if (parts[1] === 'match' && parts[2] && parts[3]) {
    return {
      mode: 'pvp_online_match',
      roomId: decodeURIComponent(parts[2]),
      matchId: decodeURIComponent(parts[3]),
    };
  }
  if (parts[1] === 'match' && parts[2]) {
    return { mode: 'pvp_online_match', roomId: null, matchId: decodeURIComponent(parts[2]) };
  }
  return null;
}

const App: React.FC = () => {
  const initialOnlineRoute = parseOnlineHashRoute(window.location.hash);
  const [mode, setMode] = useState<AppMode>(initialOnlineRoute?.mode ?? "game");
  const [pvpConfig, setPvpConfig] = useState<PvpMatchConfig | null>(null);
  const [onlineRoomId, setOnlineRoomId] = useState<string | null>(initialOnlineRoute?.roomId ?? null);
  const [onlineMatchId, setOnlineMatchId] = useState<string | null>(initialOnlineRoute?.matchId ?? null);
  const [pendingInvites, setPendingInvites] = useState<PvpInvite[]>([]);
  const [inviteActionId, setInviteActionId] = useState<string | null>(null);

  useEffect(() => {
    const handleHashChange = () => {
      const route = parseOnlineHashRoute(window.location.hash);
      if (!route) {
        setOnlineRoomId(null);
        setOnlineMatchId(null);
        setMode((currentMode) => (
          currentMode === "pvp_online_lobby" || currentMode === "pvp_online_room" || currentMode === "pvp_online_match"
            ? "game"
            : currentMode
        ));
        return;
      }

      setOnlineRoomId(route.roomId);
      setOnlineMatchId(route.matchId);
      setMode(route.mode);
    };

    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  useEffect(() => {
    if (mode === "pvp_online_room" || mode === "pvp_online_match") {
      setPendingInvites([]);
      return;
    }

    let cancelled = false;
    const loadInvites = async () => {
      try {
        const res = await onlinePvpAPI.getPendingInvites();
        if (!cancelled) {
          setPendingInvites(res.invites);
        }
      } catch {
        if (!cancelled) {
          setPendingInvites([]);
        }
      }
    };

    loadInvites();
    const interval = setInterval(loadInvites, 3000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [mode]);

  const navigateToHash = useCallback((hash: string) => {
    if (window.location.hash !== hash) {
      window.location.hash = hash;
      return;
    }

    const route = parseOnlineHashRoute(hash);
    if (!route) return;
    setOnlineRoomId(route.roomId);
    setOnlineMatchId(route.matchId);
    setMode(route.mode);
  }, []);

  const clearHash = useCallback(() => {
    if (window.location.hash) {
      window.location.hash = "";
    }
  }, []);

  const handlePvpClick = useCallback(() => {
    clearHash();
    setMode("pvp_lobby");
  }, [clearHash]);

  const handleOnlinePvpClick = useCallback(() => {
    navigateToHash("#/pvp-online/lobby");
  }, [navigateToHash]);

  const handleBackToGame = useCallback(() => {
    clearHash();
    setMode("game");
    setPvpConfig(null);
    setOnlineRoomId(null);
    setOnlineMatchId(null);
  }, [clearHash]);

  const handleStartMatch = useCallback((config: PvpMatchConfig) => {
    clearHash();
    setPvpConfig(config);
    setMode("pvp_playing");
  }, [clearHash]);

  const handleMatchEnd = useCallback(async (state: PvpMatchState) => {
    // Settle bet if applicable
    if (state.config.betting && state.config.p1UserId && state.config.p2UserId) {
      const matchWinner = state.p1Wins >= state.roundsNeeded ? 1 : 2;
      const winnerId = matchWinner === 1 ? state.config.p1UserId : state.config.p2UserId;
      const loserId = matchWinner === 1 ? state.config.p2UserId : state.config.p1UserId;
      const loserBet = matchWinner === 1 ? state.config.p2Bet : state.config.p1Bet;

      if (loserBet.coins > 0 || loserBet.dolphins > 0 || loserBet.tubePieces > 0) {
        try {
          await pvpAPI.settleBet({ winnerUserId: winnerId, loserUserId: loserId, bet: loserBet });
        } catch {
          // Best effort - UI already shows result
        }
      }
    }
  }, []);

  const handleBackToLobby = useCallback(() => {
    clearHash();
    setMode("pvp_lobby");
    setPvpConfig(null);
  }, [clearHash]);

  const handleOpenOnlineLobby = useCallback(() => {
    navigateToHash("#/pvp-online/lobby");
  }, [navigateToHash]);

  const handleOpenOnlineRoom = useCallback((roomId: string | null) => {
    const nextHash = roomId ? `#/pvp-online/room/${encodeURIComponent(roomId)}` : "#/pvp-online/room/new";
    navigateToHash(nextHash);
  }, [navigateToHash]);

  const handleResolveOnlineRoom = useCallback((roomId: string) => {
    navigateToHash(`#/pvp-online/room/${encodeURIComponent(roomId)}`);
  }, [navigateToHash]);

  const handleOpenOnlineMatch = useCallback((roomId: string, matchId: string) => {
    navigateToHash(`#/pvp-online/match/${encodeURIComponent(roomId)}/${encodeURIComponent(matchId)}`);
  }, [navigateToHash]);

  const handleAcceptInviteAnywhere = useCallback(async (invite: PvpInvite) => {
    setInviteActionId(invite.inviteId);
    try {
      const res = await onlinePvpAPI.acceptInvite(invite.inviteId);
      setPendingInvites((current) => current.filter((entry) => entry.inviteId !== invite.inviteId));
      handleOpenOnlineRoom(res.room.roomId);
    } finally {
      setInviteActionId(null);
    }
  }, [handleOpenOnlineRoom]);

  const handleDeclineInviteAnywhere = useCallback(async (invite: PvpInvite) => {
    setInviteActionId(invite.inviteId);
    try {
      await onlinePvpAPI.declineInvite(invite.inviteId);
      setPendingInvites((current) => current.filter((entry) => entry.inviteId !== invite.inviteId));
    } finally {
      setInviteActionId(null);
    }
  }, []);

  if (mode === "pvp_lobby") {
    return (
      <>
        <PvpLobby onStartMatch={handleStartMatch} onBack={handleBackToGame} />
        <OnlineInvitePopup invites={pendingInvites} busyInviteId={inviteActionId} onAccept={handleAcceptInviteAnywhere} onDecline={handleDeclineInviteAnywhere} />
      </>
    );
  }

  if (mode === "pvp_playing" && pvpConfig) {
    return (
      <>
        <PvpGame
          config={pvpConfig}
          onMatchEnd={handleMatchEnd}
          onBackToLobby={handleBackToLobby}
        />
        <OnlineInvitePopup invites={pendingInvites} busyInviteId={inviteActionId} onAccept={handleAcceptInviteAnywhere} onDecline={handleDeclineInviteAnywhere} />
      </>
    );
  }

  if (mode === "pvp_online_lobby") {
    return (
      <OnlinePvpLobby
        onBack={handleBackToGame}
        onCreateRoom={() => handleOpenOnlineRoom(null)}
        onJoinRoom={(roomId) => handleOpenOnlineRoom(roomId)}
      />
    );
  }

  if (mode === "pvp_online_room") {
    return (
      <OnlinePvpRoom
        roomId={onlineRoomId}
        onBackToLobby={handleOpenOnlineLobby}
        onRoomResolved={handleResolveOnlineRoom}
        onMatchStart={handleOpenOnlineMatch}
      />
    );
  }

  if (mode === "pvp_online_match") {
    return <OnlinePvpMatch roomId={onlineRoomId} matchId={onlineMatchId} onBackToLobby={handleOpenOnlineLobby} onReturnToRoom={handleResolveOnlineRoom} />;
  }

  return (
    <>
      <DeepDiveGame onPvpClick={handlePvpClick} onOnlinePvpClick={handleOnlinePvpClick} />
      <OnlineInvitePopup invites={pendingInvites} busyInviteId={inviteActionId} onAccept={handleAcceptInviteAnywhere} onDecline={handleDeclineInviteAnywhere} />
    </>
  );
};

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
