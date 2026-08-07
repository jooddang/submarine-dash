# 🌊 Deep Dive Dash (Submarine Dash)

A fun endless runner game built with React, TypeScript, and Vite. Navigate your submarine through the depths, avoid obstacles, collect oxygen, and compete on the global leaderboard!

## 🎮 Features

- **Endless Runner Gameplay** - Navigate through procedurally generated underwater terrain
- **Power-ups** - Collect oxygen tanks and swordfish for special abilities
- **Obstacles** - Avoid quicksand, urchins, and gaps
- **Variable Jump Mechanics** - Hold jump for higher jumps
- **Universal Leaderboard** - Compete globally with all players
- **Mobile Support** - Full touch controls and mobile-optimized audio
- **Beautiful Underwater Theme** - Dynamic backgrounds with fish, whales, and more

## 🚀 Quick Start

### Prerequisites

- Node.js (v18 or higher)
- npm or yarn

### Local Development

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Run the development servers:**
   ```bash
   # Run both frontend and backend together
   npm run dev

   # Or run separately
   # Terminal 1: Frontend
   npm run dev:frontend

   # Terminal 2: Backend
   cd backend
   npm install
   npm run dev
   ```

3. **Open your browser:**
   - Game: http://localhost:3000
   - API: http://localhost:3001

## 📦 Deploy to Vercel

This project is optimized for deployment on Vercel with serverless functions.

### Quick Deploy

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/yourusername/submarine-dash)

### Manual Deployment

See [DEPLOYMENT.md](DEPLOYMENT.md) for detailed instructions on:
- Setting up Redis database (Upstash, RedisLabs, etc.)
- Configuring environment variables
- Deploying via CLI or Dashboard
- Custom domain setup

**TL;DR:**
```bash
# 1. Get Redis URL from your provider
# 2. Add REDIS_URL to Vercel environment variables
# 3. Deploy
npm install -g vercel
vercel --prod
```

## 🎯 How to Play

### Controls
- **Keyboard:** Spacebar or Arrow Up
- **Touch:** Tap anywhere on the screen
- **Variable Jump:** Hold longer for higher jumps

### Objective
- Survive as long as possible
- Collect oxygen tanks to refill oxygen
- Avoid gaps, quicksand, and urchins
- Collect swordfish for 3x speed and invincibility
- Compete for the top spot on the leaderboard!

## 🏗️ Project Structure

```
submarine-dash/
├── api/                    # Vercel serverless functions
│   ├── leaderboard.ts      # Leaderboard API endpoint
│   └── health.ts           # Health check endpoint
├── backend/                # Local Express server (for development)
│   └── src/
│       └── server.js
├── src/                    # Frontend source code
│   ├── components/         # React components
│   ├── constants.ts        # Game constants
│   ├── types.ts            # TypeScript types
│   ├── audio.ts            # Audio system
│   ├── graphics.ts         # Graphics utilities
│   ├── entities.ts         # Game entities
│   ├── drawing.ts          # Drawing functions
│   ├── api.ts              # API client
│   └── Game.tsx            # Main game component
├── index.html              # Entry HTML
├── index.tsx               # Entry point
├── vercel.json             # Vercel configuration
└── package.json
```

## 🛠️ Tech Stack

### Frontend
- **React 19** - UI framework
- **TypeScript** - Type safety
- **Vite** - Build tool and dev server
- **Canvas API** - Game rendering
- **Web Audio API** - Sound effects

### Backend
- **Vercel Serverless Functions** - API endpoints (production)
- **Redis** - Leaderboard storage (works with any Redis provider)
- **Express.js** - Local development server
- **CORS** - Cross-origin support

## 🎵 Audio

The game includes procedurally generated sound effects:
- Jump sounds
- Oxygen collection
- Power-up activation
- Game over sounds

Audio is optimized for mobile devices with proper unlock handling.

## 📱 Mobile Support

- Full touch control support
- Responsive canvas sizing
- Mobile-optimized audio (iOS/Android compatible)
- Keyboard prevention on mobile
- Fixed viewport to prevent scroll issues

## 🏆 Leaderboard

The leaderboard is globally shared across all players:
- Top 5 scores displayed
- Persistent storage using Redis
- Real-time updates
- Name submission for high scores

## 🧪 Development

### Scripts

```bash
npm run dev              # Run both frontend and backend
npm run dev:frontend     # Run frontend only
npm run dev:backend      # Run backend only
npm run build            # Build for production
npm run preview          # Preview production build
npm run backend:install  # Install backend dependencies
```

### API Endpoints

- `GET /api/leaderboard` - Get top 5 scores
- `POST /api/leaderboard` - Submit new score
- `DELETE /api/leaderboard` - Clear leaderboard (testing)
- `GET /api/health` - Health check

### Migration admission controls

The Redis-backed mutation gate is disabled by default. Before a freeze, deploy every participating runtime with `SD_MIGRATION_ADMISSION_GATE_ENABLED=true`, then verify its `/api/health` response. The operator command requires every configured HTTPS probe to report the same route-inventory version/digest and the exact deployed **40-character commit SHA**. Run the safety-state reconciliation preflight first; it verifies the probes, requires an open healthy gate, and requires PVP to be fully drained without closing the gate. Its Redis status check may atomically sweep expired leases and set the corresponding hard-failure evidence, so it is not a strictly read-only Redis operation.

```bash
SD_MIGRATION_ADMISSION_GATE_ENABLED=true \
SD_MIGRATION_RUNTIME_PROBE_URLS=https://submarine-dash.example.com/api/health \
SD_MIGRATION_EXPECTED_DEPLOYED_COMMIT=replace-with-exact-40-character-commit \
npm run migration:control -- preflight
```

When preflight reports `"outcome": "ready"`, run freeze with an explicit confirmation:

```bash
SD_MIGRATION_ADMISSION_GATE_ENABLED=true \
SD_MIGRATION_RUNTIME_PROBE_URLS=https://submarine-dash.example.com/api/health \
SD_MIGRATION_EXPECTED_DEPLOYED_COMMIT=3065c4defce45314ae166922f64df60136d25c88 \
SD_MIGRATION_CONTROL_CONFIRM=FREEZE \
npm run migration:control -- freeze
```

Freeze closes the gate only after the initial checks pass, then polls until all mutation leases drain. PVP drain verification follows a complete cursor-based `sd:pvp:match:*` scan as well as the room index, so orphan matches and room/match partial writes cannot be mistaken for a drain. Success is reported only when the gate is closed, active leases are zero, no expired-lease hard failure exists, and PVP is still drained. The default 1,000,000 ms timeout exceeds the default 930,000 ms lease TTL; custom timeout and poll values use `SD_MIGRATION_FREEZE_DRAIN_TIMEOUT_MS` and `SD_MIGRATION_FREEZE_POLL_INTERVAL_MS`. A timeout or hard failure deliberately leaves the gate closed. If PVP appears after close, freeze attempts reopen only when the closed gate is healthy and has zero leases, then re-reads state and reports confirmed open, confirmed closed, or unknown. Output includes counts but never raw room IDs or upstream error payloads.

An expired lease sets a hard blocker and records its first Redis-time occurrence. Closing the gate records a separate Redis-time anchor. `reopen` remains unavailable until reconciliation is recorded. The remediation command atomically requires a closed gate, zero active leases, and a Redis-time quarantine starting at the later trusted anchor. The duration is code-owned: at least 930,000 ms and automatically extended to the largest lease TTL admitted by Redis. Operator-supplied quarantine timestamps or durations are not accepted. Two equal durable manifests must each have an ordered capture timestamp after that trusted quarantine and not in the future relative to Redis TIME. The reconciliation-report SHA, manifest SHA, capture times, batch, and operator are retained in the Redis audit record.

```bash
SD_MIGRATION_CONTROL_CONFIRM=RECONCILE_EXPIRED \
SD_MIGRATION_RECONCILIATION_REPORT_SHA256=replace-with-64-lowercase-hex \
SD_MIGRATION_FIRST_DURABLE_MANIFEST_SHA256=replace-with-64-lowercase-hex \
SD_MIGRATION_SECOND_DURABLE_MANIFEST_SHA256=replace-with-the-same-64-lowercase-hex \
SD_MIGRATION_FIRST_MANIFEST_CAPTURED_AT_MS=replace-with-first-capture-unix-ms \
SD_MIGRATION_SECOND_MANIFEST_CAPTURED_AT_MS=replace-with-second-capture-unix-ms \
SD_MIGRATION_BATCH_ID=replace-with-batch-id \
SD_MIGRATION_OPERATOR_ID=replace-with-operator-id \
npm run migration:control -- reconcile-expired
```

After reconciliation succeeds, run `npm run migration:control -- reopen` with `SD_MIGRATION_CONTROL_CONFIRM=REOPEN`. There is no implicit operator reopen after a timeout or hard failure.

## 📝 License

MIT License - feel free to use this project for learning or creating your own games!

## 🤝 Contributing

Contributions are welcome! Feel free to submit issues and pull requests.

## 🎮 Credits

Game design and development by the Claude Code community.
Built with ❤️ using modern web technologies.
