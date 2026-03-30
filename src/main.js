const { app, BrowserWindow, ipcMain, screen } = require('electron');
const { execFile } = require('node:child_process');
const path = require('node:path');
const StoreModule = require('electron-store');

const Store = StoreModule.default || StoreModule;
const store = new Store({
  defaults: {
    opacity: 0.75,
    fontSize: 42,
    fontFamily: 'Inter, Arial, sans-serif',
    pollingMs: 3000
  }
});

let overlayWindow;
let settingsWindow;
let pollTimer;
let currentTrackCache = '';
let currentLyricsCache = null;

function createOverlayWindow() {
  const { width } = screen.getPrimaryDisplay().workAreaSize;

  overlayWindow = new BrowserWindow({
    width,
    height: 240,
    x: 0,
    y: 0,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js')
    }
  });

  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  overlayWindow.loadFile(path.join(__dirname, 'overlay.html'));

  overlayWindow.webContents.on('did-finish-load', () => {
    overlayWindow.webContents.send('settings:update', store.store);
  });
}

function createSettingsWindow() {
  settingsWindow = new BrowserWindow({
    width: 420,
    height: 460,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js')
    }
  });

  settingsWindow.loadFile(path.join(__dirname, 'settings.html'));

  settingsWindow.webContents.on('did-finish-load', () => {
    settingsWindow.webContents.send('settings:update', store.store);
  });
}

function runPowerShell(command) {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
      { timeout: 4000, windowsHide: true },
      (error, stdout) => {
        if (error) {
          resolve('');
          return;
        }
        resolve(stdout.trim());
      }
    );
  });
}

function normalizeArtist(artist) {
  if (!artist) return '';
  return String(artist)
    .replace(/\s+feat\..*/i, '')
    .replace(/\s+ft\..*/i, '')
    .trim();
}

function normalizeTrackTitle(title) {
  if (!title) return '';
  return String(title)
    .replace(/\s*\((remaster|live|version).*?\)$/i, '')
    .replace(/\s*\[(remaster|live|version).*?\]$/i, '')
    .trim();
}

async function getWindowsMediaSessions() {
  const psScript = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]
$manager = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync().GetAwaiter().GetResult()
if (-not $manager) {
  '[]'
  return
}
$list = @()
foreach ($session in $manager.GetSessions()) {
  $playback = $session.GetPlaybackInfo()
  if (-not $playback) { continue }

  $media = $session.TryGetMediaPropertiesAsync().GetAwaiter().GetResult()
  if (-not $media) { continue }

  $title = [string]$media.Title
  if ([string]::IsNullOrWhiteSpace($title)) { continue }

  $artist = [string]$media.Artist
  $source = [string]$session.SourceAppUserModelId
  $stateValue = [int]$playback.PlaybackStatus
  $stateText = [string]$playback.PlaybackStatus

  $list += [PSCustomObject]@{
    sourceApp = $source
    title = $title
    artist = $artist
    playbackStateValue = $stateValue
    playbackStateText = $stateText
  }
}
$list | ConvertTo-Json -Compress
`;

  const output = await runPowerShell(psScript);
  if (!output) return [];

  try {
    const parsed = JSON.parse(output);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === 'object') return [parsed];
  } catch {
    return [];
  }

  return [];
}

function isBrowserSource(sourceApp) {
  const normalized = String(sourceApp || '').toLowerCase();
  return ['chrome', 'msedge', 'firefox', 'opera', 'brave'].some((name) => normalized.includes(name));
}

function isPlayingTrack(track) {
  const text = String(track.playbackStateText || '').toLowerCase();
  const numeric = Number(track.playbackStateValue);
  return text.includes('playing') || numeric === 4;
}

function pickPreferredTrack(tracks) {
  const playableTracks = tracks.filter((track) => track.title && isPlayingTrack(track));
  const candidateTracks = playableTracks.length ? playableTracks : tracks.filter((track) => track.title);

  if (!candidateTracks.length) return null;

  const spotifyTrack = candidateTracks.find((track) =>
    String(track.sourceApp || '').toLowerCase().includes('spotify')
  );
  if (spotifyTrack) return spotifyTrack;

  const youtubeTrack = candidateTracks.find((track) => {
    const loweredTitle = String(track.title || '').toLowerCase();
    return loweredTitle.includes('youtube') || isBrowserSource(track.sourceApp);
  });

  return youtubeTrack || candidateTracks[0];
}

async function getActiveTrack() {
  const sessions = await getWindowsMediaSessions();
  if (!sessions.length) return null;

  const track = pickPreferredTrack(sessions);
  if (!track) return null;

  return {
    sourceApp: track.sourceApp || '',
    title: normalizeTrackTitle(track.title),
    artist: normalizeArtist(track.artist),
    rawTitle: track.title || '',
    rawArtist: track.artist || ''
  };
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) return null;
  return response.json();
}

function lyricsFromPayload(payload) {
  if (!payload) return null;
  const text = payload.plainLyrics || payload.syncedLyrics;
  if (!text) return null;

  return {
    text,
    source: 'LRCLIB'
  };
}

async function fetchLyrics(track) {
  const primaryQuery = new URLSearchParams({ track_name: track.title });
  if (track.artist) {
    primaryQuery.set('artist_name', track.artist);
  }

  const primaryPayload = await fetchJson(`https://lrclib.net/api/get?${primaryQuery.toString()}`);
  const primaryLyrics = lyricsFromPayload(primaryPayload);
  if (primaryLyrics) return primaryLyrics;

  const searchQuery = new URLSearchParams({ track_name: track.title });
  if (track.artist) {
    searchQuery.set('artist_name', track.artist);
  }

  const searchPayload = await fetchJson(`https://lrclib.net/api/search?${searchQuery.toString()}`);
  if (!Array.isArray(searchPayload)) return null;

  for (const candidate of searchPayload) {
    const lyrics = lyricsFromPayload(candidate);
    if (lyrics) return lyrics;
  }

  return null;
}

async function pushLyricsUpdate() {
  if (!overlayWindow) return;

  const track = await getActiveTrack();
  if (!track) {
    overlayWindow.webContents.send('lyrics:update', {
      status: 'idle',
      title: 'No active Spotify/YouTube media detected',
      body: 'Start playback in Spotify or a browser tab with media controls enabled.'
    });
    return;
  }

  const displayArtist = track.artist || track.rawArtist || 'Unknown artist';
  const displayTitle = track.title || track.rawTitle || 'Unknown title';
  const trackKey = `${track.sourceApp}:${displayArtist}:${displayTitle}`;

  if (trackKey === currentTrackCache && currentLyricsCache) {
    overlayWindow.webContents.send('lyrics:update', currentLyricsCache);
    return;
  }

  currentTrackCache = trackKey;
  overlayWindow.webContents.send('lyrics:update', {
    status: 'loading',
    title: `${displayArtist} — ${displayTitle}`,
    body: 'Fetching lyrics...'
  });

  let lyrics;
  try {
    lyrics = await fetchLyrics(track);
  } catch {
    lyrics = null;
  }

  currentLyricsCache = lyrics
    ? {
        status: 'ok',
        title: `${displayArtist} — ${displayTitle}`,
        body: lyrics.text,
        source: lyrics.source
      }
    : {
        status: 'missing',
        title: `${displayArtist} — ${displayTitle}`,
        body: 'No lyrics found. Try another track.'
      };

  overlayWindow.webContents.send('lyrics:update', currentLyricsCache);
}

function startPolling() {
  clearInterval(pollTimer);
  const pollingMs = Math.max(1000, Number(store.get('pollingMs')) || 3000);
  pushLyricsUpdate();
  pollTimer = setInterval(pushLyricsUpdate, pollingMs);
}

ipcMain.handle('settings:get', () => store.store);
ipcMain.handle('settings:set', (_event, key, value) => {
  store.set(key, value);

  if (key === 'pollingMs') {
    startPolling();
  }

  if (overlayWindow) {
    overlayWindow.webContents.send('settings:update', store.store);
  }

  if (settingsWindow) {
    settingsWindow.webContents.send('settings:update', store.store);
  }

  return store.store;
});

app.whenReady().then(() => {
  createOverlayWindow();
  createSettingsWindow();
  startPolling();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createOverlayWindow();
      createSettingsWindow();
      startPolling();
    }
  });
});

app.on('window-all-closed', () => {
  clearInterval(pollTimer);
  app.quit();
});
