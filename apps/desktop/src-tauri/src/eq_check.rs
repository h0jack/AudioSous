use std::fs;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::time::UNIX_EPOCH;

use audiosous_audio::{check_candidate, ensure_proxy, proxy_file_name, CandidateCheck, FilterSpec};
use serde::{Deserialize, Serialize};

use crate::bundle;

/// Longest stretch of proxy audio read for one recommendation.
const MAX_SECONDS: f64 = 20.0;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EqCheckRequest {
    pub id: String,
    pub track_id: String,
    pub relative_path: String,
    pub windows: Vec<(f64, f64)>,
    pub saved: Vec<FilterSpec>,
    pub candidate: Vec<FilterSpec>,
    pub low_hz: f32,
    pub high_hz: f32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EqCheckResponse {
    pub id: String,
    pub result: Option<CandidateCheck>,
    pub error: Option<String>,
}

/// Measures each candidate filter on its track's playback proxy. The original stems are not read
/// except to rebuild a proxy whose identity no longer matches.
pub fn check(project_file: &str, requests: Vec<EqCheckRequest>) -> Result<Vec<EqCheckResponse>, String> {
    let project = PathBuf::from(project_file);
    let bundle = bundle::bundle_dir_for(&project)?.canonicalize().map_err(|error| error.to_string())?;
    let cache = bundle.join("cache").join("playback");
    fs::create_dir_all(&cache).map_err(|error| error.to_string())?;
    let mut out = Vec::with_capacity(requests.len());
    for request in requests {
        let measured = (|| -> Result<CandidateCheck, String> {
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
            check_candidate(
                &proxy,
                &request.windows,
                &request.saved,
                &request.candidate,
                request.low_hz,
                request.high_hz,
                MAX_SECONDS,
            )
        })();
        match measured {
            Ok(result) => out.push(EqCheckResponse { id: request.id, result: Some(result), error: None }),
            Err(error) => out.push(EqCheckResponse { id: request.id, result: None, error: Some(error) }),
        }
    }
    Ok(out)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EqBandsRequest {
    pub track_id: String,
    pub relative_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EqBandsResponse {
    pub track_id: String,
    pub json: Option<String>,
    pub error: Option<String>,
}

/// Proxy band frames for EQ planning, from `cache/analysis/<trackId>__eqbands.json` or measured now.
pub fn band_frames(project_file: &str, requests: Vec<EqBandsRequest>) -> Result<Vec<EqBandsResponse>, String> {
    let project = PathBuf::from(project_file);
    let bundle = bundle::bundle_dir_for(&project)?.canonicalize().map_err(|error| error.to_string())?;
    let mut out = Vec::with_capacity(requests.len());
    for request in requests {
        let measured = bundle::resolve_project_media_file(&project, &request.relative_path)
            .and_then(|source| audiosous_audio::cached_band_frames(&bundle, &request.track_id, &source, &AtomicBool::new(false)));
        match measured {
            Ok(json) => out.push(EqBandsResponse { track_id: request.track_id, json: Some(json), error: None }),
            Err(error) => out.push(EqBandsResponse { track_id: request.track_id, json: None, error: Some(error) }),
        }
    }
    Ok(out)
}
