// Render functions for PVP split-screen mode.
// Each player's world is drawn into a clipped viewport (top or bottom half).

import type { PvpPlayerState, PvpMatchState, ScorePopup } from "./pvpTypes";
import { interpolateColor } from "../graphics";
import { drawSwordfish, drawUrchin, drawBackgroundEntities, drawTurtleShell } from "../drawing";
import { drawSubmarine, updateTrailParticles, drawTrailParticles, getSkinDef, type TrailParticle, type SkinDef } from "../skins";

export interface Viewport {
  x: number;
  y: number;
  width: number;
  height: number;
}

// --- Draw a single player's game world into a viewport ---
export function drawPlayerWorld(
  ctx: CanvasRenderingContext2D,
  s: PvpPlayerState,
  viewport: Viewport,
  skinDef: SkinDef,
  turtleShellImg: HTMLImageElement | null,
  tubeImg: HTMLImageElement | null,
  turtleRescueImg: HTMLImageElement | null,
) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(viewport.x, viewport.y, viewport.width, viewport.height);
  ctx.clip();
  ctx.translate(viewport.x, viewport.y);

  const vw = viewport.width;
  const vh = viewport.height;

  // Camera Y offset: anchor view to bottom-left so submarine & platforms are always visible on small screens.
  // The world was created with a specific height (platforms at worldBottom), but the viewport may be smaller now.
  const worldBottom = s.platforms.length > 0 ? s.platforms[0].y + s.platforms[0].height : vh;
  const cameraY = Math.min(0, vh - worldBottom);

  // 1. Background gradient
  const maxDepthScore = 5000;
  const depthProgress = Math.min(s.score / maxDepthScore, 1);
  const c1 = interpolateColor([0, 105, 148], [0, 20, 40], depthProgress);
  const c2 = interpolateColor([0, 30, 54], [0, 5, 10], depthProgress);

  const gradient = ctx.createLinearGradient(0, 0, 0, vh);
  gradient.addColorStop(0, c1);
  gradient.addColorStop(1, c2);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, vw, vh);

  // 2. Light rays
  ctx.save();
  ctx.globalCompositeOperation = 'overlay';
  const t = s.gameTime;
  for (let i = 0; i < 5; i++) {
    const opacity = (Math.sin(t + i) + 1) / 2 * 0.1;
    ctx.fillStyle = `rgba(255, 255, 255, ${opacity})`;
    ctx.beginPath();
    const baseX = (vw / 5) * i;
    const slant = Math.sin(t * 0.2) * 100;
    ctx.moveTo(baseX - 100, -50);
    ctx.lineTo(baseX + 100, -50);
    ctx.lineTo(baseX + slant + 50, vh * 0.8);
    ctx.lineTo(baseX + slant - 50, vh * 0.8);
    ctx.fill();
  }
  ctx.restore();

  // Apply camera Y offset for world elements (keeps bottom of world visible)
  ctx.translate(0, cameraY);

  // 3. Background entities
  drawBackgroundEntities(ctx, s.bgEntities, s.gameTime);

  // 4. Bubbles
  ctx.fillStyle = "rgba(255, 255, 255, 0.3)";
  s.bubbles.forEach(b => {
    ctx.globalAlpha = b.opacity;
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.size, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.globalAlpha = 1.0;

  // 5. Platforms
  s.platforms.forEach(p => {
    ctx.fillStyle = p.type === "QUICKSAND" ? "#a67b5b" : "#c2b280";
    ctx.fillRect(p.x, p.y, p.width, p.height);
    ctx.fillStyle = p.type === "QUICKSAND" ? "#c4a484" : "#e0d5a6";
    ctx.fillRect(p.x, p.y, p.width, 10);
  });

  // 6. Items
  s.items.forEach(item => {
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
      const img = turtleShellImg;
      if (img && img.complete && img.naturalWidth > 0) {
        const r = img.naturalWidth / img.naturalHeight;
        let w = item.width;
        let h = item.height;
        if (w / h > r) { w = h * r; } else { h = w / r; }
        const dx = item.x + (item.width - w) / 2;
        const dy = item.y + (item.height - h) / 2;
        ctx.drawImage(img, dx, dy, w, h);
      } else {
        drawTurtleShell(ctx, item.x, item.y, item.width, item.height);
      }
    } else if (item.type === "TUBE_PIECE") {
      const img = tubeImg;
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

  // 7. Trail particles
  const dt = 1 / 60;
  s.trailParticles = updateTrailParticles(
    s.trailParticles as TrailParticle[],
    dt,
    skinDef,
    s.player.x, s.player.y, s.player.width, s.player.height,
    s.gameTime,
    s.alive,
  );
  drawTrailParticles(ctx, s.trailParticles as TrailParticle[], skinDef.trailType);

  // 8. Submarine
  drawSubmarine(
    ctx,
    s.player.x, s.player.y, s.player.width, s.player.height,
    s.player.rotation, skinDef, s.isSwordfishActive, s.gameTime,
  );

  // 9. Rescue turtle overlay
  const rescue = s.rescue;
  if (rescue.active && turtleRescueImg && turtleRescueImg.complete && turtleRescueImg.naturalWidth > 0) {
    const w = 80;
    const h = (turtleRescueImg.naturalHeight / turtleRescueImg.naturalWidth) * w;
    const drawX = rescue.turtleX - w / 2;
    const drawY = rescue.turtleY - h / 2;

    const isPulling = rescue.phase === "HOOK" || rescue.phase === "TOW";
    if (isPulling) {
      const rodTipX = drawX + w * 0.20;
      const rodTipY = drawY + h * 0.56;
      ctx.save();
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(rodTipX, rodTipY);
      ctx.lineTo(rescue.hookPointX, rescue.hookPointY);
      ctx.stroke();
      ctx.fillStyle = "rgba(255,255,255,0.95)";
      ctx.beginPath();
      ctx.arc(rescue.hookPointX, rescue.hookPointY, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    if (drawX + w > -20) {
      ctx.drawImage(turtleRescueImg, drawX, drawY, w, h);
    }
  }

  // 10. Tube rescue overlay
  const tubeRescue = s.tubeRescue;
  if (tubeRescue.active && tubeImg && tubeImg.complete && tubeImg.naturalWidth > 0) {
    const w = 92;
    const h = (tubeImg.naturalHeight / tubeImg.naturalWidth) * w;
    ctx.save();
    ctx.translate(tubeRescue.tubeX, tubeRescue.tubeY);
    ctx.rotate(tubeRescue.tubeRot);
    ctx.shadowColor = "rgba(0,255,255,0.35)";
    ctx.shadowBlur = 16;
    ctx.globalAlpha = 0.95;
    ctx.drawImage(tubeImg, -w / 2, -h / 2, w, h);
    ctx.restore();
  }

  // 11. Death overlay (in viewport coords, undo camera offset)
  if (!s.alive) {
    ctx.save();
    ctx.translate(0, -cameraY);
    ctx.fillStyle = "rgba(255, 0, 0, 0.15)";
    ctx.fillRect(0, 0, vw, vh);
    ctx.restore();
  }

  // 12. Score popups (for score_attack mode)
  s.scorePopups.forEach(popup => {
    ctx.save();
    ctx.globalAlpha = popup.opacity;
    ctx.font = "bold 18px monospace";
    ctx.textAlign = "center";
    const isNegative = popup.text.startsWith("-");
    ctx.fillStyle = isNegative ? "#ff4444" : "#00ff88";
    ctx.shadowColor = "rgba(0,0,0,0.7)";
    ctx.shadowBlur = 4;
    ctx.fillText(popup.text, popup.x, popup.y);
    ctx.restore();
  });

  ctx.restore();
}

// --- Draw the divider line between the two halves ---
export function drawDivider(ctx: CanvasRenderingContext2D, canvasWidth: number, y: number) {
  ctx.save();
  ctx.strokeStyle = "rgba(255, 255, 255, 0.6)";
  ctx.lineWidth = 3;
  ctx.setLineDash([10, 6]);
  ctx.beginPath();
  ctx.moveTo(0, y);
  ctx.lineTo(canvasWidth, y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

// --- Draw the mini HUD for each player (score, oxygen, items) inside their viewport ---
export function drawPlayerHUD(
  ctx: CanvasRenderingContext2D,
  s: PvpPlayerState,
  viewport: Viewport,
  playerLabel: string,
  powerUpMode: string,
) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(viewport.x, viewport.y, viewport.width, viewport.height);
  ctx.clip();
  ctx.translate(viewport.x, viewport.y);

  const vw = viewport.width;
  const pad = 10;

  // Player label
  ctx.font = "bold 14px monospace";
  ctx.fillStyle = "rgba(255, 255, 255, 0.7)";
  ctx.textAlign = "left";
  ctx.fillText(playerLabel, pad, 20);

  // Score
  ctx.font = "bold 20px monospace";
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.shadowColor = "rgba(0,0,0,0.6)";
  ctx.shadowBlur = 4;
  ctx.fillText(`${s.score}`, vw / 2, 24);
  ctx.shadowBlur = 0;

  // Oxygen bar
  const barW = 100;
  const barH = 8;
  const barX = vw - barW - pad;
  const barY = 10;
  const oxygenPct = Math.max(0, s.oxygen / 30);
  ctx.fillStyle = "rgba(0, 0, 0, 0.4)";
  ctx.fillRect(barX, barY, barW, barH);
  ctx.fillStyle = oxygenPct > 0.3 ? "#00ccff" : "#ff4444";
  ctx.fillRect(barX, barY, barW * oxygenPct, barH);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.4)";
  ctx.lineWidth = 1;
  ctx.strokeRect(barX, barY, barW, barH);

  // O2 label
  ctx.font = "9px monospace";
  ctx.fillStyle = "rgba(255,255,255,0.6)";
  ctx.textAlign = "right";
  ctx.fillText("O2", barX - 4, barY + 7);

  // Items info (only for relevant modes)
  if (powerUpMode === "inventory" || powerUpMode === "earned") {
    let infoY = 30;
    ctx.font = "11px monospace";
    ctx.textAlign = "right";
    ctx.fillStyle = "#aaa";

    if (s.turtleShellSaved) {
      ctx.fillStyle = "#2ecc71";
      ctx.fillText("Shell Ready", vw - pad, infoY);
      infoY += 14;
    }
    if (s.dolphinCount > 0) {
      ctx.fillStyle = "#5dade2";
      ctx.fillText(`Dolphins: ${s.dolphinCount}`, vw - pad, infoY);
      infoY += 14;
    }
    if (s.tubeRescueCharges > 0) {
      ctx.fillStyle = "#00ffff";
      ctx.fillText(`Tubes: ${s.tubeRescueCharges}`, vw - pad, infoY);
      infoY += 14;
    }
    if (s.tubePieces > 0) {
      ctx.fillStyle = "#00ffff";
      ctx.fillText(`Pieces: ${s.tubePieces}/4`, vw - pad, infoY);
    }
  }

  // "DEAD" text
  if (!s.alive) {
    ctx.font = "bold 36px monospace";
    ctx.fillStyle = "rgba(255, 60, 60, 0.9)";
    ctx.textAlign = "center";
    ctx.shadowColor = "rgba(0,0,0,0.8)";
    ctx.shadowBlur = 6;
    ctx.fillText("DEFEATED", vw / 2, viewport.height / 2);
    ctx.shadowBlur = 0;
  }

  ctx.restore();
}

// --- Draw rescue countdown overlay ---
export function drawRescueCountdown(
  ctx: CanvasRenderingContext2D,
  s: PvpPlayerState,
  viewport: Viewport,
) {
  const rescue = s.rescue.active ? s.rescue : s.tubeRescue.active ? s.tubeRescue : null;
  if (!rescue || !rescue.active || rescue.phase !== "COUNTDOWN") return;

  const display = Math.max(0, Math.ceil(rescue.countdownMs / 1000));
  if (display <= 0) return;

  ctx.save();
  ctx.beginPath();
  ctx.rect(viewport.x, viewport.y, viewport.width, viewport.height);
  ctx.clip();
  ctx.translate(viewport.x, viewport.y);

  ctx.font = "bold 48px monospace";
  ctx.fillStyle = "white";
  ctx.textAlign = "center";
  ctx.shadowColor = "rgba(0,0,0,0.6)";
  ctx.shadowBlur = 6;
  ctx.fillText(`${display}`, viewport.width / 2, viewport.height / 2);

  if (s.rescueJumpCharges > 0) {
    ctx.font = "bold 20px monospace";
    ctx.fillText(`x${s.rescueJumpCharges}`, viewport.width / 2, viewport.height / 2 + 30);
  }

  ctx.shadowBlur = 0;
  ctx.restore();
}
