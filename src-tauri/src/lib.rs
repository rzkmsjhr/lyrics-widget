use serde::Serialize;

#[derive(Serialize, Clone, Debug)]
struct TrackInfo {
    title: String,
    artist: String,
    progress_ms: i64,
}

/// Reads the current playing track from Windows System Media Transport Controls.
/// This works with Spotify Free, no OAuth or Premium required.
#[tauri::command]
async fn get_current_track() -> Result<Option<TrackInfo>, String> {
    get_current_track_impl()
}

#[cfg(target_os = "windows")]
fn get_current_track_impl() -> Result<Option<TrackInfo>, String> {
    use windows::Media::Control::{
        GlobalSystemMediaTransportControlsSessionManager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus,
    };

    // Get the session manager (blocks until ready)
    let manager = GlobalSystemMediaTransportControlsSessionManager::RequestAsync()
        .map_err(|e| e.to_string())?
        .get()
        .map_err(|e| e.to_string())?;

    // Get the currently active media session
    let session = match manager.GetCurrentSession() {
        Ok(s) => s,
        Err(_) => return Ok(None), // nothing playing
    };

    // Only report if actually playing (not paused/stopped)
    let playback_info = session.GetPlaybackInfo().map_err(|e| e.to_string())?;
    let status = playback_info.PlaybackStatus().map_err(|e| e.to_string())?;
    if status != GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing {
        return Ok(None);
    }

    // Get track title and artist
    let media_props = session
        .TryGetMediaPropertiesAsync()
        .map_err(|e| e.to_string())?
        .get()
        .map_err(|e| e.to_string())?;

    let title = media_props.Title().map_err(|e| e.to_string())?.to_string();
    let artist = media_props.Artist().map_err(|e| e.to_string())?.to_string();

    // Get playback position (TimeSpan.Duration is in 100-nanosecond intervals)
    let timeline = session.GetTimelineProperties().map_err(|e| e.to_string())?;
    let position = timeline.Position().map_err(|e| e.to_string())?;
    let progress_ms = position.Duration / 10_000;

    Ok(Some(TrackInfo {
        title,
        artist,
        progress_ms,
    }))
}

#[cfg(not(target_os = "windows"))]
fn get_current_track_impl() -> Result<Option<TrackInfo>, String> {
    Ok(None) // SMTC is Windows-only
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![get_current_track])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
