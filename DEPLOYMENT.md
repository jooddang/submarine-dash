# Deploying Submarine Dash to Vercel

This guide will walk you through deploying the Submarine Dash game to Vercel with serverless functions.

## Prerequisites

1. A [Vercel account](https://vercel.com/signup)
2. [Vercel CLI](https://vercel.com/cli) installed (optional but recommended)
3. Git repository (GitHub, GitLab, or Bitbucket)

## Setup Redis Database

The application uses Redis for persistent leaderboard storage. You can use any Redis provider.

### Recommended Redis Providers

- **Upstash** (Free tier, serverless Redis) - https://upstash.com
- **RedisLabs** (Free tier available) - https://redis.com
- **Railway** (Free tier) - https://railway.app
- **Render** (Free tier) - https://render.com

### 1. Create a Redis Database

#### Option A: Upstash (Recommended for Vercel)
1. Go to [Upstash Console](https://console.upstash.com)
2. Click **Create Database**
3. Choose a name: `submarine-dash`
4. Select region closest to your Vercel deployment
5. Click **Create**
6. Copy the **REDIS_URL** from the connection details

#### Option B: RedisLabs
1. Go to [RedisLabs](https://app.redislabs.com)
2. Create a new database
3. Copy the connection URL (format: `redis://default:PASSWORD@HOST:PORT`)

### 2. Add Environment Variable to Vercel

1. Go to your project in [Vercel Dashboard](https://vercel.com/dashboard)
2. Navigate to **Settings** → **Environment Variables**
3. Click **Add New**
4. Name: `REDIS_URL`
5. Value: Your Redis connection URL (e.g., `redis://default:PASSWORD@HOST:PORT`)
6. Select all environments (Production, Preview, Development)
7. Click **Save**

## Deployment Methods

### Method 1: Deploy via Vercel Dashboard (Recommended for first deployment)

1. **Push your code to Git**
   ```bash
   git add .
   git commit -m "Ready for Vercel deployment"
   git push origin main
   ```

2. **Import project to Vercel**
   - Go to [Vercel Dashboard](https://vercel.com/dashboard)
   - Click **Add New** → **Project**
   - Import your Git repository
   - Vercel will auto-detect the Vite configuration

3. **Configure build settings** (should be auto-detected)
   - Framework Preset: `Vite`
   - Build Command: `npm run build`
   - Output Directory: `dist`
   - Install Command: `npm install`

4. **Deploy**
   - Click **Deploy**
   - Wait for the build to complete

5. **Connect KV Database**
   - After deployment, go to project **Storage** tab
   - Connect your KV database as described above

### Method 2: Deploy via Vercel CLI

1. **Install Vercel CLI**
   ```bash
   npm install -g vercel
   ```

2. **Login to Vercel**
   ```bash
   vercel login
   ```

3. **Deploy**
   ```bash
   # First deployment
   vercel

   # Production deployment
   vercel --prod
   ```

4. **Link KV Database**
   ```bash
   # Pull environment variables
   vercel env pull
   ```

## Environment Variables

### Required
- `REDIS_URL` - Redis connection URL from your Redis provider
  - Format: `redis://default:PASSWORD@HOST:PORT`
  - Example: `redis://default:abc123@redis-10391.c60.us-west-1-2.ec2.cloud.redislabs.com:10391`

### Optional
- `VITE_API_URL` - Custom API base URL (not needed for Vercel deployment)

## Post-Deployment

### Migration freeze runbook

Use this sequence only after every participating runtime has been deployed with the admission gate enabled. The commands require Redis credentials, the complete comma-separated set of HTTPS health probes, and one exact 40-character deployed commit SHA.

1. Stop admitting new PVP activity through normal operations and wait for rooms and matches to drain.
2. Run the safety-state reconciliation preflight. It verifies every runtime probe before checking Redis, then requires the gate to be open, no hard-expired lease, and PVP to be drained. The status Lua may sweep expired leases and record hard-failure evidence, so this preflight does not close the gate but is not a strictly read-only Redis operation:

   ```bash
   SD_MIGRATION_ADMISSION_GATE_ENABLED=true \
   SD_MIGRATION_RUNTIME_PROBE_URLS=https://submarine-dash.example.com/api/health \
   SD_MIGRATION_EXPECTED_DEPLOYED_COMMIT=replace-with-exact-40-character-commit \
   npm run migration:control -- preflight
   ```

3. Confirm that preflight returned `"outcome": "ready"`, then freeze:

   ```bash
   SD_MIGRATION_ADMISSION_GATE_ENABLED=true \
   SD_MIGRATION_RUNTIME_PROBE_URLS=https://submarine-dash.example.com/api/health \
   SD_MIGRATION_EXPECTED_DEPLOYED_COMMIT=replace-with-exact-40-character-commit \
   SD_MIGRATION_CONTROL_CONFIRM=FREEZE \
   npm run migration:control -- freeze
   ```

4. Proceed only when the result is `"outcome": "frozen"`, with `gate.gate` equal to `closed`, `gate.activeLeases` equal to `0`, `gate.hardExpiredLease` equal to `false`, and `pvp.drained` equal to `true`.

Decision log and failure handling:

- Runtime probes are checked first so an outdated or partially deployed fleet cannot close the shared gate.
- The default drain timeout is 1,000,000 ms: the default 930,000 ms lease TTL plus a 70,000 ms safety margin. A configured timeout must cover the configured lease TTL plus this margin and cannot exceed 30 minutes. Polling defaults to 1,000 ms and must be between 50 and 10,000 ms.
- A lease timeout, gate-state change, or expired-lease hard failure is fail-closed. Do not reopen merely to make the migration command succeed; investigate and reconcile the durable state.
- PVP is checked both before and after close. A post-close PVP race triggers one automatic reopen attempt only if the gate remains closed, healthy, and at zero leases. The command re-reads control state after the attempt and reports confirmed open, confirmed closed, or unknown; it never infers closed state from a transport error.
- PVP drain checks traverse every cursor page for `sd:pvp:match:*` and merge those keys with room references. Active orphan matches, missing referenced matches, malformed records, incomplete pagination, and provider failures all block freeze.
- Drain uses only canonical terminal phases: rooms must be `CANCELED` or `COMPLETED`; matches must be `MATCH_RESULT` or `ABORTED`. Unrecognized and legacy-looking aliases remain active blockers.
- CLI output redacts raw PVP room identifiers. Use aggregate room/match counts for operator decisions.
- Manual reopen always requires `SD_MIGRATION_CONTROL_CONFIRM=REOPEN`. After any failure, first run `npm run migration:control -- status`, resolve the reported blocker, and obtain the appropriate operator approval before reopening.

If strict preflight identifies restore-verified stale PVP, use the dedicated `quarantine-stale-pvp` command only with approved precleanup evidence. It requires confirmation `QUARANTINE_STALE_PVP`, exact archive/manifest/restore-report hashes, separate precleanup archive and current runtime commits, a cutoff at least 30 days before Redis TIME, the exact epoch/operator, and inherited archive/key/report FDs. Source inventory v1 and executing/final inventory v2 identities are independently audited. It closes the gate despite the approved active graph but never weakens `freeze`, never auto-reopens, rejects every unexpected `sd:pvp:*` key, and writes only durable CAS-matched quarantine targets plus a redacted audit. Run `verify-frozen` afterward and keep that epoch closed through final T1 capture.

### Verify Deployment

1. **Test the frontend**
   - Visit your Vercel URL (e.g., `https://your-project.vercel.app`)
   - The game should load

2. **Test the API**
   - Visit `https://your-project.vercel.app/api/health`
   - Should return: `{"status":"ok","message":"Submarine Dash API is running"}`

3. **Test leaderboard**
   - Play the game and submit a score
   - Verify it appears in the leaderboard
   - Open in another browser/device - the leaderboard should be the same

### Custom Domain (Optional)

1. Go to your project in Vercel Dashboard
2. Navigate to **Settings** → **Domains**
3. Add your custom domain
4. Follow Vercel's instructions to configure DNS

## Local Development

To run the full stack locally:

```bash
# Terminal 1: Backend (local Express server)
cd backend
npm install
npm run dev

# Terminal 2: Frontend (Vite dev server)
npm run dev:frontend
```

Or run both together:
```bash
npm run dev
```

## Troubleshooting

### "REDIS_URL environment variable is not set" error
- Make sure you've added `REDIS_URL` in Vercel Environment Variables
- Go to **Settings** → **Environment Variables**
- Add the variable and redeploy

### Connection timeout or Redis errors
- Verify your Redis instance is running
- Check that the Redis URL is correct
- Make sure your Redis provider allows connections from Vercel IPs

### CORS errors
- Check that `vercel.json` includes CORS headers
- Verify API endpoints are accessible

### Leaderboard not persisting
- Ensure `REDIS_URL` environment variable is set correctly
- Check Vercel Function logs for errors
- Test Redis connection using your provider's dashboard

### Build failures
- Make sure all dependencies are in `package.json`
- Check build logs in Vercel Dashboard
- Ensure TypeScript types are correct

## API Endpoints

After deployment, your API will be available at:

- `GET /api/leaderboard` - Get top 5 scores
- `POST /api/leaderboard` - Submit new score
  - Body: `{ "name": "Player", "score": 1000 }`
- `DELETE /api/leaderboard` - Clear leaderboard (for testing)
- `GET /api/health` - Health check

## Architecture

```
Vercel Deployment
├── Frontend (Static Site)
│   ├── Vite build → dist/
│   └── Served at: https://your-project.vercel.app
│
├── API (Serverless Functions)
│   ├── /api/leaderboard.ts
│   ├── /api/health.ts
│   └── Served at: https://your-project.vercel.app/api/*
│
└── Database (Redis)
    └── Any Redis provider (Upstash, RedisLabs, etc.)
    └── Connected via REDIS_URL environment variable
```

## Cost

- **Vercel Hosting**: Free tier includes:
  - 100GB bandwidth/month
  - Unlimited deployments
  - Automatic HTTPS

- **Redis Providers**:
  - **Upstash**: Free tier includes 10k commands/day
  - **RedisLabs**: Free tier includes 30MB storage
  - **Railway**: Free tier with $5/month credit
  - All free tiers are sufficient for a leaderboard with thousands of entries

## Support

For issues:
1. Check Vercel Function logs in Dashboard
2. Review deployment logs
3. Check browser console for client-side errors
