# SpotifyOverlay

A Windows 11 desktop lyrics overlay that stays **always on top**, including fullscreen apps/games, and shows lyrics for tracks currently playing from Spotify or YouTube/browser media sessions.

## Main goals implemented

- Always-on-top transparent lyrics layer.
- Lyrics opacity control.
- Font family and font size control.

## How it works (Windows 11)

1. The app polls active media sessions from **Windows System Media Transport Controls** (GSMTC) via PowerShell.
2. It picks the active playing source (Spotify preferred, YouTube/browser fallback).
3. It fetches lyrics from [lrclib.net](https://lrclib.net/) using title + artist.
4. Overlay updates in near real-time.

## Setup

### 1) Install dependencies

```bash
npm install
```

### 2) Run on Windows 11

```bash
npm start
```

## Usage

- A transparent overlay appears at the top of the screen.
- A settings window lets you tune:
  - Opacity
  - Font size
  - Font family
  - Polling interval

## Notes / next improvements

- Add per-line timed lyric highlighting (karaoke mode) when synced lyrics are available.
- Add draggable overlay position and multi-monitor placement.
- Add click-through toggle hotkey.
- Add packaging/signing with `electron-builder` for Windows release installs.
