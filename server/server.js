require('dotenv').config();
const express = require('express');
const cors = require('cors');
const app = express();

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const PORT = process.env.PORT || 1234;

let accessToken = null;
let refreshToken = process.env.REFRESH_TOKEN;
let tokenExpiresAt = null;

app.use(cors());
app.use(express.json());

const refreshAccessToken = async () => {
  if (!refreshToken) {
    throw new Error('No refresh token available');
  }

  const authOptions = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from(CLIENT_ID + ':' + CLIENT_SECRET).toString('base64')
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken
    })
  };

  try {
    const response = await fetch('https://accounts.spotify.com/api/token', authOptions);
    const data = await response.json();

    if (response.ok) {
      accessToken = data.access_token;
      tokenExpiresAt = Date.now() + (data.expires_in * 1000);
      if (data.refresh_token) {
        refreshToken = data.refresh_token;
      }
      return accessToken;
    } else {
      throw new Error('Failed to refresh token');
    }
  } catch (error) {
    console.error('Error refreshing token:', error);
    throw error;
  }
};

const getValidAccessToken = async () => {
  if (!accessToken || (tokenExpiresAt && Date.now() >= tokenExpiresAt - 60000)) {
    await refreshAccessToken();
  }

  return accessToken;
};

app.get('/api/now-playing', async (req, res) => {
  try {
    const token = await getValidAccessToken();

    const response = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    if (response.status === 204 || response.status === 404) {
      return res.json({ isPlaying: false, message: 'No song currently playing' });
    }

    if (!response.ok) {
      throw new Error(`Spotify API error: ${response.status}`);
    }

    const data = await response.json();

    if (!data || !data.item) {
      return res.json({ isPlaying: false, message: 'No song currently playing' });
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

    res.json(song);
  } catch (error) {
    console.error('Error fetching now playing:', error);
    res.status(500).json({ error: 'Failed to fetch currently playing song', message: error.message });
  }
});

app.get('/api/recent-tracks', async (req, res) => {
  try {
    const token = await getValidAccessToken();

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

    res.json({ tracks });
  } catch (error) {
    console.error('Error fetching recent tracks:', error);
    res.status(500).json({ error: 'Failed to fetch recent tracks', message: error.message });
  }
});

app.get('/api/top-tracks', async (req, res) => {
  try {
    const token = await getValidAccessToken();
    const limit = req.query.limit || 10;

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

    res.json({ tracks });
  } catch (error) {
    console.error('Error fetching top tracks:', error);
    res.status(500).json({ error: 'Failed to fetch top tracks', message: error.message });
  }
});

app.get('/api/top-artists', async (req, res) => {
  try {
    const token = await getValidAccessToken();
    const limit = req.query.limit || 10;

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

    res.json({ artists });
  } catch (error) {
    console.error('Error fetching top artists:', error);
    res.status(500).json({ error: 'Failed to fetch top artists', message: error.message });
  }
});

app.get('/api/playlists', async (req, res) => {
  try {
    const token = await getValidAccessToken();

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

    res.json({ playlists });
  } catch (error) {
    console.error('Error fetching playlists:', error);
    res.status(500).json({ error: 'Failed to fetch playlists', message: error.message });
  }
});

app.get('/api/status', (req, res) => {
  res.json({
    authenticated: !!accessToken,
    tokenExpires: tokenExpiresAt ? new Date(tokenExpiresAt).toISOString() : null
  });
});

app.get('/', (req, res) => {
  res.send(`
    <html>
      <head>
        <title>Spotify Server</title>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
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
          <p>Server is running on port ${PORT}</p>
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
  `);
});

app.listen(PORT, () => {
  console.log(`\nSpotify server is running on http://localhost:${PORT}`);
  console.log(`\nAvailable endpoints:`);
  console.log(`  - http://localhost:${PORT}/api/now-playing (Get currently playing song)`);
  console.log(`  - http://localhost:${PORT}/api/recent-tracks (Get recently played tracks)`);
  console.log(`  - http://localhost:${PORT}/api/top-tracks (Get top 10 tracks)`);
  console.log(`  - http://localhost:${PORT}/api/top-artists (Get top 10 artists)`);
  console.log(`  - http://localhost:${PORT}/api/playlists (Get user playlists)`);
  console.log(`  - http://localhost:${PORT}/api/status (Check server status)\n`);
});
