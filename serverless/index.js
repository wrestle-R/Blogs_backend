// Cloudflare Worker for Spotify Integration

// In-memory token cache (will reset on worker restart)
let tokenCache = {
  accessToken: null,
  tokenExpiresAt: null
};

// Client Credentials token cache for search
let clientCredentialsCache = {
  accessToken: null,
  tokenExpiresAt: null
};

// Simple in-memory cache for search results
const searchCache = new Map();
const CACHE_TTL = 120000; // 120 seconds

// Cache for track details (longer TTL)
const trackCache = new Map();
const TRACK_CACHE_TTL = 86400000; // 24 hours

// Helper function to refresh access token
async function refreshAccessToken(env) {
  const CLIENT_ID = env.CLIENT_ID;
  const CLIENT_SECRET = env.CLIENT_SECRET;
  const REFRESH_TOKEN = env.REFRESH_TOKEN;

  if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
    throw new Error('Missing required environment variables: CLIENT_ID, CLIENT_SECRET, or REFRESH_TOKEN');
  }

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
async function getValidAccessToken(env) {
  if (!tokenCache.accessToken || (tokenCache.tokenExpiresAt && Date.now() >= tokenCache.tokenExpiresAt - 60000)) {
    await refreshAccessToken(env);
  }
  return tokenCache.accessToken;
}

// Get Client Credentials token for public API access (search)
async function getClientCredentialsToken(env) {
  if (clientCredentialsCache.accessToken && clientCredentialsCache.tokenExpiresAt && Date.now() < clientCredentialsCache.tokenExpiresAt - 60000) {
    return clientCredentialsCache.accessToken;
  }

  const CLIENT_ID = env.CLIENT_ID;
  const CLIENT_SECRET = env.CLIENT_SECRET;

  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error('Missing required environment variables: CLIENT_ID or CLIENT_SECRET');
  }

  const authString = btoa(`${CLIENT_ID}:${CLIENT_SECRET}`);
  
  const authOptions = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${authString}`
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials'
    })
  };

  try {
    const response = await fetch('https://accounts.spotify.com/api/token', authOptions);
    const data = await response.json();

    if (response.ok) {
      clientCredentialsCache.accessToken = data.access_token;
      clientCredentialsCache.tokenExpiresAt = Date.now() + (data.expires_in * 1000);
      return clientCredentialsCache.accessToken;
    } else {
      throw new Error('Failed to get client credentials token');
    }
  } catch (error) {
    console.error('Error getting client credentials token:', error);
    throw error;
  }
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
async function handleSearch(env, url) {
  try {
    const urlParams = new URL(url).searchParams;
    const q = urlParams.get('q');
    const limit = urlParams.get('limit') || '6';
    const market = urlParams.get('market');

    // Validate query
    if (!q || q.trim().length < 2) {
      return jsonResponse({ 
        error: 'Query parameter "q" is required and must be at least 2 characters' 
      }, 400);
    }

    const trimmedQuery = q.trim();
    const searchLimit = Math.min(Math.max(parseInt(limit) || 6, 1), 10);

    // Create cache key
    const cacheKey = `search:${trimmedQuery.toLowerCase()}:${searchLimit}:${market || 'none'}`;
    
    // Check cache
    const cached = searchCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      return jsonResponse(cached.data);
    }

    // Get client credentials token
    const token = await getClientCredentialsToken(env);

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

    return jsonResponse(response);
  } catch (error) {
    console.error('Error searching tracks:', error);
    return jsonResponse({ error: 'Failed to search tracks', message: error.message }, 500);
  }
}

async function handleGetTrack(env, url) {
  try {
    const urlParams = new URL(url).searchParams;
    const id = urlParams.get('id');
    const force = urlParams.get('force');

    // Validate track ID
    if (!id || typeof id !== 'string' || id.trim().length === 0) {
      return jsonResponse({ 
        error: 'Query parameter "id" is required and must be a valid Spotify track ID' 
      }, 400);
    }

    const trackId = id.trim();
    const forceRefresh = force === 'true' || force === '1';

    // Create cache key
    const cacheKey = `track:${trackId}`;
    
    // Check cache (unless force refresh)
    if (!forceRefresh) {
      const cached = trackCache.get(cacheKey);
      if (cached && Date.now() < cached.expiresAt) {
        return jsonResponse(cached.data);
      }
    }

    // Get client credentials token
    const token = await getClientCredentialsToken(env);

    // Call Spotify Get Track endpoint
    const spotifyResponse = await fetch(`https://api.spotify.com/v1/tracks/${trackId}`, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    if (!spotifyResponse.ok) {
      if (spotifyResponse.status === 404) {
        return jsonResponse({ error: 'Track not found' }, 404);
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

    return jsonResponse(trackData);
  } catch (error) {
    console.error('Error fetching track details:', error);
    return jsonResponse({ error: 'Failed to fetch track details', message: error.message }, 500);
  }
}

async function handlePreview(env, trackId) {
  try {
    // Validate track ID
    if (!trackId || trackId.trim().length === 0) {
      return jsonResponse({ 
        error: 'Track ID is required in the URL path' 
      }, 400);
    }

    const cleanTrackId = trackId.trim();

    // Get client credentials token
    const token = await getClientCredentialsToken(env);

    // Fetch track from Spotify API
    const spotifyResponse = await fetch(`https://api.spotify.com/v1/tracks/${cleanTrackId}`, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    if (!spotifyResponse.ok) {
      if (spotifyResponse.status === 404) {
        return jsonResponse({ error: 'Track not found' }, 404);
      }
      throw new Error(`Spotify API error: ${spotifyResponse.status}`);
    }

    const trackData = await spotifyResponse.json();

    // Return only the preview URL
    return jsonResponse({ 
      preview_url: trackData.preview_url 
    });

  } catch (error) {
    console.error('Error fetching preview URL:', error);
    return jsonResponse({ 
      error: 'Failed to fetch preview URL', 
      message: error.message 
    }, 500);
  }
}

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

async function handleLastPlayed(env) {
  try {
    const token = await getValidAccessToken(env);

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
      return jsonResponse({ message: 'No recently played tracks found' });
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

    return jsonResponse(song);
  } catch (error) {
    console.error('Error fetching last played song:', error);
    return jsonResponse({ error: 'Failed to fetch last played song', message: error.message }, 500);
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

async function handleGetPlaylistTracks(env, url) {
  try {
    const urlParams = new URL(url).searchParams;
    const playlistId = urlParams.get('id') || env.PLAYLIST_ID || '5iw7Tk89Q0p9a5waGqJFLG';
    const limit = urlParams.get('limit') || '50';
    const offset = urlParams.get('offset') || '0';

    // Get client credentials token (public endpoint)
    const token = await getClientCredentialsToken(env);

    // Fetch playlist tracks
    const response = await fetch(
      `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=${limit}&offset=${offset}`,
      {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      }
    );

    if (!response.ok) {
      if (response.status === 404) {
        return jsonResponse({ error: 'Playlist not found' }, 404);
      }
      throw new Error(`Spotify API error: ${response.status}`);
    }

    const data = await response.json();

    // Map tracks to a clean format
    const tracks = data.items
      .filter(item => item.track) // Filter out null tracks
      .map(item => ({
        id: item.track.id,
        name: item.track.name,
        artist: item.track.artists.map(artist => artist.name).join(', '),
        artistIds: item.track.artists.map(artist => artist.id),
        album: item.track.album.name,
        albumId: item.track.album.id,
        albumArt: item.track.album.images[0]?.url || null,
        duration: item.track.duration_ms,
        url: item.track.external_urls.spotify,
        uri: item.track.uri,
        previewUrl: item.track.preview_url,
        addedAt: item.added_at,
        addedBy: item.added_by?.id || null,
        isLocal: item.is_local,
        popularity: item.track.popularity,
        explicit: item.track.explicit
      }));

    return jsonResponse({
      playlistId,
      tracks,
      total: data.total,
      limit: parseInt(limit),
      offset: parseInt(offset),
      next: data.next,
      previous: data.previous
    });
  } catch (error) {
    console.error('Error fetching playlist tracks:', error);
    return jsonResponse({ error: 'Failed to fetch playlist tracks', message: error.message }, 500);
  }
}

async function handleAddTrack(env, request) {
  try {
    // Parse request body
    const body = await request.json();
    const { track_id } = body;

    // Validate track_id
    if (!track_id || typeof track_id !== 'string' || track_id.trim().length === 0) {
      return jsonResponse({ 
        error: 'track_id is required and must be a valid Spotify track ID' 
      }, 400);
    }

    const trackId = track_id.trim();
    const playlistId = env.PLAYLIST_ID || '5iw7Tk89Q0p9a5waGqJFLG'; // Use env var or fallback

    if (!playlistId) {
      return jsonResponse({ 
        error: 'PLAYLIST_ID environment variable is not configured' 
      }, 500);
    }

    // Get valid access token (with refresh if needed)
    const token = await getValidAccessToken(env);

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
        return jsonResponse({ error: 'Playlist not found or track not found' }, 404);
      }
      if (spotifyResponse.status === 403) {
        return jsonResponse({ error: 'Insufficient permissions to modify this playlist' }, 403);
      }
      
      throw new Error(`Spotify API error: ${spotifyResponse.status} - ${errorData.error?.message || 'Unknown error'}`);
    }

    const data = await spotifyResponse.json();

    // Return success response
    return jsonResponse({
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
    return jsonResponse({ 
      error: 'Failed to add track to playlist', 
      message: error.message 
    }, 500);
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
          .post { color: #ffa500; }
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
            <code>GET /api/search?q=query</code> - Search for tracks (autocomplete)<br>
            <code>GET /api/getTrack?id=trackId</code> - Get full track details by ID<br>
            <code>GET /api/preview/:id</code> - Get preview URL for a track by ID<br>
            <code>GET /api/playlist-tracks?id=playlistId</code> - Get all tracks from playlist<br>
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
    } else if (path === '/api/search') {
      return handleSearch(env, request.url);
    } else if (path === '/api/getTrack') {
      return handleGetTrack(env, request.url);
    } else if (path.startsWith('/api/preview/')) {
      const trackId = path.replace('/api/preview/', '');
      return handlePreview(env, trackId);
    } else if (path === '/api/playlist-tracks') {
      return handleGetPlaylistTracks(env, request.url);
    } else if (path === '/api/addTrack' && request.method === 'POST') {
      return handleAddTrack(env, request);
    } else if (path === '/api/now-playing') {
      return handleNowPlaying(env);
    } else if (path === '/api/recent-tracks') {
      return handleRecentTracks(env);
    } else if (path === '/api/last-played') {
      return handleLastPlayed(env);
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
