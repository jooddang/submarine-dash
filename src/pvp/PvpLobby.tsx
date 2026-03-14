import React, { useState, useEffect } from "react";
import type { PvpMatchConfig, PvpMatchFormat, PvpPowerUpMode, PvpBet } from "./pvpTypes";
import { authAPI, inventoryAPI, type AuthUser } from "../api";
import { DEFAULT_SKIN_ID } from "../skins";

interface PvpLobbyProps {
  onStartMatch: (config: PvpMatchConfig) => void;
  onBack: () => void;
}

const emptyBet: PvpBet = { coins: 0, dolphins: 0, tubePieces: 0 };

export const PvpLobby: React.FC<PvpLobbyProps> = ({ onStartMatch, onBack }) => {
  const [format, setFormat] = useState<PvpMatchFormat>("single");
  const [powerUpMode, setPowerUpMode] = useState<PvpPowerUpMode>("earned");
  const [betting, setBetting] = useState(false);

  // Auth state for each player
  const [p1Auth, setP1Auth] = useState<AuthUser | null>(null);
  const [p2Auth, setP2Auth] = useState<AuthUser | null>(null);
  const [p1LoginId, setP1LoginId] = useState("");
  const [p1Password, setP1Password] = useState("");
  const [p2LoginId, setP2LoginId] = useState("");
  const [p2Password, setP2Password] = useState("");
  const [p1Error, setP1Error] = useState<string | null>(null);
  const [p2Error, setP2Error] = useState<string | null>(null);
  const [p1Busy, setP1Busy] = useState(false);
  const [p2Busy, setP2Busy] = useState(false);

  // Bet amounts
  const [p1Bet, setP1Bet] = useState<PvpBet>({ ...emptyBet });
  const [p2Bet, setP2Bet] = useState<PvpBet>({ ...emptyBet });
  const [p1Confirmed, setP1Confirmed] = useState(false);
  const [p2Confirmed, setP2Confirmed] = useState(false);

  // Inventory info (loaded after login for betting)
  const [p1Inventory, setP1Inventory] = useState<{ coins: number; dolphins: number; tubePieces: number }>({ coins: 0, dolphins: 0, tubePieces: 0 });
  const [p2Inventory, setP2Inventory] = useState<{ coins: number; dolphins: number; tubePieces: number }>({ coins: 0, dolphins: 0, tubePieces: 0 });

  const needsLogin = betting || powerUpMode === "inventory";

  // Login handler for a player
  const handleLogin = async (player: 1 | 2) => {
    const loginId = player === 1 ? p1LoginId : p2LoginId;
    const password = player === 1 ? p1Password : p2Password;
    const setAuth = player === 1 ? setP1Auth : setP2Auth;
    const setError = player === 1 ? setP1Error : setP2Error;
    const setBusy = player === 1 ? setP1Busy : setP2Busy;
    const setInv = player === 1 ? setP1Inventory : setP2Inventory;

    if (!loginId || !password) {
      setError("Enter login ID and password");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const result = await authAPI.login(loginId, password);
      if (result && "userId" in result) {
        setAuth(result);
        // Load inventory
        const inv = result.inventory;
        if (inv) {
          setInv({
            coins: inv.coins || 0,
            dolphins: inv.dolphinSaved || 0,
            tubePieces: inv.tube?.pieces || 0,
          });
        }
      } else {
        setError("Login failed");
      }
    } catch {
      setError("Login failed");
    } finally {
      setBusy(false);
    }
  };

  const canStart = () => {
    if (needsLogin && (!p1Auth || !p2Auth)) return false;
    if (betting && (!p1Confirmed || !p2Confirmed)) return false;
    return true;
  };

  const handleStart = () => {
    if (!canStart()) return;
    onStartMatch({
      format,
      powerUpMode,
      betting,
      p1Bet: betting ? p1Bet : { ...emptyBet },
      p2Bet: betting ? p2Bet : { ...emptyBet },
      p1UserId: p1Auth?.userId ?? null,
      p2UserId: p2Auth?.userId ?? null,
      p1LoginId: p1Auth?.loginId ?? null,
      p2LoginId: p2Auth?.loginId ?? null,
      p1SkinId: DEFAULT_SKIN_ID,
      p2SkinId: DEFAULT_SKIN_ID,
    });
  };

  // Styles
  const containerStyle: React.CSSProperties = {
    position: "fixed", top: 0, left: 0, width: "100%", height: "100%",
    background: "linear-gradient(180deg, #001428 0%, #000a14 100%)",
    display: "flex", flexDirection: "column", alignItems: "center",
    overflow: "auto", fontFamily: "monospace", color: "white",
    padding: "20px 16px",
    boxSizing: "border-box",
  };

  const sectionStyle: React.CSSProperties = {
    width: "100%", maxWidth: 520,
    background: "rgba(0, 40, 80, 0.3)",
    border: "1px solid rgba(0, 150, 255, 0.2)",
    borderRadius: 12, padding: "16px 20px",
    marginBottom: 14,
  };

  const btnGroupStyle: React.CSSProperties = {
    display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8,
  };

  const optionBtn = (active: boolean): React.CSSProperties => ({
    padding: "8px 16px",
    fontSize: "0.85rem",
    fontWeight: 700,
    fontFamily: "monospace",
    background: active ? "rgba(0, 180, 255, 0.3)" : "rgba(255, 255, 255, 0.05)",
    border: active ? "2px solid #00b4ff" : "1px solid rgba(255,255,255,0.15)",
    borderRadius: 8,
    color: active ? "#fff" : "#888",
    cursor: "pointer",
  });

  const inputStyle: React.CSSProperties = {
    padding: "8px 12px",
    fontSize: "0.85rem",
    fontFamily: "monospace",
    background: "rgba(0, 0, 0, 0.4)",
    border: "1px solid rgba(255,255,255,0.2)",
    borderRadius: 6,
    color: "white",
    width: "100%",
    boxSizing: "border-box",
  };

  const numInputStyle: React.CSSProperties = {
    ...inputStyle,
    width: 80,
  };

  const loginBtn: React.CSSProperties = {
    padding: "8px 20px",
    fontSize: "0.85rem",
    fontWeight: 700,
    fontFamily: "monospace",
    background: "rgba(0, 180, 255, 0.25)",
    border: "1px solid rgba(0, 150, 255, 0.5)",
    borderRadius: 8,
    color: "white",
    cursor: "pointer",
    marginTop: 8,
  };

  const startBtn: React.CSSProperties = {
    padding: "16px 48px",
    fontSize: "1.2rem",
    fontWeight: 900,
    fontFamily: "monospace",
    background: canStart() ? "rgba(0, 255, 136, 0.25)" : "rgba(100,100,100,0.2)",
    border: canStart() ? "2px solid #00ff88" : "2px solid rgba(100,100,100,0.3)",
    borderRadius: 14,
    color: canStart() ? "#fff" : "#555",
    cursor: canStart() ? "pointer" : "not-allowed",
    marginTop: 10,
  };

  const renderLoginSection = (player: 1 | 2) => {
    const auth = player === 1 ? p1Auth : p2Auth;
    const loginId = player === 1 ? p1LoginId : p2LoginId;
    const password = player === 1 ? p1Password : p2Password;
    const error = player === 1 ? p1Error : p2Error;
    const busy = player === 1 ? p1Busy : p2Busy;
    const setLid = player === 1 ? setP1LoginId : setP2LoginId;
    const setPwd = player === 1 ? setP1Password : setP2Password;

    if (auth) {
      return (
        <div style={{ color: "#00ff88", fontSize: "0.9rem", marginTop: 8 }}>
          Logged in as: {auth.loginId}
        </div>
      );
    }

    return (
      <div style={{ marginTop: 8 }}>
        <input
          style={{ ...inputStyle, marginBottom: 6 }}
          placeholder="Login ID"
          value={loginId}
          onChange={e => setLid(e.target.value)}
        />
        <input
          style={inputStyle}
          type="password"
          placeholder="Password"
          value={password}
          onChange={e => setPwd(e.target.value)}
        />
        {error && <div style={{ color: "#ff4444", fontSize: "0.8rem", marginTop: 4 }}>{error}</div>}
        <button style={loginBtn} onClick={() => handleLogin(player)} disabled={busy}>
          {busy ? "..." : "Login"}
        </button>
      </div>
    );
  };

  const renderBetSection = (player: 1 | 2) => {
    const bet = player === 1 ? p1Bet : p2Bet;
    const setBet = player === 1 ? setP1Bet : setP2Bet;
    const confirmed = player === 1 ? p1Confirmed : p2Confirmed;
    const setConfirmed = player === 1 ? setP1Confirmed : setP2Confirmed;
    const inv = player === 1 ? p1Inventory : p2Inventory;

    if (confirmed) {
      return (
        <div style={{ color: "#00ff88", fontSize: "0.85rem", marginTop: 8 }}>
          Confirmed: {bet.coins > 0 ? `${bet.coins} coins` : ""} {bet.dolphins > 0 ? `${bet.dolphins} dolphins` : ""} {bet.tubePieces > 0 ? `${bet.tubePieces} tubes` : ""}
          {bet.coins === 0 && bet.dolphins === 0 && bet.tubePieces === 0 ? "No bet" : ""}
          <button
            style={{ ...loginBtn, fontSize: "0.75rem", padding: "4px 12px", marginLeft: 8 }}
            onClick={() => setConfirmed(false)}
          >
            Edit
          </button>
        </div>
      );
    }

    return (
      <div style={{ marginTop: 8 }}>
        <div style={{ fontSize: "0.8rem", color: "#888", marginBottom: 6 }}>
          Available: {inv.coins} coins, {inv.dolphins} dolphins, {inv.tubePieces} tube pieces
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <label style={{ fontSize: "0.8rem" }}>
            Coins:
            <input
              style={numInputStyle}
              type="number"
              min={0}
              max={inv.coins}
              value={bet.coins}
              onChange={e => setBet({ ...bet, coins: Math.max(0, Math.min(inv.coins, parseInt(e.target.value) || 0)) })}
            />
          </label>
          <label style={{ fontSize: "0.8rem" }}>
            Dolphins:
            <input
              style={numInputStyle}
              type="number"
              min={0}
              max={inv.dolphins}
              value={bet.dolphins}
              onChange={e => setBet({ ...bet, dolphins: Math.max(0, Math.min(inv.dolphins, parseInt(e.target.value) || 0)) })}
            />
          </label>
          <label style={{ fontSize: "0.8rem" }}>
            Tubes:
            <input
              style={numInputStyle}
              type="number"
              min={0}
              max={inv.tubePieces}
              value={bet.tubePieces}
              onChange={e => setBet({ ...bet, tubePieces: Math.max(0, Math.min(inv.tubePieces, parseInt(e.target.value) || 0)) })}
            />
          </label>
        </div>
        <button style={{ ...loginBtn, marginTop: 8 }} onClick={() => setConfirmed(true)}>
          Confirm Bet
        </button>
      </div>
    );
  };

  return (
    <div style={containerStyle}>
      <div style={{ fontSize: "clamp(24px, 5vw, 36px)", fontWeight: 900, color: "#00ccff", marginBottom: 20 }}>
        PVP LOBBY
      </div>

      {/* Match Format */}
      <div style={sectionStyle}>
        <div style={{ fontWeight: 700, fontSize: "0.95rem", marginBottom: 4 }}>Match Format</div>
        <div style={btnGroupStyle}>
          {(["single", "bo3", "bo5"] as PvpMatchFormat[]).map(f => (
            <button key={f} style={optionBtn(format === f)} onClick={() => setFormat(f)}>
              {f === "single" ? "Single Game" : f === "bo3" ? "Best of 3" : "Best of 5"}
            </button>
          ))}
        </div>
      </div>

      {/* Power-up Mode */}
      <div style={sectionStyle}>
        <div style={{ fontWeight: 700, fontSize: "0.95rem", marginBottom: 4 }}>Power-Up Mode</div>
        <div style={btnGroupStyle}>
          {(["earned", "inventory", "none", "score_attack"] as PvpPowerUpMode[]).map(m => (
            <button key={m} style={optionBtn(powerUpMode === m)} onClick={() => {
              setPowerUpMode(m);
              // Reset betting if switching to no-login modes
              if (m !== "inventory" && !betting) {
                // no change needed
              }
            }}>
              {m === "earned" ? "Earned Only" : m === "inventory" ? "Inventory" : m === "none" ? "No Power-Ups" : "Score Attack"}
            </button>
          ))}
        </div>
        <div style={{ fontSize: "0.75rem", color: "#666", marginTop: 6 }}>
          {powerUpMode === "earned" && "Use only items found during gameplay."}
          {powerUpMode === "inventory" && "Bring dolphins & tubes from your inventory. Login required."}
          {powerUpMode === "none" && "Pure skill - no power-ups, only oxygen. Urchins still lethal."}
          {powerUpMode === "score_attack" && "Items give points instead of effects. Swordfish +300, Tube +75, Turtle +100, Urchin -500. Highest score wins!"}
        </div>
      </div>

      {/* Betting */}
      <div style={sectionStyle}>
        <div style={{ fontWeight: 700, fontSize: "0.95rem", marginBottom: 4 }}>Betting</div>
        <div style={btnGroupStyle}>
          <button style={optionBtn(!betting)} onClick={() => setBetting(false)}>No Betting</button>
          <button style={optionBtn(betting)} onClick={() => setBetting(true)}>Bet Items</button>
        </div>
        {betting && (
          <div style={{ fontSize: "0.75rem", color: "#ffcc00", marginTop: 6 }}>
            Both players must log in and confirm their bets. Winner takes all!
          </div>
        )}
      </div>

      {/* Login sections (only when needed) */}
      {needsLogin && (
        <>
          <div style={sectionStyle}>
            <div style={{ fontWeight: 700, fontSize: "0.95rem", color: "#4facfe" }}>Player 1 Login</div>
            {renderLoginSection(1)}
          </div>
          <div style={sectionStyle}>
            <div style={{ fontWeight: 700, fontSize: "0.95rem", color: "#ff8c42" }}>Player 2 Login</div>
            {renderLoginSection(2)}
          </div>
        </>
      )}

      {/* Betting sections */}
      {betting && p1Auth && p2Auth && (
        <>
          <div style={sectionStyle}>
            <div style={{ fontWeight: 700, fontSize: "0.95rem", color: "#4facfe" }}>Player 1 Bet</div>
            {renderBetSection(1)}
          </div>
          <div style={sectionStyle}>
            <div style={{ fontWeight: 700, fontSize: "0.95rem", color: "#ff8c42" }}>Player 2 Bet</div>
            {renderBetSection(2)}
          </div>
        </>
      )}

      {/* Action buttons */}
      <div style={{ display: "flex", gap: 12, marginTop: 10, marginBottom: 30 }}>
        <button
          style={{ ...loginBtn, background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.15)", color: "#888" }}
          onClick={onBack}
        >
          Back
        </button>
        <button style={startBtn} onClick={handleStart} disabled={!canStart()}>
          START MATCH
        </button>
      </div>
    </div>
  );
};
