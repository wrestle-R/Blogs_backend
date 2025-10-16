// Cloudflare Worker for Spotify Integration

// In-memory token cache (will reset on worker restart)
let tokenCache = {
  accessToken: null,
  tokenExpiresAt: null
};

// Hardcoded Spotify API credentials
const CLIENT_ID = 'a1ef78fef1584de88d6a0274aca40003';
const CLIENT_SECRET = 'dc9b0088d0bd491abb8dfd6ddfda9180';
const REFRESH_TOKEN = 'AQC11rEwSxok54PSJjK7jj0BEe0lvCC_cNDgUApfsK7JTJynT0iBUp37-iHCfVsQwvhwabki94PUBFXQKHMUVbK8SlhuhI5kzsxyhhSCu-VsFQBM3goIxbaWCKY0HuXScu8';

// Helper function to refresh access token
async function refreshAccessToken() {
  const authString = btoa(`${CLIENT_ID}:${CLIENT_SECRET}`);
  
  const authOptions = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${authString}`
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: REFRESH_TOKEN
    })
  };

  try {
    const response = await fetch('https://accounts.spotify.com/api/token', authOptions);
    const data = await response.json();

    if (response.ok) {
      tokenCache.accessToken = data.access_token;
      tokenCache.tokenExpiresAt = Date.now() + (data.expires_in * 1000);
      return tokenCache.accessToken;
    } else {
      throw new Error('Failed to refresh token');
    }
  } catch (error) {
    console.error('Error refreshing token:', error);
    throw error;
  }
}

// Helper function to get valid access token
async function getValidAccessToken() {
  if (!tokenCache.accessToken || (tokenCache.tokenExpiresAt && Date.now() >= tokenCache.tokenExpiresAt - 60000)) {
    await refreshAccessToken();
  }
  return tokenCache.accessToken;
}

// CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Handle CORS preflight requests
function handleOptions() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders
  });
}

// JSON response helper
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders
    }
  });
}

// HTML response helper
function htmlResponse(html) {
  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html',
      ...corsHeaders
    }
  });
}

// Route handlers
async function handleNowPlaying(env) {
  try {
    const token = await getValidAccessToken(env);

    const response = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    if (response.status === 204 || response.status === 404) {
      return jsonResponse({ isPlaying: false, message: 'No song currently playing' });
    }

    if (!response.ok) {
      throw new Error(`Spotify API error: ${response.status}`);
    }

    const data = await response.json();

    if (!data || !data.item) {
      return jsonResponse({ isPlaying: false, message: 'No song currently playing' });
    }

    const song = {
      isPlaying: data.is_playing,
      name: data.item.name,
      artist: data.item.artists.map(artist => artist.name).join(', '),
      album: data.item.album.name,
      albumArt: data.item.album.images[0]?.url || null,
      songUrl: data.item.external_urls.spotify,
      previewUrl: data.item.preview_url,
      duration: data.item.duration_ms,
      progress: data.progress_ms,
      popularity: data.item.popularity
    };

    return jsonResponse(song);
  } catch (error) {
    console.error('Error fetching now playing:', error);
    return jsonResponse({ error: 'Failed to fetch currently playing song', message: error.message }, 500);
  }
}

async function handleRecentTracks(env) {
  try {
    const token = await getValidAccessToken(env);

    const response = await fetch('https://api.spotify.com/v1/me/player/recently-played?limit=10', {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    if (!response.ok) {
      throw new Error(`Spotify API error: ${response.status}`);
    }

    const data = await response.json();

    const tracks = data.items.map(item => ({
      name: item.track.name,
      artist: item.track.artists.map(artist => artist.name).join(', '),
      album: item.track.album.name,
      albumArt: item.track.album.images[0]?.url || null,
      playedAt: item.played_at,
      songUrl: item.track.external_urls.spotify
    }));

    return jsonResponse({ tracks });
  } catch (error) {
    console.error('Error fetching recent tracks:', error);
    return jsonResponse({ error: 'Failed to fetch recent tracks', message: error.message }, 500);
  }
}

async function handleTopTracks(env, url) {
  try {
    const token = await getValidAccessToken(env);
    const urlParams = new URL(url).searchParams;
    const limit = urlParams.get('limit') || 10;

    const response = await fetch(`https://api.spotify.com/v1/me/top/tracks?limit=${limit}&time_range=short_term`, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    if (!response.ok) {
      throw new Error(`Spotify API error: ${response.status}`);
    }

    const data = await response.json();

    const tracks = data.items.map(track => ({
      name: track.name,
      artist: track.artists.map(artist => artist.name).join(', '),
      album: track.album.name,
      albumArt: track.album.images[0]?.url || null,
      songUrl: track.external_urls.spotify,
      popularity: track.popularity
    }));

    return jsonResponse({ tracks });
  } catch (error) {
    console.error('Error fetching top tracks:', error);
    return jsonResponse({ error: 'Failed to fetch top tracks', message: error.message }, 500);
  }
}

async function handleTopArtists(env, url) {
  try {
    const token = await getValidAccessToken(env);
    const urlParams = new URL(url).searchParams;
    const limit = urlParams.get('limit') || 10;

    const response = await fetch(`https://api.spotify.com/v1/me/top/artists?limit=${limit}&time_range=short_term`, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    if (!response.ok) {
      throw new Error(`Spotify API error: ${response.status}`);
    }

    const data = await response.json();

    const artists = data.items.map(artist => ({
      name: artist.name,
      image: artist.images[0]?.url || null,
      genres: artist.genres,
      popularity: artist.popularity,
      url: artist.external_urls.spotify
    }));

    return jsonResponse({ artists });
  } catch (error) {
    console.error('Error fetching top artists:', error);
    return jsonResponse({ error: 'Failed to fetch top artists', message: error.message }, 500);
  }
}

async function handlePlaylists(env) {
  try {
    const token = await getValidAccessToken(env);

    const response = await fetch('https://api.spotify.com/v1/me/playlists?limit=20', {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    if (!response.ok) {
      throw new Error(`Spotify API error: ${response.status}`);
    }

    const data = await response.json();

    const playlists = data.items.map(playlist => ({
      id: playlist.id,
      name: playlist.name,
      description: playlist.description,
      image: playlist.images[0]?.url || null,
      trackCount: playlist.tracks.total,
      isPublic: playlist.public,
      isCollaborative: playlist.collaborative,
      url: playlist.external_urls.spotify,
      owner: playlist.owner.display_name
    }));

    return jsonResponse({ playlists });
  } catch (error) {
    console.error('Error fetching playlists:', error);
    return jsonResponse({ error: 'Failed to fetch playlists', message: error.message }, 500);
  }
}

function handleStatus() {
  return jsonResponse({
    authenticated: !!tokenCache.accessToken,
    tokenExpires: tokenCache.tokenExpiresAt ? new Date(tokenCache.tokenExpiresAt).toISOString() : null
  });
}

function handleHome() {
  const html = `
    <html>
      <head>
        <title>Spotify Server</title>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            margin: 0;
            background: #191414;
            color: white;
          }
          .container {
            text-align: center;
            max-width: 500px;
            padding: 2rem;
          }
          h1 { color: #1DB954; margin-bottom: 1rem; }
          p { opacity: 0.8; margin-bottom: 2rem; }
          .status { 
            background: rgba(255,255,255,0.1); 
            padding: 1rem; 
            border-radius: 0.5rem; 
            margin-bottom: 2rem;
          }
          a {
            display: inline-block;
            padding: 1rem 2rem;
            background: #1DB954;
            color: white;
            text-decoration: none;
            border-radius: 2rem;
            font-weight: 600;
            margin: 0.5rem;
            transition: transform 0.2s;
          }
          a:hover { transform: scale(1.05); }
          .endpoints {
            margin-top: 2rem;
            text-align: left;
            background: rgba(255,255,255,0.05);
            padding: 1rem;
            border-radius: 0.5rem;
            font-size: 0.875rem;
          }
          .endpoints code {
            color: #1DB954;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>Spotify Integration Server</h1>
          <p>Cloudflare Worker - Serverless Function</p>
          <div class="status"> 
            <strong>Status:</strong> Ready
          </div>
          <div class="endpoints">
            <strong>Available Endpoints:</strong><br>
            <code>GET /api/now-playing</code> - Get currently playing song<br>
            <code>GET /api/recent-tracks</code> - Get recently played tracks<br>
            <code>GET /api/top-tracks</code> - Get top 10 tracks<br>
            <code>GET /api/top-artists</code> - Get top 10 artists<br>
            <code>GET /api/playlists</code> - Get user playlists<br>
            <code>GET /api/status</code> - Check server status
          </div>
        </div>
      </body>
    </html>
  `;
  return htmlResponse(html);
}

// Main fetch handler
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Handle OPTIONS requests (CORS preflight)
    if (request.method === 'OPTIONS') {
      return handleOptions();
    }

    // Route handling
    if (path === '/' || path === '') {
      return handleHome();
    } else if (path === '/api/now-playing') {
      return handleNowPlaying(env);
    } else if (path === '/api/recent-tracks') {
      return handleRecentTracks(env);
    } else if (path === '/api/top-tracks') {
      return handleTopTracks(env, request.url);
    } else if (path === '/api/top-artists') {
      return handleTopArtists(env, request.url);
    } else if (path === '/api/playlists') {
      return handlePlaylists(env);
    } else if (path === '/api/status') {
      return handleStatus();
    } else {
      return jsonResponse({ error: 'Not Found' }, 404);
    }
  }
};
