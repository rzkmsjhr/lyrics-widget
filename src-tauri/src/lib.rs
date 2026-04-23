use serde::Serialize;

#[derive(Serialize, Clone, Debug)]
struct TrackInfo {
    title: String,
    artist: String,
    progress_ms: i64,
}

// We change the main command to async to support cross-platform libraries
#[tauri::command]
async fn get_current_track() -> Result<Option<TrackInfo>, String> {
    get_current_track_impl().await
}

#[cfg(target_os = "windows")]
async fn get_current_track_impl() -> Result<Option<TrackInfo>, String> {
    use windows::Media::Control::{
        GlobalSystemMediaTransportControlsSessionManager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus,
    };

    let manager = GlobalSystemMediaTransportControlsSessionManager::RequestAsync()
        .map_err(|e| e.to_string())?
        .get()
        .map_err(|e| e.to_string())?;

    let session = match manager.GetCurrentSession() {
        Ok(s) => s,
        Err(_) => return Ok(None),
    };

    let playback_info = session.GetPlaybackInfo().map_err(|e| e.to_string())?;
    let status = playback_info.PlaybackStatus().map_err(|e| e.to_string())?;
    if status != GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing {
        return Ok(None);
    }

    let media_props = session
        .TryGetMediaPropertiesAsync()
        .map_err(|e| e.to_string())?
        .get()
        .map_err(|e| e.to_string())?;

    let title = media_props.Title().map_err(|e| e.to_string())?.to_string();
    let artist = media_props.Artist().map_err(|e| e.to_string())?.to_string();

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
async fn get_current_track_impl() -> Result<Option<TrackInfo>, String> {
    use nowhear::{MediaSourceBuilder, PlaybackState};
    let source = MediaSourceBuilder::new()
        .build()
        .await
        .map_err(|e| e.to_string())?;
        
    let players = source.list_players().await.map_err(|e| e.to_string())?;
    
    if let Some(player_name) = players.first() {
        let info = source.get_player(player_name).await.map_err(|e| e.to_string())?;
        let is_playing = match info.playback_state {
            PlaybackState::Playing => true,
            _ => false,
        };

        if is_playing {
            if let Some(track) = info.current_track {
                return Ok(Some(TrackInfo {
                    title: track.title,
                    artist: track.artist.join(", "),
                    progress_ms: 0, 
                }));
            }
        }
    }
    
    Ok(None)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![get_current_track])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}