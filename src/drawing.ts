import type { Item, BackgroundEntity } from "./types";

// Draw Swordfish Item
export const drawSwordfish = (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) => {
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
  ctx.moveTo(x, y + h / 2);
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

// Draw Turtle Shell Item (a turtle in a shell)
export const drawTurtleShell = (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) => {
  // Shell
  ctx.fillStyle = "#8d6e63";
  ctx.beginPath();
  ctx.ellipse(x + w * 0.55, y + h * 0.55, w * 0.42, h * 0.35, -0.2, 0, Math.PI * 2);
  ctx.fill();

  // Shell pattern
  ctx.strokeStyle = "rgba(255, 255, 255, 0.35)";
  ctx.lineWidth = Math.max(1, Math.floor(w * 0.05));
  ctx.beginPath();
  ctx.moveTo(x + w * 0.42, y + h * 0.55);
  ctx.lineTo(x + w * 0.70, y + h * 0.55);
  ctx.moveTo(x + w * 0.52, y + h * 0.42);
  ctx.lineTo(x + w * 0.60, y + h * 0.68);
  ctx.stroke();

  // Turtle head peeking out
  ctx.fillStyle = "#2ecc71";
  ctx.beginPath();
  ctx.ellipse(x + w * 0.22, y + h * 0.55, w * 0.18, h * 0.14, 0, 0, Math.PI * 2);
  ctx.fill();

  // Eye
  ctx.fillStyle = "black";
  ctx.beginPath();
  ctx.arc(x + w * 0.18, y + h * 0.52, Math.max(1, w * 0.03), 0, Math.PI * 2);
  ctx.fill();
};

// Draw Rescue Turtle (simple flying turtle holding a rod) + optional hook line
export const drawRescueTurtle = (
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  scale: number,
  hookTo?: { x: number; y: number }
) => {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale, scale);

  // Fishing rod (clearly held)
  const rodBase = { x: -12, y: 6 };
  const rodTip = { x: 44, y: 22 };

  // Handle / grip
  ctx.fillStyle = "#8e5a2b";
  ctx.fillRect(rodBase.x - 2, rodBase.y - 2, 10, 6);

  // Rod pole
  ctx.strokeStyle = "#c49a6c";
  ctx.lineWidth = 4;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(rodBase.x + 8, rodBase.y + 1);
  ctx.lineTo(rodTip.x, rodTip.y);
  ctx.stroke();

  // Reel
  ctx.fillStyle = "#444";
  ctx.beginPath();
  ctx.arc(rodBase.x + 10, rodBase.y + 2, 4, 0, Math.PI * 2);
  ctx.fill();

  // Line + hook (originates from rod tip)
  if (hookTo) {
    const hx = (hookTo.x - x) / scale;
    const hy = (hookTo.y - y) / scale;
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(rodTip.x, rodTip.y);
    ctx.lineTo(hx, hy);
    ctx.stroke();

    // Hook
    ctx.strokeStyle = "#ddd";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(hx, hy, 4, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(hx + 2.5, hy + 2.5);
    ctx.quadraticCurveTo(hx + 7, hy + 7, hx + 2, hy + 10);
    ctx.stroke();
  }

  // Wings (tiny fins)
  ctx.fillStyle = "rgba(46, 204, 113, 0.7)";
  ctx.beginPath();
  ctx.ellipse(-10, 10, 14, 6, -0.3, 0, Math.PI * 2);
  ctx.ellipse(10, 12, 14, 6, 0.4, 0, Math.PI * 2);
  ctx.fill();

  // Shell
  ctx.fillStyle = "#8d6e63";
  ctx.beginPath();
  ctx.ellipse(0, 10, 22, 16, -0.2, 0, Math.PI * 2);
  ctx.fill();

  // Head
  ctx.fillStyle = "#2ecc71";
  ctx.beginPath();
  ctx.ellipse(-24, 12, 10, 8, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "black";
  ctx.beginPath();
  ctx.arc(-27, 10, 2.2, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
};

// Draw Urchin Item
export const drawUrchin = (ctx: CanvasRenderingContext2D, item: Item) => {
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
  if (item.isDead) {
    // Crying Eyes
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

// Draw Background Entities
export const drawBackgroundEntities = (
  ctx: CanvasRenderingContext2D,
  entities: BackgroundEntity[],
  gameTime: number
) => {
  entities.forEach(e => {
    ctx.save();
    ctx.translate(e.x, e.y);
    ctx.scale(e.scale, e.scale);
    // Subtle rotation for "swimming" effect
    ctx.rotate(Math.sin(gameTime * 1.5 + e.wobbleOffset) * 0.05);

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
      ctx.arc(-10, -4, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'black';
      ctx.beginPath();
      ctx.arc(-12, -4, 2, 0, Math.PI * 2);
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
      for (let i = 0; i < 5; i++) {
        const sx = (Math.sin(e.id + i) * 60);
        const sy = (Math.cos(e.id + i) * 20);
        ctx.beginPath();
        ctx.arc(sx, sy, 1 + (i % 2), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    else if (e.type === "JELLYFISH") {
      // Cute Jellyfish
      ctx.fillStyle = e.variant % 2 === 0 ? 'rgba(255, 182, 193, 0.6)' : 'rgba(255, 160, 122, 0.6)';

      // Head
      ctx.beginPath();
      ctx.arc(0, -10, 20, Math.PI, 0);
      // Ruffled bottom
      for (let i = 0; i < 5; i++) {
        ctx.arc(20 - i * 10 + 5, -10, 5, 0, Math.PI);
      }
      ctx.fill();

      // Face
      ctx.fillStyle = '#333';
      ctx.beginPath();
      ctx.arc(-8, -15, 2, 0, Math.PI * 2); // Left Eye
      ctx.arc(8, -15, 2, 0, Math.PI * 2);  // Right Eye
      ctx.fill();
      // Smile
      ctx.beginPath();
      ctx.arc(0, -12, 4, 0, Math.PI);
      ctx.stroke();

      // Tentacles
      ctx.strokeStyle = e.variant % 2 === 0 ? 'rgba(255, 182, 193, 0.4)' : 'rgba(255, 160, 122, 0.4)';
      ctx.lineWidth = 3;
      for (let i = 0; i < 4; i++) {
        ctx.beginPath();
        ctx.moveTo(-15 + i * 10, -10);
        ctx.quadraticCurveTo(-15 + i * 10 + Math.sin(gameTime * 4 + i) * 10, 10, -15 + i * 10, 30);
        ctx.stroke();
      }
    }
    else if (e.type === "DIVER") {
      // Scuba Diver
      ctx.fillStyle = "#004e92"; // Blue Suit
      // Body
      ctx.beginPath();
      ctx.ellipse(0, 0, 25, 8, 0, 0, Math.PI * 2);
      ctx.fill();

      // Tank
      ctx.fillStyle = "#ffd700"; // Yellow Tank
      ctx.fillRect(-10, -12, 15, 6);

      // Head
      ctx.fillStyle = "#ffccaa"; // Skin
      ctx.beginPath();
      ctx.arc(-25, -2, 6, 0, Math.PI * 2);
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
      if (Math.sin(gameTime * 5) > 0.5) {
        ctx.fillStyle = "rgba(255,255,255,0.5)";
        ctx.beginPath();
        ctx.arc(-35, -10, 2, 0, Math.PI * 2);
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
