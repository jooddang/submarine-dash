// Pure game logic functions for PVP mode.
// Mirrors Game.tsx update logic but operates on PvpPlayerState objects instead of refs.

import type { Platform } from "../types";
import type { PvpPlayerState, PvpPowerUpMode, ScorePopup } from "./pvpTypes";
import * as Constants from "../constants";
import { generateNextSegment, createBubbleSeeded, spawnBackgroundEntitySeeded } from "./pvpWorld";
import { playSound } from "../audio";

const DOLPHIN_USES_PER_RUN_MAX = 3;

// --- Initialize a fresh player state for a new round ---
export function createPlayerState(
  rng: () => number,
  canvasWidth: number,
  canvasHeight: number,
  powerUpMode: PvpPowerUpMode,
  dolphinCount: number,
  tubeCharges: number,
): PvpPlayerState {
  const platforms: Platform[] = [];
  const count = Math.ceil(canvasWidth / Constants.TILE_SIZE) + 5;
  for (let i = 0; i < count; i++) {
    platforms.push({
      x: i * Constants.TILE_SIZE,
      y: canvasHeight - 100,
      width: Constants.TILE_SIZE,
      height: 100,
      type: "NORMAL",
    });
  }

  const bubbles = Array.from({ length: 20 }, () => createBubbleSeeded(rng, canvasWidth, canvasHeight));

  return {
    player: {
      x: 100,
      y: canvasHeight - 200,
      width: 40,
      height: 40,
      dy: 0,
      grounded: false,
      rotation: 0,
      isTrapped: false,
      isBoosting: false,
      boostTimer: 0,
    },
    platforms,
    items: [],
    bubbles,
    bgEntities: [],

    oxygen: Constants.OXYGEN_MAX,
    speed: Constants.GAME_SPEED_START,
    distance: 0,
    score: 0,
    gameTime: 0,
    alive: true,
    deathCause: null,

    swordfishTimer: 0,
    isSwordfishActive: false,
    turtleShellSaved: false,
    turtleShellUseCount: 0,
    rescue: { active: false },
    tubeRescue: { active: false },
    rescueJumpCharges: 0,
    tubePieces: 0,
    tubeRescueCharges: (powerUpMode === "inventory") ? tubeCharges : 0,
    dolphinCount: (powerUpMode === "inventory") ? dolphinCount : 0,
    dolphinUsesThisRun: 0,

    jumpInputActive: false,
    jumpBufferTimer: 0,

    rng,

    trailParticles: [],

    quickSandTimer: null,
    elapsedMs: 0,

    scoreAttackBonus: 0,
    scorePopups: [],
  };
}

// --- Attempt jump for a player ---
function isImminentLanding(s: PvpPlayerState): boolean {
  const player = s.player;
  if (player.dy <= 0) return false;

  const playerLeft = player.x;
  const playerRight = player.x + player.width;
  const playerBottom = player.y + player.height;

  let minFrames: number | null = null;
  for (const plat of s.platforms) {
    const overlapsX = playerRight > plat.x && playerLeft < plat.x + plat.width;
    if (!overlapsX) continue;
    const dist = plat.y - playerBottom;
    if (dist < 0) continue;
    const g = Constants.GRAVITY;
    const disc = (player.dy * player.dy) + (2 * g * dist);
    const n = (-player.dy + Math.sqrt(disc)) / g;
    if (!Number.isFinite(n) || n < 0) continue;
    if (minFrames === null || n < minFrames) minFrames = n;
  }
  return minFrames !== null && minFrames <= 8;
}

export function attemptJump(s: PvpPlayerState, allowDolphin: boolean, powerUpMode: PvpPowerUpMode): boolean {
  const player = s.player;
  if (player.isTrapped) return false;
  if (s.rescue.active || s.tubeRescue.active) return false;

  // Exit swordfish hover
  if (s.isSwordfishActive) {
    if (s.swordfishTimer > 0) return false;
    s.isSwordfishActive = false;
    player.dy = Constants.JUMP_FORCE_INITIAL;
    player.grounded = false;
    player.rotation = -20;
    player.isBoosting = true;
    player.boostTimer = 0;
    playSound('jump');
    return true;
  }

  // Ground jump
  if (player.grounded) {
    player.dy = Constants.JUMP_FORCE_INITIAL;
    player.grounded = false;
    player.rotation = -20;
    player.isBoosting = true;
    player.boostTimer = 0;
    playSound('jump');
    return true;
  }

  // Dolphin double jump (only in inventory mode)
  if (
    allowDolphin &&
    powerUpMode === "inventory" &&
    s.dolphinCount > 0 &&
    s.dolphinUsesThisRun < DOLPHIN_USES_PER_RUN_MAX &&
    !isImminentLanding(s)
  ) {
    s.dolphinCount -= 1;
    s.dolphinUsesThisRun += 1;
    player.dy = Constants.JUMP_FORCE_INITIAL;
    player.grounded = false;
    player.rotation = -20;
    player.isBoosting = true;
    player.boostTimer = 0;
    playSound('jump');
    return true;
  }

  return false;
}

// --- Shift world (used during rescue tow) ---
function shiftWorldX(s: PvpPlayerState, dx: number) {
  if (dx === 0) return;
  s.platforms.forEach(p => { p.x -= dx; });
  s.items.forEach(it => { it.x -= dx; });
  s.bubbles.forEach(b => { b.x -= dx * 0.2; });
  s.bgEntities.forEach(e => { e.x -= dx * 0.2; });
}

// --- Start rescue from quicksand ---
function startRescueFromQuickSand(s: PvpPlayerState, trappedPlat: Platform, canvasWidth: number, canvasHeight: number) {
  if (!s.turtleShellSaved || s.rescue.active) return;

  s.turtleShellSaved = false;
  s.turtleShellUseCount += 1;

  const targetPlat = s.platforms
    .filter(p => p.type === "NORMAL" && p.x > trappedPlat.x + trappedPlat.width + 1)
    .sort((a, b) => a.x - b.x)[0];

  const player = s.player;
  const fallbackX = Math.min(canvasWidth - player.width - 40, Math.max(40, player.x));
  const fallbackY = canvasHeight - 100 - player.height;

  const targetPlayerX = targetPlat
    ? Math.min(canvasWidth - player.width - 40, Math.max(40, targetPlat.x + targetPlat.width / 2 - player.width / 2))
    : fallbackX;
  const targetPlayerY = targetPlat ? (targetPlat.y - player.height) : fallbackY;

  s.rescue = {
    active: true,
    phase: "FLY_IN",
    phaseT: 0,
    turtleX: canvasWidth + 120,
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

  player.isTrapped = false;
  player.dy = 0;
  s.isSwordfishActive = false;
  s.swordfishTimer = 0;
  s.rescueJumpCharges = 0;
}

// --- Start tube rescue from fall ---
function startTubeRescueFromFall(s: PvpPlayerState, canvasWidth: number, canvasHeight: number) {
  if (s.tubeRescueCharges <= 0 || s.tubeRescue.active || s.rescue.active) return;

  s.tubeRescueCharges -= 1;
  const player = s.player;

  const targetPlat = s.platforms
    .filter(p => p.type === "NORMAL" && p.x > player.x + 40)
    .sort((a, b) => a.x - b.x)[0];

  const fallbackX = Math.min(canvasWidth - player.width - 40, Math.max(40, player.x));
  const fallbackY = canvasHeight - 100 - player.height;

  const targetPlayerX = targetPlat
    ? Math.min(canvasWidth - player.width - 40, Math.max(40, targetPlat.x + targetPlat.width / 2 - player.width / 2))
    : fallbackX;
  const targetPlayerY = targetPlat ? (targetPlat.y - player.height) : fallbackY;

  s.tubeRescue = {
    active: true,
    phase: "FLY_IN",
    phaseT: 0,
    tubeX: canvasWidth + 140,
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

  player.isTrapped = false;
  player.dy = 0;
  player.rotation = 0;
  s.isSwordfishActive = false;
  s.swordfishTimer = 0;
  s.rescueJumpCharges = 0;
}

// --- Update rescue animation ---
function updateRescue(s: PvpPlayerState, dt: number, canvasWidth: number, canvasHeight: number) {
  const rescue = s.rescue;
  if (!rescue.active) return;

  rescue.phaseT += dt;
  const player = s.player;
  rescue.hookPointX = player.x + player.width / 2;
  rescue.hookPointY = player.y + player.height / 2;

  if (rescue.phase === "FLY_IN") {
    const targetX = player.x + 160;
    const targetY = Math.max(40, player.y - 140);
    const speed = 6;
    rescue.turtleX += (targetX - rescue.turtleX) * Math.min(1, dt * speed);
    rescue.turtleY += (targetY - rescue.turtleY) * Math.min(1, dt * speed);
    if (Math.hypot(rescue.turtleX - targetX, rescue.turtleY - targetY) < 12 || rescue.phaseT > 1.2) {
      rescue.phase = "HOOK";
      rescue.phaseT = 0;
    }
    return;
  }

  if (rescue.phase === "HOOK") {
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
    const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

    const desiredShift = rescue.targetPlayerX - rescue.playerXFixed;
    const shiftNow = desiredShift * ease;
    const shiftStep = shiftNow - rescue.worldShiftApplied;
    shiftWorldX(s, shiftStep);
    rescue.worldShiftApplied = shiftNow;

    player.x = rescue.playerXFixed;
    player.y = rescue.towStartY + (rescue.targetPlayerY - rescue.towStartY) * ease;
    player.dy = 0;
    player.grounded = true;
    player.rotation = 0;

    rescue.turtleX = player.x + 140;
    rescue.turtleY = Math.max(30, player.y - 130);

    if (t >= 1) {
      rescue.phase = "COUNTDOWN";
      rescue.phaseT = 0;
      rescue.countdownMs = 3000;
      rescue.lastCountdownDisplay = null;
    }
    return;
  }

  if (rescue.phase === "COUNTDOWN") {
    rescue.countdownMs -= dt * 1000;
    rescue.turtleX -= dt * 650;
    rescue.turtleY -= dt * 120;

    if (rescue.countdownMs <= 0) {
      if (s.rescueJumpCharges > 0) {
        const chargeForce = Math.min(s.rescueJumpCharges, 10) * 0.5;
        player.dy = Constants.JUMP_FORCE_INITIAL - chargeForce;
        player.grounded = false;
        player.isBoosting = true;
        player.boostTimer = 0;
        s.jumpBufferTimer = 0;
        playSound('jump');
      }
      s.rescueJumpCharges = 0;
      s.rescue = { active: false };
      s.quickSandTimer = null;
    }
  }
}

// --- Update tube rescue animation ---
function updateTubeRescue(s: PvpPlayerState, dt: number, canvasWidth: number, canvasHeight: number) {
  const rescue = s.tubeRescue;
  if (!rescue.active) return;

  rescue.phaseT += dt;
  rescue.tubeRot += dt * 3.5;
  const player = s.player;

  if (rescue.phase === "FLY_IN") {
    const targetX = player.x + 150;
    const targetY = Math.max(40, Math.min(canvasHeight - 180, player.y - 140));
    const speed = 6;
    rescue.tubeX += (targetX - rescue.tubeX) * Math.min(1, dt * speed);
    rescue.tubeY += (targetY - rescue.tubeY) * Math.min(1, dt * speed);
    if (Math.hypot(rescue.tubeX - targetX, rescue.tubeY - targetY) < 14 || rescue.phaseT > 1.2) {
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
    shiftWorldX(s, shiftStep);
    rescue.worldShiftApplied = shiftNow;

    player.x = rescue.playerXFixed;
    player.y = rescue.towStartY + (rescue.targetPlayerY - rescue.towStartY) * ease;
    player.dy = 0;
    player.grounded = true;
    player.rotation = 0;

    rescue.tubeX = player.x + 140;
    rescue.tubeY = Math.max(30, player.y - 120);

    if (t >= 1) {
      rescue.phase = "COUNTDOWN";
      rescue.phaseT = 0;
      rescue.countdownMs = 3000;
      rescue.lastCountdownDisplay = null;
    }
    return;
  }

  if (rescue.phase === "COUNTDOWN") {
    rescue.countdownMs -= dt * 1000;

    rescue.tubeX += dt * 520;
    rescue.tubeY -= dt * 140;

    if (rescue.countdownMs <= 0) {
      if (s.rescueJumpCharges > 0) {
        const chargeForce = Math.min(s.rescueJumpCharges, 10) * 0.5;
        player.dy = Constants.JUMP_FORCE_INITIAL - chargeForce;
        player.grounded = false;
        player.isBoosting = true;
        player.boostTimer = 0;
        s.jumpBufferTimer = 0;
        playSound('jump');
      }
      s.rescueJumpCharges = 0;
      s.tubeRescue = { active: false };
      s.quickSandTimer = null;
    }
  }
}

// --- Add score popup ---
function addScorePopup(s: PvpPlayerState, text: string, x: number, y: number) {
  s.scorePopups.push({ text, x, y, opacity: 1, age: 0 });
}

// --- Main update function ---
// Returns true if player died this frame.
export function updatePlayerState(
  s: PvpPlayerState,
  dt: number,
  canvasWidth: number,
  canvasHeight: number,
  powerUpMode: PvpPowerUpMode,
): boolean {
  if (!s.alive) return false;

  s.gameTime += dt;
  s.elapsedMs += dt * 1000;

  // Update score popups
  s.scorePopups = s.scorePopups.filter(p => {
    p.age += dt;
    p.y -= 40 * dt;
    p.opacity = Math.max(0, 1 - p.age / 1.5);
    return p.age < 1.5;
  });

  // Handle rescues
  if (s.rescue.active) {
    updateRescue(s, dt, canvasWidth, canvasHeight);
    return false;
  }
  if (s.tubeRescue.active) {
    updateTubeRescue(s, dt, canvasWidth, canvasHeight);
    return false;
  }

  const player = s.player;

  // Jump buffer
  if (s.jumpBufferTimer > 0) {
    const isSwordfishHover = s.isSwordfishActive && s.swordfishTimer <= 0;
    if (!isSwordfishHover) {
      s.jumpBufferTimer -= dt;
    }
  }

  // Powerup timers
  if (s.swordfishTimer > 0) {
    s.swordfishTimer -= dt * 1000;
  }

  // Oxygen
  s.oxygen -= Constants.OXYGEN_DEPLETION_RATE * dt;
  if (s.oxygen <= 0) {
    s.oxygen = 0;
    s.deathCause = "oxygen";
    s.alive = false;
    return true;
  }

  // Speed & Score
  let effectiveSpeed = s.speed;
  if (s.swordfishTimer > 0) {
    effectiveSpeed *= Constants.SWORDFISH_SPEED_MULT;
  }
  s.speed = Math.min(Constants.MAX_SPEED, s.speed + 0.1 * dt);
  s.distance += effectiveSpeed;

  const baseScore = Math.floor(s.distance / 10);
  if (powerUpMode === "score_attack") {
    s.score = baseScore + s.scoreAttackBonus;
  } else {
    s.score = baseScore;
  }

  // Background entities (use seeded RNG for determinism)
  if (s.rng() < 0.015) {
    spawnBackgroundEntitySeeded(s.rng, canvasWidth, canvasHeight, s.bgEntities);
  }
  s.bgEntities.forEach(e => {
    const parallaxSpeed = effectiveSpeed * (0.2 * e.scale);
    e.x -= (parallaxSpeed + (e.type === "SHIP" || e.type === "CORAL" ? 0 : e.speed));
    e.y += Math.sin(s.gameTime * 2 + e.wobbleOffset) * 0.2;
  });
  s.bgEntities = s.bgEntities.filter(e => e.x > -300);

  // Swordfish safe landing
  let shouldDescend = false;
  if (s.isSwordfishActive && s.swordfishTimer <= 0) {
    const playerCenter = player.x + player.width / 2;
    const platformBelow = s.platforms.find(p =>
      playerCenter > p.x && playerCenter < p.x + p.width
    );
    if (platformBelow) {
      const groundY = platformBelow.y - player.height;
      const fallDistance = Math.max(0, groundY - player.y);
      const framesToFall = Math.sqrt(2 * fallDistance / Constants.GRAVITY);
      const currentRightEdge = platformBelow.x + platformBelow.width;
      const futureRightEdge = currentRightEdge - (framesToFall * s.speed);
      if (futureRightEdge > player.x + player.width + 100) {
        s.isSwordfishActive = false;
      } else {
        shouldDescend = true;
      }
    }
  }

  // Player physics
  if (s.isSwordfishActive) {
    player.dy = shouldDescend ? 3 : 0;
    player.rotation = 0;
    player.grounded = false;
    player.isBoosting = false;
  } else {
    if (player.isBoosting) {
      if (s.jumpInputActive && player.boostTimer < Constants.JUMP_BOOST_MAX_DURATION) {
        player.dy -= Constants.JUMP_BOOST_FORCE;
        player.boostTimer += dt;
      } else {
        player.isBoosting = false;
      }
    }
    player.dy += Constants.GRAVITY;
  }
  player.y += player.dy;

  // Rotation
  if (!s.isSwordfishActive) {
    if (!player.grounded) {
      player.rotation += 2;
    } else {
      player.rotation = 0;
    }
  }

  // Platform collision
  let onGround = false;
  let touchingQuickSand = false;
  let trappedQuickSand: Platform | null = null;
  player.isTrapped = false;

  for (const plat of s.platforms) {
    if (
      player.x < plat.x + plat.width &&
      player.x + player.width > plat.x &&
      player.y + player.height > plat.y &&
      player.y + player.height < plat.y + 35
    ) {
      if (plat.type === "QUICKSAND") {
        touchingQuickSand = true;
        if (s.quickSandTimer === null) {
          s.quickSandTimer = s.elapsedMs;
        }
        if (s.elapsedMs - s.quickSandTimer > 500) {
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
    player.isBoosting = false;
  } else {
    player.grounded = false;
  }

  // Jump buffer
  if (s.jumpBufferTimer > 0) {
    if (attemptJump(s, false, powerUpMode)) {
      s.jumpBufferTimer = 0;
    }
  }

  if (!touchingQuickSand) {
    s.quickSandTimer = null;
  }

  // Auto-use turtle shell
  if (player.isTrapped && trappedQuickSand && s.turtleShellSaved && powerUpMode !== "none" && powerUpMode !== "score_attack") {
    startRescueFromQuickSand(s, trappedQuickSand, canvasWidth, canvasHeight);
    return false;
  }

  // Fall death
  if (player.y > canvasHeight) {
    if (s.tubeRescueCharges > 0 && powerUpMode !== "none" && powerUpMode !== "score_attack") {
      startTubeRescueFromFall(s, canvasWidth, canvasHeight);
      return false;
    }
    s.deathCause = player.isTrapped ? "quicksand" : "fall";
    playSound(player.isTrapped ? 'die_quicksand' : 'die_fall');
    s.alive = false;
    return true;
  }

  // Move world
  s.platforms.forEach(p => {
    p.x -= effectiveSpeed;
    if (p.sinking) p.y += 3;
  });

  if (s.platforms.length > 0 && s.platforms[0].x + s.platforms[0].width < -100) {
    s.platforms.shift();
  }

  // Generate new segments
  generateNextSegment(
    s.rng, s.platforms, s.items,
    canvasWidth, canvasHeight,
    s.score, s.speed,
    s.turtleShellSaved, s.turtleShellUseCount,
    s.rescue.active,
    s.tubePieces,
  );

  // Move & check items
  s.items.forEach(item => {
    item.x -= effectiveSpeed;
    if (item.type === "URCHIN") {
      if (item.isDead) {
        item.dy = (item.dy || 0) + Constants.GRAVITY;
        item.y += item.dy;
        item.rotation = (item.rotation || 0) + 15;
      } else {
        item.rotation = (item.rotation || 0) + 3;
      }
    }
  });

  s.items = s.items.filter(item => {
    if (item.collected) return false;
    if (item.x + item.width < -50 || item.y > canvasHeight + 50) return false;

    // Collision
    if (
      player.x < item.x + item.width &&
      player.x + player.width > item.x &&
      player.y < item.y + item.height &&
      player.y + player.height > item.y
    ) {
      // --- Score Attack mode: items give points, no effects ---
      if (powerUpMode === "score_attack") {
        if (item.type === "OXYGEN") {
          // Oxygen still works normally in score attack (otherwise it's unplayable)
          s.oxygen = Math.min(Constants.OXYGEN_MAX, s.oxygen + Constants.OXYGEN_RESTORE);
          playSound('oxygen');
          return false;
        }
        if (item.type === "SWORDFISH") {
          s.scoreAttackBonus += 300;
          addScorePopup(s, "+300", item.x, item.y);
          playSound('swordfish');
          return false;
        }
        if (item.type === "TUBE_PIECE") {
          s.scoreAttackBonus += 75;
          addScorePopup(s, "+75", item.x, item.y);
          playSound('oxygen');
          return false;
        }
        if (item.type === "TURTLE_SHELL") {
          s.scoreAttackBonus += 100;
          addScorePopup(s, "+100", item.x, item.y);
          playSound('shell_crack');
          return false;
        }
        if (item.type === "URCHIN") {
          if (item.isDead) return true;
          s.scoreAttackBonus -= 500;
          addScorePopup(s, "-500", item.x, item.y);
          playSound('die_urchin');
          item.isDead = true;
          item.dy = -5;
          return true;
        }
        return false;
      }

      // --- None mode: only oxygen works, everything else ignored ---
      if (powerUpMode === "none") {
        if (item.type === "OXYGEN") {
          s.oxygen = Math.min(Constants.OXYGEN_MAX, s.oxygen + Constants.OXYGEN_RESTORE);
          playSound('oxygen');
          return false;
        }
        if (item.type === "URCHIN") {
          if (item.isDead) return true;
          playSound('die_urchin');
          s.deathCause = "urchin";
          s.alive = false;
          return false;
        }
        // Skip all other items (swordfish, turtle shell, tube piece)
        return true;
      }

      // --- Normal item collection (inventory / earned modes) ---
      if (item.type === "OXYGEN") {
        s.oxygen = Math.min(Constants.OXYGEN_MAX, s.oxygen + Constants.OXYGEN_RESTORE);
        playSound('oxygen');
        return false;
      }
      if (item.type === "SWORDFISH") {
        s.isSwordfishActive = true;
        s.swordfishTimer = Constants.SWORDFISH_DURATION;
        playSound('swordfish');
        return false;
      }
      if (item.type === "TURTLE_SHELL") {
        s.turtleShellSaved = true;
        playSound('shell_crack');
        return false;
      }
      if (item.type === "TUBE_PIECE") {
        const next = s.tubePieces + 1;
        playSound('oxygen');
        if (next >= Constants.TUBE_PIECES_PER_TUBE) {
          s.tubePieces = 0;
          s.tubeRescueCharges += 1;
          // Score bonus
          s.distance += Constants.TUBE_COMPLETION_BONUS_SCORE * 10;
        } else {
          s.tubePieces = next;
        }
        return false;
      }
      if (item.type === "URCHIN") {
        if (item.isDead) return true;
        if (s.isSwordfishActive) {
          item.isDead = true;
          item.dy = -5;
          playSound('die_urchin');
          return true;
        }
        playSound('die_urchin');
        s.deathCause = "urchin";
        s.alive = false;
        return false;
      }
      return false;
    }
    return true;
  });

  // Bubbles (use seeded rng for deterministic respawn)
  s.bubbles.forEach(b => {
    b.y -= b.speed;
    b.x -= effectiveSpeed * 0.2;
    b.x += Math.sin(s.gameTime * 2 + b.wobbleOffset) * 0.5;
    if (b.y < -10) {
      Object.assign(b, createBubbleSeeded(s.rng, canvasWidth, canvasHeight, false));
    }
  });

  return false;
}
