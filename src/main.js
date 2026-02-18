const { app, BrowserWindow, ipcMain, screen } = require('electron');
const { execFile } = require('node:child_process');
const path = require('node:path');
const Store = require('electron-store');

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
      { timeout: 2000 },
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

async function getWindowsMediaSessions() {
  const psScript = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]
$manager = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync().GetAwaiter().GetResult()
if (-not $manager) { return }
foreach ($session in $manager.GetSessions()) {
  $playback = $session.GetPlaybackInfo()
  if (-not $playback) { continue }
  $status = [string]$playback.PlaybackStatus
  $media = $session.TryGetMediaPropertiesAsync().GetAwaiter().GetResult()
  if (-not $media) { continue }
  $source = $session.SourceAppUserModelId
  $title = $media.Title
  $artist = $media.Artist
  if ([string]::IsNullOrWhiteSpace($title)) { continue }
  Write-Output "$source|$title|$artist|$status"
}
`;

  return runPowerShell(psScript);
}

function parseTrackLine(line) {
  const [sourceApp, title, artist, status] = line.split('|');
  return {
    sourceApp: sourceApp || '',
    title: title || '',
    artist: artist || '',
    status: status || ''
  };
}

function isBrowserSource(sourceApp) {
  const normalized = sourceApp.toLowerCase();
  return ['chrome', 'msedge', 'firefox', 'opera', 'brave'].some((name) => normalized.includes(name));
}

function pickPreferredTrack(lines) {
  const tracks = lines
    .map(parseTrackLine)
    .filter((track) => track.status === 'Playing' && track.title);

  if (!tracks.length) return null;

  const spotifyTrack = tracks.find((track) => track.sourceApp.toLowerCase().includes('spotify'));
  if (spotifyTrack) return spotifyTrack;

  const youtubeTrack = tracks.find((track) => {
    const loweredTitle = track.title.toLowerCase();
    return loweredTitle.includes('youtube') || (isBrowserSource(track.sourceApp) && loweredTitle.includes(' - '));
  });

  return youtubeTrack || tracks[0];
}

async function getActiveTrack() {
  const output = await getWindowsMediaSessions();
  if (!output) return null;

  const lines = output.split('\n').filter(Boolean);
  return pickPreferredTrack(lines);
}

async function fetchLyrics(track) {
  const query = new URLSearchParams({
    track_name: track.title,
    artist_name: track.artist
  });

  const response = await fetch(`https://lrclib.net/api/get?${query.toString()}`);
  if (!response.ok) return null;

  const payload = await response.json();
  const text = payload?.plainLyrics || payload?.syncedLyrics;
  if (!text) return null;

  return {
    text,
    source: 'LRCLIB'
  };
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

  const trackKey = `${track.sourceApp}:${track.artist}:${track.title}`;
  if (trackKey === currentTrackCache && currentLyricsCache) {
    overlayWindow.webContents.send('lyrics:update', currentLyricsCache);
    return;
  }

  currentTrackCache = trackKey;
  overlayWindow.webContents.send('lyrics:update', {
    status: 'loading',
    title: `${track.artist} — ${track.title}`,
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
        title: `${track.artist} — ${track.title}`,
        body: lyrics.text,
        source: lyrics.source
      }
    : {
        status: 'missing',
        title: `${track.artist} — ${track.title}`,
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
