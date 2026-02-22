import React from "react";
import type { LeaderboardEntry, WeeklyLeaderboard } from "../types";
import { OXYGEN_MAX, TUBE_PIECE_UNLOCK_SCORE, TUBE_PIECES_PER_TUBE } from "../constants";
import { SKIN_CATALOG, RARITY_COLORS, getSkinImage, getSkinDef, type SkinDef, type SkinRarity } from "../skins";
import turtleShellItemImg from "../../turtle-shell-item.png";
import dolphinItemImg from "../../dolphin.png";
import tubeImg from "../../tube.png";

type AuthMode = "login" | "signup" | "changePassword";

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
  justifyContent: "flex-start",
  alignItems: "center",
  padding: "24px 16px",
  paddingBottom: "40px",
  boxSizing: "border-box",
  color: "white",
  textAlign: "center",
  zIndex: 10,
  overflowY: "auto",
  WebkitOverflowScrolling: "touch",
  touchAction: "pan-y",
  overscrollBehavior: "contain",
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

const panelTitleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: "1.35rem",
  color: "#00ffff",
};

const panelSubtitleStyle: React.CSSProperties = {
  margin: "6px 0 0 0",
  fontSize: "0.95rem",
  color: "rgba(255,255,255,0.8)",
};

interface AuthModalProps {
  open: boolean;
  mode: AuthMode;
  setMode: (m: AuthMode) => void;
  loginId: string;
  setLoginId: (v: string) => void;
  password: string;
  setPassword: (v: string) => void;
  newPassword: string;
  setNewPassword: (v: string) => void;
  newPasswordConfirm: string;
  setNewPasswordConfirm: (v: string) => void;
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
  newPassword,
  setNewPassword,
  newPasswordConfirm,
  setNewPasswordConfirm,
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
            {mode === "login" ? "LOG IN" : mode === "signup" ? "SIGN UP" : "CHANGE PASSWORD"}
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
          {mode !== "changePassword" ? (
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
          ) : (
            <>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Current password"
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
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="New password (min 8 chars)"
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
              <input
                type="password"
                value={newPasswordConfirm}
                onChange={(e) => setNewPasswordConfirm(e.target.value)}
                placeholder="Confirm new password"
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
            </>
          )}

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
            {isBusy ? "PLEASE WAIT..." : (mode === "login" ? "LOG IN" : mode === "signup" ? "SIGN UP" : "CHANGE PASSWORD")}
          </button>

          <div style={{ marginTop: 6, fontSize: "0.95rem", color: "rgba(255,255,255,0.8)" }}>
            {mode === "login" ? (
              <>
                New here?{" "}
                <button
                  type="button"
                  onClick={() => setMode("signup")}
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
                  Sign up
                </button>
                {" · "}
                <button
                  type="button"
                  onClick={() => {
                    setMode("changePassword");
                  }}
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
                  Change password
                </button>
              </>
            ) : mode === "signup" ? (
              <>
                Already have an account?{" "}
                <button
                  type="button"
                  onClick={() => setMode("login")}
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
                  Log in
                </button>
              </>
            ) : (
              <>
                Back to{" "}
                <button
                  type="button"
                  onClick={() => setMode("login")}
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
                  Log in
                </button>
                {" · "}
                <button
                  type="button"
                  onClick={() => setMode("signup")}
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
                  Sign up
                </button>
              </>
            )}
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

type DailyMission = {
  id: string;
  title: string;
  target: number;
  type: "reach_score" | "play_runs" | "collect_oxygen";
};

type DailyMissionsPanelProps = {
  open: boolean;
  onClose: () => void;
  date: string | null;
  streakCurrent: number | null;
  missions: DailyMission[];
  progress: { runs: number; oxygenCollected: number; maxScore: number; completedMissionIds: string[] } | null;
};

function missionProgressLabel(m: DailyMission, progress: DailyMissionsPanelProps["progress"]) {
  if (!progress) return "—";
  if (m.type === "reach_score") return `${Math.min(progress.maxScore, m.target)}/${m.target}`;
  if (m.type === "play_runs") return `${Math.min(progress.runs, m.target)}/${m.target}`;
  return `${Math.min(progress.oxygenCollected, m.target)}/${m.target}`;
}

export const DailyMissionsPanel: React.FC<DailyMissionsPanelProps> = ({
  open,
  onClose,
  date,
  streakCurrent,
  missions,
  progress,
}) => {
  if (!open) return null;
  const completed = new Set(progress?.completedMissionIds || []);
  return (
    <div style={modalBackdropStyle} onMouseDown={onClose}>
      <div style={modalCardStyle} onMouseDown={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
          <div style={{ textAlign: "left" }}>
            <h2 style={panelTitleStyle}>STREAK</h2>
            <p style={panelSubtitleStyle}>
              {date ? `Today (${date})` : "Today"} ·{" "}
              <span style={{ color: "#ffd700", fontWeight: 800 }}>{streakCurrent ?? 0} day</span>
            </p>
          </div>
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

        <div style={{ marginTop: 14, textAlign: "left" }}>
          {missions.length === 0 ? (
            <div style={{ color: "rgba(255,255,255,0.75)" }}>No missions found.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {missions.map((m) => {
                const isDone = completed.has(m.id);
                return (
                  <div
                    key={m.id}
                    style={{
                      padding: "10px 12px",
                      borderRadius: 12,
                      border: `1px solid ${isDone ? "rgba(0,255,255,0.65)" : "rgba(255,255,255,0.18)"}`,
                      background: isDone ? "rgba(0,255,255,0.08)" : "rgba(0,0,0,0.22)",
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: 12,
                    }}
                  >
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      <div style={{ fontWeight: 800, color: isDone ? "#00ffff" : "rgba(255,255,255,0.95)" }}>
                        {m.title}
                      </div>
                      <div style={{ fontSize: "0.9rem", color: "rgba(255,255,255,0.75)" }}>
                        Progress: {missionProgressLabel(m, progress)}
                      </div>
                    </div>
                    <div
                      style={{
                        fontSize: "0.9rem",
                        fontWeight: 900,
                        color: isDone ? "#00ffff" : "rgba(255,255,255,0.55)",
                      }}
                    >
                      {isDone ? "DONE" : ""}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {!progress && (
            <div style={{ marginTop: 12, fontSize: "0.95rem", color: "rgba(255,255,255,0.8)" }}>
              Log in to track progress.
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

// --- Reward / FX overlays ---

// Inventory / Profile Panel
type InventoryPanelProps = {
  open: boolean;
  onClose: () => void;
  loginId: string | null;
  coinBalance: number;
  dolphinCount: number;
  tubePieces: number;
  tubeRescueCharges: number;
  streakCurrent: number;
};

export const InventoryPanel: React.FC<InventoryPanelProps> = ({
  open,
  onClose,
  loginId,
  coinBalance,
  dolphinCount,
  tubePieces,
  tubeRescueCharges,
  streakCurrent,
}) => {
  if (!open) return null;

  const items: { label: string; value: string; img?: string; color: string }[] = [
    { label: "Coins", value: String(coinBalance), color: "#ffd700" },
    { label: "Dolphins", value: String(dolphinCount), img: dolphinItemImg, color: "#00ffff" },
    { label: "Tube Pieces", value: `${tubePieces}/${TUBE_PIECES_PER_TUBE}`, img: tubeImg, color: "#00ffff" },
    { label: "Tube Charges", value: String(tubeRescueCharges), img: tubeImg, color: "#7CFF6B" },
    { label: "Streak", value: `${streakCurrent} day${streakCurrent === 1 ? "" : "s"}`, color: "#ffd700" },
  ];

  return (
    <div style={modalBackdropStyle} onMouseDown={onClose}>
      <div style={modalCardStyle} onMouseDown={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
          <div style={{ textAlign: "left" }}>
            <h2 style={panelTitleStyle}>INVENTORY</h2>
            {loginId && (
              <p style={panelSubtitleStyle}>{loginId}</p>
            )}
          </div>
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

        <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 10 }}>
          {items.map((item) => (
            <div
              key={item.label}
              style={{
                padding: "10px 12px",
                borderRadius: 12,
                border: "1px solid rgba(255,255,255,0.18)",
                background: "rgba(0,0,0,0.22)",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 12,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                {item.img && (
                  <img
                    src={item.img}
                    alt={item.label}
                    width={24}
                    height={24}
                    style={{ width: 24, height: 24, objectFit: "contain" }}
                    draggable={false}
                  />
                )}
                <span style={{ fontWeight: 800, color: "rgba(255,255,255,0.95)" }}>{item.label}</span>
              </div>
              <span style={{ fontWeight: 900, color: item.color, fontSize: "1.1rem" }}>{item.value}</span>
            </div>
          ))}
        </div>

        {!loginId && (
          <div style={{ marginTop: 12, fontSize: "0.95rem", color: "rgba(255,255,255,0.75)" }}>
            Log in to persist your inventory across sessions.
          </div>
        )}
      </div>
    </div>
  );
};

// ── Skin Selection Panel ──────────────────────────────────────────────

type SkinPanelProps = {
  open: boolean;
  onClose: () => void;
  coinBalance: number;
  ownedSkins: string[];
  equippedSkinId: string;
  onPurchase: (skinId: string) => void;
  onEquip: (skinId: string) => void;
  busy: boolean;
};

function SkinMiniPreview({ skin }: { skin: SkinDef }) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);

  React.useEffect(() => {
    const cvs = canvasRef.current;
    if (!cvs) return;
    const ctx = cvs.getContext("2d");
    if (!ctx) return;

    const size = 80; // 2x for retina
    cvs.width = size;
    cvs.height = size;

    const img = getSkinImage(skin);
    if (!img) return;

    const draw = () => {
      ctx.clearRect(0, 0, size, size);

      // Fit image into canvas preserving aspect ratio
      const aspect = img.naturalWidth / img.naturalHeight;
      let dw = size, dh = size;
      if (aspect > 1) { dh = size / aspect; } else { dw = size * aspect; }
      const dx = (size - dw) / 2;
      const dy = (size - dh) / 2;

      if (skin.tint) {
        // Draw original, apply 'color' blend tint, restore alpha
        ctx.drawImage(img, dx, dy, dw, dh);
        ctx.globalCompositeOperation = "color";
        ctx.fillStyle = skin.tint;
        ctx.fillRect(0, 0, size, size);
        ctx.globalCompositeOperation = "destination-in";
        ctx.drawImage(img, dx, dy, dw, dh);
        ctx.globalCompositeOperation = "source-over";
      } else {
        ctx.drawImage(img, dx, dy, dw, dh);
      }
    };

    if (img.complete && img.naturalWidth > 0) {
      draw();
    } else {
      img.onload = draw;
    }
  }, [skin]);

  return (
    <div style={{ width: 44, height: 44, borderRadius: 8, overflow: "hidden", background: "rgba(0,0,0,0.3)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
      <canvas ref={canvasRef} width={80} height={80} style={{ width: 40, height: 40 }} />
    </div>
  );
}

function rarityLabel(r: SkinRarity): string {
  return r.charAt(0).toUpperCase() + r.slice(1);
}

export const SkinPanel: React.FC<SkinPanelProps> = ({
  open,
  onClose,
  coinBalance,
  ownedSkins,
  equippedSkinId,
  onPurchase,
  onEquip,
  busy,
}) => {
  if (!open) return null;
  const owned = new Set(ownedSkins);
  return (
    <div style={modalBackdropStyle} onMouseDown={onClose}>
      <div
        style={{ ...modalCardStyle, width: "min(560px, 94vw)", maxHeight: "80vh", overflowY: "auto", WebkitOverflowScrolling: "touch" }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
          <div style={{ textAlign: "left" }}>
            <h2 style={panelTitleStyle}>SKINS</h2>
            <p style={panelSubtitleStyle}>
              <span style={{ color: "#ffd700", fontWeight: 800 }}>{coinBalance}</span> coins
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{ background: "transparent", border: "none", color: "rgba(255,255,255,0.85)", fontSize: "20px", cursor: "pointer", padding: "6px 10px" }}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 10 }}>
          {SKIN_CATALOG.map((skin) => {
            const isOwned = owned.has(skin.id) || skin.id === "default";
            const isEquipped = equippedSkinId === skin.id;
            const canAfford = coinBalance >= skin.cost;
            return (
              <div
                key={skin.id}
                style={{
                  padding: "10px 12px",
                  borderRadius: 12,
                  border: `1px solid ${isEquipped ? "rgba(0,255,255,0.7)" : "rgba(255,255,255,0.18)"}`,
                  background: isEquipped ? "rgba(0,255,255,0.08)" : "rgba(0,0,0,0.22)",
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                }}
              >
                <SkinMiniPreview skin={skin} />
                <div style={{ flex: 1, textAlign: "left" }}>
                  <div style={{ fontWeight: 800, color: "rgba(255,255,255,0.95)" }}>{skin.name}</div>
                  <div style={{ fontSize: "0.85rem", display: "flex", gap: 8, alignItems: "center", marginTop: 2 }}>
                    <span style={{ color: RARITY_COLORS[skin.rarity], fontWeight: 700, textTransform: "uppercase", fontSize: "0.75rem", letterSpacing: 0.5 }}>
                      {rarityLabel(skin.rarity)}
                    </span>
                    {skin.trailType !== "none" && (
                      <span style={{ color: "rgba(255,255,255,0.6)", fontSize: "0.75rem" }}>
                        {skin.trailType} trail
                      </span>
                    )}
                  </div>
                </div>
                <div>
                  {isEquipped ? (
                    <span style={{ fontSize: "0.85rem", fontWeight: 900, color: "#00ffff" }}>EQUIPPED</span>
                  ) : isOwned ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => onEquip(skin.id)}
                      style={{
                        padding: "6px 14px", borderRadius: 8, border: "1px solid rgba(0,255,255,0.6)",
                        background: "rgba(0,255,255,0.12)", color: "#00ffff", fontWeight: 800,
                        fontSize: "0.85rem", cursor: busy ? "not-allowed" : "pointer", opacity: busy ? 0.6 : 1,
                      }}
                    >
                      EQUIP
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={busy || !canAfford}
                      onClick={() => onPurchase(skin.id)}
                      style={{
                        padding: "6px 14px", borderRadius: 8, border: "none",
                        background: canAfford ? "#ffd700" : "rgba(255,255,255,0.15)",
                        color: canAfford ? "#001e36" : "rgba(255,255,255,0.5)",
                        fontWeight: 800, fontSize: "0.85rem",
                        cursor: (busy || !canAfford) ? "not-allowed" : "pointer",
                        opacity: busy ? 0.6 : 1,
                      }}
                    >
                      {skin.cost} coins
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

function rand(min: number, max: number) {
  return Math.random() * (max - min) + min;
}

const confettiColors = ["#00ffff", "#ffd700", "#ff6b6b", "#7CFF6B", "#B36BFF", "#ffffff"];

const ConfettiCanvas: React.FC<{ active: boolean; durationMs?: number }> = ({ active, durationMs = 2200 }) => {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);

  React.useEffect(() => {
    if (!active) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };
    resize();
    window.addEventListener("resize", resize);

    type P = {
      x: number;
      y: number;
      vx: number;
      vy: number;
      size: number;
      rot: number;
      vr: number;
      color: string;
      life: number;
    };

    const particles: P[] = Array.from({ length: 160 }, () => ({
      x: rand(0, canvas.width),
      y: rand(-canvas.height * 0.2, canvas.height * 0.15),
      vx: rand(-260, 260),
      vy: rand(80, 420),
      size: rand(5, 10),
      rot: rand(0, Math.PI * 2),
      vr: rand(-10, 10),
      color: confettiColors[Math.floor(Math.random() * confettiColors.length)],
      life: rand(0.7, 1.0),
    }));

    const start = performance.now();
    let raf = 0;
    const tick = (t: number) => {
      const elapsed = t - start;
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const dt = 1 / 60;
      const g = 520;

      for (const p of particles) {
        p.vy += g * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.rot += p.vr * dt;
        p.life -= dt / (durationMs / 1000);

        // Wrap horizontally for a fuller spread.
        if (p.x < -20) p.x = canvas.width + 20;
        if (p.x > canvas.width + 20) p.x = -20;

        if (p.life <= 0) continue;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.globalAlpha = Math.max(0, Math.min(1, p.life));
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.65);
        ctx.restore();
      }

      if (elapsed < durationMs) {
        raf = requestAnimationFrame(tick);
      }
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, [active, durationMs]);

  if (!active) return null;
  return (
    <canvas
      ref={canvasRef}
      style={{
        position: "fixed",
        inset: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        zIndex: 80,
      }}
    />
  );
};

export const DolphinStreakRewardOverlay: React.FC<{ open: boolean; streakDays?: number; onClose: () => void }> = ({ open, streakDays, onClose }) => {
  if (!open) return null;
  return (
    <>
      <ConfettiCanvas active={open} />
      <div style={{ ...modalBackdropStyle, zIndex: 90 }} onMouseDown={onClose}>
        <div style={modalCardStyle} onMouseDown={(e) => e.stopPropagation()}>
          <h2 style={{ margin: 0, fontSize: "1.45rem", color: "#00ffff" }}>DOLPHIN UNLOCKED!</h2>
          <p style={{ margin: "10px 0 0 0", color: "rgba(255,255,255,0.85)", lineHeight: 1.55 }}>
            You earned a <b>Dolphin</b>{typeof streakDays === "number" ? <> for increasing your streak to <b>{streakDays} days</b>.</> : <> for increasing your streak.</>}
          </p>
          <p style={{ margin: "8px 0 0 0", color: "rgba(255,255,255,0.75)", lineHeight: 1.45, fontSize: "0.95rem" }}>
            Streak bonus: once your streak is <b>5+</b>, you get <b>one Dolphin</b> each time your streak increases.
          </p>
          <div
            style={{
              marginTop: 14,
              padding: "12px 12px",
              borderRadius: 12,
              border: "1px solid rgba(0,255,255,0.35)",
              background: "rgba(0,255,255,0.08)",
              textAlign: "left",
              display: "flex",
              gap: 12,
              alignItems: "center",
            }}
          >
            <img src={dolphinItemImg} alt="Dolphin item" width={34} height={34} style={{ width: 34, height: 34 }} draggable={false} />
            <div>
              <div style={{ fontWeight: 900, color: "#00ffff" }}>Double Jump</div>
              <div style={{ marginTop: 3, fontSize: "0.95rem", color: "rgba(255,255,255,0.85)" }}>
                Jump once more while you’re already in the air. The Dolphin is <b>consumed</b> when used.
              </div>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            style={{
              marginTop: 14,
              width: "100%",
              padding: "10px 16px",
              fontSize: "1.05rem",
              background: "#00ffff",
              color: "#001e36",
              border: "none",
              borderRadius: 10,
              cursor: "pointer",
              fontWeight: 900,
            }}
          >
            OK
          </button>
        </div>
      </div>
    </>
  );
};

export const DolphinWeeklyWinnerRewardOverlay: React.FC<{ open: boolean; weekId?: string; onClose: () => void }> = ({ open, weekId, onClose }) => {
  if (!open) return null;
  return (
    <>
      <ConfettiCanvas active={open} />
      <div style={{ ...modalBackdropStyle, zIndex: 90 }} onMouseDown={onClose}>
        <div style={modalCardStyle} onMouseDown={(e) => e.stopPropagation()}>
          <h2 style={{ margin: 0, fontSize: "1.45rem", color: "#00ffff" }}>WEEKLY #1 REWARD!</h2>
          <p style={{ margin: "10px 0 0 0", color: "rgba(255,255,255,0.85)", lineHeight: 1.55 }}>
            You finished <b>#1</b>{weekId ? <> for week <b>{weekId}</b>.</> : <> last week.</>} Here’s a <b>Dolphin</b> reward!
          </p>
          <div
            style={{
              marginTop: 14,
              padding: "12px 12px",
              borderRadius: 12,
              border: "1px solid rgba(0,255,255,0.35)",
              background: "rgba(0,255,255,0.08)",
              textAlign: "left",
              display: "flex",
              gap: 12,
              alignItems: "center",
            }}
          >
            <img src={dolphinItemImg} alt="Dolphin item" width={34} height={34} style={{ width: 34, height: 34 }} draggable={false} />
            <div>
              <div style={{ fontWeight: 900, color: "#00ffff" }}>Double Jump</div>
              <div style={{ marginTop: 3, fontSize: "0.95rem", color: "rgba(255,255,255,0.85)" }}>
                Jump once more while you’re already in the air. The Dolphin is <b>consumed</b> when used.
              </div>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            style={{
              marginTop: 14,
              width: "100%",
              padding: "10px 16px",
              fontSize: "1.05rem",
              background: "#00ffff",
              color: "#001e36",
              border: "none",
              borderRadius: 10,
              cursor: "pointer",
              fontWeight: 900,
            }}
          >
            OK
          </button>
        </div>
      </div>
    </>
  );
};

// Leaderboard Component
interface LeaderboardProps {
  leaderboard: LeaderboardEntry[];
  lastSubmittedId: number | null;
}

function LeaderboardSkinIcon({ skinId }: { skinId?: string }) {
  if (!skinId) return null;
  const skin = getSkinDef(skinId);
  return (
    <img
      src={skin.sprite}
      alt={skin.name}
      style={{ width: 22, height: 22, objectFit: "contain", verticalAlign: "middle", flexShrink: 0 }}
    />
  );
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
              <td style={{ padding: "5px 8px 5px 0", width: 24 }}>{i + 1}.</td>
              <td style={{ padding: "5px 8px 5px 0" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <LeaderboardSkinIcon skinId={entry.skinId} />
                  <div style={{ display: "flex", flexDirection: "column", gap: "2px", minWidth: 0 }}>
                    <span>{entry.name}</span>
                    {entry.userId && entry.userId !== entry.name && (
                      <span style={{ fontSize: "12px", color: "rgba(255,255,255,0.7)" }}>
                        {entry.userId}
                      </span>
                    )}
                  </div>
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

function weekTitle(w: WeeklyLeaderboard) {
  const range = w.startDate && w.endDate ? `${w.startDate} → ${w.endDate}` : w.weekId;
  return `WEEK ${range}`;
}

export const WeeklyLeaderboardHistory: React.FC<{ weeks: WeeklyLeaderboard[]; excludeWeekId?: string }> = ({ weeks, excludeWeekId }) => {
  const history = weeks.filter((w) => w && w.entries && w.entries.length > 0 && w.weekId !== excludeWeekId);
  if (history.length === 0) return null;
  return (
    <div style={{ marginTop: 12, textAlign: "left", width: "min(560px, 92vw)" }}>
      <div style={{ color: "rgba(255,255,255,0.9)", fontWeight: 900, letterSpacing: 0.8 }}>
        HISTORY (Weekly)
      </div>
      <div
        data-allow-scroll="1"
        style={{
          marginTop: 8,
          maxHeight: "32vh",
          overflowY: "auto",
          WebkitOverflowScrolling: "touch",
          touchAction: "pan-y",
          overscrollBehavior: "contain",
          background: "rgba(0,0,0,0.22)",
          border: "1px solid rgba(255,255,255,0.12)",
          borderRadius: 12,
          padding: "10px 12px",
          boxSizing: "border-box",
        }}
      >
        {history.map((w) => (
          <div key={w.weekId} style={{ padding: "10px 0", borderBottom: "1px solid rgba(255,255,255,0.10)" }}>
            <div style={{ fontWeight: 900, color: "rgba(255,255,255,0.92)" }}>{weekTitle(w)}</div>
            <div style={{ marginTop: 6 }}>
              {w.entries.map((e, i) => (
                <div key={`${w.weekId}:${e.id}:${i}`} style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: "0.98rem", alignItems: "center", marginBottom: 2 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                    <span style={{ width: 22, flexShrink: 0, color: "rgba(255,255,255,0.75)" }}>{i + 1}.</span>
                    <LeaderboardSkinIcon skinId={e.skinId} />
                    <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                      <span style={{ overflowWrap: "anywhere" }}>{e.name}</span>
                      {e.userId && e.userId !== e.name && (
                        <span style={{ fontSize: "11px", color: "rgba(255,255,255,0.55)" }}>{e.userId}</span>
                      )}
                    </div>
                  </div>
                  <div style={{ fontWeight: 800, color: "rgba(255,255,255,0.92)", flexShrink: 0 }}>{e.score}</div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 6, fontSize: "0.9rem", color: "rgba(255,255,255,0.65)" }}>
        Scroll to view older weeks (newest first).
      </div>
    </div>
  );
};

// HUD Component
interface HUDProps {
  score: number;
  level: number;
  oxygen: number;
  hasTurtleShell?: boolean;
  dolphinCount?: number;
  dolphinSpendSeq?: number;
  dolphinUseEnabled?: boolean;
  onToggleDolphinUse?: () => void;
  tubePieces?: number;
  tubeRescueCharges?: number;
}

export const HUD: React.FC<HUDProps> = ({
  score,
  level,
  oxygen,
  hasTurtleShell,
  dolphinCount,
  dolphinSpendSeq,
  dolphinUseEnabled,
  onToggleDolphinUse,
  tubePieces,
  tubeRescueCharges,
}) => {
  const dolphinSlotRef = React.useRef<HTMLDivElement | null>(null);
  const dolphinSpendFxRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (!dolphinSpendSeq) return;

    const slot = dolphinSlotRef.current;
    if (slot) {
      try {
        slot.animate(
          [
            { boxShadow: "0 0 0 rgba(0,0,0,0)", transform: "scale(1)" },
            { boxShadow: "0 0 18px rgba(255, 60, 60, 0.75)", transform: "scale(1.06)" },
            { boxShadow: "0 0 10px rgba(0, 255, 255, 0.35)", transform: "scale(1)" },
          ],
          { duration: 520, easing: "ease-out" }
        );
      } catch {
        // ignore (older browsers)
      }
    }

    const fx = dolphinSpendFxRef.current;
    if (fx) {
      try {
        fx.animate(
          [
            { opacity: 0, transform: "translateY(6px) scale(0.95)" },
            { opacity: 1, transform: "translateY(0px) scale(1)" },
            { opacity: 0, transform: "translateY(-18px) scale(1.02)" },
          ],
          { duration: 650, easing: "ease-out" }
        );
      } catch {
        // ignore
      }
    }
  }, [dolphinSpendSeq]);

  const dc = typeof dolphinCount === "number" ? dolphinCount : 0;
  const dolphinEnabled = !!dolphinUseEnabled;
  const tp = typeof tubePieces === "number" ? Math.max(0, Math.min(TUBE_PIECES_PER_TUBE - 1, Math.floor(tubePieces))) : 0;
  const tubeUnlocked = score >= TUBE_PIECE_UNLOCK_SCORE || tp > 0;
  const trc = typeof tubeRescueCharges === "number" ? Math.max(0, Math.floor(tubeRescueCharges)) : 0;

  return (
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
          width: `${Math.min(oxygen / OXYGEN_MAX, 1) * 100}%`,
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
      {[
        { has: !!hasTurtleShell, img: turtleShellItemImg, alt: "Turtle shell saved" },
        { has: dc > 0, img: dolphinItemImg, alt: "Dolphin saved", count: dc },
        { has: trc > 0, img: tubeImg, alt: "Tube rescue saved", count: trc },
      ].map((slot, idx) => (
        <div
          key={idx}
          ref={idx === 1 ? dolphinSlotRef : undefined}
          style={{
            width: 28,
            height: 28,
            borderRadius: 8,
            border: "2px solid rgba(255,255,255,0.9)",
            background: slot.has ? "rgba(0,0,0,0.35)" : "rgba(0,0,0,0.15)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            boxShadow: slot.has ? "0 0 12px rgba(0,255,255,0.35)" : "none",
            position: "relative",
          }}
        >
          {slot.has ? (
            <>
              <img
                src={slot.img}
                alt={slot.alt}
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
              {idx === 1 && (
                <div
                  ref={dolphinSpendFxRef}
                  style={{
                    position: "absolute",
                    left: "50%",
                    top: -16,
                    transform: "translateX(-50%)",
                    opacity: 0,
                    pointerEvents: "none",
                    color: "rgba(255,80,80,0.98)",
                    fontSize: 12,
                    fontWeight: 900,
                    textShadow: "0 2px 0 rgba(0,0,0,0.6)",
                    letterSpacing: 0.2,
                  }}
                >
                  -1
                </div>
              )}
              {typeof slot.count === "number" && slot.count > 1 && (
                <div
                  style={{
                    position: "absolute",
                    right: -6,
                    bottom: -6,
                    minWidth: 16,
                    height: 16,
                    padding: "0 4px",
                    borderRadius: 999,
                    background: "rgba(0,0,0,0.75)",
                    border: "1px solid rgba(255,255,255,0.8)",
                    color: "white",
                    fontSize: 10,
                    lineHeight: "16px",
                    fontWeight: 900,
                    textAlign: "center",
                    textShadow: "1px 1px 0 rgba(0,0,0,0.6)",
                  }}
                >
                  x{slot.count}
                </div>
              )}
            </>
          ) : (
            <span style={{ fontSize: "14px", opacity: 0.4 }}>—</span>
          )}
        </div>
      ))}
    </div>
    <div style={{ marginTop: "6px", display: "flex", alignItems: "center", gap: "8px" }}>
      <button
        type="button"
        onClick={onToggleDolphinUse}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "4px 10px",
          borderRadius: 999,
          border: "1px solid rgba(255,255,255,0.8)",
          background: dolphinEnabled ? "rgba(0,0,0,0.4)" : "rgba(0,0,0,0.2)",
          color: dolphinEnabled ? "#00ffff" : "rgba(255,255,255,0.7)",
          fontSize: 12,
          fontWeight: 800,
          letterSpacing: 0.4,
          cursor: "pointer",
        }}
      >
        <img
          src={dolphinItemImg}
          alt="Dolphin toggle"
          width={16}
          height={16}
          style={{
            width: 16,
            height: 16,
            objectFit: "contain",
            filter: dolphinEnabled ? "none" : "grayscale(1)",
            opacity: dolphinEnabled ? 1 : 0.6,
          }}
          draggable={false}
        />
        {dolphinEnabled ? "DOLPHIN ON" : "DOLPHIN OFF"}
      </button>
    </div>

    {tubeUnlocked && (
      <div style={{ marginTop: "8px", display: "flex", alignItems: "center", gap: "8px" }}>
        <span style={{ fontSize: "14px", opacity: 0.9 }}>TUBE:</span>
        <div
          aria-label={`Tube pieces: ${tp}/${TUBE_PIECES_PER_TUBE}`}
          style={{
            width: 34,
            height: 34,
            borderRadius: 10,
            border: "2px solid rgba(255,255,255,0.9)",
            background: "rgba(0,0,0,0.22)",
            padding: 3,
            boxSizing: "border-box",
            display: "grid",
            gridTemplateColumns: "repeat(2, 1fr)",
            gridTemplateRows: "repeat(2, 1fr)",
            gap: 2,
            boxShadow: tp > 0 ? "0 0 12px rgba(0,255,255,0.25)" : "none",
          }}
        >
          {Array.from({ length: 4 }).map((_, i) => {
            const filled = i < tp;
            const bx = (i % 2) * 100;
            const by = Math.floor(i / 2) * 100;
            return (
              <div
                key={i}
                style={{
                  borderRadius: 6,
                  overflow: "hidden",
                  backgroundImage: `url(${tubeImg})`,
                  backgroundRepeat: "no-repeat",
                  backgroundSize: "200% 200%",
                  backgroundPosition: `${bx}% ${by}%`,
                  filter: filled ? "none" : "grayscale(1)",
                  opacity: filled ? 1 : 0.25,
                }}
              />
            );
          })}
        </div>
        <span style={{ fontSize: "14px", opacity: 0.85 }}>{tp}/{TUBE_PIECES_PER_TUBE}</span>
      </div>
    )}
  </div>
  );
};

// Menu Overlay
interface MenuOverlayProps {
  leaderboard: LeaderboardEntry[];
  lastSubmittedId: number | null;
  weeklyLeaderboards?: WeeklyLeaderboard[];
  currentWeekId?: string | null;
  onLoginClick?: () => void;
  loginId?: string | null;
  onLogoutClick?: () => void;
  onStreakClick?: () => void;
  onInventoryClick?: () => void;
  onSkinsClick?: () => void;
  onInboxClick?: () => void;
  inboxCount?: number;
  streakCurrent?: number;
  coinBalance?: number;
}

export const MenuOverlay: React.FC<MenuOverlayProps> = ({
  leaderboard,
  lastSubmittedId,
  weeklyLeaderboards,
  currentWeekId,
  onLoginClick,
  loginId,
  onLogoutClick,
  onStreakClick,
  onInventoryClick,
  onSkinsClick,
  onInboxClick,
  inboxCount,
  streakCurrent,
  coinBalance,
}) => (
  <div style={overlayStyle} data-allow-scroll="1">
    <h1 style={titleStyle}>DEEP DIVE DASH</h1>
    <p style={subtitleStyle}>Press SPACE to Start</p>
    <div style={instructionStyle}>
      Avoid Gaps! Collect Oxygen!<br />
      Beware of <span style={{ color: "#a67b5b", fontWeight: "bold" }}>Quick Sand</span> and <span style={{ color: "#e67e22", fontWeight: "bold" }}>Urchins</span>!<br />
      Collect <span style={{ color: "#5dade2", fontWeight: "bold" }}>Swordfish</span> for 3x SPEED & INVINCIBILITY!<br />
      Controls: Spacebar (Hold for High Jump) / Arrow Up
    </div>

    <div
      style={{
        marginTop: 14,
        width: "min(760px, 92vw)",
        borderRadius: 16,
        border: "1px solid rgba(0,255,255,0.45)",
        background: (typeof streakCurrent === "number" && streakCurrent >= 5)
          ? "linear-gradient(135deg, rgba(0,255,255,0.18), rgba(255,215,0,0.12))"
          : "linear-gradient(135deg, rgba(255,215,0,0.14), rgba(0,255,255,0.10))",
        padding: "14px 16px",
        boxSizing: "border-box",
        display: "flex",
        gap: 14,
        alignItems: "center",
        boxShadow: "0 0 26px rgba(0,255,255,0.18)",
      }}
    >
      <img
        src={dolphinItemImg}
        alt="Dolphin item"
        width={40}
        height={40}
        style={{ width: 40, height: 40, filter: "drop-shadow(0 6px 10px rgba(0,0,0,0.35))" }}
        draggable={false}
      />
      <div style={{ textAlign: "left", flex: 1 }}>
        {(typeof streakCurrent === "number" && streakCurrent >= 5) ? (
          <>
            <div style={{ fontWeight: 1000, color: "#00ffff", letterSpacing: 0.9, fontSize: "1.05rem" }}>
              STREAK BONUS ACTIVE
            </div>
            <div style={{ marginTop: 3, color: "rgba(255,255,255,0.92)", lineHeight: 1.35, fontSize: "1.02rem" }}>
              Each day your streak increases (5+), you earn a <b>Dolphin</b> — a <b>one‑time Double Jump</b>.
            </div>
          </>
        ) : (
          <>
            <div style={{ fontWeight: 1000, color: "#ffd700", letterSpacing: 0.9, fontSize: "1.05rem" }}>
              HIT A 5‑DAY STREAK
            </div>
            <div style={{ marginTop: 3, color: "rgba(255,255,255,0.92)", lineHeight: 1.35, fontSize: "1.02rem" }}>
              Reach <b>5 days</b> to unlock daily <b>Dolphin</b> rewards whenever your streak increases — a <b>one‑time Double Jump</b>.
            </div>
          </>
        )}

        {typeof streakCurrent === "number" && (
          <div style={{ marginTop: 6, color: "rgba(255,255,255,0.75)", fontSize: "0.95rem" }}>
            Current streak: <b style={{ color: "rgba(255,255,255,0.92)" }}>{streakCurrent}</b> day{streakCurrent === 1 ? "" : "s"}
          </div>
        )}
      </div>
    </div>

    <div style={{ marginTop: "18px", display: "flex", flexDirection: "column", gap: "10px", alignItems: "center" }}>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "center" }}>
        {onStreakClick && (
          <button
            type="button"
            onClick={onStreakClick}
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
            STREAK
          </button>
        )}
        {onInventoryClick && loginId && (
          <button
            type="button"
            onClick={onInventoryClick}
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
            INVENTORY
          </button>
        )}
        {onSkinsClick && loginId && (
          <button
            type="button"
            onClick={onSkinsClick}
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
            SKINS
          </button>
        )}
        {onInboxClick && (
          <button
            type="button"
            onClick={onInboxClick}
            style={{
              padding: "10px 18px",
              fontSize: "1.05rem",
              background: "rgba(0,0,0,0.25)",
              color: "rgba(255,255,255,0.9)",
              border: "1px solid rgba(255,255,255,0.25)",
              borderRadius: "10px",
              cursor: "pointer",
              fontWeight: 700,
              position: "relative",
            }}
          >
            INBOX
            {!!inboxCount && inboxCount > 0 && (
              <span
                style={{
                  position: "absolute",
                  top: -8,
                  right: -8,
                  background: "#ff6b6b",
                  color: "white",
                  borderRadius: 999,
                  padding: "2px 7px",
                  fontSize: 12,
                  fontWeight: 900,
                  border: "2px solid rgba(0, 20, 40, 0.95)",
                }}
              >
                {inboxCount}
              </span>
            )}
          </button>
        )}
      </div>
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
          {typeof coinBalance === "number" && (
            <span style={{ marginLeft: 12, color: "#ffd700", fontWeight: 800 }}>
              {coinBalance} coins
            </span>
          )}
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
    {!!weeklyLeaderboards && weeklyLeaderboards.length > 0 && (
      <WeeklyLeaderboardHistory weeks={weeklyLeaderboards} excludeWeekId={currentWeekId ?? undefined} />
    )}
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
  <div style={{ ...overlayStyle, justifyContent: "center" }}>
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
  weeklyLeaderboards?: WeeklyLeaderboard[];
  currentWeekId?: string | null;
  coinsEarned?: number;
  coinBalance?: number;
}

export const GameOverOverlay: React.FC<GameOverOverlayProps> = ({ score, didSubmit, leaderboard, lastSubmittedId, weeklyLeaderboards, currentWeekId, coinsEarned, coinBalance }) => (
  <div style={overlayStyle} data-allow-scroll="1">
    <h1 style={{ ...titleStyle, color: didSubmit ? "#ffd700" : "#ff6b6b" }}>
      {didSubmit ? "LEADERBOARD" : "GAME OVER"}
    </h1>
    <div style={scoreStyle}>Score: {score}</div>
    {typeof coinsEarned === "number" && coinsEarned > 0 && (
      <div style={{ marginTop: 6, fontSize: "1.1rem", color: "#ffd700", fontWeight: 800 }}>
        +{coinsEarned} coins
        {typeof coinBalance === "number" && (
          <span style={{ color: "rgba(255,255,255,0.75)", fontWeight: 400, fontSize: "0.95rem" }}>
            {" "}(total: {coinBalance})
          </span>
        )}
      </div>
    )}
    <Leaderboard leaderboard={leaderboard} lastSubmittedId={lastSubmittedId} />
    {!!weeklyLeaderboards && weeklyLeaderboards.length > 0 && (
      <WeeklyLeaderboardHistory weeks={weeklyLeaderboards} excludeWeekId={currentWeekId ?? undefined} />
    )}
    <p style={{ ...subtitleStyle, marginTop: "40px" }}>Press SPACE to Retry</p>
  </div>
);
