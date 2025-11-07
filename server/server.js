
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const app = express();

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const PORT = process.env.PORT ;

let accessToken = null;
let refreshToken = process.env.REFRESH_TOKEN;
let tokenExpiresAt = null;

// Client Credentials token for search (public endpoints)
let clientCredentialsToken = null;
let clientCredentialsExpiresAt = null;

// Simple in-memory cache for search results
const searchCache = new Map();
const CACHE_TTL = 120000; // 120 seconds

// Cache for track details (longer TTL)
const trackCache = new Map();
const TRACK_CACHE_TTL = 86400000; // 24 hours

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
      console.error('Spotify API Error Response:', data);
      throw new Error(`Failed to refresh token: ${data.error} - ${data.error_description || 'No description'}`);
    }
  } catch (error) {
    console.error('Error refreshing token:', error.message);
    throw error;
  }
};

const getValidAccessToken = async () => {
  if (!accessToken || (tokenExpiresAt && Date.now() >= tokenExpiresAt - 60000)) {
    await refreshAccessToken();
  }

  return accessToken;
};

// Get Client Credentials token for public API access (search)
const getClientCredentialsToken = async () => {
  if (clientCredentialsToken && clientCredentialsExpiresAt && Date.now() < clientCredentialsExpiresAt - 60000) {
    return clientCredentialsToken;
  }

  const authOptions = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from(CLIENT_ID + ':' + CLIENT_SECRET).toString('base64')
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials'
    })
  };

  try {
    const response = await fetch('https://accounts.spotify.com/api/token', authOptions);
    const data = await response.json();

    if (response.ok) {
      clientCredentialsToken = data.access_token;
      clientCredentialsExpiresAt = Date.now() + (data.expires_in * 1000);
      return clientCredentialsToken;
    } else {
      throw new Error(`Failed to get client credentials token: ${data.error}`);
    }
  } catch (error) {
    console.error('Error getting client credentials token:', error.message);
    throw error;
  }
};

app.get('/api/search', async (req, res) => {
  try {
    const { q, limit = 6, market } = req.query;

    // Validate query
    if (!q || q.trim().length < 2) {
      return res.status(400).json({ 
        error: 'Query parameter "q" is required and must be at least 2 characters' 
      });
    }

    const trimmedQuery = q.trim();
    const searchLimit = Math.min(Math.max(parseInt(limit) || 6, 1), 10);

    // Create cache key
    const cacheKey = `search:${trimmedQuery.toLowerCase()}:${searchLimit}:${market || 'none'}`;
    
    // Check cache
    const cached = searchCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      return res.json(cached.data);
    }

    // Get client credentials token
    const token = await getClientCredentialsToken();

    // Build Spotify API URL
    const params = new URLSearchParams({
      q: trimmedQuery,
      type: 'track',
      limit: searchLimit.toString()
    });
    if (market) {
      params.append('market', market);
    }

    const spotifyResponse = await fetch(`https://api.spotify.com/v1/search?${params.toString()}`, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    if (!spotifyResponse.ok) {
      throw new Error(`Spotify API error: ${spotifyResponse.status}`);
    }

    const data = await spotifyResponse.json();

    // Map response to lightweight format
    const suggestions = data.tracks.items.map(track => ({
      id: track.id,
      name: track.name,
      artist: track.artists.map(artist => artist.name).join(', '),
      album: track.album.name,
      albumArt: track.album.images[0]?.url || null,
      duration: track.duration_ms,
      url: track.external_urls.spotify,
      previewUrl: track.preview_url
    }));

    const response = {
      suggestions,
      count: suggestions.length,
      query: trimmedQuery
    };

    // Cache the result
    searchCache.set(cacheKey, {
      data: response,
      expiresAt: Date.now() + CACHE_TTL
    });

    // Clean old cache entries (simple cleanup)
    if (searchCache.size > 100) {
      const now = Date.now();
      for (const [key, value] of searchCache.entries()) {
        if (now >= value.expiresAt) {
          searchCache.delete(key);
        }
      }
    }

    res.json(response);
  } catch (error) {
    console.error('Error searching tracks:', error);
    res.status(500).json({ error: 'Failed to search tracks', message: error.message });
  }
});

app.get('/api/getTrack', async (req, res) => {
  try {
    const { id, force } = req.query;

    // Validate track ID
    if (!id || typeof id !== 'string' || id.trim().length === 0) {
      return res.status(400).json({ 
        error: 'Query parameter "id" is required and must be a valid Spotify track ID' 
      });
    }

    const trackId = id.trim();
    const forceRefresh = force === 'true' || force === '1';

    // Create cache key
    const cacheKey = `track:${trackId}`;
    
    // Check cache (unless force refresh)
    if (!forceRefresh) {
      const cached = trackCache.get(cacheKey);
      if (cached && Date.now() < cached.expiresAt) {
        return res.json(cached.data);
      }
    }

    // Get client credentials token
    const token = await getClientCredentialsToken();

    // Call Spotify Get Track endpoint
    const spotifyResponse = await fetch(`https://api.spotify.com/v1/tracks/${trackId}`, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    if (!spotifyResponse.ok) {
      if (spotifyResponse.status === 404) {
        return res.status(404).json({ error: 'Track not found' });
      }
      throw new Error(`Spotify API error: ${spotifyResponse.status}`);
    }

    const track = await spotifyResponse.json();

    // Map to minimal metadata format
    const trackData = {
      id: track.id,
      name: track.name,
      artist: track.artists.map(artist => artist.name).join(', '),
      artistIds: track.artists.map(artist => artist.id),
      album: track.album.name,
      albumId: track.album.id,
      albumArt: track.album.images[0]?.url || null,
      duration: track.duration_ms,
      url: track.external_urls.spotify,
      uri: track.uri,
      previewUrl: track.preview_url,
      isrc: track.external_ids?.isrc || null,
      releaseDate: track.album.release_date,
      popularity: track.popularity,
      explicit: track.explicit,
      availableMarkets: track.available_markets?.length || 0
    };

    // Cache the result with 24h TTL
    trackCache.set(cacheKey, {
      data: trackData,
      expiresAt: Date.now() + TRACK_CACHE_TTL
    });

    // Clean old cache entries (simple cleanup)
    if (trackCache.size > 200) {
      const now = Date.now();
      for (const [key, value] of trackCache.entries()) {
        if (now >= value.expiresAt) {
          trackCache.delete(key);
        }
      }
    }

    res.json(trackData);
  } catch (error) {
    console.error('Error fetching track details:', error);
    res.status(500).json({ error: 'Failed to fetch track details', message: error.message });
  }
});

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

app.get('/api/last-played', async (req, res) => {
  try {
    const token = await getValidAccessToken();

    const response = await fetch('https://api.spotify.com/v1/me/player/recently-played?limit=1', {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    if (!response.ok) {
      throw new Error(`Spotify API error: ${response.status}`);
    }

    const data = await response.json();

    if (!data.items || data.items.length === 0) {
      return res.json({ message: 'No recently played tracks found' });
    }

    const lastPlayed = data.items[0];
    const song = {
      name: lastPlayed.track.name,
      artist: lastPlayed.track.artists.map(artist => artist.name).join(', '),
      album: lastPlayed.track.album.name,
      albumArt: lastPlayed.track.album.images[0]?.url || null,
      songUrl: lastPlayed.track.external_urls.spotify,
      playedAt: lastPlayed.played_at,
      playedAtTimestamp: new Date(lastPlayed.played_at).getTime()
    };

    res.json(song);
  } catch (error) {
    console.error('Error fetching last played song:', error);
    res.status(500).json({ error: 'Failed to fetch last played song', message: error.message });
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

app.post('/api/addTrack', async (req, res) => {
  try {
    const { track_id } = req.body;

    // Validate track_id
    if (!track_id || typeof track_id !== 'string' || track_id.trim().length === 0) {
      return res.status(400).json({ 
        error: 'track_id is required and must be a valid Spotify track ID' 
      });
    }

    const trackId = track_id.trim();
    const playlistId = '5iw7Tk89Q0p9a5waGqJFLG'; // Your specified playlist

    // Get valid access token (with refresh if needed)
    const token = await getValidAccessToken();

    // Construct Spotify track URI
    const trackUri = `spotify:track:${trackId}`;

    // Add track to playlist
    const spotifyResponse = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}/tracks`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        uris: [trackUri]
      })
    });

    if (!spotifyResponse.ok) {
      const errorData = await spotifyResponse.json();
      
      if (spotifyResponse.status === 404) {
        return res.status(404).json({ error: 'Playlist not found or track not found' });
      }
      if (spotifyResponse.status === 403) {
        return res.status(403).json({ error: 'Insufficient permissions to modify this playlist' });
      }
      
      throw new Error(`Spotify API error: ${spotifyResponse.status} - ${errorData.error?.message || 'Unknown error'}`);
    }

    const data = await spotifyResponse.json();

    // Return success response
    res.json({
      status: 'success',
      playlist_id: playlistId,
      snapshot_id: data.snapshot_id,
      added_track: {
        spotify_id: trackId,
        spotify_url: `https://open.spotify.com/track/${trackId}`,
        playlist_url: `https://open.spotify.com/playlist/${playlistId}`
      },
      message: 'Track successfully added to playlist'
    });

  } catch (error) {
    console.error('Error adding track to playlist:', error);
    res.status(500).json({ 
      error: 'Failed to add track to playlist', 
      message: error.message 
    });
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
          .post { color: #ffa500; }
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
            <code>GET /api/search?q=query</code> - Search for tracks (autocomplete)<br>
            <code>GET /api/getTrack?id=trackId</code> - Get full track details by ID<br>
            <code class="post">POST /api/addTrack</code> - Add track to playlist (body: {track_id})<br>
            <code>GET /api/now-playing</code> - Get currently playing song<br>
            <code>GET /api/recent-tracks</code> - Get recently played tracks<br>
            <code>GET /api/last-played</code> - Get last played song with timestamp<br>
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
  console.log(`  - http://localhost:${PORT}/api/search?q=query (Search for tracks - autocomplete)`);
  console.log(`  - http://localhost:${PORT}/api/getTrack?id=trackId (Get full track details by ID)`);
  console.log(`  - http://localhost:${PORT}/api/addTrack [POST] (Add track to playlist - body: {track_id})`);
  console.log(`  - http://localhost:${PORT}/api/now-playing (Get currently playing song)`);
  console.log(`  - http://localhost:${PORT}/api/recent-tracks (Get recently played tracks)`);
  console.log(`  - http://localhost:${PORT}/api/last-played (Get last played song with timestamp)`);
  console.log(`  - http://localhost:${PORT}/api/top-tracks (Get top 10 tracks)`);
  console.log(`  - http://localhost:${PORT}/api/top-artists (Get top 10 artists)`);
  console.log(`  - http://localhost:${PORT}/api/playlists (Get user playlists)`);
  console.log(`  - http://localhost:${PORT}/api/status (Check server status)\n`);
});
