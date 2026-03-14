import React, { useState, useCallback } from "react";
import { createRoot } from "react-dom/client";
import { DeepDiveGame } from "./src/Game";
import { PvpLobby } from "./src/pvp/PvpLobby";
import { PvpGame } from "./src/pvp/PvpGame";
import type { PvpMatchConfig, PvpMatchState } from "./src/pvp/pvpTypes";
import { pvpAPI } from "./src/api";

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

type AppMode = "game" | "pvp_lobby" | "pvp_playing";

const App: React.FC = () => {
  const [mode, setMode] = useState<AppMode>("game");
  const [pvpConfig, setPvpConfig] = useState<PvpMatchConfig | null>(null);

  const handlePvpClick = useCallback(() => {
    setMode("pvp_lobby");
  }, []);

  const handleBackToGame = useCallback(() => {
    setMode("game");
    setPvpConfig(null);
  }, []);

  const handleStartMatch = useCallback((config: PvpMatchConfig) => {
    setPvpConfig(config);
    setMode("pvp_playing");
  }, []);

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
    setMode("pvp_lobby");
    setPvpConfig(null);
  }, []);

  if (mode === "pvp_lobby") {
    return <PvpLobby onStartMatch={handleStartMatch} onBack={handleBackToGame} />;
  }

  if (mode === "pvp_playing" && pvpConfig) {
    return (
      <PvpGame
        config={pvpConfig}
        onMatchEnd={handleMatchEnd}
        onBackToLobby={handleBackToLobby}
      />
    );
  }

  return <DeepDiveGame onPvpClick={handlePvpClick} />;
};

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
