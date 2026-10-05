use std::fs;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::time::UNIX_EPOCH;

use audiosous_audio::{check_spatial, ensure_proxy, proxy_file_name, FilterSpec, SpatialCheck, SpatialParams};
use serde::{Deserialize, Serialize};

use crate::bundle;

/// Longest stretch of proxy audio read for one recommendation.
const MAX_SECONDS: f64 = 20.0;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StereoFramesRequest {
    pub track_id: String,
    pub relative_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StereoFramesResponse {
    pub track_id: String,
    pub json: Option<String>,
    pub error: Option<String>,
}

/// Stereo frames for spatial planning, from `cache/analysis/<trackId>__stereo.json` or measured now.
pub fn stereo_frames(project_file: &str, requests: Vec<StereoFramesRequest>) -> Result<Vec<StereoFramesResponse>, String> {
    let project = PathBuf::from(project_file);
    let bundle = bundle::bundle_dir_for(&project)?.canonicalize().map_err(|error| error.to_string())?;
    let mut out = Vec::with_capacity(requests.len());
    for request in requests {
        let measured = bundle::resolve_project_media_file(&project, &request.relative_path)
            .and_then(|source| audiosous_audio::cached_stereo_frames(&bundle, &request.track_id, &source, &AtomicBool::new(false)));
        match measured {
            Ok(json) => out.push(StereoFramesResponse { track_id: request.track_id, json: Some(json), error: None }),
            Err(error) => out.push(StereoFramesResponse { track_id: request.track_id, json: None, error: Some(error) }),
        }
    }
    Ok(out)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpatialSettingDto {
    pub pan: f32,
    pub width: f32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpatialCheckRequest {
    pub id: String,
    pub track_id: String,
    pub relative_path: String,
    pub windows: Vec<(f64, f64)>,
    /// The saved EQ that runs before the spatial stage on this track in this scope.
    pub saved: Vec<FilterSpec>,
    pub before: SpatialSettingDto,
    pub after: SpatialSettingDto,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpatialCheckResponse {
    pub id: String,
    pub result: Option<SpatialCheck>,
    pub error: Option<String>,
}

/// Measures each candidate pan/width on its track's playback proxy through the native spatial stage.
/// The original stems are not read except to rebuild a proxy whose identity no longer matches.
pub fn check(project_file: &str, requests: Vec<SpatialCheckRequest>) -> Result<Vec<SpatialCheckResponse>, String> {
    let project = PathBuf::from(project_file);
    let bundle = bundle::bundle_dir_for(&project)?.canonicalize().map_err(|error| error.to_string())?;
    let cache = bundle.join("cache").join("playback");
    fs::create_dir_all(&cache).map_err(|error| error.to_string())?;
    let mut out = Vec::with_capacity(requests.len());
    for request in requests {
        let measured = (|| -> Result<SpatialCheck, String> {
            let proxy = cache.join(proxy_file_name(&request.track_id)?);
            let source = bundle::resolve_project_media_file(&project, &request.relative_path)?;
            let meta = fs::metadata(&source).map_err(|error| error.to_string())?;
            let modified = meta
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|duration| u64::try_from(duration.as_nanos()).unwrap_or(u64::MAX))
                .unwrap_or(0);
            ensure_proxy(&source, &proxy, meta.len(), modified, &AtomicBool::new(false), &mut |_| {})?;
            check_spatial(
                &proxy,
                &request.windows,
                &request.saved,
                SpatialParams { pan: request.before.pan, width: request.before.width },
                SpatialParams { pan: request.after.pan, width: request.after.width },
                MAX_SECONDS,
            )
        })();
        match measured {
            Ok(result) => out.push(SpatialCheckResponse { id: request.id, result: Some(result), error: None }),
            Err(error) => out.push(SpatialCheckResponse { id: request.id, result: None, error: Some(error) }),
        }
    }
    Ok(out)
}
