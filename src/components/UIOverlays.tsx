import React from "react";
import type { LeaderboardEntry } from "../types";
import { OXYGEN_MAX } from "../constants";
import turtleShellItemImg from "../../turtle-shell-item.png";

type AuthMode = "login" | "signup";

// Styles
const overlayStyle: React.CSSProperties = {
  position: "absolute",
  top: 0,
  left: 0,
  width: "100%",
  height: "100%",
  background: "rgba(0, 30, 54, 0.85)",
  display: "flex",
  flexDirection: "column",
  justifyContent: "center",
  alignItems: "center",
  padding: "24px 16px",
  boxSizing: "border-box",
  color: "white",
  textAlign: "center",
  zIndex: 10
};

const titleStyle: React.CSSProperties = {
  fontSize: "clamp(2.2rem, 7vw, 4rem)",
  margin: "0 0 20px 0",
  color: "#00ffff",
  textShadow: "0 0 20px rgba(0,255,255,0.5)",
  letterSpacing: "clamp(1px, 0.8vw, 4px)",
  lineHeight: 1.05,
  maxWidth: "min(760px, 92vw)",
  overflowWrap: "anywhere",
};

const subtitleStyle: React.CSSProperties = {
  fontSize: "2rem",
  animation: "pulse 1.5s infinite",
};

const scoreStyle: React.CSSProperties = {
  fontSize: "2rem",
  marginTop: "10px",
  color: "#fff",
};

const instructionStyle: React.CSSProperties = {
  marginTop: "20px",
  fontSize: "1.2rem",
  lineHeight: "1.6",
  color: "#ccc"
};

const modalBackdropStyle: React.CSSProperties = {
  position: "absolute",
  top: 0,
  left: 0,
  width: "100%",
  height: "100%",
  background: "rgba(0, 0, 0, 0.55)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 50,
  padding: "16px",
  boxSizing: "border-box",
};

const modalCardStyle: React.CSSProperties = {
  width: "min(520px, 92vw)",
  background: "rgba(0, 20, 40, 0.95)",
  border: "1px solid rgba(0,255,255,0.35)",
  borderRadius: 14,
  padding: "18px 16px",
  boxSizing: "border-box",
  color: "white",
  textAlign: "center",
};

interface AuthModalProps {
  open: boolean;
  mode: AuthMode;
  setMode: (m: AuthMode) => void;
  loginId: string;
  setLoginId: (v: string) => void;
  password: string;
  setPassword: (v: string) => void;
  error: string | null;
  isBusy: boolean;
  onClose: () => void;
  onSubmit: () => void;
  onContinueAsGuest?: () => void;
}

export const AuthModal: React.FC<AuthModalProps> = ({
  open,
  mode,
  setMode,
  loginId,
  setLoginId,
  password,
  setPassword,
  error,
  isBusy,
  onClose,
  onSubmit,
  onContinueAsGuest,
}) => {
  if (!open) return null;
  return (
    <div style={modalBackdropStyle} onMouseDown={onClose}>
      <div style={modalCardStyle} onMouseDown={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
          <h2 style={{ margin: 0, fontSize: "1.4rem", color: "#00ffff" }}>
            {mode === "login" ? "LOG IN" : "SIGN UP"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: "transparent",
              border: "none",
              color: "rgba(255,255,255,0.85)",
              fontSize: "20px",
              cursor: "pointer",
              padding: "6px 10px",
            }}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 10, alignItems: "center" }}>
          <input
            autoFocus
            type="text"
            value={loginId}
            onChange={(e) => setLoginId(e.target.value)}
            placeholder="Login ID"
            maxLength={32}
            style={{
              width: "min(380px, 100%)",
              padding: "10px",
              fontSize: "1.05rem",
              borderRadius: 8,
              border: "none",
              textAlign: "center",
            }}
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password (min 8 chars)"
            maxLength={72}
            style={{
              width: "min(380px, 100%)",
              padding: "10px",
              fontSize: "1.05rem",
              borderRadius: 8,
              border: "none",
              textAlign: "center",
            }}
          />

          {error && (
            <div style={{ color: "#ff6b6b", fontSize: "0.95rem" }}>{error}</div>
          )}

          <button
            type="button"
            onClick={onSubmit}
            disabled={isBusy}
            style={{
              marginTop: 6,
              width: "min(380px, 100%)",
              padding: "10px 16px",
              fontSize: "1.1rem",
              background: "#00ffff",
              color: "#001e36",
              border: "none",
              borderRadius: 10,
              cursor: isBusy ? "not-allowed" : "pointer",
              fontWeight: 800,
              opacity: isBusy ? 0.7 : 1,
            }}
          >
            {isBusy ? "PLEASE WAIT..." : (mode === "login" ? "LOG IN" : "SIGN UP")}
          </button>

          <div style={{ marginTop: 6, fontSize: "0.95rem", color: "rgba(255,255,255,0.8)" }}>
            {mode === "login" ? "New here?" : "Already have an account?"}{" "}
            <button
              type="button"
              onClick={() => setMode(mode === "login" ? "signup" : "login")}
              style={{
                background: "transparent",
                border: "none",
                color: "#00ffff",
                cursor: "pointer",
                fontWeight: 800,
                textDecoration: "underline",
                padding: 0,
              }}
            >
              {mode === "login" ? "Sign up" : "Log in"}
            </button>
          </div>

          {onContinueAsGuest && (
            <button
              type="button"
              onClick={onContinueAsGuest}
              style={{
                marginTop: 4,
                background: "transparent",
                border: "1px solid rgba(255,255,255,0.25)",
                color: "rgba(255,255,255,0.85)",
                padding: "8px 12px",
                borderRadius: 10,
                cursor: "pointer",
              }}
            >
              Continue as Guest
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

// Leaderboard Component
interface LeaderboardProps {
  leaderboard: LeaderboardEntry[];
  lastSubmittedId: number | null;
}

export const Leaderboard: React.FC<LeaderboardProps> = ({ leaderboard, lastSubmittedId }) => (
  <div style={{ marginTop: "20px", textAlign: "left", background: "rgba(0,0,0,0.3)", padding: "20px", borderRadius: "10px", width: "min(560px, 92vw)", boxSizing: "border-box" }}>
    <h3 style={{ borderBottom: "1px solid #00ffff", paddingBottom: "10px", color: "#00ffff", margin: "0 0 10px 0", fontSize: "clamp(1.1rem, 4.2vw, 1.5rem)", letterSpacing: "clamp(0.5px, 0.4vw, 1px)", overflowWrap: "anywhere" }}>LEADERBOARD</h3>
    <table style={{ width: "100%", borderCollapse: "collapse" }}>
      <tbody>
        {leaderboard.length === 0 ? (
          <tr><td style={{ color: "#ccc" }}>No records yet</td></tr>
        ) : (
          leaderboard.map((entry, i) => (
            <tr key={i} style={{ color: entry.id === lastSubmittedId ? "#ffd700" : "white" }}>
              <td style={{ padding: "5px 15px 5px 0" }}>{i + 1}.</td>
              <td style={{ padding: "5px 15px 5px 0" }}>
                <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                  <span>{entry.name}</span>
                  {entry.userId && entry.userId !== entry.name && (
                    <span style={{ fontSize: "12px", color: "rgba(255,255,255,0.7)" }}>
                      {entry.userId}
                    </span>
                  )}
                </div>
              </td>
              <td style={{ padding: "5px 0", textAlign: "right" }}>{entry.score}</td>
            </tr>
          ))
        )}
      </tbody>
    </table>
  </div>
);

// HUD Component
interface HUDProps {
  score: number;
  level: number;
  oxygen: number;
  hasTurtleShell?: boolean;
}

export const HUD: React.FC<HUDProps> = ({ score, level, oxygen, hasTurtleShell }) => (
  <div style={{
    position: "absolute",
    top: 20,
    left: 20,
    color: "white",
    fontFamily: "monospace",
    fontSize: "24px",
    textShadow: "2px 2px 0 #000"
  }}>
    <div style={{ display: "flex", gap: "20px" }}>
      <span>SCORE: {score.toString().padStart(5, '0')}</span>
      <span style={{ color: "#ffd700" }}>LVL {level}</span>
    </div>
    <div style={{ marginTop: "10px", display: "flex", alignItems: "center", gap: "10px" }}>
      <span>OXYGEN:</span>
      <div style={{
        width: "200px",
        height: "20px",
        background: "rgba(0,0,0,0.5)",
        border: "2px solid white",
        borderRadius: "4px",
        overflow: "hidden",
        position: "relative"
      }}>
        <div style={{
          width: `${(oxygen / OXYGEN_MAX) * 100}%`,
          height: "100%",
          background: oxygen < 5 ? "#ff3333" : "#00ffff",
          transition: "background 0.3s"
        }} />
        <span style={{
          position: "absolute",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          fontSize: "12px",
          color: "white",
          textShadow: "1px 1px 1px black"
        }}>{Math.ceil(oxygen)}s</span>
      </div>
    </div>
    <div style={{ marginTop: "8px", display: "flex", alignItems: "center", gap: "8px" }}>
      <span style={{ fontSize: "14px", opacity: 0.9 }}>SAVED:</span>
      <div style={{
        width: 28,
        height: 28,
        borderRadius: 8,
        border: "2px solid rgba(255,255,255,0.9)",
        background: hasTurtleShell ? "rgba(0,0,0,0.35)" : "rgba(0,0,0,0.15)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        boxShadow: hasTurtleShell ? "0 0 12px rgba(0,255,255,0.35)" : "none"
      }}>
        {hasTurtleShell ? (
          <img
            src={turtleShellItemImg}
            alt="Turtle shell saved"
            width={22}
            height={22}
            style={{
              display: "block",
              width: 22,
              height: 22,
              objectFit: "contain",
              filter: "drop-shadow(0 2px 0 rgba(0,0,0,0.35))"
            }}
            draggable={false}
          />
        ) : (
          <span style={{ fontSize: "14px", opacity: 0.4 }}>—</span>
        )}
      </div>
    </div>
  </div>
);

// Menu Overlay
interface MenuOverlayProps {
  leaderboard: LeaderboardEntry[];
  lastSubmittedId: number | null;
  onLoginClick?: () => void;
  loginId?: string | null;
  onLogoutClick?: () => void;
}

export const MenuOverlay: React.FC<MenuOverlayProps> = ({ leaderboard, lastSubmittedId, onLoginClick, loginId, onLogoutClick }) => (
  <div style={overlayStyle}>
    <h1 style={titleStyle}>DEEP DIVE DASH</h1>
    <p style={subtitleStyle}>Press SPACE to Start</p>
    <div style={instructionStyle}>
      Avoid Gaps! Collect Oxygen!<br />
      Beware of <span style={{ color: "#a67b5b", fontWeight: "bold" }}>Quick Sand</span> and <span style={{ color: "#e67e22", fontWeight: "bold" }}>Urchins</span>!<br />
      Collect <span style={{ color: "#5dade2", fontWeight: "bold" }}>Swordfish</span> for 3x SPEED & INVINCIBILITY!<br />
      Controls: Spacebar (Hold for High Jump) / Arrow Up
    </div>

    {loginId ? (
      <div style={{
        marginTop: "18px",
        display: "flex",
        flexDirection: "column",
        gap: "10px",
        alignItems: "center",
      }}>
        <div style={{ fontSize: "0.95rem", color: "rgba(255,255,255,0.85)" }}>
          Logged in as{" "}
          <span style={{ color: "#00ffff", fontWeight: 800 }}>{loginId}</span>
        </div>
        {onLogoutClick && (
          <button
            type="button"
            onClick={onLogoutClick}
            style={{
              padding: "10px 18px",
              fontSize: "1.05rem",
              background: "rgba(0,0,0,0.25)",
              color: "rgba(255,255,255,0.9)",
              border: "1px solid rgba(255,255,255,0.25)",
              borderRadius: "10px",
              cursor: "pointer",
              fontWeight: 700,
            }}
          >
            LOG OUT
          </button>
        )}
      </div>
    ) : (onLoginClick && (
      <button
        type="button"
        onClick={onLoginClick}
        style={{
          marginTop: "18px",
          padding: "10px 18px",
          fontSize: "1.05rem",
          background: "rgba(0,0,0,0.25)",
          color: "#00ffff",
          border: "1px solid rgba(0,255,255,0.8)",
          borderRadius: "10px",
          cursor: "pointer",
          fontWeight: 700,
        }}
      >
        LOG IN / SIGN UP
      </button>
    ))}
    <Leaderboard leaderboard={leaderboard} lastSubmittedId={lastSubmittedId} />
  </div>
);

// Input Name Overlay
interface InputNameOverlayProps {
  score: number;
  playerName: string;
  setPlayerName: (name: string) => void;
  isLoggedIn?: boolean;
  loginId?: string | null;
  onOpenLogin?: () => void;
  onSubmit: (e: React.FormEvent) => void;
}

export const InputNameOverlay: React.FC<InputNameOverlayProps> = ({ score, playerName, setPlayerName, isLoggedIn, loginId, onOpenLogin, onSubmit }) => (
  <div style={overlayStyle}>
    <h1 style={{ ...titleStyle, fontSize: "3rem", color: "#ffd700" }}>NEW HIGH SCORE!</h1>
    <p style={{ fontSize: "1.5rem", marginBottom: "20px" }}>Score: {score}</p>
    <form onSubmit={onSubmit} style={{ display: "flex", flexDirection: "column", gap: "10px", alignItems: "center" }}>
      <input
        autoFocus
        type="text"
        value={playerName}
        onChange={(e) => setPlayerName(e.target.value)}
        placeholder={isLoggedIn ? "Leaderboard name (optional)" : "Leaderboard name (optional)"}
        maxLength={40}
        style={{
          padding: "10px",
          fontSize: "1.2rem",
          borderRadius: "5px",
          border: "none",
          textAlign: "center",
          width: "300px",
          touchAction: "auto"
        }}
      />
      {isLoggedIn && (
        <div style={{ fontSize: "13px", color: "rgba(255,255,255,0.8)", marginTop: "-2px" }}>
          If blank, your ID will be shown: <span style={{ color: "#00ffff", fontWeight: 700 }}>{loginId || "—"}</span>
        </div>
      )}
      {!isLoggedIn && onOpenLogin && (
        <button
          type="button"
          onClick={onOpenLogin}
          style={{
            padding: "10px 20px",
            fontSize: "1.05rem",
            background: "rgba(0,0,0,0.25)",
            color: "#00ffff",
            border: "1px solid rgba(0,255,255,0.8)",
            borderRadius: "8px",
            cursor: "pointer",
            fontWeight: 700,
          }}
        >
          LOG IN TO SUBMIT
        </button>
      )}
      <button
        type="submit"
        style={{
          padding: "10px 20px",
          fontSize: "1.2rem",
          background: "#00ffff",
          color: "#001e36",
          border: "none",
          borderRadius: "5px",
          cursor: "pointer",
          fontWeight: "bold",
          touchAction: "auto"
        }}
      >
        SUBMIT
      </button>
    </form>
  </div>
);

// Game Over Overlay
interface GameOverOverlayProps {
  score: number;
  didSubmit: boolean;
  leaderboard: LeaderboardEntry[];
  lastSubmittedId: number | null;
}

export const GameOverOverlay: React.FC<GameOverOverlayProps> = ({ score, didSubmit, leaderboard, lastSubmittedId }) => (
  <div style={overlayStyle}>
    <h1 style={{ ...titleStyle, color: didSubmit ? "#ffd700" : "#ff6b6b" }}>
      {didSubmit ? "LEADERBOARD" : "GAME OVER"}
    </h1>
    <div style={scoreStyle}>Score: {score}</div>
    <Leaderboard leaderboard={leaderboard} lastSubmittedId={lastSubmittedId} />
    <p style={{ ...subtitleStyle, marginTop: "40px" }}>Press SPACE to Retry</p>
  </div>
);
