use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use audiosous_audio::{check_mix, MixCheck, MixSectionSpec, MixVariantSpec};
use serde::Deserialize;

use crate::{bundle, dynamics_check};

/// Most audio one whole-mix check renders per variant, seconds.
const MAX_SECONDS: f64 = 90.0;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MixCheckTrack {
    pub track_id: String,
    pub relative_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MixCheckRequest {
    pub tracks: Vec<MixCheckTrack>,
    pub variants: Vec<MixVariantSpec>,
    pub windows: Vec<(f64, f64)>,
    pub sections: Vec<MixSectionSpec>,
    pub duration_seconds: f64,
}

/// Renders Current and the full-mix candidate from the playback proxies through the native DSP, over the
/// request's windows (at most `MAX_SECONDS`), and measures each.
pub fn check(project_file: &str, request: MixCheckRequest) -> Result<Vec<MixCheck>, String> {
    let project = PathBuf::from(project_file);
    let bundle = bundle::bundle_dir_for(&project)?.canonicalize().map_err(|error| error.to_string())?;
    let cache = bundle.join("cache").join("playback");
    fs::create_dir_all(&cache).map_err(|error| error.to_string())?;
    let paths: HashMap<String, String> = request.tracks.into_iter().map(|track| (track.track_id, track.relative_path)).collect();
    let mut proxies: HashMap<String, PathBuf> = HashMap::new();
    for (track_id, relative_path) in &paths {
        proxies.insert(track_id.clone(), dynamics_check::proxy_for(&project, &cache, track_id, relative_path)?);
    }
    let mut windows = audiosous_audio::merge_windows(&request.windows, request.duration_seconds);
    let mut budget = MAX_SECONDS;
    windows.retain_mut(|window| {
        if budget <= 0.0 {
            return false;
        }
        window.1 = window.1.min(window.0 + budget);
        budget -= window.1 - window.0;
        true
    });
    check_mix(&request.variants, &windows, &request.sections, request.duration_seconds, |track_id| {
        proxies.get(track_id).cloned().ok_or_else(|| format!("No playback proxy for track {track_id}."))
    })
}
