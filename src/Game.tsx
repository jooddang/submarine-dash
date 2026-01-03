import React, { useEffect, useRef, useState } from "react";
import type { GameState, Player, Platform, Item, Bubble, BackgroundEntity, LeaderboardEntry } from "./types";
import * as Constants from "./constants";
import { initAudio, playSound } from "./audio";
import { interpolateColor } from "./graphics";
import { createBubble, spawnBackgroundEntity } from "./entities";
import { drawSwordfish, drawUrchin, drawBackgroundEntities, drawTurtleShell } from "./drawing";
import { HUD, MenuOverlay, InputNameOverlay, GameOverOverlay, AuthModal, DailyMissionsPanel, DolphinStreakRewardOverlay } from "./components/UIOverlays";
import { authAPI, leaderboardAPI, missionsAPI, type DailyMissionsResponse } from "./api";
import turtleRescueImg from "../turtle.png";
import turtleShellItemImg from "../turtle-shell-item.png";

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
  const devForceLongQuickSandOnceRef = useRef<boolean>(false);
  const rescueTurtleImgRef = useRef<HTMLImageElement | null>(null);
  const turtleShellItemImgRef = useRef<HTMLImageElement | null>(null);
  // Dolphin (saved item): allows 1x mid-air double jump, then consumed
  const dolphinSavedRef = useRef<boolean>(false);

  // --- React State for UI ---
  const [gameState, setGameState] = useState<GameState>("MENU");
  const [score, setScore] = useState(0);
  const [oxygen, setOxygen] = useState(Constants.OXYGEN_MAX);
  const [level, setLevel] = useState(1);
  const [hasTurtleShell, setHasTurtleShell] = useState(false);
  const [hasDolphin, setHasDolphin] = useState(false);
  const [restartCountdown, setRestartCountdown] = useState<number | null>(null);
  const [dolphinRewardOpen, setDolphinRewardOpen] = useState(false);

  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const leaderboardRef = useRef<LeaderboardEntry[]>([]);
  const [lastSubmittedId, setLastSubmittedId] = useState<number | null>(null);

  const [playerName, setPlayerName] = useState("");
  const [authUser, setAuthUser] = useState<{ userId: string; loginId: string; refCode: string } | null>(null);
  // Important: the game loop + global event listeners are registered once and can capture stale state.
  // Mirror auth state into a ref so gameplay-side logic always sees the latest auth status.
  const authUserRef = useRef<{ userId: string; loginId: string; refCode: string } | null>(null);
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [authMode, setAuthMode] = useState<"login" | "signup">("login");
  const [authLoginId, setAuthLoginId] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const pendingSubmitRef = useRef<boolean>(false);
  const [streakOpen, setStreakOpen] = useState(false);
  const [dailyMissions, setDailyMissions] = useState<DailyMissionsResponse | null>(null);
  const pendingDolphinRewardRef = useRef<boolean>(false);
  const lastSeenStreakRef = useRef<number | null>(null);
  const lastAwardedStreakRef = useRef<number>(0);

  const DOLPHIN_SAVED_KEY_BASE = "subdash:savedItem:dolphin";
  const DOLPHIN_STREAK_LAST_AWARDED_KEY_BASE = "subdash:reward:dolphin:streak:lastAwarded";

  const storageUserId = () => authUserRef.current?.userId ?? "guest";
  const keyForUser = (base: string) => `${base}:${storageUserId()}`;

  const setDolphinSaved = (value: boolean, opts?: { persist?: boolean }) => {
    dolphinSavedRef.current = value;
    setHasDolphin(value);
    if (opts?.persist === false) return;
    try {
      localStorage.setItem(keyForUser(DOLPHIN_SAVED_KEY_BASE), value ? "1" : "0");
    } catch {
      // ignore (private mode / blocked storage)
    }
  };

  const loadDolphinSavedFromStorage = () => {
    try {
      const raw = localStorage.getItem(keyForUser(DOLPHIN_SAVED_KEY_BASE));
      setDolphinSaved(raw === "1", { persist: false });
    } catch {
      setDolphinSaved(false, { persist: false });
    }
  };

  const refreshDailyMissions = async () => {
    try {
      const data = await missionsAPI.getDaily();
      setDailyMissions(data);
    } catch (e) {
      console.error("Failed to fetch daily missions:", e);
    }
  };

  useEffect(() => {
    // Load leaderboard from backend API
    const loadLeaderboard = async () => {
      try {
        const data = await leaderboardAPI.getLeaderboard();
        setLeaderboard(data);
        leaderboardRef.current = data;
      } catch (e) {
        console.error("Failed to load leaderboard", e);
      }
    };

    loadLeaderboard();

    // Load auth session (if any)
    const loadMe = async () => {
      const me = await authAPI.me();
      setAuthUser(me);
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
    // Load saved dolphin per-user (persists across runs until consumed).
    loadDolphinSavedFromStorage();
    // Load last awarded streak per-user to prevent double-awards across reloads.
    try {
      const raw = localStorage.getItem(keyForUser(DOLPHIN_STREAK_LAST_AWARDED_KEY_BASE));
      const n = raw ? Number.parseInt(raw, 10) : 0;
      lastAwardedStreakRef.current = Number.isFinite(n) ? Math.max(0, n) : 0;
    } catch {
      lastAwardedStreakRef.current = 0;
    }
    lastSeenStreakRef.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authUser?.userId]);

  useEffect(() => {
    // Refresh missions when auth changes (login/logout)
    refreshDailyMissions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authUser?.userId]);

  useEffect(() => {
    // Dev/testing: force the streak reward moment (confetti + modal) and grant dolphin.
    if (!Constants.DEV_FORCE_DOLPHIN_STREAK_REWARD_MOMENT) return;
    setDolphinSaved(true);
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
    // Streak reward: when streak increases AND the new value is 5+,
    // grant a saved dolphin and celebrate (once per streak increment).
    const streak = dailyMissions?.user?.streak?.current;
    if (typeof streak !== "number") return;
    if (streak < 5) {
      lastSeenStreakRef.current = streak;
      return;
    }
    if (!authUserRef.current) {
      lastSeenStreakRef.current = streak;
      return;
    }

    const prev = lastSeenStreakRef.current;
    lastSeenStreakRef.current = streak;
    if (prev === null) return; // first observation: don't award retroactively
    if (streak <= prev) return; // only on increase
    if (streak <= lastAwardedStreakRef.current) return; // already awarded (e.g., after reload)

    lastAwardedStreakRef.current = streak;
    try {
      localStorage.setItem(keyForUser(DOLPHIN_STREAK_LAST_AWARDED_KEY_BASE), String(streak));
    } catch {
      // ignore (private mode / blocked storage)
    }

    setDolphinSaved(true);
    if (gameStateRef.current === "PLAYING") {
      pendingDolphinRewardRef.current = true;
    } else {
      setDolphinRewardOpen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dailyMissions?.user?.streak?.current]);

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

  // --- Input Handling ---
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
      } else if (gameStateRef.current === "MENU" || gameStateRef.current === "GAME_OVER") {
        startGame();
      }
    };

    const handleTouchEnd = (e: TouchEvent) => {
      // Allow interacting with UI controls (login button, inputs, etc.)
      const target = e.target as HTMLElement;
      if (target?.tagName === "INPUT" || target?.tagName === "BUTTON") {
        return;
      }

      if (e.cancelable) {
        e.preventDefault();
      }
      isJumpInputActiveRef.current = false;
    };

    const handleClick = () => {
      initAudio(); // Unlock audio on click for mobile devices
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    // passive: false is required to use preventDefault() in touch listeners
    window.addEventListener("touchstart", handleTouchStart, { passive: false });
    window.addEventListener("touchend", handleTouchEnd, { passive: false });
    window.addEventListener("click", handleClick);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("touchstart", handleTouchStart);
      window.removeEventListener("touchend", handleTouchEnd);
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
    if (dolphinSavedRef.current && !isImminentLandingWhileFalling()) {
      setDolphinSaved(false);

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
      turtleShellSavedRef.current = true;
      setHasTurtleShell(true);
    }
    // Dev/testing: start with a saved Dolphin (double jump)
    if (Constants.DEV_FORCE_DOLPHIN_ON_START) {
      setDolphinSaved(true);
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

    itemsRef.current = [];
    bubblesRef.current = Array.from({ length: 20 }, () => createBubble(canvasRef.current!.width, canvasRef.current!.height));
    bgEntitiesRef.current = []; // Clear old background

    lastTimeRef.current = performance.now();
    cancelAnimationFrame(requestRef.current);
    requestRef.current = requestAnimationFrame(gameLoop);
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
      missionsAPI
        .postEvent({ type: "run_end", score: finalScore })
        .then(() => refreshDailyMissions())
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
    setAuthBusy(true);
    try {
      const loginId = authLoginId.trim();
      const password = authPassword;
      const user =
        authMode === "signup"
          ? await authAPI.register(loginId, password)
          : await authAPI.login(loginId, password);
      setAuthUser(user);
      setAuthModalOpen(false);
      setAuthLoginId("");
      setAuthPassword("");
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

        if (futureRightEdge > player.x + player.width + 30) {
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
          // Dev/testing: make the next generated platform a long quicksand
          if (Constants.DEV_FORCE_LONG_QUICKSAND_AFTER_TURTLE_SHELL) {
            devForceLongQuickSandOnceRef.current = true;
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
        <HUD score={score} level={level} oxygen={oxygen} hasTurtleShell={hasTurtleShell} hasDolphin={hasDolphin} />
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

      {gameState === "MENU" && (
        <MenuOverlay
          leaderboard={leaderboard}
          lastSubmittedId={lastSubmittedId}
          streakCurrent={dailyMissions?.user ? dailyMissions.user.streak.current : 0}
          loginId={authUser?.loginId ?? null}
          onLogoutClick={async () => {
            await authAPI.logout();
            setAuthUser(null);
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
