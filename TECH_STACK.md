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
| `SD_LEGACY_STORAGE_ENABLED` | Keep Redis as active legacy storage | `true` | No (defaults true) |
| `SD_SUPABASE_SHADOW_VERIFY` | Enable later shadow verification | `false` | No |
| `SD_MIGRATION_ADMISSION_GATE_ENABLED` | Enforce Redis-backed fenced mutation admission | `false` | No |
| `SD_CANONICAL_AUTH_TICKETS_ENABLED` | Enable later canonical auth ticket flow | `false` | No |
| `SD_PROTECTED_ACCOUNT_CANARY_ENABLED` | Restrict later cutover to protected canaries | `false` | No |
| `SD_LEGACY_ROAD_LOGIN_ENABLED` | Permit the internal read-only legacy verifier for protected Roadcrosser login | `false` | No |
| `SD_MIGRATION_ROLLBACK_MODE` | Route later storage access through rollback mode | `false` | No |
| `SD_SUPABASE_GAMEPLAY_WRITES_ENABLED` | Route canonical mission gameplay settlement to Roadcrosser Supabase; legacy sessions remain on Redis | `false` | Canonical auth only |
| `SD_SUBMARINE_PUBLIC_ORIGIN` | Exact same-origin boundary for canonical logout | `https://submarine-dash.roadcrosser.com` | Canonical auth only |
| `SD_ROADCROSSER_PUBLIC_ORIGIN` | Exact Roadcrosser ticket issuer origin | `https://www.roadcrosser.com` | Canonical auth only |
| `SD_ROADCROSSER_INTERNAL_BASE_URL` | Fixed server-to-server Roadcrosser base URL; localhost is accepted only outside production | `https://www.roadcrosser.com` | Canonical auth only |
| `SD_ROADCROSSER_INTERNAL_AUTH_TOKEN` | Audience-scoped server credential; never expose through `VITE_*` | random 32+ chars | Canonical auth only |
| `SD_MIGRATION_LEASE_TTL_MS` | Mutation lease TTL; must exceed max invocation plus margin | `930000` | No |
| `SD_MIGRATION_RUNTIME_PROBE_URLS` | Comma-separated deployed HTTPS health probes required before freeze | `https://game.example/api/health` | Freeze operator only |
| `SD_MIGRATION_EXPECTED_DEPLOYED_COMMIT` | Exact commit every runtime probe must report | Git SHA | Freeze operator only |

Canonical canary responses carry both `canonical: true` and `readOnly: true`.
The browser disables writes for clear UX, while the server enforces the trust
boundary by refusing legacy Redis session resolution whenever the canonical
cookie is present. Canonical, legacy, and callback-state cookies are host-only
and are never interchangeable.
