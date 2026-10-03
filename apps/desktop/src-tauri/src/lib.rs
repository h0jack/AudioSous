mod bundle;

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
fn write_project_file(project_file: String, project_json: String) -> Result<(), String> {
    bundle::write_project_file(PathBuf::from(project_file).as_path(), &project_json)
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

#[tauri::command]
fn append_log(app: AppHandle, line: String) -> Result<(), String> {
    let directory = app
        .path()
        .app_log_dir()
        .map_err(|error| error.to_string())?;
    bundle::append_log_line(&directory, &line)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
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
            append_log
        ])
        .run(tauri::generate_context!())
        .expect("Audiosous failed to start");
}
