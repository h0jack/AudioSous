mod agent_host;
mod export_host;
mod reference_host;
mod analysis;
mod audio_host;
mod bundle;
mod dynamics_check;
mod mix_check;
mod eq_check;
mod space_check;
mod waveform;

use std::path::PathBuf;

use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::bundle::{CopyItem, UserFile};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateBundleRequest {
    parent_dir: String,
    bundle_name: String,
    project_json: String,
    copies: Vec<CopyItem>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CreateBundleResponse {
    bundle_dir: String,
    project_file: String,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ReadProjectResponse {
    project_file: String,
    json: String,
}

#[tauri::command]
fn list_audio_files(paths: Vec<String>) -> Result<Vec<UserFile>, String> {
    bundle::list_audio_files(&paths)
}

#[tauri::command]
fn read_user_file_range(path: String, offset: u64, length: u32) -> Result<Vec<u8>, String> {
    bundle::read_range(PathBuf::from(path).as_path(), offset, length)
}

#[tauri::command]
fn read_project_media_range(
    project_file: String,
    relative_path: String,
    offset: u64,
    length: u32,
) -> Result<Vec<u8>, String> {
    bundle::read_project_media(
        PathBuf::from(project_file).as_path(),
        &relative_path,
        offset,
        length,
    )
}

#[tauri::command]
fn project_media_status(
    project_file: String,
    relative_paths: Vec<String>,
) -> Result<Vec<bundle::MediaStatus>, String> {
    bundle::project_media_status(PathBuf::from(project_file).as_path(), &relative_paths)
}

#[tauri::command]
async fn create_project_bundle(
    app: AppHandle,
    request: CreateBundleRequest,
) -> Result<CreateBundleResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (bundle_dir, project_file) = bundle::create_bundle(
            PathBuf::from(&request.parent_dir).as_path(),
            &request.bundle_name,
            &request.project_json,
            &request.copies,
            |progress| {
                let _ = app.emit("stem-copy-progress", progress);
            },
        )?;
        Ok(CreateBundleResponse {
            bundle_dir: bundle_dir.to_string_lossy().into_owned(),
            project_file: project_file.to_string_lossy().into_owned(),
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn write_project_file(project_file: String, project_json: String) -> Result<String, String> {
    let saved = bundle::write_project_file(PathBuf::from(project_file).as_path(), &project_json)?;
    Ok(saved.to_string_lossy().into_owned())
}

#[tauri::command]
fn read_project_file(project_file: String) -> Result<ReadProjectResponse, String> {
    let (path, json) = bundle::read_project_text(PathBuf::from(project_file).as_path())?;
    Ok(ReadProjectResponse {
        project_file: path.to_string_lossy().into_owned(),
        json,
    })
}

#[tauri::command]
fn read_project_cache(
    project_file: String,
    relative_path: String,
) -> Result<Option<String>, String> {
    let bytes = bundle::read_project_cache(PathBuf::from(project_file).as_path(), &relative_path)?;
    Ok(bytes.map(|value| bundle::encode_base64(&value)))
}

#[tauri::command]
fn write_project_cache(
    project_file: String,
    relative_path: String,
    base64_data: String,
) -> Result<(), String> {
    let bytes = bundle::decode_base64(&base64_data)?;
    bundle::write_project_cache(
        PathBuf::from(project_file).as_path(),
        &relative_path,
        &bytes,
    )
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AnalyzeAudioRequest {
    project_file: String,
    relative_paths: Vec<String>,
    scope_type: String,
    start_seconds: Option<f64>,
    end_seconds: Option<f64>,
    job_id: u64,
}

#[tauri::command]
async fn analyze_track_file(
    project_file: String,
    relative_path: String,
) -> Result<analysis::AnalyzeTrackResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        analysis::analyze_project_track(PathBuf::from(project_file).as_path(), &relative_path)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn analyze_audio(
    request: AnalyzeAudioRequest,
) -> Result<analysis::AnalyzeTrackResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        analysis::analyze_project_audio(
            PathBuf::from(request.project_file).as_path(),
            &request.relative_paths,
            &request.scope_type,
            request.start_seconds,
            request.end_seconds,
            request.job_id,
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn cancel_analysis(job_id: u64) {
    analysis::cancel_analysis(job_id);
}

#[tauri::command]
async fn measure_waveform(
    app: AppHandle,
    project_file: String,
    relative_path: String,
    track_id: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        waveform::measure(app, &project_file, &relative_path, &track_id)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn cancel_waveform() {
    waveform::cancel_measure();
}

#[tauri::command]
fn audio_engine_kind() -> &'static str {
    audio_host::engine_kind()
}

#[tauri::command]
async fn audio_load(
    host: tauri::State<'_, audio_host::AudioHost>,
    request: audio_host::AudioLoadRequest,
) -> Result<(), String> {
    let engine = std::sync::Arc::clone(&host.engine);
    tauri::async_runtime::spawn_blocking(move || {
        audio_host::load_project(&audio_host::AudioHost { engine }, request)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn audio_play(
    host: tauri::State<'_, audio_host::AudioHost>,
    seconds: f64,
) -> Result<(), String> {
    let engine = std::sync::Arc::clone(&host.engine);
    tauri::async_runtime::spawn_blocking(move || engine.play(seconds))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
fn audio_pause(host: tauri::State<'_, audio_host::AudioHost>) {
    host.engine.pause();
}

#[tauri::command]
fn audio_stop(host: tauri::State<'_, audio_host::AudioHost>) {
    host.engine.stop();
}

#[tauri::command]
fn audio_seek(host: tauri::State<'_, audio_host::AudioHost>, seconds: f64) {
    host.engine.seek(seconds);
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AudioTrackUpdate {
    id: String,
    gain_db: Option<f32>,
    pan: Option<f32>,
    muted: Option<bool>,
    solo: Option<bool>,
}

#[tauri::command]
fn audio_set_track(host: tauri::State<'_, audio_host::AudioHost>, track: AudioTrackUpdate) {
    host.engine
        .set_track(&track.id, track.gain_db, track.pan, track.muted, track.solo);
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AudioGainRegion {
    track_id: String,
    start_seconds: f64,
    end_seconds: f64,
    gain_db: f32,
}

#[tauri::command]
fn audio_set_gain_regions(host: tauri::State<'_, audio_host::AudioHost>, regions: Vec<AudioGainRegion>) {
    host.engine.set_gain_regions(
        regions
            .into_iter()
            .map(|region| audiosous_audio::TrackGainRegion {
                track_id: region.track_id,
                start_seconds: region.start_seconds,
                end_seconds: region.end_seconds,
                gain_db: region.gain_db,
            })
            .collect(),
    );
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AudioEqRegion {
    start_seconds: f64,
    end_seconds: f64,
    filters: Vec<audiosous_audio::FilterSpec>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AudioTrackEq {
    track_id: String,
    filters: Vec<audiosous_audio::FilterSpec>,
    regions: Vec<AudioEqRegion>,
}

#[tauri::command]
fn audio_set_eq(host: tauri::State<'_, audio_host::AudioHost>, tracks: Vec<AudioTrackEq>) {
    host.engine.set_eq(
        tracks
            .into_iter()
            .map(|track| audiosous_audio::TrackEq {
                track_id: track.track_id,
                filters: track.filters,
                regions: track
                    .regions
                    .into_iter()
                    .map(|region| audiosous_audio::TrackEqRegion {
                        start_seconds: region.start_seconds,
                        end_seconds: region.end_seconds,
                        filters: region.filters,
                    })
                    .collect(),
            })
            .collect(),
    );
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AudioSpatialRegion {
    start_seconds: f64,
    end_seconds: f64,
    pan: f32,
    width: f32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AudioTrackSpatial {
    track_id: String,
    pan: f32,
    width: f32,
    regions: Vec<AudioSpatialRegion>,
}

#[tauri::command]
fn audio_set_spatial(host: tauri::State<'_, audio_host::AudioHost>, tracks: Vec<AudioTrackSpatial>) {
    host.engine.set_spatial(
        tracks
            .into_iter()
            .map(|track| audiosous_audio::TrackSpatial {
                track_id: track.track_id,
                pan: track.pan,
                width: track.width,
                regions: track
                    .regions
                    .into_iter()
                    .map(|region| audiosous_audio::TrackSpatialRegion {
                        start_seconds: region.start_seconds,
                        end_seconds: region.end_seconds,
                        pan: region.pan,
                        width: region.width,
                    })
                    .collect(),
            })
            .collect(),
    );
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AudioDynamicsRegion {
    start_seconds: f64,
    end_seconds: f64,
    nodes: Vec<audiosous_audio::DynamicsNodeSpec>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AudioTrackDynamics {
    track_id: String,
    nodes: Vec<audiosous_audio::DynamicsNodeSpec>,
    regions: Vec<AudioDynamicsRegion>,
}

#[tauri::command]
fn audio_set_dynamics(host: tauri::State<'_, audio_host::AudioHost>, tracks: Vec<AudioTrackDynamics>) {
    host.engine.set_dynamics(
        tracks
            .into_iter()
            .map(|track| audiosous_audio::TrackDynamics {
                track_id: track.track_id,
                nodes: track.nodes,
                regions: track
                    .regions
                    .into_iter()
                    .map(|region| audiosous_audio::TrackDynamicsRegion {
                        start_seconds: region.start_seconds,
                        end_seconds: region.end_seconds,
                        nodes: region.nodes,
                    })
                    .collect(),
            })
            .collect(),
    );
}

#[tauri::command]
fn audio_dynamics_meter(host: tauri::State<'_, audio_host::AudioHost>) -> Vec<audiosous_audio::DynamicsMeter> {
    host.engine.dynamics_meter()
}

#[tauri::command]
async fn envelope_frames(
    project_file: String,
    tracks: Vec<dynamics_check::EnvelopeFramesRequest>,
) -> Result<Vec<dynamics_check::EnvelopeFramesResponse>, String> {
    tauri::async_runtime::spawn_blocking(move || dynamics_check::envelope_frames(&project_file, tracks))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn dynamics_check(
    project_file: String,
    requests: Vec<dynamics_check::DynamicsCheckRequest>,
) -> Result<Vec<dynamics_check::DynamicsCheckResponse>, String> {
    tauri::async_runtime::spawn_blocking(move || dynamics_check::check(&project_file, requests))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn mix_check(project_file: String, request: mix_check::MixCheckRequest) -> Result<Vec<audiosous_audio::MixCheck>, String> {
    tauri::async_runtime::spawn_blocking(move || mix_check::check(&project_file, request))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn stereo_frames(
    project_file: String,
    tracks: Vec<space_check::StereoFramesRequest>,
) -> Result<Vec<space_check::StereoFramesResponse>, String> {
    tauri::async_runtime::spawn_blocking(move || space_check::stereo_frames(&project_file, tracks))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn spatial_check(
    project_file: String,
    requests: Vec<space_check::SpatialCheckRequest>,
) -> Result<Vec<space_check::SpatialCheckResponse>, String> {
    tauri::async_runtime::spawn_blocking(move || space_check::check(&project_file, requests))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn eq_check(
    project_file: String,
    requests: Vec<eq_check::EqCheckRequest>,
) -> Result<Vec<eq_check::EqCheckResponse>, String> {
    tauri::async_runtime::spawn_blocking(move || eq_check::check(&project_file, requests))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn eq_band_frames(
    project_file: String,
    tracks: Vec<eq_check::EqBandsRequest>,
) -> Result<Vec<eq_check::EqBandsResponse>, String> {
    tauri::async_runtime::spawn_blocking(move || eq_check::band_frames(&project_file, tracks))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
fn audio_set_loop(
    host: tauri::State<'_, audio_host::AudioHost>,
    start: Option<f64>,
    end: Option<f64>,
) {
    host.engine.set_loop(match (start, end) {
        (Some(start), Some(end)) => Some((start, end)),
        _ => None,
    });
}

#[tauri::command]
fn audio_status(host: tauri::State<'_, audio_host::AudioHost>) -> audiosous_audio::EngineStatus {
    audio_host::status(&host)
}

#[tauri::command]
fn append_log(app: AppHandle, line: String) -> Result<(), String> {
    let directory = app
        .path()
        .app_log_dir()
        .map_err(|error| error.to_string())?;
    bundle::append_log_line(&directory, &line)
}

fn agent_config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_config_dir().map_err(|error| error.to_string())
}

#[tauri::command]
fn agent_settings(app: AppHandle) -> Result<agent_host::AgentSettingsInfo, String> {
    Ok(agent_host::settings_info(&agent_config_dir(&app)?))
}

#[tauri::command]
fn agent_save_settings(app: AppHandle, settings: agent_host::SaveAgentSettings) -> Result<agent_host::AgentSettingsInfo, String> {
    agent_host::save_settings(&agent_config_dir(&app)?, settings)
}

/// The assistant's only network request: a POST to the Anthropic Messages endpoint, with the key added here.
#[tauri::command]
async fn agent_http(app: AppHandle, request: agent_host::AgentHttpRequest) -> Result<agent_host::AgentHttpResponse, String> {
    let dir = agent_config_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || agent_host::send(&dir, request))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
fn export_start(host: tauri::State<'_, export_host::ExportHost>, project_file: String, request: export_host::ExportRequest) -> Result<u64, String> {
    host.start(&project_file, request)
}

#[tauri::command]
fn export_status(host: tauri::State<'_, export_host::ExportHost>, job_id: u64) -> Result<export_host::ExportStatus, String> {
    host.status(job_id)
}

#[tauri::command]
fn export_decide(host: tauri::State<'_, export_host::ExportHost>, job_id: u64, choice: Option<audiosous_audio::LimitingChoice>) -> Result<(), String> {
    host.decide(job_id, choice)
}

#[tauri::command]
fn export_cancel(host: tauri::State<'_, export_host::ExportHost>, job_id: u64) -> Result<(), String> {
    host.cancel(job_id)
}

#[tauri::command]
fn export_reveal(path: String) -> Result<(), String> {
    export_host::reveal(&path)
}

#[tauri::command]
async fn reference_import(project_file: String, source_path: String) -> Result<reference_host::ReferenceInfo, String> {
    tauri::async_runtime::spawn_blocking(move || reference_host::import(&project_file, &source_path)).await.map_err(|error| error.to_string())?
}

#[tauri::command]
async fn reference_list(project_file: String) -> Result<Vec<reference_host::ReferenceInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || reference_host::list(&project_file)).await.map_err(|error| error.to_string())?
}

#[tauri::command]
fn reference_delete(project_file: String, name: String) -> Result<(), String> {
    reference_host::delete(&project_file, &name)
}

#[tauri::command]
async fn mix_profile(project_file: String, request: reference_host::MixProfileRequest) -> Result<audiosous_audio::SongProfile, String> {
    tauri::async_runtime::spawn_blocking(move || reference_host::mix_profile(&project_file, request)).await.map_err(|error| error.to_string())?
}

#[tauri::command]
fn export_mp3_available() -> Result<String, String> {
    audiosous_audio::lame_available()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(audio_host::AudioHost::new())
        .manage(export_host::ExportHost::default())
        .invoke_handler(tauri::generate_handler![
            list_audio_files,
            read_user_file_range,
            read_project_media_range,
            project_media_status,
            create_project_bundle,
            write_project_file,
            read_project_file,
            read_project_cache,
            write_project_cache,
            analyze_track_file,
            analyze_audio,
            cancel_analysis,
            measure_waveform,
            cancel_waveform,
            audio_engine_kind,
            audio_load,
            audio_play,
            audio_pause,
            audio_stop,
            audio_seek,
            audio_set_track,
            audio_set_gain_regions,
            audio_set_eq,
            audio_set_spatial,
            audio_set_dynamics,
            audio_dynamics_meter,
            envelope_frames,
            dynamics_check,
            mix_check,
            eq_check,
            eq_band_frames,
            stereo_frames,
            spatial_check,
            audio_set_loop,
            audio_status,
            append_log,
            agent_settings,
            agent_save_settings,
            agent_http,
            export_start,
            export_status,
            export_decide,
            export_cancel,
            export_reveal,
            export_mp3_available,
            reference_import,
            reference_list,
            reference_delete,
            mix_profile
        ])
        .run(tauri::generate_context!())
        .expect("Audiosous failed to start");
}
