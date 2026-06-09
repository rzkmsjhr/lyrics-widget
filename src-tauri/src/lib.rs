use serde::Serialize;
#[cfg(not(target_os = "windows"))]
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
#[cfg(not(target_os = "windows"))]
use cpal::FromSample;
use lazy_static::lazy_static;
use std::sync::{Arc, Mutex};

lazy_static! {
    static ref CURRENT_DB: Arc<Mutex<f32>> = Arc::new(Mutex::new(0.0));
}
#[derive(Serialize, Clone, Debug)]
struct TrackInfo {
    title: String,
    artist: String,
    progress_ms: i64,
}

#[tauri::command]
async fn get_current_track() -> Result<Option<TrackInfo>, String> {
    get_current_track_impl().await
}

#[tauri::command]
fn get_microphone_db() -> f32 {
    get_microphone_db_impl()
}

#[cfg(not(target_os = "windows"))]
fn get_microphone_db_impl() -> f32 {
    let db = CURRENT_DB.lock().unwrap();
    *db
}

#[cfg(not(target_os = "windows"))]
fn start_audio_monitor() {
    std::thread::spawn(|| {
        let host = cpal::default_host();
        let device = match host.default_input_device() {
            Some(device) => device,
            None => {
                println!("Failed to get default input device");
                return;
            }
        };

        let config = match device.default_input_config() {
            Ok(config) => config,
            Err(e) => {
                println!("Failed to get default input config: {}", e);
                return;
            }
        };

        let stream = match config.sample_format() {
            cpal::SampleFormat::F32 => run_stream::<f32>(&device, &config.into()),
            cpal::SampleFormat::I16 => run_stream::<i16>(&device, &config.into()),
            cpal::SampleFormat::U16 => run_stream::<u16>(&device, &config.into()),
            _ => return,
        };

        match stream {
            Ok(s) => {
                let _ = s.play();
                loop {
                    std::thread::sleep(std::time::Duration::from_secs(3600));
                }
            }
            Err(e) => println!("Error running stream: {}", e),
        }
    });
}

#[cfg(not(target_os = "windows"))]
fn run_stream<T>(device: &cpal::Device, config: &cpal::StreamConfig) -> Result<cpal::Stream, cpal::BuildStreamError>
where
    T: cpal::Sample + cpal::SizedSample,
    f32: cpal::FromSample<T>,
{
    let err_fn = |err| eprintln!("an error occurred on stream: {}", err);

    device.build_input_stream(
        config,
        move |data: &[T], _: &cpal::InputCallbackInfo| {
            let mut sum_squares = 0.0;
            for sample in data {
                let sample_f32 = f32::from_sample_(*sample);
                sum_squares += sample_f32 * sample_f32;
            }
            let rms = if data.is_empty() { 0.0 } else { (sum_squares / (data.len() as f32)).sqrt() };
            let dbfs = 20.0 * (rms + 1e-6).log10();
            
            let calibrated_db = dbfs + 100.0;
            let final_db = calibrated_db.max(0.0).min(120.0);
            
            if let Ok(mut db) = CURRENT_DB.lock() {
                *db = final_db;
            }
        },
        err_fn,
        None,
    )
}

// ─── WINDOWS IMPLEMENTATION ──────────────────────────────────────────────
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

#[cfg(target_os = "windows")]
fn get_microphone_db_impl() -> f32 {
    use windows::Win32::Media::Audio::{eRender, eMultimedia, IMMDeviceEnumerator, MMDeviceEnumerator};
    use windows::Win32::Media::Audio::Endpoints::{IAudioMeterInformation, IAudioEndpointVolume};
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED, CLSCTX_ALL, CoCreateInstance};

    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        
        let enumerator: Result<IMMDeviceEnumerator, _> = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL);
        if let Ok(enumerator) = enumerator {
            if let Ok(device) = enumerator.GetDefaultAudioEndpoint(eRender, eMultimedia) {
                if let Ok(meter) = device.Activate::<IAudioMeterInformation>(CLSCTX_ALL, None) {
                    if let Ok(volume_ctrl) = device.Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None) {
                        if let (Ok(peak), Ok(master_vol)) = (meter.GetPeakValue(), volume_ctrl.GetMasterVolumeLevelScalar()) {
                            if master_vol < 0.001 || peak < 0.0001 {
                                return 0.0;
                            }
                            let peak_db = 20.0 * peak.log10();
                            let base_volume_db = 40.0 + (master_vol.powf(0.7) * 90.0);
                            let final_db = (base_volume_db + peak_db).max(0.0).min(130.0);
                            return final_db;
                        }
                    }
                }
            }
        }
    }
    0.0
}

// ─── LINUX IMPLEMENTATION ────────────────────────────────────────────────
#[cfg(target_os = "linux")]
async fn get_current_track_impl() -> Result<Option<TrackInfo>, String> {
    use nowhear::{MediaSource, MediaSourceBuilder, PlaybackState};
    
    let source = MediaSourceBuilder::new().build().await.map_err(|e| e.to_string())?;
    let players = source.list_players().await.map_err(|e| e.to_string())?;
    
    if let Some(player_name) = players.first() {
        let info = source.get_player(player_name).await.map_err(|e| e.to_string())?;
        
        let is_playing = match info.playback_state {
            PlaybackState::Playing => true,
            _ => false,
        };

        if is_playing {
            if let Some(track) = info.current_track {
                let progress_ms = info.position.map(|p| p.as_millis() as i64).unwrap_or(0);

                return Ok(Some(TrackInfo {
                    title: track.title,
                    artist: track.artist.join(", "),
                    progress_ms, 
                }));
            }
        }
    }
    Ok(None)
}

// ─── MACOS IMPLEMENTATION ────────────────────────────────────────────────
#[cfg(target_os = "macos")]
async fn get_current_track_impl() -> Result<Option<TrackInfo>, String> {
    use mediaremote_rs::{get_now_playing, is_playing};
   
    if is_playing() {
        if let Some(info) = get_now_playing() {
            let progress_ms = info.elapsed_time.map(|s| (s * 1000.0) as i64).unwrap_or(0);

            return Ok(Some(TrackInfo {
                title: info.title,
                artist: info.artist.unwrap_or_default(),
                progress_ms,
            }));
        }
    }
    
    Ok(None)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(not(target_os = "windows"))]
    start_audio_monitor();
    
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![get_current_track, get_microphone_db])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}