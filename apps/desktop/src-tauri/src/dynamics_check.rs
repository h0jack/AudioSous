use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::time::UNIX_EPOCH;

use audiosous_audio::{check_dynamics, ensure_proxy, proxy_file_name, DynKind, DynamicsCheck, DynamicsCheckInput, DynamicsNodeSpec, FilterSpec};
use serde::{Deserialize, Serialize};

use crate::bundle;

/// Longest stretch of proxy audio read for one recommendation.
const MAX_SECONDS: f64 = 30.0;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvelopeFramesRequest {
    pub track_id: String,
    pub relative_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvelopeFramesResponse {
    pub track_id: String,
    pub json: Option<String>,
    pub error: Option<String>,
}

/// Envelope frames for dynamics planning, from `cache/analysis/<trackId>__envelope.json` or measured now.
pub fn envelope_frames(project_file: &str, requests: Vec<EnvelopeFramesRequest>) -> Result<Vec<EnvelopeFramesResponse>, String> {
    let project = PathBuf::from(project_file);
    let bundle = bundle::bundle_dir_for(&project)?.canonicalize().map_err(|error| error.to_string())?;
    let mut out = Vec::with_capacity(requests.len());
    for request in requests {
        let measured = bundle::resolve_project_media_file(&project, &request.relative_path)
            .and_then(|source| audiosous_audio::cached_envelope_frames(&bundle, &request.track_id, &source, &AtomicBool::new(false)));
        match measured {
            Ok(json) => out.push(EnvelopeFramesResponse { track_id: request.track_id, json: Some(json), error: None }),
            Err(error) => out.push(EnvelopeFramesResponse { track_id: request.track_id, json: None, error: Some(error) }),
        }
    }
    Ok(out)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DynamicsCheckRequest {
    pub id: String,
    pub track_id: String,
    pub relative_path: String,
    /// The key track of the row's processor, if it has one. Keyed nodes read it.
    pub key_track_id: Option<String>,
    pub key_relative_path: Option<String>,
    pub windows: Vec<(f64, f64)>,
    /// Saved static EQ that runs before the dynamics in this scope.
    pub saved_eq: Vec<FilterSpec>,
    /// Dynamics in effect now, and with the row (a replaced node left out).
    pub before: Vec<DynamicsNodeSpec>,
    pub after: Vec<DynamicsNodeSpec>,
    /// "compressor", "ducking", "transient", or "dynamic-eq".
    pub kind: String,
    pub band: Option<(f32, f32)>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DynamicsCheckResponse {
    pub id: String,
    pub result: Option<DynamicsCheck>,
    pub error: Option<String>,
}

/// Runs each row's track through its saved EQ and the native dynamics on the playback proxies, with and
/// without the row. A node keyed to a track other than the row's key is left out of the check.
pub fn check(project_file: &str, requests: Vec<DynamicsCheckRequest>) -> Result<Vec<DynamicsCheckResponse>, String> {
    let project = PathBuf::from(project_file);
    let bundle = bundle::bundle_dir_for(&project)?.canonicalize().map_err(|error| error.to_string())?;
    let cache = bundle.join("cache").join("playback");
    fs::create_dir_all(&cache).map_err(|error| error.to_string())?;
    let mut out = Vec::with_capacity(requests.len());
    for request in requests {
        let measured = (|| -> Result<DynamicsCheck, String> {
            let proxy = proxy_for(&project, &cache, &request.track_id, &request.relative_path)?;
            let key_proxy = match (&request.key_track_id, &request.key_relative_path) {
                (Some(id), Some(path)) => Some(proxy_for(&project, &cache, id, path)?),
                _ => None,
            };
            let key = request.key_track_id.clone();
            let resolve = |nodes: &[DynamicsNodeSpec]| {
                nodes
                    .iter()
                    .filter_map(|node| node.resolve(usize::MAX, |id| (key.as_deref() == Some(id)).then_some(0)))
                    .collect::<Vec<_>>()
            };
            let kind = match request.kind.as_str() {
                "compressor" => DynKind::Compressor,
                "ducking" => DynKind::Ducking,
                "dynamic-eq" => DynKind::DynamicEq,
                "transient" => DynKind::Transient,
                other => return Err(format!("Unknown dynamics kind {other}.")),
            };
            check_dynamics(&DynamicsCheckInput {
                proxy: &proxy,
                key_proxy: key_proxy.as_deref(),
                windows: &request.windows,
                saved_eq: &request.saved_eq,
                before: &resolve(&request.before),
                after: &resolve(&request.after),
                kind,
                band: request.band,
                max_seconds: MAX_SECONDS,
            })
        })();
        match measured {
            Ok(result) => out.push(DynamicsCheckResponse { id: request.id, result: Some(result), error: None }),
            Err(error) => out.push(DynamicsCheckResponse { id: request.id, result: None, error: Some(error) }),
        }
    }
    Ok(out)
}

pub(crate) fn proxy_for(project: &Path, cache: &Path, track_id: &str, relative_path: &str) -> Result<PathBuf, String> {
    let proxy = cache.join(proxy_file_name(track_id)?);
    let source = bundle::resolve_project_media_file(project, relative_path)?;
    let meta = fs::metadata(&source).map_err(|error| error.to_string())?;
    let modified = meta
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| u64::try_from(duration.as_nanos()).unwrap_or(u64::MAX))
        .unwrap_or(0);
    ensure_proxy(&source, &proxy, meta.len(), modified, &AtomicBool::new(false), &mut |_| {})?;
    Ok(proxy)
}
