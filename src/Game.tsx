import React, { useEffect, useRef, useState } from "react";
import type { GameState, Player, Platform, Item, Bubble, BackgroundEntity, LeaderboardEntry } from "./types";
import * as Constants from "./constants";
import { initAudio, playSound } from "./audio";
import { interpolateColor } from "./graphics";
import { createBubble, spawnBackgroundEntity } from "./entities";
import { drawSwordfish, drawUrchin, drawBackgroundEntities } from "./drawing";
import { HUD, MenuOverlay, InputNameOverlay, GameOverOverlay } from "./components/UIOverlays";

export const DeepDiveGame = () => {
  // --- Refs for Game Loop ---
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const requestRef = useRef<number>(0);
  const scoreRef = useRef<number>(0);
  const gameStateRef = useRef<GameState>("MENU");
  const didSubmitRef = useRef<boolean>(false);

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

  // --- React State for UI ---
  const [gameState, setGameState] = useState<GameState>("MENU");
  const [score, setScore] = useState(0);
  const [oxygen, setOxygen] = useState(Constants.OXYGEN_MAX);
  const [level, setLevel] = useState(1);

  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const leaderboardRef = useRef<LeaderboardEntry[]>([]);
  const [lastSubmittedId, setLastSubmittedId] = useState<number | null>(null);

  const [playerName, setPlayerName] = useState("");

  useEffect(() => {
    try {
      const saved = localStorage.getItem("deep-dive-leaderboard");
      if (saved) {
        const parsed = JSON.parse(saved);
        // Ensure IDs exist for migration
        const withIds = parsed.map((e: any, idx: number) => ({
          ...e,
          id: e.id || Date.now() + idx
        }));
        setLeaderboard(withIds);
        leaderboardRef.current = withIds;
      } else {
        const oldHigh = localStorage.getItem("deep-dive-highscore");
        if (oldHigh) {
          const parsed = [{ id: Date.now(), name: "Player", score: parseInt(oldHigh) }];
          setLeaderboard(parsed);
          leaderboardRef.current = parsed;
        }
      }
    } catch (e) {
      console.error("Failed to load leaderboard", e);
    }

    // Initialize audio eagerly for better mobile support
    initAudio();

    // Attempt to focus the window/canvas on mount to ensure keyboard events are received immediately
    window.focus();
    if (canvasRef.current) {
      canvasRef.current.focus();
    }

    return () => cancelAnimationFrame(requestRef.current);
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
      initAudio(); // Ensure audio context is ready

      // Allow typing in name input by not preventing default behavior on form elements
      if (gameStateRef.current === "INPUT_NAME") {
        const target = e.target as HTMLElement;
        if (target.tagName === "INPUT" || target.tagName === "BUTTON") {
          return;
        }
      }

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
      // Allow typing in name input
      if (gameStateRef.current === "INPUT_NAME") {
        const target = e.target as HTMLElement;
        if (target.tagName === "INPUT" || target.tagName === "BUTTON") {
          return;
        }
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
    // Initial Jump Logic
    if (player.grounded && !player.isTrapped && !isSwordfishActiveRef.current) {
      player.dy = Constants.JUMP_FORCE_INITIAL;
      player.grounded = false;
      player.rotation = -20;
      // Initialize Boost State
      player.isBoosting = true;
      player.boostTimer = 0;
      playSound('jump'); // Play Jump Sound
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

    swordfishTimerRef.current = 0;
    isSwordfishActiveRef.current = false;
    isJumpInputActiveRef.current = false;
    jumpBufferTimerRef.current = 0;
    gameTimeRef.current = 0;

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

  const gameOver = () => {
    const finalScore = scoreRef.current;
    didSubmitRef.current = false;

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

  const submitHighScore = (e: React.FormEvent) => {
    e.preventDefault();
    const name = playerName.trim() || "Anonymous";
    const id = Date.now();
    const newEntry: LeaderboardEntry = { id, name, score: scoreRef.current };

    const newLeaderboard = [...leaderboard, newEntry]
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    setLeaderboard(newLeaderboard);
    leaderboardRef.current = newLeaderboard;
    localStorage.setItem("deep-dive-leaderboard", JSON.stringify(newLeaderboard));

    setLastSubmittedId(id);

    didSubmitRef.current = true;
    gameStateRef.current = "GAME_OVER";
    setGameState("GAME_OVER");
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
      const isQuickSand = Math.random() < 0.25;

      const newPlat: Platform = {
        x: nextX,
        y: groundY,
        width: platTiles * Constants.TILE_SIZE,
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
          return false;
        } else if (item.type === "SWORDFISH") {
          isSwordfishActiveRef.current = true;
          swordfishTimerRef.current = Constants.SWORDFISH_DURATION;
          playSound('swordfish');
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
        <HUD score={score} level={level} oxygen={oxygen} />
      )}

      {gameState === "MENU" && (
        <MenuOverlay leaderboard={leaderboard} lastSubmittedId={lastSubmittedId} />
      )}

      {gameState === "INPUT_NAME" && (
        <InputNameOverlay
          score={score}
          playerName={playerName}
          setPlayerName={setPlayerName}
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
    </div>
  );
};
