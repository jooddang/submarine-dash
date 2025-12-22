# Deploying Submarine Dash to Vercel

This guide will walk you through deploying the Submarine Dash game to Vercel with serverless functions.

## Prerequisites

1. A [Vercel account](https://vercel.com/signup)
2. [Vercel CLI](https://vercel.com/cli) installed (optional but recommended)
3. Git repository (GitHub, GitLab, or Bitbucket)

## Setup Vercel KV Database

The application uses Vercel KV (Redis) for persistent leaderboard storage.

### 1. Create a KV Database

1. Go to your [Vercel Dashboard](https://vercel.com/dashboard)
2. Navigate to **Storage** tab
3. Click **Create Database**
4. Select **KV** (Redis-compatible)
5. Name it `submarine-dash-kv` (or any name you prefer)
6. Choose your region (select the one closest to your users)
7. Click **Create**

### 2. Connect KV to Your Project

After deployment, you need to connect the KV database:

1. Go to your project in Vercel Dashboard
2. Navigate to **Storage** tab
3. Click **Connect Store**
4. Select your KV database
5. This will automatically add the required environment variables:
   - `KV_URL`
   - `KV_REST_API_URL`
   - `KV_REST_API_TOKEN`
   - `KV_REST_API_READ_ONLY_TOKEN`

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

### Required (Auto-configured when connecting KV)
- `KV_URL` - Vercel KV connection URL
- `KV_REST_API_URL` - REST API endpoint
- `KV_REST_API_TOKEN` - Authentication token
- `KV_REST_API_READ_ONLY_TOKEN` - Read-only token

### Optional
- `VITE_API_URL` - Custom API base URL (not needed for Vercel deployment)

## Post-Deployment

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

### "KV is not defined" error
- Make sure you've connected the KV database in Vercel Dashboard
- Environment variables should be automatically added
- Redeploy after connecting KV

### CORS errors
- Check that `vercel.json` includes CORS headers
- Verify API endpoints are accessible

### Leaderboard not persisting
- Ensure KV database is connected
- Check Vercel Function logs for errors
- Verify environment variables are set

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
└── Database (Vercel KV)
    └── Redis-compatible key-value store
```

## Cost

- **Vercel Hosting**: Free tier includes:
  - 100GB bandwidth/month
  - Unlimited deployments
  - Automatic HTTPS

- **Vercel KV**: Free tier includes:
  - 256MB storage
  - 10k commands/day
  - Enough for thousands of leaderboard entries

## Support

For issues:
1. Check Vercel Function logs in Dashboard
2. Review deployment logs
3. Check browser console for client-side errors
