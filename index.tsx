import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

// --- Game Constants ---
const GRAVITY = 0.6;
const JUMP_FORCE_INITIAL = -9; // Reduced from -12 for "Short Jump" base
const JUMP_BOOST_FORCE = 0.6; // Force applied per frame while holding jump
const JUMP_BOOST_MAX_DURATION = 0.4; // Seconds
const JUMP_BUFFER_TIME = 0.15; // Seconds to buffer jump input
const GAME_SPEED_START = 6;
const MAX_SPEED = 14; 
const OXYGEN_MAX = 30; 
const OXYGEN_DEPLETION_RATE = 1.0; 
const OXYGEN_RESTORE = 8; 
const TILE_SIZE = 50; 
const TANK_CHANCE = 0.15; 
const SWORDFISH_CHANCE = 0.03; 
const SWORDFISH_DURATION = 5000; 
const SWORDFISH_SPEED_MULT = 3.0;
const URCHIN_CHANCE = 0.04;
const URCHIN_SCORE_THRESHOLD = 1000;

// --- Audio System ---
const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
let audioCtx: AudioContext | null = null;

const initAudio = () => {
  if (!audioCtx && AudioContextClass) {
    audioCtx = new AudioContextClass();
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
};

const playSound = (type: 'jump' | 'oxygen' | 'swordfish' | 'die_fall' | 'die_urchin' | 'die_quicksand') => {
  if (!audioCtx) return;
  
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  
  const now = audioCtx.currentTime;
  
  switch (type) {
    case 'jump':
      osc.type = 'sine';
      osc.frequency.setValueAtTime(200, now);
      osc.frequency.linearRampToValueAtTime(400, now + 0.1);
      gain.gain.setValueAtTime(0.1, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.1);
      osc.start(now);
      osc.stop(now + 0.1);
      break;
      
    case 'oxygen':
      osc.type = 'sine';
      osc.frequency.setValueAtTime(800, now);
      osc.frequency.exponentialRampToValueAtTime(1200, now + 0.1);
      gain.gain.setValueAtTime(0.1, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
      osc.start(now);
      osc.stop(now + 0.15);
      break;

    case 'swordfish':
       // Powerup sound - simple arpeggio
       osc.type = 'square';
       osc.frequency.setValueAtTime(440, now);
       osc.frequency.setValueAtTime(554, now + 0.1); // C#
       osc.frequency.setValueAtTime(659, now + 0.2); // E
       gain.gain.setValueAtTime(0.05, now);
       gain.gain.linearRampToValueAtTime(0.01, now + 0.3);
       osc.start(now);
       osc.stop(now + 0.3);
       break;

    case 'die_urchin':
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(150, now);
      osc.frequency.linearRampToValueAtTime(50, now + 0.3);
      gain.gain.setValueAtTime(0.15, now);
      gain.gain.linearRampToValueAtTime(0.001, now + 0.3);
      osc.start(now);
      osc.stop(now + 0.3);
      break;

    case 'die_fall':
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(300, now);
      osc.frequency.linearRampToValueAtTime(50, now + 0.5);
      gain.gain.setValueAtTime(0.15, now);
      gain.gain.linearRampToValueAtTime(0.001, now + 0.5);
      osc.start(now);
      osc.stop(now + 0.5);
      break;
      
    case 'die_quicksand':
      osc.type = 'square';
      osc.frequency.setValueAtTime(80, now);
      osc.frequency.exponentialRampToValueAtTime(30, now + 0.8);
      gain.gain.setValueAtTime(0.15, now);
      gain.gain.linearRampToValueAtTime(0.001, now + 0.8);
      osc.start(now);
      osc.stop(now + 0.8);
      break;
  }
};

// --- Graphics Helpers ---
const interpolateColor = (start: number[], end: number[], factor: number) => {
  const result = start.map((startVal, i) => {
    const endVal = end[i];
    return Math.round(startVal + (endVal - startVal) * factor);
  });
  return `rgb(${result[0]}, ${result[1]}, ${result[2]})`;
};

// --- Types ---
type GameState = "MENU" | "PLAYING" | "GAME_OVER" | "INPUT_NAME";

interface Player {
  x: number;
  y: number;
  width: number;
  height: number;
  dy: number;
  grounded: boolean;
  rotation: number;
  isTrapped: boolean;
  isBoosting: boolean; // Is the player currently extending their jump?
  boostTimer: number; // How long have we been boosting?
}

interface Platform {
  x: number;
  y: number;
  width: number;
  height: number;
  type: "NORMAL" | "QUICKSAND";
  sinking?: boolean; 
}

interface Item {
  x: number;
  y: number;
  width: number;
  height: number;
  collected: boolean;
  type: "OXYGEN" | "SWORDFISH" | "URCHIN";
  // Urchin specific
  rotation?: number;
  isDead?: boolean;
  dy?: number;
}

interface Bubble {
  x: number;
  y: number;
  size: number;
  speed: number;
  opacity: number;
  wobbleOffset: number;
}

type BackgroundEntityType = "FISH" | "WHALE" | "JELLYFISH" | "SHIP" | "DIVER" | "CORAL";

interface BackgroundEntity {
  id: number;
  type: BackgroundEntityType;
  x: number;
  y: number;
  scale: number;
  speed: number;
  variant: number; // 0-2 usually for color variation
  wobbleOffset: number;
}

interface LeaderboardEntry {
  id: number;
  name: string;
  score: number;
}

const DeepDiveGame = () => {
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

  const oxygenRef = useRef<number>(OXYGEN_MAX);
  const lastTimeRef = useRef<number>(0);
  const gameTimeRef = useRef<number>(0);
  const speedRef = useRef<number>(GAME_SPEED_START);
  const distanceRef = useRef<number>(0);
  
  const quickSandTimerRef = useRef<number | null>(null);

  // Swordfish Power-up Refs
  const swordfishTimerRef = useRef<number>(0); 
  const isSwordfishActiveRef = useRef<boolean>(false);

  // --- React State for UI ---
  const [gameState, setGameState] = useState<GameState>("MENU");
  const [score, setScore] = useState(0);
  const [oxygen, setOxygen] = useState(OXYGEN_MAX);
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
            jumpBufferTimerRef.current = JUMP_BUFFER_TIME;

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
       jumpBufferTimerRef.current = JUMP_BUFFER_TIME;
       
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

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    // passive: false is required to use preventDefault() in touch listeners
    window.addEventListener("touchstart", handleTouchStart, { passive: false });
    window.addEventListener("touchend", handleTouchEnd, { passive: false });
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("touchstart", handleTouchStart);
      window.removeEventListener("touchend", handleTouchEnd);
    };
  }, []);

  const attemptJump = () => {
    const player = playerRef.current;
    // Initial Jump Logic
    if (player.grounded && !player.isTrapped && !isSwordfishActiveRef.current) {
      player.dy = JUMP_FORCE_INITIAL;
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
    oxygenRef.current = OXYGEN_MAX;
    setOxygen(OXYGEN_MAX);
    speedRef.current = GAME_SPEED_START;
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
    for (let i = 0; i < Math.ceil(canvasRef.current.width / TILE_SIZE) + 5; i++) {
      platformsRef.current.push({
        x: i * TILE_SIZE,
        y: canvasRef.current.height - 100,
        width: TILE_SIZE,
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

  const createBubble = (w: number, h: number, randomY = true): Bubble => ({
    x: Math.random() * w,
    y: randomY ? Math.random() * h : h + 20,
    size: Math.random() * 5 + 2,
    speed: Math.random() * 1 + 0.5,
    opacity: Math.random() * 0.5 + 0.1,
    wobbleOffset: Math.random() * Math.PI * 2,
  });

  const spawnBackgroundEntity = (width: number, height: number) => {
    const types: BackgroundEntityType[] = ["FISH", "FISH", "FISH", "WHALE", "JELLYFISH", "DIVER", "CORAL", "SHIP"];
    const type = types[Math.floor(Math.random() * types.length)];
    
    let y = Math.random() * (height - 100);
    let scale = 0.5 + Math.random() * 0.5;
    let speed = 0.5 + Math.random() * 1.5;

    if (type === "WHALE") {
        scale = 1.2 + Math.random() * 0.8;
        speed = 0.3; // Slower
        y = Math.random() * (height * 0.8);
    } else if (type === "SHIP") {
        scale = 1.0 + Math.random() * 0.5;
        speed = 0; // Moves with background
        y = height - 150 + Math.random() * 50; // Near bottom
    } else if (type === "CORAL") {
        speed = 0;
        y = height - 80 + Math.random() * 20;
        scale = 0.8 + Math.random() * 0.4;
    }

    bgEntitiesRef.current.push({
        id: Date.now() + Math.random(),
        type,
        x: width + 200,
        y,
        scale,
        speed,
        variant: Math.floor(Math.random() * 3),
        wobbleOffset: Math.random() * Math.PI * 2
    });
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
    oxygenRef.current -= OXYGEN_DEPLETION_RATE * dt;
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
        effectiveSpeed *= SWORDFISH_SPEED_MULT;
    }

    speedRef.current = Math.min(MAX_SPEED, speedRef.current + 0.1 * dt);
    
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
        spawnBackgroundEntity(canvas.width, canvas.height);
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
            const framesToFall = Math.sqrt(2 * fallDistance / GRAVITY);
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
            if (isJumpInputActiveRef.current && player.boostTimer < JUMP_BOOST_MAX_DURATION) {
                // Apply anti-gravity boost
                player.dy -= JUMP_BOOST_FORCE;
                player.boostTimer += dt;
            } else {
                // Stop boosting if key released or time limit reached
                player.isBoosting = false;
            }
        }

        player.dy += GRAVITY;
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
        const safeMaxGapTiles = Math.floor(maxJumpPx / TILE_SIZE);
        
        maxGapTiles = Math.min(maxGapTiles, safeMaxGapTiles);
        if (minGapTiles > maxGapTiles) minGapTiles = maxGapTiles;

        const isGap = Math.random() < holeChance;
        const groundY = canvas.height - 100;
        
        let nextX = lastPlat.x + lastPlat.width;
        
        if (isGap) {
            const gapTiles = Math.floor(Math.random() * (maxGapTiles - minGapTiles + 1)) + minGapTiles;
            nextX += gapTiles * TILE_SIZE;
        }

        const platTiles = Math.floor(Math.random() * (maxPlatTiles - minPlatTiles + 1)) + minPlatTiles;
        const isQuickSand = Math.random() < 0.25;
        
        const newPlat: Platform = {
            x: nextX,
            y: groundY,
            width: platTiles * TILE_SIZE,
            height: 100,
            type: isQuickSand ? "QUICKSAND" : "NORMAL",
            sinking: false
        };
        platformsRef.current.push(newPlat);

        if (!isGap) {
             // URCHIN SPAWN LOGIC
             let spawnedUrchin = false;
             if (scoreRef.current > URCHIN_SCORE_THRESHOLD) {
                if (Math.random() < URCHIN_CHANCE) {
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
                 if (rand < SWORDFISH_CHANCE) {
                     itemsRef.current.push({
                         x: newPlat.x + newPlat.width / 2 - 25, 
                         y: newPlat.y - 120 - (Math.random() * 80), 
                         width: 50,
                         height: 30,
                         collected: false,
                         type: "SWORDFISH"
                     });
                 }
                 else if (rand < SWORDFISH_CHANCE + TANK_CHANCE) {
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
                item.dy = (item.dy || 0) + GRAVITY;
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
                oxygenRef.current = Math.min(OXYGEN_MAX, oxygenRef.current + OXYGEN_RESTORE);
                setOxygen(oxygenRef.current);
                playSound('oxygen');
                return false;
            } else if (item.type === "SWORDFISH") {
                isSwordfishActiveRef.current = true;
                swordfishTimerRef.current = SWORDFISH_DURATION;
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

  const drawSwordfish = (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) => {
      ctx.fillStyle = "#5dade2";
      ctx.beginPath();
      ctx.ellipse(x + w * 0.4, y + h / 2, w * 0.4, h * 0.35, 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = "#5dade2";
      ctx.beginPath();
      ctx.moveTo(x + w * 0.7, y + h / 2 - 2);
      ctx.lineTo(x + w + 10, y + h / 2);
      ctx.lineTo(x + w * 0.7, y + h / 2 + 2);
      ctx.fill();

      ctx.fillStyle = "#ff8c00";
      
      ctx.beginPath();
      ctx.moveTo(x + w * 0.3, y + h * 0.2);
      ctx.quadraticCurveTo(x + w * 0.4, y - h * 0.2, x + w * 0.6, y + h * 0.3);
      ctx.lineTo(x + w * 0.3, y + h * 0.2);
      ctx.fill();
      
      ctx.beginPath();
      ctx.moveTo(x + w * 0.35, y + h * 0.8);
      ctx.lineTo(x + w * 0.5, y + h * 1.2);
      ctx.lineTo(x + w * 0.55, y + h * 0.8);
      ctx.fill();

      ctx.beginPath();
      ctx.moveTo(x, y + h/2);
      ctx.lineTo(x - 5, y + h * 0.2);
      ctx.lineTo(x - 5, y + h * 0.8);
      ctx.fill();

      ctx.fillStyle = "white";
      ctx.beginPath();
      ctx.arc(x + w * 0.6, y + h * 0.4, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "black";
      ctx.beginPath();
      ctx.arc(x + w * 0.62, y + h * 0.4, 2, 0, Math.PI * 2);
      ctx.fill();
  };

  const drawUrchin = (ctx: CanvasRenderingContext2D, item: Item) => {
      const cx = item.x + item.width / 2;
      const cy = item.y + item.height / 2;
      const radius = item.width / 2;

      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate((item.rotation || 0) * Math.PI / 180);

      // Spikes (Star shape)
      ctx.fillStyle = "#e67e22"; // Darker Orange
      const spikes = 12;
      ctx.beginPath();
      for (let i = 0; i < spikes * 2; i++) {
        const r = (i % 2 === 0) ? radius : radius * 0.6;
        const a = (Math.PI * i) / spikes;
        ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      ctx.closePath();
      ctx.fill();

      // Body
      ctx.fillStyle = "#f39c12"; // Orange
      ctx.beginPath();
      ctx.arc(0, 0, radius * 0.7, 0, Math.PI * 2);
      ctx.fill();

      // Face
      // Eyes
      if (item.isDead) {
          // Crying Eyes (lines or Xs)
          ctx.strokeStyle = "black";
          ctx.lineWidth = 2;
          
          // Left Eye
          ctx.beginPath();
          ctx.moveTo(-8, -5);
          ctx.lineTo(-4, -5);
          ctx.stroke();
          
          // Right Eye
          ctx.beginPath();
          ctx.moveTo(4, -5);
          ctx.lineTo(8, -5);
          ctx.stroke();

          // Tears
          ctx.fillStyle = "#3498db";
          ctx.beginPath();
          ctx.arc(-6, 2, 2, 0, Math.PI * 2);
          ctx.arc(6, 2, 2, 0, Math.PI * 2);
          ctx.fill();

          // Mouth (Sad)
          ctx.beginPath();
          ctx.arc(0, 8, 4, Math.PI, 0); // Arch up
          ctx.stroke();

      } else {
          // Cute Eyes
          ctx.fillStyle = "black";
          ctx.beginPath();
          ctx.arc(-6, -4, 3, 0, Math.PI * 2);
          ctx.arc(6, -4, 3, 0, Math.PI * 2);
          ctx.fill();
          
          ctx.fillStyle = "white";
          ctx.beginPath();
          ctx.arc(-5, -5, 1, 0, Math.PI * 2);
          ctx.arc(7, -5, 1, 0, Math.PI * 2);
          ctx.fill();

          // Mouth (Happy)
          ctx.strokeStyle = "black";
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(0, 2, 5, 0, Math.PI); // Smile
          ctx.stroke();
      }

      ctx.restore();
  };

  const drawBackgroundEntities = (ctx: CanvasRenderingContext2D) => {
    bgEntitiesRef.current.forEach(e => {
        ctx.save();
        ctx.translate(e.x, e.y);
        ctx.scale(e.scale, e.scale);
        // Subtle rotation for "swimming" effect
        ctx.rotate(Math.sin(gameTimeRef.current * 1.5 + e.wobbleOffset) * 0.05);

        if (e.type === "FISH") {
            const colors = [
                ['#ff7f50', '#ff6347'], // Coral / Tomato
                ['#4facfe', '#00f2fe'], // Blue Cyan
                ['#ffd700', '#ffa500']  // Gold / Orange
            ];
            const [c1, c2] = colors[e.variant % colors.length];
            
            // Fish Body
            const grad = ctx.createLinearGradient(-20, 0, 20, 0);
            grad.addColorStop(0, c1);
            grad.addColorStop(1, c2);
            ctx.fillStyle = grad;
            
            ctx.beginPath();
            ctx.ellipse(0, 0, 20, 12, 0, 0, Math.PI * 2);
            ctx.fill();
            
            // Tail
            ctx.beginPath();
            ctx.moveTo(15, 0);
            ctx.lineTo(30, -10);
            ctx.lineTo(30, 10);
            ctx.fill();
            
            // Eye
            ctx.fillStyle = 'white';
            ctx.beginPath();
            ctx.arc(-10, -4, 4, 0, Math.PI*2);
            ctx.fill();
            ctx.fillStyle = 'black';
            ctx.beginPath();
            ctx.arc(-12, -4, 2, 0, Math.PI*2);
            ctx.fill();
            
            // Fin
            ctx.fillStyle = c2;
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.quadraticCurveTo(5, 5, -5, 8);
            ctx.fill();
        } 
        else if (e.type === "WHALE") {
            // Galaxy Whale Style
            const grad = ctx.createLinearGradient(-100, -50, 100, 50);
            // Variant 0: Pink/Purple, Variant 1: Blue/Teal
            if (e.variant % 2 === 0) {
                 grad.addColorStop(0, '#fbc2eb'); // light pink
                 grad.addColorStop(0.5, '#a6c1ee'); // light blue
                 grad.addColorStop(1, '#a18cd1'); // purple
            } else {
                 grad.addColorStop(0, '#89f7fe');
                 grad.addColorStop(1, '#66a6ff');
            }
            ctx.fillStyle = grad;
            
            // Whale Shape
            ctx.beginPath();
            ctx.moveTo(-80, 20);
            ctx.quadraticCurveTo(-40, -60, 40, -40);
            ctx.quadraticCurveTo(100, -20, 130, -60); // Tail tip top
            ctx.quadraticCurveTo(120, -30, 130, 0);   // Tail tip bottom
            ctx.quadraticCurveTo(80, 20, 60, 40);
            ctx.quadraticCurveTo(0, 70, -80, 20);
            ctx.fill();

            // Belly Lines
            ctx.strokeStyle = "rgba(255,255,255,0.3)";
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(-60, 30);
            ctx.quadraticCurveTo(0, 60, 50, 40);
            ctx.moveTo(-50, 40);
            ctx.quadraticCurveTo(0, 65, 40, 45);
            ctx.stroke();
            
            // Sparkles/Stars
            ctx.fillStyle = 'white';
            for(let i=0; i<5; i++) {
                const sx = (Math.sin(e.id + i) * 60);
                const sy = (Math.cos(e.id + i) * 20);
                ctx.beginPath();
                ctx.arc(sx, sy, 1 + (i%2), 0, Math.PI*2);
                ctx.fill();
            }
        }
        else if (e.type === "JELLYFISH") {
            // Cute Jellyfish
            ctx.fillStyle = e.variant % 2 === 0 ? 'rgba(255, 182, 193, 0.6)' : 'rgba(255, 160, 122, 0.6)'; // Pink or Salmon
            
            // Head
            ctx.beginPath();
            ctx.arc(0, -10, 20, Math.PI, 0);
            // Ruffled bottom
            for(let i=0; i<5; i++) {
                ctx.arc(20 - i*10 + 5, -10, 5, 0, Math.PI);
            }
            ctx.fill();
            
            // Face
            ctx.fillStyle = '#333';
            ctx.beginPath();
            ctx.arc(-8, -15, 2, 0, Math.PI*2); // Left Eye
            ctx.arc(8, -15, 2, 0, Math.PI*2);  // Right Eye
            ctx.fill();
            // Smile
            ctx.beginPath();
            ctx.arc(0, -12, 4, 0, Math.PI);
            ctx.stroke();

            // Tentacles
            ctx.strokeStyle = e.variant % 2 === 0 ? 'rgba(255, 182, 193, 0.4)' : 'rgba(255, 160, 122, 0.4)';
            ctx.lineWidth = 3;
            for(let i=0; i<4; i++) {
                ctx.beginPath();
                ctx.moveTo(-15 + i*10, -10);
                ctx.quadraticCurveTo(-15 + i*10 + Math.sin(gameTimeRef.current * 4 + i)*10, 10, -15 + i*10, 30);
                ctx.stroke();
            }
        }
        else if (e.type === "DIVER") {
            // Scuba Diver
            ctx.fillStyle = "#004e92"; // Blue Suit
            // Body
            ctx.beginPath();
            ctx.ellipse(0, 0, 25, 8, 0, 0, Math.PI*2);
            ctx.fill();
            
            // Tank
            ctx.fillStyle = "#ffd700"; // Yellow Tank
            ctx.fillRect(-10, -12, 15, 6);
            
            // Head
            ctx.fillStyle = "#ffccaa"; // Skin
            ctx.beginPath();
            ctx.arc(-25, -2, 6, 0, Math.PI*2);
            ctx.fill();
            
            // Mask
            ctx.fillStyle = "#333";
            ctx.fillRect(-30, -4, 4, 3);
            
            // Fins
            ctx.fillStyle = "#333";
            ctx.beginPath();
            ctx.moveTo(25, 0);
            ctx.lineTo(40, -5);
            ctx.lineTo(40, 5);
            ctx.fill();

            // Bubbles
            if (Math.sin(gameTimeRef.current * 5) > 0.5) {
                ctx.fillStyle = "rgba(255,255,255,0.5)";
                ctx.beginPath();
                ctx.arc(-35, -10, 2, 0, Math.PI*2);
                ctx.fill();
            }
        }
        else if (e.type === "SHIP") {
            ctx.fillStyle = "#3e2723"; // Dark Wood
            // Hull
            ctx.beginPath();
            ctx.moveTo(-60, 10);
            ctx.lineTo(60, 10);
            ctx.quadraticCurveTo(40, 40, -50, 40);
            ctx.lineTo(-60, 10);
            ctx.fill();
            
            // Mast
            ctx.strokeStyle = "#3e2723";
            ctx.lineWidth = 4;
            ctx.beginPath();
            ctx.moveTo(0, 10);
            ctx.lineTo(0, -50);
            ctx.stroke();
            
            // Tattered Sail
            ctx.fillStyle = "rgba(255,255,255,0.3)";
            ctx.beginPath();
            ctx.moveTo(2, -45);
            ctx.lineTo(40, -10);
            ctx.lineTo(2, -10);
            ctx.fill();
        }
        else if (e.type === "CORAL") {
            ctx.strokeStyle = e.variant === 0 ? "#ff6b6b" : (e.variant === 1 ? "#4ecdc4" : "#ffe66d");
            ctx.lineWidth = 4;
            ctx.lineCap = "round";
            
            ctx.beginPath();
            ctx.moveTo(0, 0); // Base
            // Branch 1
            ctx.quadraticCurveTo(0, -20, -10, -30);
            ctx.quadraticCurveTo(-15, -35, -5, -45);
            // Branch 2
            ctx.moveTo(0, -10);
            ctx.quadraticCurveTo(10, -25, 20, -30);
            ctx.stroke();
        }

        ctx.restore();
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
    for(let i=0; i<rayCount; i++) {
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
    drawBackgroundEntities(ctx);

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
    ctx.roundRect(-p.width/2, -p.height/2, p.width, p.height, 8);
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
    ctx.fillRect(-p.width/2 - 5, -5, 5, 10);

    ctx.restore();
  };
  
  const renderLeaderboard = () => (
    <div style={{ marginTop: "20px", textAlign: "left", background: "rgba(0,0,0,0.3)", padding: "20px", borderRadius: "10px" }}>
        <h3 style={{ borderBottom: "1px solid #00ffff", paddingBottom: "10px", color: "#00ffff", margin: "0 0 10px 0" }}>LEADERBOARD</h3>
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
        </div>
      )}

      {gameState === "MENU" && (
        <div style={overlayStyle}>
          <h1 style={titleStyle}>DEEP DIVE DASH</h1>
          <p style={subtitleStyle}>Press SPACE to Start</p>
          <div style={instructionStyle}>
             Avoid Gaps! Collect Oxygen!<br/>
             Beware of <span style={{color: "#a67b5b", fontWeight: "bold"}}>Quick Sand</span> and <span style={{color: "#e67e22", fontWeight: "bold"}}>Urchins</span>!<br/>
             Collect <span style={{color: "#5dade2", fontWeight: "bold"}}>Swordfish</span> for 3x SPEED & INVINCIBILITY!<br/>
             Controls: Spacebar (Hold for High Jump) / Arrow Up
          </div>
          {renderLeaderboard()}
        </div>
      )}

      {gameState === "INPUT_NAME" && (
        <div style={overlayStyle}>
           <h1 style={{...titleStyle, fontSize: "3rem", color: "#ffd700"}}>NEW HIGH SCORE!</h1>
           <p style={{ fontSize: "1.5rem", marginBottom: "20px" }}>Score: {score}</p>
           <form onSubmit={submitHighScore} style={{ display: "flex", flexDirection: "column", gap: "10px", alignItems: "center" }}>
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
      )}

      {gameState === "GAME_OVER" && (
        <div style={overlayStyle}>
          <h1 style={{...titleStyle, color: didSubmitRef.current ? "#ffd700" : "#ff6b6b"}}>
              {didSubmitRef.current ? "LEADERBOARD" : "GAME OVER"}
          </h1>
          <div style={scoreStyle}>Score: {score}</div>
          {renderLeaderboard()}
          <p style={{...subtitleStyle, marginTop: "40px"}}>Press SPACE to Retry</p>
        </div>
      )}
    </div>
  );
};

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
  color: "white",
  textAlign: "center",
  zIndex: 10
};

const titleStyle: React.CSSProperties = {
  fontSize: "4rem",
  margin: "0 0 20px 0",
  color: "#00ffff",
  textShadow: "0 0 20px rgba(0,255,255,0.5)",
  letterSpacing: "4px",
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
}

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

const root = createRoot(document.getElementById("root")!);
root.render(<DeepDiveGame />);
