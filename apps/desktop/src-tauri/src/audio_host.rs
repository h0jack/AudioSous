use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::UNIX_EPOCH;

use crate::bundle;
use audiosous_audio::{proxy_file_name, Engine, EngineStatus, LoadedTrack};
use serde::Deserialize;

pub struct AudioHost {
    pub engine: Arc<Engine>,
}

impl AudioHost {
    pub fn new() -> Self {
        Self {
            engine: Arc::new(Engine::start()),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioLoadTrack {
    pub id: String,
    pub label: String,
    pub relative_path: String,
    pub gain_db: f32,
    pub pan: f32,
    pub muted: bool,
    pub solo: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioLoadRequest {
    pub project_file: String,
    pub tracks: Vec<AudioLoadTrack>,
}

pub fn engine_kind() -> &'static str {
    match std::env::var("AUDIOSOUS_AUDIO_ENGINE") {
        Ok(value) if value.eq_ignore_ascii_case("legacy") => "legacy",
        _ => "native",
    }
}

pub fn load_project(host: &AudioHost, request: AudioLoadRequest) -> Result<(), String> {
    let project = PathBuf::from(&request.project_file);
    let bundle = bundle::bundle_dir_for(&project)?;
    let bundle = bundle.canonicalize().map_err(|error| error.to_string())?;
    let cache = bundle.join("cache").join("playback");
    fs::create_dir_all(&cache).map_err(|error| error.to_string())?;
    let cache = cache.canonicalize().map_err(|error| error.to_string())?;
    if !cache.starts_with(&bundle) {
        return Err("Playback cache escapes the project.".into());
    }
    let mut tracks = Vec::with_capacity(request.tracks.len());
    for track in request.tracks {
        let proxy = cache.join(proxy_file_name(&track.id)?);
        let source = bundle::resolve_project_media_file(&project, &track.relative_path)?;
        let meta = fs::metadata(&source).map_err(|error| error.to_string())?;
        let modified_ns = meta
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| u64::try_from(duration.as_nanos()).unwrap_or(u64::MAX))
            .unwrap_or(0);
        tracks.push(LoadedTrack {
            id: track.id,
            label: track.label,
            source_path: source,
            proxy_path: proxy,
            source_size: meta.len(),
            source_modified_ns: modified_ns,
            gain_db: track.gain_db,
            pan: track.pan,
            muted: track.muted,
            solo: track.solo,
        });
    }
    host.engine.load(tracks)
}

pub fn status(host: &AudioHost) -> EngineStatus {
    host.engine.status()
}
