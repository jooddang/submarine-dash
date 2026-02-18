# Tech Stack & Environment

## Language & Runtime
- Language: TypeScript 5.8 (frontend), JavaScript ES2022 (backend dev server)
- Runtime: Node.js 24.x
- Target: ES2022, browser + serverless

## Framework
- Core: React 19 (single-component game architecture)
- UI: Raw HTML5 Canvas API (no game engine)
- Styling: Inline CSS styles (no CSS framework)
- Component Library: N/A

## Data
- Primary DB: Redis (Upstash — production)
- ORM / Query Builder: N/A (direct Redis commands)
- Cache: N/A (Redis serves as both primary store and cache)
- Search: N/A

## Infrastructure
- Hosting: Vercel (frontend + serverless functions)
- CI/CD: Vercel auto-deploy on push
- Container: N/A
- IaC: N/A

## Package Management
- Package Manager: npm
- Monorepo Tool: N/A (separate `package.json` for frontend and backend dev server)

## Testing
- Unit / Integration: N/A (no test framework configured)
- E2E: N/A
- Coverage Target: N/A

## Code Quality
- Linter: N/A (not configured)
- Formatter: N/A (not configured)
- Type Checking: `tsc` via `tsconfig.json` (frontend only, `noEmit`)

## Authentication & Security
- Auth: Custom session-based auth (Node `crypto.scrypt` + Redis sessions)
- Secrets Management: `.env` (local) + Vercel environment variables (production)

## Audio
- Engine: Web Audio API (OscillatorNode + GainNode)
- Assets: None — all sounds synthesized at runtime

## External Services & APIs

| Service | Purpose | SDK / Client |
|---------|---------|-------------|
| Upstash Redis | Production database | `@upstash/redis` ^1.35.8 |
| Redis (local) | Dev database | `ioredis` ^5.3.2 / ^5.8.2 |
| Vercel | Hosting + serverless | `@vercel/node` ^3.0.0 |
| Google Profanity Words | Profanity filter (EN) | `@coffeeandfun/google-profanity-words` ^3.0.0 |

## Version Constraints

| Package | Pinned Version | Reason |
|---------|---------------|--------|
| Node.js | 24.x | `engines` field in package.json |
| React | ^19.2.3 | Uses React 19 features |
| TypeScript | ~5.8.2 | Tilde pin for patch-level stability |

## Dev Environment Setup

1. `git clone <repo-url> && cd submarine-dash`
2. `npm install`
3. `npm run backend:install`
4. Copy `.env.example` to `.env` and set `REDIS_URL`
5. Start local Redis (or use Upstash with connection string)
6. `npm run dev` (starts both frontend on :3000 and backend on :3001)

## Required Environment Variables

| Variable | Description | Example | Required |
|----------|-------------|---------|----------|
| `REDIS_URL` | Redis connection string | `redis://default:pass@host:port` | Yes (backend) |
| `VITE_API_URL` | Backend API URL for local dev | `http://localhost:3001` | No (defaults to relative path) |
