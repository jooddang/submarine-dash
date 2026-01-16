import React, { useEffect, useRef, useState } from "react";
import type { GameState, Player, Platform, Item, Bubble, BackgroundEntity, LeaderboardEntry, WeeklyLeaderboard } from "./types";
import * as Constants from "./constants";
import { initAudio, playSound } from "./audio";
import { interpolateColor } from "./graphics";
import { createBubble, spawnBackgroundEntity } from "./entities";
import { drawSwordfish, drawUrchin, drawBackgroundEntities, drawTurtleShell } from "./drawing";
import { HUD, MenuOverlay, InputNameOverlay, GameOverOverlay, AuthModal, DailyMissionsPanel, DolphinStreakRewardOverlay, DolphinWeeklyWinnerRewardOverlay } from "./components/UIOverlays";
import { authAPI, inventoryAPI, leaderboardAPI, missionsAPI, type DailyMissionsResponse, type AuthUser } from "./api";
import turtleRescueImg from "../turtle.png";
import turtleShellItemImg from "../turtle-shell-item.png";
import tubeImg from "../tube.png";

type RescuePhase = "FLY_IN" | "HOOK" | "TOW" | "COUNTDOWN";
type RescueState =
  | { active: false }
  | {
    active: true;
    phase: RescuePhase;
    phaseT: number; // seconds
    turtleX: number;
    turtleY: number;
    targetPlayerX: number;
    targetPlayerY: number;
    // Fairness: keep the submarine's on-screen X fixed; shift the world instead during tow.
    playerXFixed: number;
    towStartY: number;
    worldShiftApplied: number;
    hookPointX: number;
    hookPointY: number;
    countdownMs: number;
    lastCountdownDisplay: number | null;
  };

type TubeRescueState =
  | { active: false }
  | {
    active: true;
    phase: RescuePhase;
    phaseT: number; // seconds
    tubeX: number;
    tubeY: number;
    tubeRot: number;
    targetPlayerX: number;
    targetPlayerY: number;
    playerXFixed: number;
    towStartY: number;
    worldShiftApplied: number;
    countdownMs: number;
    lastCountdownDisplay: number | null;
  };

export const DeepDiveGame = () => {
  // --- Refs for Game Loop ---
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const requestRef = useRef<number>(0);
  const scoreRef = useRef<number>(0);
  const gameStateRef = useRef<GameState>("MENU");
  const didSubmitRef = useRef<boolean>(false);
  const didSendRunEndRef = useRef<boolean>(false);

  // Input Ref
  const isJumpInputActiveRef = useRef<boolean>(false);
  const jumpBufferTimerRef = useRef<number>(0);

  // Game Entities Refs (mutable for performance)
  const playerRef = useRef<Player>({
    x: 100,
    y: 0,
    width: 40,
    height: 40,
    dy: 0,
    grounded: false,
    rotation: 0,
    isTrapped: false,
    isBoosting: false,
    boostTimer: 0,
  });

  const platformsRef = useRef<Platform[]>([]);
  const itemsRef = useRef<Item[]>([]);
  const bubblesRef = useRef<Bubble[]>([]);
  const bgEntitiesRef = useRef<BackgroundEntity[]>([]);

  const oxygenRef = useRef<number>(Constants.OXYGEN_MAX);
  const lastTimeRef = useRef<number>(0);
  const gameTimeRef = useRef<number>(0);
  const speedRef = useRef<number>(Constants.GAME_SPEED_START);
  const distanceRef = useRef<number>(0);

  const quickSandTimerRef = useRef<number | null>(null);

  // Swordfish Power-up Refs
  const swordfishTimerRef = useRef<number>(0);
  const isSwordfishActiveRef = useRef<boolean>(false);

  // Turtle Shell (saved item) + rarity tracking
  const turtleShellSavedRef = useRef<boolean>(false);
  const turtleShellUseCountRef = useRef<number>(0);
  const rescueRef = useRef<RescueState>({ active: false });
  const tubeRescueRef = useRef<TubeRescueState>({ active: false });
  const devForceLongQuickSandOnceRef = useRef<boolean>(false);
  const rescueTurtleImgRef = useRef<HTMLImageElement | null>(null);
  const turtleShellItemImgRef = useRef<HTMLImageElement | null>(null);
  const tubeImgRef = useRef<HTMLImageElement | null>(null);
  // Dolphin (saved item): allows 1x mid-air double jump, then consumed
  const dolphinSavedCountRef = useRef<number>(0);
  // Tube pieces (session-persisted collectible)
  const tubePiecesRef = useRef<number>(0);
  const tubeRescueChargesRef = useRef<number>(0);

  // --- React State for UI ---
  const [gameState, setGameState] = useState<GameState>("MENU");
  const [score, setScore] = useState(0);
  const [oxygen, setOxygen] = useState(Constants.OXYGEN_MAX);
  const [level, setLevel] = useState(1);
  const [hasTurtleShell, setHasTurtleShell] = useState(false);
  const [dolphinCount, setDolphinCountState] = useState(0);
  const [dolphinSpendSeq, setDolphinSpendSeq] = useState(0);
  const [tubePieces, setTubePiecesState] = useState(0);
  const [tubeToast, setTubeToast] = useState<string | null>(null);
  const [tubeRescueCharges, setTubeRescueChargesState] = useState(0);
  const [restartCountdown, setRestartCountdown] = useState<number | null>(null);
  const [dolphinRewardOpen, setDolphinRewardOpen] = useState(false);
  const [weeklyDolphinRewardOpen, setWeeklyDolphinRewardOpen] = useState(false);
  const [weeklyDolphinRewardWeekId, setWeeklyDolphinRewardWeekId] = useState<string | null>(null);
  const pendingWeeklyDolphinRewardRef = useRef<boolean>(false);

  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const leaderboardRef = useRef<LeaderboardEntry[]>([]);
  const [lastSubmittedId, setLastSubmittedId] = useState<number | null>(null);
  const [weeklyLeaderboards, setWeeklyLeaderboards] = useState<WeeklyLeaderboard[]>([]);
  const [currentWeekId, setCurrentWeekId] = useState<string | null>(null);

  const [playerName, setPlayerName] = useState("");
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  // Important: the game loop + global event listeners are registered once and can capture stale state.
  // Mirror auth state into a ref so gameplay-side logic always sees the latest auth status.
  const authUserRef = useRef<AuthUser | null>(null);
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [authMode, setAuthMode] = useState<"login" | "signup" | "changePassword">("login");
  const [authLoginId, setAuthLoginId] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authNewPassword, setAuthNewPassword] = useState("");
  const [authNewPasswordConfirm, setAuthNewPasswordConfirm] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const pendingSubmitRef = useRef<boolean>(false);
  const [streakOpen, setStreakOpen] = useState(false);
  const [dailyMissions, setDailyMissions] = useState<DailyMissionsResponse | null>(null);
  const initialPageStyleRef = useRef<{
    bodyOverflow: string;
    htmlOverflow: string;
    bodyTouchAction: string;
  } | null>(null);
  const touchGestureRef = useRef<{
    active: boolean;
    moved: boolean;
    allowScroll: boolean;
    startX: number;
    startY: number;
  }>({ active: false, moved: false, allowScroll: false, startX: 0, startY: 0 });
  const pendingDolphinRewardRef = useRef<boolean>(false);

  // Dolphin is sourced from Redis (server is source of truth).
  // Client state is a cache for UI; it is reconciled via /auth/me, /missions/daily, and consume endpoint.
  const DOLPHIN_SAVED_MAX = 5;
  const LEGACY_DOLPHIN_LOCAL_KEY_BASE = "subdash:savedItem:dolphin";
  const clampDolphinCount = (n: number) => Math.max(0, Math.min(DOLPHIN_SAVED_MAX, Math.floor(n)));

  const dolphinSyncSeqRef = useRef<number>(0);
  const dolphinLastAppliedSeqRef = useRef<number>(0);
  const nextDolphinSyncSeq = () => {
    dolphinSyncSeqRef.current += 1;
    return dolphinSyncSeqRef.current;
  };

  const applyDolphinCount = (value: number) => {
    const next = clampDolphinCount(value);
    dolphinSavedCountRef.current = next;
    setDolphinCountState(next);
  };

  const applyDolphinCountSync = (value: number, seq: number) => {
    if (seq < dolphinLastAppliedSeqRef.current) return;
    dolphinLastAppliedSeqRef.current = seq;
    applyDolphinCount(value);
  };

  const setDolphinCountLocal = (value: number) => {
    const seq = nextDolphinSyncSeq();
    applyDolphinCountSync(value, seq);
  };

  const TUBE_SESSION_KEY = "subdash:session:tubePieces";
  const TUBE_RESCUE_CHARGES_SESSION_KEY = "subdash:session:tubeRescueCharges";
  const clampTubePieces = (n: number) => Math.max(0, Math.min(Constants.TUBE_PIECES_PER_TUBE - 1, Math.floor(n)));
  const setTubePieces = (value: number) => {
    const next = clampTubePieces(value);
    tubePiecesRef.current = next;
    setTubePiecesState(next);
    try {
      sessionStorage.setItem(TUBE_SESSION_KEY, String(next));
    } catch {
      // ignore
    }
  };

  const showTubeToast = (text: string) => setTubeToast(text);

  const clampTubeRescueCharges = (n: number) => Math.max(0, Math.min(3, Math.floor(n)));
  const setTubeRescueCharges = (value: number) => {
    const next = clampTubeRescueCharges(value);
    tubeRescueChargesRef.current = next;
    setTubeRescueChargesState(next);
    try {
      sessionStorage.setItem(TUBE_RESCUE_CHARGES_SESSION_KEY, String(next));
    } catch {
      // ignore
    }
  };

  const readLegacyLocalDolphinCount = (userId: string): number => {
    // Back-compat: older builds stored dolphin counts in localStorage.
    // We import these once into Redis, then clear local values.
    try {
      const guestRaw = localStorage.getItem(`${LEGACY_DOLPHIN_LOCAL_KEY_BASE}:guest`);
      const userRaw = localStorage.getItem(`${LEGACY_DOLPHIN_LOCAL_KEY_BASE}:${userId}`);
      const guestN = guestRaw ? Number.parseInt(guestRaw, 10) : (guestRaw === "1" ? 1 : 0);
      const userN = userRaw ? Number.parseInt(userRaw, 10) : (userRaw === "1" ? 1 : 0);
      const guestCount = Number.isFinite(guestN) ? Math.max(0, guestN) : 0;
      const userCount = Number.isFinite(userN) ? Math.max(0, userN) : 0;
      return guestCount + userCount;
    } catch {
      return 0;
    }
  };

  const clearLegacyLocalDolphinCount = (userId: string) => {
    try {
      localStorage.setItem(`${LEGACY_DOLPHIN_LOCAL_KEY_BASE}:guest`, "0");
      localStorage.setItem(`${LEGACY_DOLPHIN_LOCAL_KEY_BASE}:${userId}`, "0");
    } catch {
      // ignore
    }
  };

  const refreshDailyMissions = async () => {
    const seq = nextDolphinSyncSeq();
    try {
      const data = await missionsAPI.getDaily();
      setDailyMissions(data);
      if (data.user?.inventory && typeof data.user.inventory.dolphinSaved === "number") {
        applyDolphinCountSync(data.user.inventory.dolphinSaved, seq);
      }
    } catch (e) {
      console.error("Failed to fetch daily missions:", e);
    }
  };

  useEffect(() => {
    // Load leaderboard from backend API
    const loadLeaderboard = async () => {
      try {
        // Prefer weekly API (current + history). Fall back to legacy endpoint.
        try {
          const data = await leaderboardAPI.getWeeklyLeaderboards(52);
          setCurrentWeekId(data.currentWeekId);
          setWeeklyLeaderboards(data.weeks || []);
          setLeaderboard(data.current || []);
          leaderboardRef.current = data.current || [];
        } catch {
          const data = await leaderboardAPI.getLeaderboard();
          setLeaderboard(data);
          leaderboardRef.current = data;
        }
      } catch (e) {
        console.error("Failed to load leaderboard", e);
      }
    };

    loadLeaderboard();

    // Load auth session (if any)
    const loadMe = async () => {
      const seq = nextDolphinSyncSeq();
      const me = await authAPI.me();
      setAuthUser(me);
      // Keep the auth ref in sync immediately (used by gameplay-side auth checks).
      authUserRef.current = me;

      // Hydrate dolphin count from Redis (source of truth).
      if (me?.inventory && typeof me.inventory.dolphinSaved === "number") {
        applyDolphinCountSync(me.inventory.dolphinSaved, seq);
      } else {
        applyDolphinCountSync(0, seq);
      }

      // One-time import of legacy localStorage dolphins into Redis (prevents losing old items).
      if (me?.userId) {
        const legacy = readLegacyLocalDolphinCount(me.userId);
        if (legacy > 0) {
          const importSeq = nextDolphinSyncSeq();
          const imported = await inventoryAPI.importDolphin(legacy);
          if (imported?.inventory && typeof imported.inventory.dolphinSaved === "number") {
            applyDolphinCountSync(imported.inventory.dolphinSaved, importSeq);
          }
          clearLegacyLocalDolphinCount(me.userId);
        }
      }

      // Weekly winner dolphin reward (server-claimed via /auth/me).
      if (me?.rewards?.weeklyWinner?.dolphin) {
        setWeeklyDolphinRewardWeekId(me.rewards.weeklyWinner.weekId);
        if (gameStateRef.current === "PLAYING") {
          pendingWeeklyDolphinRewardRef.current = true;
        } else {
          setWeeklyDolphinRewardOpen(true);
        }
      }
    };
    loadMe();
    refreshDailyMissions();

    // Initialize audio eagerly for better mobile support
    initAudio();

    // Attempt to focus the window/canvas on mount to ensure keyboard events are received immediately
    window.focus();
    if (canvasRef.current) {
      canvasRef.current.focus();
    }

    return () => cancelAnimationFrame(requestRef.current);
  }, []);

  useEffect(() => {
    authUserRef.current = authUser;
  }, [authUser]);

  useEffect(() => {
    // Refresh missions when auth changes (login/logout)
    refreshDailyMissions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authUser?.userId]);

  useEffect(() => {
    // Dev/testing: force the streak reward moment (confetti + modal) and grant dolphin.
    if (!Constants.DEV_FORCE_DOLPHIN_STREAK_REWARD_MOMENT) return;
    setDolphinCountLocal(dolphinSavedCountRef.current + 1);
    if (gameStateRef.current === "PLAYING") {
      pendingDolphinRewardRef.current = true;
    } else {
      setDolphinRewardOpen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // If we deferred the reward during gameplay, show it as soon as we return to a non-playing screen.
    if (gameState === "PLAYING") return;
    if (!pendingDolphinRewardRef.current) return;
    pendingDolphinRewardRef.current = false;
    setDolphinRewardOpen(true);
  }, [gameState]);

  useEffect(() => {
    if (gameState === "PLAYING") return;
    if (!pendingWeeklyDolphinRewardRef.current) return;
    pendingWeeklyDolphinRewardRef.current = false;
    setWeeklyDolphinRewardOpen(true);
  }, [gameState]);

  // Streak dolphin awards are granted server-side (Redis source of truth).

  useEffect(() => {
    const img = new Image();
    img.src = turtleRescueImg;
    rescueTurtleImgRef.current = img;
  }, []);

  useEffect(() => {
    const img = new Image();
    img.src = turtleShellItemImg;
    turtleShellItemImgRef.current = img;
  }, []);

  useEffect(() => {
    const img = new Image();
    img.src = tubeImg;
    tubeImgRef.current = img;
  }, []);

  useEffect(() => {
    // Tube pieces persist for the lifetime of the tab/session.
    try {
      const raw = sessionStorage.getItem(TUBE_SESSION_KEY);
      if (raw != null) {
        const n = Number.parseInt(raw, 10);
        if (Number.isFinite(n)) setTubePieces(n);
      }
    } catch {
      // ignore
    }
    try {
      const raw = sessionStorage.getItem(TUBE_RESCUE_CHARGES_SESSION_KEY);
      if (raw != null) {
        const n = Number.parseInt(raw, 10);
        if (Number.isFinite(n)) setTubeRescueCharges(n);
      }
    } catch {
      // ignore
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!tubeToast) return;
    const t = window.setTimeout(() => setTubeToast(null), 1200);
    return () => window.clearTimeout(t);
  }, [tubeToast]);

  // --- Input Handling ---
  useEffect(() => {
    // Hard lock page scroll during gameplay (prevents wheel/trackpad scroll and mobile overscroll).
    // MENU/GAME_OVER scroll is handled inside the overlay containers.
    if (!initialPageStyleRef.current) {
      initialPageStyleRef.current = {
        bodyOverflow: document.body.style.overflow,
        htmlOverflow: document.documentElement.style.overflow,
        bodyTouchAction: document.body.style.touchAction,
      };
    }
    const initial = initialPageStyleRef.current;
    if (!initial) return;

    if (gameState === "PLAYING") {
      document.body.style.overflow = "hidden";
      document.documentElement.style.overflow = "hidden";
      document.body.style.touchAction = "none";
    } else {
      document.body.style.overflow = initial.bodyOverflow;
      document.documentElement.style.overflow = initial.htmlOverflow;
      document.body.style.touchAction = initial.bodyTouchAction;
    }

    return () => {
      // On unmount, restore initial styles.
      const init = initialPageStyleRef.current;
      if (!init) return;
      document.body.style.overflow = init.bodyOverflow;
      document.documentElement.style.overflow = init.htmlOverflow;
      document.body.style.touchAction = init.bodyTouchAction;
    };
  }, [gameState]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      initAudio(); // Ensure audio context is ready
      if (gameStateRef.current === "INPUT_NAME") return;

      if (e.code === "Space" || e.code === "ArrowUp") {
        e.preventDefault(); // Prevent default scrolling
        if (!e.repeat) { // Ignore key repeat
          isJumpInputActiveRef.current = true;
          jumpBufferTimerRef.current = Constants.JUMP_BUFFER_TIME;

          if (gameStateRef.current === "PLAYING") {
            const jumped = attemptJump();
            if (jumped) jumpBufferTimerRef.current = 0;
          } else if (gameStateRef.current === "MENU" || gameStateRef.current === "GAME_OVER") {
            startGame();
          }
        }
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space" || e.code === "ArrowUp") {
        isJumpInputActiveRef.current = false;
      }
    };

    const handleTouchStart = (e: TouchEvent) => {
      // Allow interacting with UI controls (login button, inputs, etc.) without starting the run.
      const target = e.target as HTMLElement;
      if (target?.tagName === "INPUT" || target?.tagName === "BUTTON") {
        return;
      }
      const allowScroll = !!target?.closest?.('[data-allow-scroll="1"]');
      const isMenuLike = gameStateRef.current === "MENU" || gameStateRef.current === "GAME_OVER";
      if (isMenuLike) {
        // Don't start immediately on touchstart; allow scroll gestures.
        const t = e.touches && e.touches[0];
        touchGestureRef.current = {
          active: true,
          moved: false,
          allowScroll,
          startX: t ? t.clientX : 0,
          startY: t ? t.clientY : 0,
        };
        return;
      }

      // Initialize audio BEFORE preventing default to ensure it's treated as user interaction
      initAudio();

      if (e.cancelable) {
        e.preventDefault();
      }
      isJumpInputActiveRef.current = true;
      jumpBufferTimerRef.current = Constants.JUMP_BUFFER_TIME;

      if (gameStateRef.current === "PLAYING") {
        const jumped = attemptJump();
        if (jumped) jumpBufferTimerRef.current = 0;
      }
    };

    const handleTouchEnd = (e: TouchEvent) => {
      // Allow interacting with UI controls (login button, inputs, etc.)
      const target = e.target as HTMLElement;
      if (target?.tagName === "INPUT" || target?.tagName === "BUTTON") {
        return;
      }
      const isMenuLike = gameStateRef.current === "MENU" || gameStateRef.current === "GAME_OVER";
      if (isMenuLike) {
        // Start game only on a tap (no meaningful movement).
        const g = touchGestureRef.current;
        touchGestureRef.current.active = false;
        if (!g.moved) {
          initAudio();
          startGame();
        }
        return;
      }

      if (e.cancelable) {
        e.preventDefault();
      }
      isJumpInputActiveRef.current = false;
    };

    const handleTouchMove = (e: TouchEvent) => {
      const isMenuLike = gameStateRef.current === "MENU" || gameStateRef.current === "GAME_OVER";
      if (isMenuLike) {
        const g = touchGestureRef.current;
        if (!g.active) return;
        const t = e.touches && e.touches[0];
        if (!t) return;
        const dx = Math.abs(t.clientX - g.startX);
        const dy = Math.abs(t.clientY - g.startY);
        if (dx + dy > 10) g.moved = true; // treat as scroll gesture
        return; // allow overlay scroll
      }

      // While playing, never allow page scroll / drag.
      if (gameStateRef.current !== "PLAYING") return;
      if (e.cancelable) e.preventDefault();
    };

    const handleWheel = (e: WheelEvent) => {
      // While playing, never allow page scroll (trackpad / mouse wheel).
      if (gameStateRef.current !== "PLAYING") return;
      e.preventDefault();
    };

    const handleClick = () => {
      initAudio(); // Unlock audio on click for mobile devices
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    // passive: false is required to use preventDefault() in touch listeners
    window.addEventListener("touchstart", handleTouchStart, { passive: false });
    window.addEventListener("touchend", handleTouchEnd, { passive: false });
    window.addEventListener("touchmove", handleTouchMove, { passive: false });
    window.addEventListener("wheel", handleWheel, { passive: false });
    window.addEventListener("click", handleClick);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("touchstart", handleTouchStart);
      window.removeEventListener("touchend", handleTouchEnd);
      window.removeEventListener("touchmove", handleTouchMove);
      window.removeEventListener("wheel", handleWheel);
      window.removeEventListener("click", handleClick);
    };
  }, []);

  const attemptJump = () => {
    const player = playerRef.current;
    if (player.isTrapped || isSwordfishActiveRef.current) return false;

    const isImminentLandingWhileFalling = (): boolean => {
      // If we're not falling, there's no risk of "buffered landing jump" consuming the dolphin.
      if (player.dy <= 0) return false;

      // Find the nearest platform directly below the player (by horizontal overlap).
      const playerLeft = player.x;
      const playerRight = player.x + player.width;
      const playerBottom = player.y + player.height;

      let minFramesToLand: number | null = null;
      for (const plat of platformsRef.current) {
        const overlapsX = playerRight > plat.x && playerLeft < plat.x + plat.width;
        if (!overlapsX) continue;

        const dist = plat.y - playerBottom; // vertical gap to the platform top
        if (dist < 0) continue; // already intersecting/inside; collision system will resolve

        // Estimate frames until contact using discrete kinematics (dy increases by GRAVITY per frame).
        // Solve: dist ≈ n*dy + 0.5*GRAVITY*n^2  for n >= 0
        const g = Constants.GRAVITY;
        const disc = (player.dy * player.dy) + (2 * g * dist);
        const n = (-player.dy + Math.sqrt(disc)) / g;

        if (!Number.isFinite(n) || n < 0) continue;
        if (minFramesToLand === null || n < minFramesToLand) minFramesToLand = n;
      }

      // If landing is imminent, treat jump input as a buffered ground jump rather than a dolphin double jump.
      return minFramesToLand !== null && minFramesToLand <= 8;
    };

    // Initial Jump Logic
    if (player.grounded) {
      player.dy = Constants.JUMP_FORCE_INITIAL;
      player.grounded = false;
      player.rotation = -20;
      // Initialize Boost State
      player.isBoosting = true;
      player.boostTimer = 0;
      playSound('jump'); // Play Jump Sound
      return true;
    }

    // Dolphin Double Jump (mid-air). Consumes the saved dolphin.
    // Important: allow during falling too, but DO NOT consume dolphin when a landing is imminent
    // (common "press jump slightly before landing" behavior should use the jump buffer instead).
    if (dolphinSavedCountRef.current > 0 && !isImminentLandingWhileFalling()) {
      const before = dolphinSavedCountRef.current;
      const seq = nextDolphinSyncSeq();
      applyDolphinCountSync(before - 1, seq);
      setDolphinSpendSeq((s) => s + 1);
      // Reconcile with Redis source of truth (best-effort).
      // If the server rejects (e.g., already 0), restore the local count.
      inventoryAPI
        .consumeDolphin()
        .then((out) => {
          if (!out || !out.ok) {
            applyDolphinCountSync(before, seq);
            return;
          }
          if (typeof out.inventory?.dolphinSaved === "number") {
            applyDolphinCountSync(out.inventory.dolphinSaved, seq);
          }
        })
        .catch(() => {
          applyDolphinCountSync(before, seq);
        });

      player.dy = Constants.JUMP_FORCE_INITIAL;
      player.grounded = false;
      player.rotation = -20;
      player.isBoosting = true;
      player.boostTimer = 0;
      playSound('jump');
      return true;
    }
    return false;
  };

  const startGame = () => {
    initAudio();
    if (!canvasRef.current) return;

    // Reset Game State
    gameStateRef.current = "PLAYING";
    setGameState("PLAYING");
    scoreRef.current = 0;
    setScore(0);
    setLevel(1);
    oxygenRef.current = Constants.OXYGEN_MAX;
    setOxygen(Constants.OXYGEN_MAX);
    speedRef.current = Constants.GAME_SPEED_START;
    distanceRef.current = 0;
    quickSandTimerRef.current = null;
    didSubmitRef.current = false;
    didSendRunEndRef.current = false;

    // Reset per-run tube progress.
    setTubePieces(0);
    setTubeRescueCharges(0);

    swordfishTimerRef.current = 0;
    isSwordfishActiveRef.current = false;
    isJumpInputActiveRef.current = false;
    jumpBufferTimerRef.current = 0;
    gameTimeRef.current = 0;

    turtleShellSavedRef.current = false;
    setHasTurtleShell(false);
    rescueRef.current = { active: false };
    setRestartCountdown(null);

    // Dev/testing: start with a saved Turtle Shell
    if (Constants.DEV_FORCE_TURTLE_SHELL_ON_START) {
      // Instead of pre-saving, spawn a Turtle Shell pickup immediately so it "appears at start".
      turtleShellSavedRef.current = false;
      setHasTurtleShell(false);
    }
    // Dev/testing: start with a saved Dolphin (double jump)
    if (Constants.DEV_FORCE_DOLPHIN_ON_START) {
      setDolphinCountLocal(dolphinSavedCountRef.current + 1);
    }

    setLastSubmittedId(null); // Reset highlight for new game

    playerRef.current = {
      x: 100,
      y: canvasRef.current.height - 200,
      width: 40,
      height: 40,
      dy: 0,
      grounded: false,
      rotation: 0,
      isTrapped: false,
      isBoosting: false,
      boostTimer: 0
    };

    platformsRef.current = [];
    for (let i = 0; i < Math.ceil(canvasRef.current.width / Constants.TILE_SIZE) + 5; i++) {
      platformsRef.current.push({
        x: i * Constants.TILE_SIZE,
        y: canvasRef.current.height - 100,
        width: Constants.TILE_SIZE,
        height: 100,
        type: "NORMAL"
      });
    }

    // Clear items for the new run BEFORE any dev spawns.
    itemsRef.current = [];

    // Dev/testing: spawn a Turtle Shell pickup at the start of the run (visible + collectible).
    if (Constants.DEV_FORCE_TURTLE_SHELL_ON_START) {
      const groundY = canvasRef.current.height - 100;
      const spawnX = Math.min(canvasRef.current.width - 80, playerRef.current.x + 260);
      itemsRef.current.push({
        x: spawnX,
        y: groundY - 90,
        width: 44,
        height: 34,
        collected: false,
        type: "TURTLE_SHELL",
      });
    }

    // Dev/testing: spawn 4 tube pieces at the start (so you can test completion quickly).
    if (Constants.DEV_FORCE_TUBE_PIECES_ON_START) {
      const groundY = canvasRef.current.height - 100;
      const baseX = Math.min(canvasRef.current.width - 220, playerRef.current.x + 220);
      const gap = 52;
      for (let i = 0; i < 4; i++) {
        itemsRef.current.push({
          x: baseX + i * gap,
          y: groundY - 92,
          width: 36,
          height: 36,
          collected: false,
          type: "TUBE_PIECE",
          variant: i,
        });
      }
    }
    bubblesRef.current = Array.from({ length: 20 }, () => createBubble(canvasRef.current!.width, canvasRef.current!.height));
    bgEntitiesRef.current = []; // Clear old background

    lastTimeRef.current = performance.now();
    cancelAnimationFrame(requestRef.current);
    requestRef.current = requestAnimationFrame(gameLoop);
  };

  const applyScoreBonus = (bonusScore: number) => {
    if (!Number.isFinite(bonusScore) || bonusScore <= 0) return;
    // Score is derived from distanceRef (score = floor(distance / 10)).
    distanceRef.current += bonusScore * 10;
    const newScore = Math.floor(distanceRef.current / 10);
    if (newScore > scoreRef.current) {
      scoreRef.current = newScore;
      setScore(newScore);
      const newLevel = Math.floor(newScore / 200) + 1;
      setLevel((prev) => (newLevel > prev ? newLevel : prev));
    }
  };

  const startRescueFromQuickSand = (trappedQuickSand: Platform) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (!turtleShellSavedRef.current) return;
    if (rescueRef.current.active) return;

    // Consume shell
    turtleShellSavedRef.current = false;
    setHasTurtleShell(false);
    turtleShellUseCountRef.current += 1;

    // Find the next NORMAL platform after the quicksand they fell from
    const targetPlat = platformsRef.current
      .filter(p => p.type === "NORMAL" && p.x > trappedQuickSand.x + trappedQuickSand.width + 1)
      .sort((a, b) => a.x - b.x)[0];

    const player = playerRef.current;
    const fallbackX = Math.min(canvas.width - player.width - 40, Math.max(40, player.x));
    const fallbackY = canvas.height - 100 - player.height;

    const targetPlayerX = targetPlat
      ? Math.min(canvas.width - player.width - 40, Math.max(40, targetPlat.x + targetPlat.width / 2 - player.width / 2))
      : fallbackX;
    const targetPlayerY = targetPlat ? (targetPlat.y - player.height) : fallbackY;

    // Initialize rescue animation from top-right
    rescueRef.current = {
      active: true,
      phase: "FLY_IN",
      phaseT: 0,
      turtleX: canvas.width + 120,
      turtleY: -80,
      targetPlayerX,
      targetPlayerY,
      playerXFixed: player.x,
      towStartY: player.y,
      worldShiftApplied: 0,
      hookPointX: player.x + player.width / 2,
      hookPointY: player.y + player.height / 2,
      countdownMs: 3000,
      lastCountdownDisplay: null,
    };

    // Stabilize player immediately (stop sinking/falling)
    player.isTrapped = false;
    player.dy = 0;
    isSwordfishActiveRef.current = false;
    swordfishTimerRef.current = 0;
  };

  const startTubeRescueFromFall = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (tubeRescueChargesRef.current <= 0) return;
    if (tubeRescueRef.current.active) return;
    if (rescueRef.current.active) return;

    // Consume 1 rescue charge (earned by completing a tube).
    setTubeRescueCharges(tubeRescueChargesRef.current - 1);

    const player = playerRef.current;

    // Find the next NORMAL platform ahead (after the gap).
    const targetPlat = platformsRef.current
      .filter(p => p.type === "NORMAL" && p.x > player.x + 40)
      .sort((a, b) => a.x - b.x)[0];

    const fallbackX = Math.min(canvas.width - player.width - 40, Math.max(40, player.x));
    const fallbackY = canvas.height - 100 - player.height;

    const targetPlayerX = targetPlat
      ? Math.min(canvas.width - player.width - 40, Math.max(40, targetPlat.x + targetPlat.width / 2 - player.width / 2))
      : fallbackX;
    const targetPlayerY = targetPlat ? (targetPlat.y - player.height) : fallbackY;

    tubeRescueRef.current = {
      active: true,
      phase: "FLY_IN",
      phaseT: 0,
      tubeX: canvas.width + 140,
      tubeY: -90,
      tubeRot: 0,
      targetPlayerX,
      targetPlayerY,
      playerXFixed: player.x,
      towStartY: player.y,
      worldShiftApplied: 0,
      countdownMs: 3000,
      lastCountdownDisplay: null,
    };

    // Stabilize player immediately.
    player.isTrapped = false;
    player.dy = 0;
    player.rotation = 0;
    isSwordfishActiveRef.current = false;
    swordfishTimerRef.current = 0;
  };

  const updateTubeRescue = (dt: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rescue = tubeRescueRef.current;
    if (!rescue.active) return;

    const shiftWorldX = (dx: number) => {
      if (dx === 0) return;
      platformsRef.current.forEach(p => { p.x -= dx; });
      itemsRef.current.forEach(it => { it.x -= dx; });
      bubblesRef.current.forEach(b => { b.x -= dx * 0.2; });
      bgEntitiesRef.current.forEach(e => { e.x -= dx * 0.2; });
    };

    rescue.phaseT += dt;
    rescue.tubeRot += dt * 3.5;

    const player = playerRef.current;

    if (rescue.phase === "FLY_IN") {
      const targetX = player.x + 150;
      const targetY = Math.max(40, Math.min(canvas.height - 180, player.y - 140));
      const speed = 6;
      rescue.tubeX += (targetX - rescue.tubeX) * Math.min(1, dt * speed);
      rescue.tubeY += (targetY - rescue.tubeY) * Math.min(1, dt * speed);
      const closeEnough = Math.hypot(rescue.tubeX - targetX, rescue.tubeY - targetY) < 14;
      if (closeEnough || rescue.phaseT > 1.2) {
        rescue.phase = "HOOK";
        rescue.phaseT = 0;
      }
      return;
    }

    if (rescue.phase === "HOOK") {
      if (rescue.phaseT > 0.55) {
        rescue.phase = "TOW";
        rescue.phaseT = 0;
        rescue.towStartY = player.y;
        rescue.playerXFixed = player.x;
        rescue.worldShiftApplied = 0;
      }
      return;
    }

    if (rescue.phase === "TOW") {
      const t = Math.min(1, rescue.phaseT / 1.1);
      const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

      const desiredShift = rescue.targetPlayerX - rescue.playerXFixed;
      const shiftNow = desiredShift * ease;
      const shiftStep = shiftNow - rescue.worldShiftApplied;
      shiftWorldX(shiftStep);
      rescue.worldShiftApplied = shiftNow;

      player.x = rescue.playerXFixed;
      player.y = rescue.towStartY + (rescue.targetPlayerY - rescue.towStartY) * ease;
      player.dy = 0;
      player.grounded = true;
      player.rotation = 0;

      // Tube stays slightly ahead/up while towing
      rescue.tubeX = player.x + 140;
      rescue.tubeY = Math.max(30, player.y - 120);

      if (t >= 1) {
        rescue.phase = "COUNTDOWN";
        rescue.phaseT = 0;
        rescue.countdownMs = 3000;
        rescue.lastCountdownDisplay = null;
        setRestartCountdown(3);
      }
      return;
    }

    if (rescue.phase === "COUNTDOWN") {
      rescue.countdownMs -= dt * 1000;
      const display = Math.max(0, Math.ceil(rescue.countdownMs / 1000));
      if (rescue.lastCountdownDisplay !== display) {
        rescue.lastCountdownDisplay = display;
        setRestartCountdown(display > 0 ? display : null);
      }

      // Fly off to the right/top
      rescue.tubeX += dt * 520;
      rescue.tubeY -= dt * 140;

      if (rescue.countdownMs <= 0) {
        tubeRescueRef.current = { active: false };
        setRestartCountdown(null);
        quickSandTimerRef.current = null;
      }
    }
  };

  const updateRescue = (dt: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rescue = rescueRef.current;
    if (!rescue.active) return;

    const shiftWorldX = (dx: number) => {
      if (dx === 0) return;
      platformsRef.current.forEach(p => { p.x -= dx; });
      itemsRef.current.forEach(it => { it.x -= dx; });
      // Light parallax so the whole scene reads as fast-forwarding together
      bubblesRef.current.forEach(b => { b.x -= dx * 0.2; });
      bgEntitiesRef.current.forEach(e => { e.x -= dx * 0.2; });
    };

    rescue.phaseT += dt;

    const player = playerRef.current;
    rescue.hookPointX = player.x + player.width / 2;
    rescue.hookPointY = player.y + player.height / 2;

    if (rescue.phase === "FLY_IN") {
      const targetX = player.x + 160;
      const targetY = Math.max(40, player.y - 140);
      const speed = 6; // higher is faster
      rescue.turtleX += (targetX - rescue.turtleX) * Math.min(1, dt * speed);
      rescue.turtleY += (targetY - rescue.turtleY) * Math.min(1, dt * speed);

      const closeEnough = Math.hypot(rescue.turtleX - targetX, rescue.turtleY - targetY) < 12;
      if (closeEnough || rescue.phaseT > 1.2) {
        rescue.phase = "HOOK";
        rescue.phaseT = 0;
      }
      return;
    }

    if (rescue.phase === "HOOK") {
      // Hold for a brief moment to emphasize the hook
      if (rescue.phaseT > 0.6) {
        rescue.phase = "TOW";
        rescue.phaseT = 0;
        rescue.towStartY = player.y;
        rescue.playerXFixed = player.x;
        rescue.worldShiftApplied = 0;
      }
      return;
    }

    if (rescue.phase === "TOW") {
      const t = Math.min(1, rescue.phaseT / 1.1);
      // Ease in-out
      const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

      // Keep submarine X fixed for fairness; shift the whole map instead.
      const desiredShift = rescue.targetPlayerX - rescue.playerXFixed;
      const shiftNow = desiredShift * ease;
      const shiftStep = shiftNow - rescue.worldShiftApplied;
      shiftWorldX(shiftStep);
      rescue.worldShiftApplied = shiftNow;

      player.x = rescue.playerXFixed;
      player.y = rescue.towStartY + (rescue.targetPlayerY - rescue.towStartY) * ease;
      player.dy = 0;
      player.grounded = true;
      player.rotation = 0;

      // Turtle stays slightly ahead/up of the submarine while towing
      rescue.turtleX = player.x + 140;
      rescue.turtleY = Math.max(30, player.y - 130);

      if (t >= 1) {
        rescue.phase = "COUNTDOWN";
        rescue.phaseT = 0;
        rescue.countdownMs = 3000;
        rescue.lastCountdownDisplay = null;
        setRestartCountdown(3);
      }
      return;
    }

    if (rescue.phase === "COUNTDOWN") {
      rescue.countdownMs -= dt * 1000;
      const display = Math.max(0, Math.ceil(rescue.countdownMs / 1000));
      if (rescue.lastCountdownDisplay !== display) {
        rescue.lastCountdownDisplay = display;
        setRestartCountdown(display > 0 ? display : null);
      }

      // After rescuing, turtle flies off to the left and disappears.
      rescue.turtleX -= dt * 650;
      rescue.turtleY -= dt * 120;

      if (rescue.countdownMs <= 0) {
        // Resume the current run from the next sand (no reset, keep speed/score/oxygen)
        rescueRef.current = { active: false };
        setRestartCountdown(null);
        quickSandTimerRef.current = null;
      }
    }
  };

  const gameOver = () => {
    const finalScore = scoreRef.current;
    didSubmitRef.current = false;
    const au = authUserRef.current;
    if (au && !didSendRunEndRef.current) {
      didSendRunEndRef.current = true;
      const runEndSeq = nextDolphinSyncSeq();
      missionsAPI
        .postEvent({ type: "run_end", score: finalScore })
        .then((out) => {
          if (out?.inventory && typeof out.inventory.dolphinSaved === "number") {
            applyDolphinCountSync(out.inventory.dolphinSaved, runEndSeq);
          }
          const streakGrant = out?.rewards?.streak?.dolphin;
          if (typeof streakGrant === "number" && streakGrant > 0) {
            if (gameStateRef.current === "PLAYING") {
              pendingDolphinRewardRef.current = true;
            } else {
              setDolphinRewardOpen(true);
            }
          }
          refreshDailyMissions();
        })
        .catch(() => undefined);
    }

    const lb = leaderboardRef.current;
    const isQualified = finalScore > 0 && (lb.length < 5 || finalScore > lb[lb.length - 1].score);

    if (isQualified) {
      gameStateRef.current = "INPUT_NAME";
      setGameState("INPUT_NAME");
      setPlayerName("");
    } else {
      gameStateRef.current = "GAME_OVER";
      setGameState("GAME_OVER");
      setLastSubmittedId(null); // No new high score, no highlight
    }
  };

  const submitHighScore = async (e: React.FormEvent) => {
    e.preventDefault();
    // Logged-in users may choose a different leaderboard name per submission.
    // If blank, server will default it to the user's loginId.
    const name = playerName.trim();

    if (!authUser) {
      pendingSubmitRef.current = true;
      setAuthMode("login");
      setAuthModalOpen(true);
      return;
    }

    try {
      const result = await leaderboardAPI.submitScore(name, scoreRef.current);

      if (result) {
        setLeaderboard(result.leaderboard);
        leaderboardRef.current = result.leaderboard;
        setLastSubmittedId(result.entry.id);
      }
    } catch (error) {
      console.error("Failed to submit high score:", error);
    }

    didSubmitRef.current = true;
    gameStateRef.current = "GAME_OVER";
    setGameState("GAME_OVER");
  };

  const handleAuthSubmit = async () => {
    setAuthError(null);

    const loginId = authLoginId.trim();
    if (!loginId) {
      setAuthError("Login ID is required");
      return;
    }

    if (authMode === "changePassword") {
      const currentPassword = authPassword;
      const newPassword = authNewPassword;
      const newPasswordConfirm = authNewPasswordConfirm;

      if (!currentPassword) {
        setAuthError("Current password is required");
        return;
      }
      if (!newPassword || newPassword.length < 8) {
        setAuthError("New password must be at least 8 characters");
        return;
      }
      if (newPassword !== newPasswordConfirm) {
        setAuthError("New password confirmation does not match");
        return;
      }
    } else {
      const password = authPassword;
      if (!password || password.length < 8) {
        setAuthError("Password must be at least 8 characters");
        return;
      }
    }

    setAuthBusy(true);
    try {
      let user: AuthUser;
      if (authMode === "signup") {
        user = await authAPI.register(loginId, authPassword);
      } else if (authMode === "changePassword") {
        user = await authAPI.changePassword(loginId, authPassword, authNewPassword);
      } else {
        user = await authAPI.login(loginId, authPassword);
      }

      setAuthUser(user);
      // Keep the auth ref in sync immediately (streak rewards + saved items use this for per-user storage keys).
      authUserRef.current = user;
      setAuthModalOpen(false);
      setAuthLoginId("");
      setAuthPassword("");
      setAuthNewPassword("");
      setAuthNewPasswordConfirm("");
      refreshDailyMissions();
      if (pendingSubmitRef.current) {
        pendingSubmitRef.current = false;
        // Retry submit (now authenticated). Keep the same score + chosen name.
        const result = await leaderboardAPI.submitScore(playerName.trim(), scoreRef.current);
        if (result) {
          setLeaderboard(result.leaderboard);
          leaderboardRef.current = result.leaderboard;
          setLastSubmittedId(result.entry.id);
        }
        didSubmitRef.current = true;
        gameStateRef.current = "GAME_OVER";
        setGameState("GAME_OVER");
      }
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : "Auth failed");
    } finally {
      setAuthBusy(false);
    }
  };

  // --- Main Game Loop ---
  const gameLoop = (time: number) => {
    if (gameStateRef.current !== "PLAYING") return;

    const deltaTime = Math.min((time - lastTimeRef.current) / 1000, 0.1);
    lastTimeRef.current = time;
    gameTimeRef.current += deltaTime;

    update(deltaTime, time);
    draw();

    requestRef.current = requestAnimationFrame(gameLoop);
  };

  const update = (dt: number, time: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // If we're mid-rescue, pause normal gameplay updates and run the rescue animation/state machine.
    if (rescueRef.current.active) {
      updateRescue(dt);
      return;
    }
    if (tubeRescueRef.current.active) {
      updateTubeRescue(dt);
      return;
    }

    const player = playerRef.current;

    // 0. Update Jump Buffer
    if (jumpBufferTimerRef.current > 0) {
      jumpBufferTimerRef.current -= dt;
    }

    // 1. Manage Powerup Timers
    if (swordfishTimerRef.current > 0) {
      swordfishTimerRef.current -= dt * 1000;
    }

    // 2. Update Oxygen
    oxygenRef.current -= Constants.OXYGEN_DEPLETION_RATE * dt;
    if (oxygenRef.current <= 0) {
      oxygenRef.current = 0;
      setOxygen(0);
      gameOver();
      return;
    }

    setOxygen(oxygenRef.current);

    // 3. Update Speed & Score
    let effectiveSpeed = speedRef.current;
    if (swordfishTimerRef.current > 0) {
      effectiveSpeed *= Constants.SWORDFISH_SPEED_MULT;
    }

    speedRef.current = Math.min(Constants.MAX_SPEED, speedRef.current + 0.1 * dt);

    distanceRef.current += effectiveSpeed;
    const newScore = Math.floor(distanceRef.current / 10);

    if (newScore > scoreRef.current) {
      scoreRef.current = newScore;
      setScore(newScore);

      const newLevel = Math.floor(newScore / 200) + 1;
      setLevel(prev => {
        if (newLevel > prev) return newLevel;
        return prev;
      });
    }

    // --- Background Entities Update ---
    if (Math.random() < 0.015) { // ~1 per second roughly
      spawnBackgroundEntity(canvas.width, canvas.height, bgEntitiesRef.current);
    }

    bgEntitiesRef.current.forEach(e => {
      // Move with parallax (slower than foreground) + intrinsic speed
      const parallaxSpeed = effectiveSpeed * (0.2 * e.scale);
      e.x -= (parallaxSpeed + (e.type === "SHIP" || e.type === "CORAL" ? 0 : e.speed));

      // Micro moves (bobbing)
      e.y += Math.sin(gameTimeRef.current * 2 + e.wobbleOffset) * 0.2;
    });
    // Remove off-screen
    bgEntitiesRef.current = bgEntitiesRef.current.filter(e => e.x > -300);


    // 4. Safe Landing Logic & Flight State Check
    let shouldDescend = false;

    if (isSwordfishActiveRef.current && swordfishTimerRef.current <= 0) {
      const playerCenter = player.x + player.width / 2;
      const platformBelow = platformsRef.current.find(p =>
        playerCenter > p.x && playerCenter < p.x + p.width
      );

      if (platformBelow) {
        const groundY = platformBelow.y - player.height;
        const fallDistance = Math.max(0, groundY - player.y);
        const framesToFall = Math.sqrt(2 * fallDistance / Constants.GRAVITY);
        const currentRightEdge = platformBelow.x + platformBelow.width;
        const futureRightEdge = currentRightEdge - (framesToFall * speedRef.current);

        if (futureRightEdge > player.x + player.width + 100) {
          isSwordfishActiveRef.current = false;
        } else {
          shouldDescend = true;
        }
      }
    }

    // 5. Player Physics
    if (isSwordfishActiveRef.current) {
      // Flight Mode
      player.dy = shouldDescend ? 3 : 0;
      player.rotation = 0;
      player.grounded = false;
      player.isBoosting = false; // Disable jump boost in flight
    } else {
      // Normal Physics with Variable Jump Height

      // Handle Boosting (Long Jump)
      if (player.isBoosting) {
        if (isJumpInputActiveRef.current && player.boostTimer < Constants.JUMP_BOOST_MAX_DURATION) {
          // Apply anti-gravity boost
          player.dy -= Constants.JUMP_BOOST_FORCE;
          player.boostTimer += dt;
        } else {
          // Stop boosting if key released or time limit reached
          player.isBoosting = false;
        }
      }

      player.dy += Constants.GRAVITY;
    }

    player.y += player.dy;

    // Rotation logic
    if (!isSwordfishActiveRef.current) {
      if (!player.grounded) {
        player.rotation += 2;
      } else {
        player.rotation = 0;
      }
    }

    // 6. Ground Collision & Logic
    let onGround = false;
    let touchingQuickSand = false;
    let trappedQuickSand: Platform | null = null;
    player.isTrapped = false;

    for (const plat of platformsRef.current) {
      if (
        player.x < plat.x + plat.width &&
        player.x + player.width > plat.x &&
        player.y + player.height > plat.y &&
        player.y + player.height < plat.y + 35
      ) {
        if (plat.type === "QUICKSAND") {
          touchingQuickSand = true;
          if (quickSandTimerRef.current === null) {
            quickSandTimerRef.current = time;
          }

          if (time - quickSandTimerRef.current > 500) {
            plat.sinking = true;
          }
        }

        if (plat.sinking) {
          player.isTrapped = true;
          if (plat.type === "QUICKSAND") trappedQuickSand = plat;
          if (player.dy >= 0 || player.grounded) {
            player.y = plat.y - player.height + 15;
            player.dy = 0;
            onGround = true;
          }
        } else {
          if (player.dy > 0) {
            player.y = plat.y - player.height;
            player.dy = 0;
            onGround = true;
          }
        }
      }
    }

    if (onGround) {
      player.grounded = true;
      player.isBoosting = false; // Reset boost on landing
    } else {
      player.grounded = false;
    }

    // 6.5 Check Jump Buffer (Late Jump / Bunny Hop)
    if (jumpBufferTimerRef.current > 0) {
      if (attemptJump()) {
        jumpBufferTimerRef.current = 0;
      }
    }

    if (!touchingQuickSand) {
      quickSandTimerRef.current = null;
    }

    // Auto-use Turtle Shell to escape quicksand
    if (player.isTrapped && trappedQuickSand && turtleShellSavedRef.current) {
      startRescueFromQuickSand(trappedQuickSand);
      return;
    }

    if (player.y > canvas.height) {
      // If tube is completed, it grants a 1x rescue-from-fall.
      if (tubeRescueChargesRef.current > 0) {
        startTubeRescueFromFall();
        return;
      }
      if (player.isTrapped) playSound('die_quicksand');
      else playSound('die_fall');
      gameOver();
      return;
    }

    // 7. Move World
    platformsRef.current.forEach(p => {
      p.x -= effectiveSpeed;
      if (p.sinking) {
        p.y += 3;
      }
    });

    if (platformsRef.current.length > 0 && platformsRef.current[0].x + platformsRef.current[0].width < -100) {
      platformsRef.current.shift();
    }

    const lastPlat = platformsRef.current[platformsRef.current.length - 1];
    if (lastPlat && lastPlat.x + lastPlat.width < canvas.width + 100) {
      const currentScore = scoreRef.current;
      const currentLevel = Math.floor(currentScore / 200) + 1;

      // Difficulty Logic
      let holeChance = 0.3;
      let minGapTiles = 2;
      let maxGapTiles = 3;
      let minPlatTiles = 4;
      let maxPlatTiles = 8;

      if (currentLevel >= 2) { holeChance = 0.35; maxGapTiles = 4; maxPlatTiles = 6; }
      if (currentLevel >= 3) { holeChance = 0.4; minGapTiles = 3; minPlatTiles = 3; maxPlatTiles = 5; }
      if (currentLevel >= 4) { holeChance = 0.45; maxGapTiles = 5; minPlatTiles = 2; maxPlatTiles = 4; }
      if (currentLevel >= 5) { holeChance = 0.5; minPlatTiles = 2; maxPlatTiles = 3; }

      const maxJumpPx = (speedRef.current * 40) - 60;
      const safeMaxGapTiles = Math.floor(maxJumpPx / Constants.TILE_SIZE);

      maxGapTiles = Math.min(maxGapTiles, safeMaxGapTiles);
      if (minGapTiles > maxGapTiles) minGapTiles = maxGapTiles;

      const isGap = Math.random() < holeChance;
      const groundY = canvas.height - 100;

      let nextX = lastPlat.x + lastPlat.width;

      if (isGap) {
        const gapTiles = Math.floor(Math.random() * (maxGapTiles - minGapTiles + 1)) + minGapTiles;
        nextX += gapTiles * Constants.TILE_SIZE;
      }

      const platTiles = Math.floor(Math.random() * (maxPlatTiles - minPlatTiles + 1)) + minPlatTiles;
      let isQuickSand = Math.random() < 0.25;
      let effectivePlatTiles = platTiles;

      // Dev/testing: after picking up a turtle shell, force a long quicksand once
      if (Constants.DEV_FORCE_LONG_QUICKSAND_AFTER_TURTLE_SHELL && devForceLongQuickSandOnceRef.current) {
        isQuickSand = true;
        effectivePlatTiles = Math.max(effectivePlatTiles, Constants.DEV_LONG_QUICKSAND_TILES);
        devForceLongQuickSandOnceRef.current = false;
      }

      const newPlat: Platform = {
        x: nextX,
        y: groundY,
        width: effectivePlatTiles * Constants.TILE_SIZE,
        height: 100,
        type: isQuickSand ? "QUICKSAND" : "NORMAL",
        sinking: false
      };
      platformsRef.current.push(newPlat);

      if (!isGap) {
        // URCHIN SPAWN LOGIC
        let spawnedUrchin = false;
        if (scoreRef.current > Constants.URCHIN_SCORE_THRESHOLD) {
          if (Math.random() < Constants.URCHIN_CHANCE) {
            itemsRef.current.push({
              x: newPlat.x + newPlat.width / 2,
              y: newPlat.y - 140 - (Math.random() * 50), // High enough to avoid short jump
              width: 40,
              height: 40,
              collected: false,
              type: "URCHIN",
              rotation: 0,
              isDead: false,
              dy: 0
            });
            spawnedUrchin = true;
          }
        }

        if (!spawnedUrchin) {
          let spawnedRegularItem = false;

          // Turtle Shell spawn (only after unlock score, and only if player doesn't already have one saved)
          if (
            scoreRef.current >= Constants.TURTLE_SHELL_UNLOCK_SCORE &&
            !turtleShellSavedRef.current &&
            !rescueRef.current.active
          ) {
            const uses = turtleShellUseCountRef.current;
            const turtleChance = Constants.TURTLE_SHELL_BASE_CHANCE / (1 + uses * Constants.TURTLE_SHELL_RARITY_DECAY_PER_USE);
            if (Math.random() < turtleChance) {
              itemsRef.current.push({
                x: newPlat.x + newPlat.width / 2 - 22,
                y: newPlat.y - 90 - (Math.random() * 70),
                width: 44,
                height: 34,
                collected: false,
                type: "TURTLE_SHELL"
              });
              spawnedRegularItem = true;
            }
          }

          if (!spawnedRegularItem) {
            const rand = Math.random();
            if (rand < Constants.SWORDFISH_CHANCE) {
              itemsRef.current.push({
                x: newPlat.x + newPlat.width / 2 - 25,
                y: newPlat.y - 120 - (Math.random() * 80),
                width: 50,
                height: 30,
                collected: false,
                type: "SWORDFISH"
              });
            }
            else if (rand < Constants.SWORDFISH_CHANCE + Constants.TANK_CHANCE) {
              itemsRef.current.push({
                x: newPlat.x + newPlat.width / 2 - 15,
                y: newPlat.y - 60 - (Math.random() * 100),
                width: 30,
                height: 40,
                collected: false,
                type: "OXYGEN"
              });
            }
            else if (
              scoreRef.current >= Constants.TUBE_PIECE_UNLOCK_SCORE &&
              !rescueRef.current.active &&
              Math.random() < Constants.TUBE_PIECE_CHANCE
            ) {
              itemsRef.current.push({
                x: newPlat.x + newPlat.width / 2 - 18,
                y: newPlat.y - 90 - (Math.random() * 70),
                width: 36,
                height: 36,
                collected: false,
                type: "TUBE_PIECE",
                // Show the "next" quarter so the piece art matches the HUD progress.
                variant: tubePiecesRef.current % 4,
              });
            }
          }
        }
      }
    }

    // 8. Move & Check Items
    itemsRef.current.forEach(item => {
      item.x -= effectiveSpeed;

      // Urchin specific physics
      if (item.type === "URCHIN") {
        if (item.isDead) {
          item.dy = (item.dy || 0) + Constants.GRAVITY;
          item.y += item.dy;
          item.rotation = (item.rotation || 0) + 15; // Fast spin when dying
        } else {
          item.rotation = (item.rotation || 0) + 3; // Normal spin
        }
      }
    });

    itemsRef.current = itemsRef.current.filter(item => {
      if (item.collected) return false;
      // Keep dead urchins longer so we see them fall off screen
      if (item.x + item.width < -50 || item.y > canvas.height + 50) return false;

      // Collision Item
      if (
        player.x < item.x + item.width &&
        player.x + player.width > item.x &&
        player.y < item.y + item.height &&
        player.y + player.height > item.y
      ) {
        if (item.type === "OXYGEN") {
          oxygenRef.current = Math.min(Constants.OXYGEN_MAX, oxygenRef.current + Constants.OXYGEN_RESTORE);
          setOxygen(oxygenRef.current);
          playSound('oxygen');
          if (authUserRef.current) {
            missionsAPI.postEvent({ type: "oxygen_collected", count: 1 });
          }
          return false;
        } else if (item.type === "SWORDFISH") {
          isSwordfishActiveRef.current = true;
          swordfishTimerRef.current = Constants.SWORDFISH_DURATION;
          playSound('swordfish');
          return false;
        } else if (item.type === "TURTLE_SHELL") {
          turtleShellSavedRef.current = true;
          setHasTurtleShell(true);
          playSound('shell_crack');
          // Dev/testing: make the next generated platform a long quicksand
          if (Constants.DEV_FORCE_LONG_QUICKSAND_AFTER_TURTLE_SHELL) {
            devForceLongQuickSandOnceRef.current = true;
          }
          return false;
        } else if (item.type === "TUBE_PIECE") {
          const next = tubePiecesRef.current + 1;
          playSound('oxygen');
          if (next >= Constants.TUBE_PIECES_PER_TUBE) {
            // Completion: trigger exactly once per 4 pieces, apply reward once, then reset.
            setTubePieces(0);
            setTubeRescueCharges(tubeRescueChargesRef.current + 1);
            applyScoreBonus(Constants.TUBE_COMPLETION_BONUS_SCORE);
            showTubeToast("Tube Completed!");
          } else {
            setTubePieces(next);
          }
          return false;
        } else if (item.type === "URCHIN") {
          if (item.isDead) return true; // Already dead, ignore

          if (isSwordfishActiveRef.current) {
            // Defeat Urchin
            item.isDead = true;
            item.dy = -5; // Bounce up
            playSound('die_urchin'); // Re-using die sound for hitting it
            return true; // Keep in array for animation
          } else {
            playSound('die_urchin');
            gameOver();
            return false;
          }
        }
        return false;
      }
      return true;
    });

    bubblesRef.current.forEach(b => {
      b.y -= b.speed;
      b.x -= effectiveSpeed * 0.2;
      // Horizontal wobble
      const wobble = Math.sin(gameTimeRef.current * 2 + b.wobbleOffset) * 0.5;
      b.x += wobble;

      if (b.y < -10) {
        Object.assign(b, createBubble(canvas.width, canvas.height, false));
      }
    });
  };

  const draw = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // 1. Dynamic Background Color
    const maxDepthScore = 5000;
    const depthProgress = Math.min(scoreRef.current / maxDepthScore, 1);
    const c1 = interpolateColor([0, 105, 148], [0, 20, 40], depthProgress);
    const c2 = interpolateColor([0, 30, 54], [0, 5, 10], depthProgress);

    const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
    gradient.addColorStop(0, c1);
    gradient.addColorStop(1, c2);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // 2. Light Rays
    ctx.save();
    ctx.globalCompositeOperation = 'overlay';
    const rayCount = 5;
    const t = gameTimeRef.current;
    for (let i = 0; i < rayCount; i++) {
      const opacity = (Math.sin(t + i) + 1) / 2 * 0.1;
      ctx.fillStyle = `rgba(255, 255, 255, ${opacity})`;
      ctx.beginPath();
      const baseX = (canvas.width / rayCount) * i;
      const slant = Math.sin(t * 0.2) * 100;
      ctx.moveTo(baseX - 100, -50);
      ctx.lineTo(baseX + 100, -50);
      ctx.lineTo(baseX + slant + 50, canvas.height * 0.8);
      ctx.lineTo(baseX + slant - 50, canvas.height * 0.8);
      ctx.fill();
    }
    ctx.restore();

    // 3. Draw Background Entities (Fish, Whales, etc.)
    drawBackgroundEntities(ctx, bgEntitiesRef.current, gameTimeRef.current);

    ctx.fillStyle = "rgba(255, 255, 255, 0.3)";
    bubblesRef.current.forEach(b => {
      ctx.globalAlpha = b.opacity;
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.size, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.globalAlpha = 1.0;

    platformsRef.current.forEach(p => {
      if (p.type === "QUICKSAND") {
        ctx.fillStyle = "#a67b5b";
      } else {
        ctx.fillStyle = "#c2b280";
      }
      ctx.fillRect(p.x, p.y, p.width, p.height);

      if (p.type === "QUICKSAND") {
        ctx.fillStyle = "#c4a484";
      } else {
        ctx.fillStyle = "#e0d5a6";
      }
      ctx.fillRect(p.x, p.y, p.width, 10);
    });

    itemsRef.current.forEach(item => {
      if (item.type === "OXYGEN") {
        ctx.fillStyle = "#00ffff";
        ctx.fillRect(item.x, item.y, item.width, item.height);
        ctx.fillStyle = "#008b8b";
        ctx.fillRect(item.x + 5, item.y + 5, item.width - 10, 5);
        ctx.fillStyle = "black";
        ctx.font = "10px Arial";
        ctx.fillText("O2", item.x + 8, item.y + 25);
      } else if (item.type === "SWORDFISH") {
        drawSwordfish(ctx, item.x, item.y, item.width, item.height);
      } else if (item.type === "TURTLE_SHELL") {
        const img = turtleShellItemImgRef.current;
        if (img && img.complete && img.naturalWidth > 0) {
          // Draw sprite (contain) inside the item bounding box
          const r = img.naturalWidth / img.naturalHeight;
          let w = item.width;
          let h = item.height;
          if (w / h > r) {
            w = h * r;
          } else {
            h = w / r;
          }
          const dx = item.x + (item.width - w) / 2;
          const dy = item.y + (item.height - h) / 2;
          ctx.drawImage(img, dx, dy, w, h);
        } else {
          // Fallback if image not ready yet
          drawTurtleShell(ctx, item.x, item.y, item.width, item.height);
        }
      } else if (item.type === "TUBE_PIECE") {
        const img = tubeImgRef.current;
        if (img && img.complete && img.naturalWidth > 0) {
          const sw = Math.floor(img.naturalWidth / 2);
          const sh = Math.floor(img.naturalHeight / 2);
          const v = (typeof item.variant === "number" && item.variant >= 0) ? (item.variant % 4) : 0;
          const sx = (v % 2) * sw;
          const sy = Math.floor(v / 2) * sh;
          ctx.drawImage(img, sx, sy, sw, sh, item.x, item.y, item.width, item.height);
        } else {
          ctx.fillStyle = "rgba(0,255,255,0.9)";
          ctx.fillRect(item.x, item.y, item.width, item.height);
        }
      } else if (item.type === "URCHIN") {
        drawUrchin(ctx, item);
      }
    });

    const p = playerRef.current;
    ctx.save();
    ctx.translate(p.x + p.width / 2, p.y + p.height / 2);
    ctx.rotate((p.rotation * Math.PI) / 180);

    if (isSwordfishActiveRef.current) {
      ctx.shadowColor = "#00ffff";
      ctx.shadowBlur = 20;
    }

    ctx.fillStyle = "#FFD700";
    ctx.beginPath();
    ctx.roundRect(-p.width / 2, -p.height / 2, p.width, p.height, 8);
    ctx.fill();

    ctx.shadowBlur = 0;

    ctx.fillStyle = "#87CEEB";
    ctx.beginPath();
    ctx.arc(5, -5, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = "#666";
    ctx.fillRect(-p.width / 2 - 5, -5, 5, 10);

    ctx.restore();

    // Rescue turtle overlay (draw last so it sits on top)
    const rescue = rescueRef.current;
    if (rescue.active) {
      const img = rescueTurtleImgRef.current;
      const source: CanvasImageSource | null = img;

      if (source && img && img.complete && img.naturalWidth > 0) {
        // Size tuned to feel readable without covering the entire screen
        const w = 80; // half size
        const h = (img.naturalHeight / img.naturalWidth) * w;
        const drawX = rescue.turtleX - w / 2;
        const drawY = rescue.turtleY - h / 2;

        // Fishing line during hook/tow so it reads like the turtle is pulling the sub
        const isPulling = rescue.phase === "HOOK" || rescue.phase === "TOW";
        if (isPulling) {
          // Approximate rod tip position within the sprite
          const rodTipX = drawX + w * 0.20;
          const rodTipY = drawY + h * 0.56;

          ctx.save();
          ctx.strokeStyle = "rgba(255,255,255,0.9)";
          ctx.lineWidth = 2.5;
          ctx.shadowColor = "rgba(0,0,0,0.45)";
          ctx.shadowBlur = 2;
          ctx.beginPath();
          ctx.moveTo(rodTipX, rodTipY);
          ctx.lineTo(rescue.hookPointX, rescue.hookPointY);
          ctx.stroke();

          // Hook dot
          ctx.fillStyle = "rgba(255,255,255,0.95)";
          ctx.beginPath();
          ctx.arc(rescue.hookPointX, rescue.hookPointY, 4, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }

        // Don't draw once the turtle has flown off-screen
        if (drawX + w > -20) {
          ctx.drawImage(source, drawX, drawY, w, h);
        }
      }
    }

    // Tube rescue overlay (draw on top)
    const tubeRescue = tubeRescueRef.current;
    if (tubeRescue.active) {
      const img = tubeImgRef.current;
      if (img && img.complete && img.naturalWidth > 0) {
        const w = 92;
        const h = (img.naturalHeight / img.naturalWidth) * w;
        const x = tubeRescue.tubeX;
        const y = tubeRescue.tubeY;
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(tubeRescue.tubeRot);
        ctx.shadowColor = "rgba(0,255,255,0.35)";
        ctx.shadowBlur = 16;
        ctx.globalAlpha = 0.95;
        ctx.drawImage(img, -w / 2, -h / 2, w, h);
        ctx.restore();
      } else {
        ctx.save();
        ctx.fillStyle = "rgba(0,255,255,0.85)";
        ctx.beginPath();
        ctx.arc(tubeRescue.tubeX, tubeRescue.tubeY, 26, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }
  };

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <canvas
        ref={canvasRef}
        width={window.innerWidth}
        height={window.innerHeight}
        style={{ display: "block" }}
        tabIndex={0}
      />

      {gameState === "PLAYING" && (
        <HUD
          score={score}
          level={level}
          oxygen={oxygen}
          hasTurtleShell={hasTurtleShell}
          dolphinCount={dolphinCount}
          dolphinSpendSeq={dolphinSpendSeq}
          tubePieces={tubePieces}
          tubeRescueCharges={tubeRescueCharges}
        />
      )}

      {tubeToast && (
        <div
          style={{
            position: "absolute",
            top: 78,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 25,
            pointerEvents: "none",
            padding: "8px 12px",
            borderRadius: 12,
            border: "1px solid rgba(0,255,255,0.55)",
            background: "rgba(0, 20, 40, 0.72)",
            color: "#00ffff",
            fontFamily: "monospace",
            fontWeight: 900,
            letterSpacing: 0.6,
            textShadow: "0 2px 0 rgba(0,0,0,0.6)",
          }}
        >
          {tubeToast}
        </div>
      )}

      {restartCountdown !== null && (
        <div style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 20,
          pointerEvents: "none",
          color: "white",
          fontFamily: "monospace",
          textShadow: "0 6px 0 rgba(0,0,0,0.6)",
          fontSize: "clamp(64px, 14vw, 140px)",
        }}>
          {restartCountdown}
        </div>
      )}

      <DolphinStreakRewardOverlay
        open={dolphinRewardOpen}
        streakDays={dailyMissions?.user ? dailyMissions.user.streak.current : undefined}
        onClose={() => setDolphinRewardOpen(false)}
      />

      <DolphinWeeklyWinnerRewardOverlay
        open={weeklyDolphinRewardOpen}
        weekId={weeklyDolphinRewardWeekId ?? undefined}
        onClose={() => setWeeklyDolphinRewardOpen(false)}
      />

      {gameState === "MENU" && (
        <MenuOverlay
          leaderboard={leaderboard}
          lastSubmittedId={lastSubmittedId}
          weeklyLeaderboards={weeklyLeaderboards}
          currentWeekId={currentWeekId}
          streakCurrent={dailyMissions?.user ? dailyMissions.user.streak.current : 0}
          loginId={authUser?.loginId ?? null}
          onLogoutClick={async () => {
            await authAPI.logout();
            setAuthUser(null);
            authUserRef.current = null;
            refreshDailyMissions();
          }}
          onLoginClick={() => {
            setAuthError(null);
            setAuthMode("login");
            setAuthModalOpen(true);
          }}
          onStreakClick={() => {
            setStreakOpen(true);
            refreshDailyMissions();
          }}
        />
      )}

      {gameState === "INPUT_NAME" && (
        <InputNameOverlay
          score={score}
          playerName={playerName}
          setPlayerName={setPlayerName}
          isLoggedIn={!!authUser}
          loginId={authUser?.loginId ?? null}
          onOpenLogin={() => {
            setAuthError(null);
            setAuthMode("login");
            setAuthModalOpen(true);
          }}
          onSubmit={submitHighScore}
        />
      )}

      {gameState === "GAME_OVER" && (
        <GameOverOverlay
          score={score}
          didSubmit={didSubmitRef.current}
          leaderboard={leaderboard}
          lastSubmittedId={lastSubmittedId}
          weeklyLeaderboards={weeklyLeaderboards}
          currentWeekId={currentWeekId}
        />
      )}

      <AuthModal
        open={authModalOpen}
        mode={authMode}
        setMode={setAuthMode}
        loginId={authLoginId}
        setLoginId={setAuthLoginId}
        password={authPassword}
        setPassword={setAuthPassword}
        newPassword={authNewPassword}
        setNewPassword={setAuthNewPassword}
        newPasswordConfirm={authNewPasswordConfirm}
        setNewPasswordConfirm={setAuthNewPasswordConfirm}
        error={authError}
        isBusy={authBusy}
        onClose={() => {
          pendingSubmitRef.current = false;
          setAuthModalOpen(false);
        }}
        onSubmit={handleAuthSubmit}
      />

      <DailyMissionsPanel
        open={streakOpen}
        onClose={() => setStreakOpen(false)}
        date={dailyMissions?.date ?? null}
        streakCurrent={dailyMissions?.user ? dailyMissions.user.streak.current : 0}
        missions={dailyMissions?.missions ?? []}
        progress={dailyMissions?.user ? dailyMissions.user.progress : null}
      />
    </div>
  );
};
