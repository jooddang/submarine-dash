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
- Setting up Vercel KV database
- Configuring environment variables
- Deploying via CLI or Dashboard
- Custom domain setup

**TL;DR:**
```bash
# Install Vercel CLI
npm install -g vercel

# Deploy
vercel --prod
```

Then connect Vercel KV database in your project dashboard.

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
- **Vercel KV (Redis)** - Leaderboard storage
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
- Persistent storage using Vercel KV
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

## 📝 License

MIT License - feel free to use this project for learning or creating your own games!

## 🤝 Contributing

Contributions are welcome! Feel free to submit issues and pull requests.

## 🎮 Credits

Game design and development by the Claude Code community.
Built with ❤️ using modern web technologies.
