# Spotify Cloudflare Worker

This is a serverless version of the Spotify integration server, built as a Cloudflare Worker.

## Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Configure environment variables:**
   
   You have two options:

   ### Option A: Use Wrangler Secrets (Recommended for production)
   ```bash
   npx wrangler secret put CLIENT_ID
   npx wrangler secret put CLIENT_SECRET
   npx wrangler secret put REFRESH_TOKEN
   ```

   ### Option B: Use wrangler.toml for development
   Edit `wrangler.toml` and uncomment the `[vars]` section, then add your values:
   ```toml
   [vars]
   CLIENT_ID = "your-spotify-client-id"
   CLIENT_SECRET = "your-spotify-client-secret"
   REFRESH_TOKEN = "your-spotify-refresh-token"
   ```

3. **Login to Cloudflare:**
   ```bash
   npx wrangler login
   ```

## Development

Run the worker locally:
```bash
npm run dev
```

This will start a local development server at `http://localhost:8787`

## Deployment

Deploy to Cloudflare Workers:
```bash
npm run deploy
```

After deployment, your worker will be available at:
- `https://spotify-worker.<your-subdomain>.workers.dev`

## API Endpoints

- `GET /` - Server information page
- `GET /api/now-playing` - Get currently playing song
- `GET /api/recent-tracks` - Get recently played tracks
- `GET /api/top-tracks?limit=10` - Get top tracks
- `GET /api/top-artists?limit=10` - Get top artists
- `GET /api/playlists` - Get user playlists
- `GET /api/status` - Check authentication status

## Environment Variables

- `CLIENT_ID` - Your Spotify Client ID
- `CLIENT_SECRET` - Your Spotify Client Secret
- `REFRESH_TOKEN` - Your Spotify Refresh Token

## Key Differences from Express Server

1. **No Node.js runtime** - Uses Cloudflare Workers runtime
2. **Serverless** - Auto-scales, pay-per-request pricing
3. **Edge deployment** - Runs on Cloudflare's global network
4. **No persistent storage** - Token cache resets on worker restart (consider using Cloudflare KV for persistence)
5. **Environment variables** - Managed through Wrangler CLI or dashboard

## Optional: Using Cloudflare KV for Token Persistence

For better token caching across worker instances, you can use Cloudflare KV:

1. Create a KV namespace:
   ```bash
   npx wrangler kv:namespace create "TOKEN_CACHE"
   ```

2. Add the binding to `wrangler.toml`:
   ```toml
   [[kv_namespaces]]
   binding = "TOKEN_CACHE"
   id = "your-namespace-id"
   ```

3. Update the code to use KV instead of in-memory cache.

## Notes

- Free tier includes 100,000 requests per day
- Edge locations provide low latency globally
- CORS is enabled for all origins (modify `corsHeaders` in `index.js` to restrict)
