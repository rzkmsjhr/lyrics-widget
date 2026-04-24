# 🎵 Floating Lyrics Widget

A native, cross-platform desktop widget that displays real-time, perfectly synced lyrics for whatever you're listening to. Built with Tauri, React, and Rust.

Unlike standard lyric apps that only link to specific desktop players, this widget hooks directly into your operating system's native media controls. This means it seamlessly works with **Spotify, YouTube Music, Apple Music, and web browsers** out of the box.

## ✨ Features

* **Universal Media Tracking:** Captures music from desktop apps and browsers using native OS integrations (Windows SMTC, macOS MediaRemote, and Linux MPRIS).
* **Smart Lyric Fetching:** Uses a custom "Global Fuzzy Net" algorithm to bypass messy metadata, localized artist names, and "feat." tags to consistently find the right lyrics via `lrclib.net`.
* **Auto-Romanization:** Automatically detects Japanese and Korean characters and generates real-time Romaji and Hangul translations.
* **Transparent Overlay:** Sits beautifully on your desktop without getting in the way of your workflow.

## 📥 Download & Installation

Head over to the [Releases](../../releases) page to download the latest version for your operating system.

### 🍎 macOS
Download the `.dmg` file for your architecture (Apple Silicon `aarch64` or Intel `x86_64`). 

**Note on Installation:** Because this is an open-source app, macOS Gatekeeper may warn you that the app is "damaged" or from an unidentified developer. To fix this:
1. Open the `.dmg` and drag the `my-lyrics-widget` app into your **Applications** folder.
2. Open your Terminal and run this command to remove the quarantine flag:
   ```bash
   xattr -cr /Applications/my-lyrics-widget.app
