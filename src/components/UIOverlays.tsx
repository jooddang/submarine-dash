import React from "react";
import type { LeaderboardEntry } from "../types";
import { OXYGEN_MAX } from "../constants";

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
              <td style={{ padding: "5px 15px 5px 0" }}>{entry.name}</td>
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
          <svg width="22" height="22" viewBox="0 0 24 24" aria-label="Turtle shell saved">
            <ellipse cx="13" cy="13" rx="8" ry="6.2" fill="#8d6e63" />
            <ellipse cx="6" cy="13" rx="3.5" ry="2.6" fill="#2ecc71" />
            <circle cx="5" cy="12.2" r="0.8" fill="#111" />
            <path d="M8 13h10" stroke="rgba(255,255,255,0.55)" strokeWidth="1.2" />
            <path d="M11 9.5l3 7" stroke="rgba(255,255,255,0.35)" strokeWidth="1.2" />
          </svg>
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
}

export const MenuOverlay: React.FC<MenuOverlayProps> = ({ leaderboard, lastSubmittedId }) => (
  <div style={overlayStyle}>
    <h1 style={titleStyle}>DEEP DIVE DASH</h1>
    <p style={subtitleStyle}>Press SPACE to Start</p>
    <div style={instructionStyle}>
      Avoid Gaps! Collect Oxygen!<br />
      Beware of <span style={{ color: "#a67b5b", fontWeight: "bold" }}>Quick Sand</span> and <span style={{ color: "#e67e22", fontWeight: "bold" }}>Urchins</span>!<br />
      Collect <span style={{ color: "#5dade2", fontWeight: "bold" }}>Swordfish</span> for 3x SPEED & INVINCIBILITY!<br />
      Controls: Spacebar (Hold for High Jump) / Arrow Up
    </div>
    <Leaderboard leaderboard={leaderboard} lastSubmittedId={lastSubmittedId} />
  </div>
);

// Input Name Overlay
interface InputNameOverlayProps {
  score: number;
  playerName: string;
  setPlayerName: (name: string) => void;
  onSubmit: (e: React.FormEvent) => void;
}

export const InputNameOverlay: React.FC<InputNameOverlayProps> = ({ score, playerName, setPlayerName, onSubmit }) => (
  <div style={overlayStyle}>
    <h1 style={{ ...titleStyle, fontSize: "3rem", color: "#ffd700" }}>NEW HIGH SCORE!</h1>
    <p style={{ fontSize: "1.5rem", marginBottom: "20px" }}>Score: {score}</p>
    <form onSubmit={onSubmit} style={{ display: "flex", flexDirection: "column", gap: "10px", alignItems: "center" }}>
      <input
        autoFocus
        type="text"
        value={playerName}
        onChange={(e) => setPlayerName(e.target.value)}
        placeholder="Enter Your Name"
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
