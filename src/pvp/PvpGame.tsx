import React, { useEffect, useRef, useState, useCallback } from "react";
import type { PvpMatchConfig, PvpMatchState, PvpRoundResult, PvpPlayerState, PvpMatchPhase } from "./pvpTypes";
import { createSeededRNG } from "./pvpWorld";
import { createPlayerState, updatePlayerState, attemptJump } from "./pvpGameLogic";
import { drawPlayerWorld, drawDivider, drawPlayerHUD, drawRescueCountdown, type Viewport } from "./pvpRenderer";
import { initAudio, playSound } from "../audio";
import { getSkinDef, preloadSkinImages } from "../skins";
import * as Constants from "../constants";
import turtleRescueImgSrc from "../../turtle.png";
import turtleShellItemImgSrc from "../../turtle-shell-item.png";
import tubeImgSrc from "../../tube.png";

interface PvpGameProps {
  config: PvpMatchConfig;
  onMatchEnd: (state: PvpMatchState) => void;
  onBackToLobby: () => void;
}

const POWER_UP_LABELS: Record<string, string> = {
  inventory: "Inventory Power-Ups",
  earned: "Earned Power-Ups Only",
  none: "No Power-Ups",
  score_attack: "Score Attack",
};

const FORMAT_LABELS: Record<string, string> = {
  single: "Single Game",
  bo3: "Best of 3",
  bo5: "Best of 5",
};

export const PvpGame: React.FC<PvpGameProps> = ({ config, onMatchEnd, onBackToLobby }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const requestRef = useRef<number>(0);
  const p1Ref = useRef<PvpPlayerState | null>(null);
  const p2Ref = useRef<PvpPlayerState | null>(null);
  const lastTimeRef = useRef<number>(0);

  const matchStateRef = useRef<PvpMatchState>({
    phase: "INSTRUCTIONS",
    config,
    roundsPlayed: 0,
    p1Wins: 0,
    p2Wins: 0,
    roundResults: [],
    countdownValue: 3,
    roundsNeeded: config.format === "bo5" ? 3 : config.format === "bo3" ? 2 : 1,
  });

  const [phase, setPhase] = useState<PvpMatchPhase>("INSTRUCTIONS");
  const [countdownValue, setCountdownValue] = useState(3);
  const [roundResult, setRoundResult] = useState<PvpRoundResult | null>(null);
  const [matchState, setMatchState] = useState<PvpMatchState>(matchStateRef.current);

  // Image refs
  const turtleRescueImgRef = useRef<HTMLImageElement | null>(null);
  const turtleShellImgRef = useRef<HTMLImageElement | null>(null);
  const tubeImgRef = useRef<HTMLImageElement | null>(null);

  // Skin defs
  const p1SkinDef = getSkinDef(config.p1SkinId);
  const p2SkinDef = getSkinDef(config.p2SkinId);

  // Preload images
  useEffect(() => {
    const loadImg = (src: string) => {
      const img = new Image();
      img.src = src;
      return img;
    };
    turtleRescueImgRef.current = loadImg(turtleRescueImgSrc);
    turtleShellImgRef.current = loadImg(turtleShellItemImgSrc);
    tubeImgRef.current = loadImg(tubeImgSrc);
    preloadSkinImages();
  }, []);

  // Canvas resize
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  // --- Initialize a new round ---
  const startRound = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    initAudio();

    const seed = Date.now();
    const rng1 = createSeededRNG(seed);
    const rng2 = createSeededRNG(seed);

    const halfH = Math.floor(canvas.height / 2) - 2;

    p1Ref.current = createPlayerState(
      rng1, canvas.width, halfH,
      config.powerUpMode,
      config.powerUpMode === "inventory" ? (/* TODO: load from auth */ 0) : 0,
      config.powerUpMode === "inventory" ? 0 : 0,
    );
    p2Ref.current = createPlayerState(
      rng2, canvas.width, halfH,
      config.powerUpMode, 0, 0,
    );

    matchStateRef.current.phase = "COUNTDOWN";
    matchStateRef.current.countdownValue = 3;
    setPhase("COUNTDOWN");
    setCountdownValue(3);

    lastTimeRef.current = performance.now();
    cancelAnimationFrame(requestRef.current);

    // Countdown timer
    let count = 3;
    const countdownInterval = setInterval(() => {
      count -= 1;
      if (count > 0) {
        matchStateRef.current.countdownValue = count;
        setCountdownValue(count);
      } else {
        clearInterval(countdownInterval);
        matchStateRef.current.phase = "PLAYING";
        matchStateRef.current.countdownValue = 0;
        setPhase("PLAYING");
        lastTimeRef.current = performance.now();
        requestRef.current = requestAnimationFrame(gameLoop);
      }
    }, 1000);

    return () => clearInterval(countdownInterval);
  }, [config]);

  // --- Game loop ---
  const gameLoop = useCallback((time: number) => {
    if (matchStateRef.current.phase !== "PLAYING") return;

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const deltaTime = Math.min((time - lastTimeRef.current) / 1000, 0.1);
    lastTimeRef.current = time;

    const p1 = p1Ref.current!;
    const p2 = p2Ref.current!;
    const halfH = Math.floor(canvas.height / 2) - 2;

    // Update both players
    const p1Died = p1.alive && updatePlayerState(p1, deltaTime, canvas.width, halfH, config.powerUpMode);
    const p2Died = p2.alive && updatePlayerState(p2, deltaTime, canvas.width, halfH, config.powerUpMode);

    // Check round end
    if (p1Died || p2Died || (!p1.alive && !p2.alive)) {
      // Determine winner
      let winner: 1 | 2;
      if (config.powerUpMode === "score_attack") {
        // In score attack, both play until one dies, then compare scores
        // If both die same frame, higher score wins
        if (!p1.alive && !p2.alive) {
          winner = p1.score >= p2.score ? 1 : 2;
        } else if (!p1.alive) {
          winner = 2;
        } else {
          winner = 1;
        }
      } else {
        if (!p1.alive && !p2.alive) {
          winner = p1.score >= p2.score ? 1 : 2;
        } else if (!p1.alive) {
          winner = 2;
        } else {
          winner = 1;
        }
      }

      const result: PvpRoundResult = {
        winner,
        p1Score: p1.score,
        p2Score: p2.score,
        p1DeathCause: p1.deathCause,
        p2DeathCause: p2.deathCause,
      };

      const ms = matchStateRef.current;
      ms.roundResults.push(result);
      ms.roundsPlayed += 1;
      if (winner === 1) ms.p1Wins += 1;
      else ms.p2Wins += 1;

      // Check match end
      if (ms.p1Wins >= ms.roundsNeeded || ms.p2Wins >= ms.roundsNeeded || ms.roundsPlayed >= (config.format === "bo5" ? 5 : config.format === "bo3" ? 3 : 1)) {
        ms.phase = "MATCH_RESULT";
        setPhase("MATCH_RESULT");
        setRoundResult(result);
        setMatchState({ ...ms });
        onMatchEnd(ms);
        return;
      }

      ms.phase = "ROUND_RESULT";
      setPhase("ROUND_RESULT");
      setRoundResult(result);
      setMatchState({ ...ms });
      return;
    }

    // Draw
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const v1: Viewport = { x: 0, y: 0, width: canvas.width, height: halfH };
    const v2: Viewport = { x: 0, y: halfH + 4, width: canvas.width, height: halfH };

    drawPlayerWorld(ctx, p1, v1, p1SkinDef, turtleShellImgRef.current, tubeImgRef.current, turtleRescueImgRef.current);
    drawPlayerWorld(ctx, p2, v2, p2SkinDef, turtleShellImgRef.current, tubeImgRef.current, turtleRescueImgRef.current);

    drawDivider(ctx, canvas.width, halfH + 2);

    drawPlayerHUD(ctx, p1, v1, "P1", config.powerUpMode);
    drawPlayerHUD(ctx, p2, v2, "P2", config.powerUpMode);

    drawRescueCountdown(ctx, p1, v1);
    drawRescueCountdown(ctx, p2, v2);

    requestRef.current = requestAnimationFrame(gameLoop);
  }, [config, p1SkinDef, p2SkinDef, onMatchEnd]);

  // --- Input handling ---
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const ms = matchStateRef.current;

      // During rescue, accumulate jump charges
      if (e.code === "Space" && p1Ref.current) {
        if (p1Ref.current.rescue.active || p1Ref.current.tubeRescue.active) {
          p1Ref.current.rescueJumpCharges += 1;
        }
        p1Ref.current.jumpInputActive = true;
        p1Ref.current.jumpBufferTimer = Constants.JUMP_BUFFER_TIME;
        if (ms.phase === "PLAYING") attemptJump(p1Ref.current, true, config.powerUpMode);
      }
      if (e.code === "ArrowUp" && p2Ref.current) {
        e.preventDefault();
        if (p2Ref.current.rescue.active || p2Ref.current.tubeRescue.active) {
          p2Ref.current.rescueJumpCharges += 1;
        }
        p2Ref.current.jumpInputActive = true;
        p2Ref.current.jumpBufferTimer = Constants.JUMP_BUFFER_TIME;
        if (ms.phase === "PLAYING") attemptJump(p2Ref.current, true, config.powerUpMode);
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space" && p1Ref.current) {
        p1Ref.current.jumpInputActive = false;
      }
      if (e.code === "ArrowUp" && p2Ref.current) {
        p2Ref.current.jumpInputActive = false;
      }
    };

    const handleTouchStart = (e: TouchEvent) => {
      if (matchStateRef.current.phase !== "PLAYING") return;
      e.preventDefault();
      const halfH = Math.floor(window.innerHeight / 2);
      for (let i = 0; i < e.changedTouches.length; i++) {
        const touch = e.changedTouches[i];
        if (touch.clientY < halfH && p1Ref.current) {
          if (p1Ref.current.rescue.active || p1Ref.current.tubeRescue.active) {
            p1Ref.current.rescueJumpCharges += 1;
          }
          p1Ref.current.jumpInputActive = true;
          p1Ref.current.jumpBufferTimer = Constants.JUMP_BUFFER_TIME;
          attemptJump(p1Ref.current, true, config.powerUpMode);
        } else if (touch.clientY >= halfH && p2Ref.current) {
          if (p2Ref.current.rescue.active || p2Ref.current.tubeRescue.active) {
            p2Ref.current.rescueJumpCharges += 1;
          }
          p2Ref.current.jumpInputActive = true;
          p2Ref.current.jumpBufferTimer = Constants.JUMP_BUFFER_TIME;
          attemptJump(p2Ref.current, true, config.powerUpMode);
        }
      }
    };

    const handleTouchEnd = (e: TouchEvent) => {
      const halfH = Math.floor(window.innerHeight / 2);
      for (let i = 0; i < e.changedTouches.length; i++) {
        const touch = e.changedTouches[i];
        if (touch.clientY < halfH && p1Ref.current) {
          p1Ref.current.jumpInputActive = false;
        } else if (p2Ref.current) {
          p2Ref.current.jumpInputActive = false;
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("keyup", handleKeyUp);
    document.addEventListener("touchstart", handleTouchStart, { passive: false });
    document.addEventListener("touchend", handleTouchEnd);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("keyup", handleKeyUp);
      document.removeEventListener("touchstart", handleTouchStart);
      document.removeEventListener("touchend", handleTouchEnd);
    };
  }, [config]);

  // Cleanup
  useEffect(() => {
    return () => cancelAnimationFrame(requestRef.current);
  }, []);

  // --- Instruction screen auto-transition ---
  useEffect(() => {
    if (phase === "INSTRUCTIONS") {
      const timer = setTimeout(() => {
        startRound();
      }, 4000);
      return () => clearTimeout(timer);
    }
  }, [phase, startRound]);

  const handleNextRound = () => {
    setRoundResult(null);
    startRound();
  };

  // --- Common overlay styles ---
  const overlayStyle: React.CSSProperties = {
    position: "absolute",
    top: 0, left: 0, width: "100%", height: "100%",
    display: "flex", flexDirection: "column",
    alignItems: "center", justifyContent: "center",
    zIndex: 10, pointerEvents: "auto",
    fontFamily: "monospace", color: "white",
  };

  const btnStyle: React.CSSProperties = {
    padding: "14px 36px",
    fontSize: "1.1rem",
    fontWeight: 800,
    fontFamily: "monospace",
    background: "rgba(0, 180, 255, 0.25)",
    border: "2px solid rgba(0, 180, 255, 0.6)",
    borderRadius: 12,
    color: "white",
    cursor: "pointer",
    marginTop: 16,
  };

  return (
    <div style={{ position: "relative", width: "100%", height: "100%", background: "#001428" }}>
      <canvas
        ref={canvasRef}
        style={{ display: "block" }}
        tabIndex={0}
      />

      {/* Instructions screen */}
      {phase === "INSTRUCTIONS" && (
        <div style={{ ...overlayStyle, background: "rgba(0, 10, 25, 0.95)" }}>
          <div style={{ fontSize: "clamp(24px, 5vw, 42px)", fontWeight: 900, marginBottom: 24, color: "#00ccff" }}>
            PVP MODE
          </div>

          <div style={{ display: "flex", width: "90%", maxWidth: 600, gap: 0, flexDirection: "column" }}>
            {/* P1 area */}
            <div style={{
              flex: 1, display: "flex", flexDirection: "column",
              alignItems: "center", justifyContent: "center",
              padding: "30px 20px",
              background: "rgba(0, 100, 200, 0.15)",
              border: "1px solid rgba(0, 150, 255, 0.3)",
              borderRadius: "16px 16px 0 0",
            }}>
              <div style={{ fontSize: "clamp(18px, 4vw, 28px)", fontWeight: 800, color: "#4facfe" }}>PLAYER 1</div>
              <div style={{ fontSize: "clamp(12px, 2.5vw, 16px)", color: "#aaa", marginTop: 6 }}>
                Top half of screen
              </div>
              <div style={{ fontSize: "clamp(12px, 2.5vw, 16px)", color: "#ccc", marginTop: 4 }}>
                Spacebar / Tap Top
              </div>
            </div>

            {/* Divider */}
            <div style={{ height: 3, background: "rgba(255,255,255,0.4)", width: "100%" }} />

            {/* P2 area */}
            <div style={{
              flex: 1, display: "flex", flexDirection: "column",
              alignItems: "center", justifyContent: "center",
              padding: "30px 20px",
              background: "rgba(255, 100, 0, 0.1)",
              border: "1px solid rgba(255, 150, 50, 0.3)",
              borderRadius: "0 0 16px 16px",
            }}>
              <div style={{ fontSize: "clamp(18px, 4vw, 28px)", fontWeight: 800, color: "#ff8c42" }}>PLAYER 2</div>
              <div style={{ fontSize: "clamp(12px, 2.5vw, 16px)", color: "#aaa", marginTop: 6 }}>
                Bottom half of screen
              </div>
              <div style={{ fontSize: "clamp(12px, 2.5vw, 16px)", color: "#ccc", marginTop: 4 }}>
                Up Arrow / Tap Bottom
              </div>
            </div>
          </div>

          <div style={{ marginTop: 20, fontSize: "clamp(12px, 2.5vw, 16px)", color: "#888" }}>
            {FORMAT_LABELS[config.format]} &middot; {POWER_UP_LABELS[config.powerUpMode]}
          </div>

          {config.powerUpMode === "score_attack" && (
            <div style={{ marginTop: 10, fontSize: "clamp(11px, 2vw, 14px)", color: "#aaa", textAlign: "center", maxWidth: 500, lineHeight: 1.5 }}>
              Swordfish: +300 &middot; Turtle Shell: +100 &middot; Tube Piece: +75 &middot; Urchin: -500
              <br />Items have no game effects. Highest score wins!
            </div>
          )}

          <div style={{ marginTop: 20, fontSize: "clamp(14px, 3vw, 20px)", opacity: 0.5, animation: "pulse 1.5s infinite" }}>
            Starting soon...
          </div>
        </div>
      )}

      {/* Countdown */}
      {phase === "COUNTDOWN" && (
        <div style={{
          ...overlayStyle,
          background: "rgba(0, 10, 25, 0.7)",
          fontSize: "clamp(80px, 18vw, 180px)",
          fontWeight: 900,
          textShadow: "0 8px 0 rgba(0,0,0,0.5)",
        }}>
          {countdownValue}
        </div>
      )}

      {/* Round result */}
      {phase === "ROUND_RESULT" && roundResult && (
        <div style={{ ...overlayStyle, background: "rgba(0, 10, 25, 0.85)" }}>
          <div style={{ fontSize: "clamp(28px, 6vw, 52px)", fontWeight: 900, color: "#00ff88" }}>
            Player {roundResult.winner} Wins!
          </div>
          <div style={{ marginTop: 12, fontSize: "clamp(14px, 3vw, 20px)", color: "#aaa" }}>
            P1: {roundResult.p1Score} &middot; P2: {roundResult.p2Score}
          </div>
          <div style={{ marginTop: 8, fontSize: "clamp(16px, 3.5vw, 24px)", color: "#fff" }}>
            Series: {matchStateRef.current.p1Wins} - {matchStateRef.current.p2Wins}
          </div>
          <button style={btnStyle} onClick={handleNextRound}>
            Next Round
          </button>
        </div>
      )}

      {/* Match result */}
      {phase === "MATCH_RESULT" && (
        <div style={{ ...overlayStyle, background: "rgba(0, 10, 25, 0.9)" }}>
          <div style={{ fontSize: "clamp(20px, 4vw, 36px)", fontWeight: 900, color: "#00ccff", marginBottom: 10 }}>
            MATCH OVER
          </div>
          <div style={{ fontSize: "clamp(32px, 7vw, 60px)", fontWeight: 900, color: "#00ff88" }}>
            Player {matchStateRef.current.p1Wins >= matchStateRef.current.roundsNeeded ? 1 : 2} Wins!
          </div>
          <div style={{ marginTop: 12, fontSize: "clamp(16px, 3.5vw, 24px)", color: "#fff" }}>
            Final: {matchStateRef.current.p1Wins} - {matchStateRef.current.p2Wins}
          </div>

          {config.betting && (
            <div style={{ marginTop: 16, fontSize: "clamp(13px, 2.5vw, 18px)", color: "#ffcc00" }}>
              Bet items transferred to the winner!
            </div>
          )}

          <div style={{ display: "flex", gap: 12, marginTop: 20 }}>
            <button style={btnStyle} onClick={onBackToLobby}>
              Back to Lobby
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
