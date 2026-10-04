use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::thread;
use std::time::{Duration, Instant, UNIX_EPOCH};

use serde::Serialize;

use crate::bundle;

const STDOUT_LIMIT: usize = 1_000_000;
const STDERR_LIMIT: usize = 64_000;
const TIMEOUT: Duration = Duration::from_secs(180);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzeTrackResponse {
    pub ok: bool,
    pub message: String,
    pub detail: String,
    pub measurement_json: String,
    pub file_size_bytes: u64,
    pub modified_at_ns: String,
    pub duration_ms: u64,
}

#[derive(Clone, PartialEq, Eq)]
struct FileStamp {
    size: u64,
    modified_at_ns: String,
}

pub fn analyze_project_track(project_file: &Path, relative: &str) -> Result<AnalyzeTrackResponse, String> {
    analyze_project_audio(project_file, &[relative.to_string()], "track", None, None)
}

pub fn analyze_project_audio(
    project_file: &Path,
    relatives: &[String],
    scope_type: &str,
    start_seconds: Option<f64>,
    end_seconds: Option<f64>,
) -> Result<AnalyzeTrackResponse, String> {
    if relatives.is_empty() {
        return Err("The analysis request did not include a stem.".into());
    }
    if scope_type != "mix" && relatives.len() != 1 {
        return Err("That analysis needs one stem.".into());
    }
    let mut paths = Vec::with_capacity(relatives.len());
    for relative in relatives {
        paths.push(bundle::resolve_project_media_file(project_file, relative)?);
    }
    for path in &paths {
        if !path.is_file() {
            return Err("That stem is missing from the project.".into());
        }
    }
    let before = paths
        .iter()
        .map(|path| stamp(path))
        .collect::<Result<Vec<_>, _>>()?;
    let started = Instant::now();
    let python = python_interpreter()?;
    let root = analysis_root();
    let request = if scope_type == "mix" {
        serde_json::json!({
            "contractVersion": 1,
            "operation": "analyze_mix",
            "audioPaths": paths,
        })
    } else {
        let mut scope = serde_json::json!({ "type": scope_type });
        if let (Some(start), Some(end)) = (start_seconds, end_seconds) {
            scope["startSeconds"] = serde_json::json!(start);
            scope["endSeconds"] = serde_json::json!(end);
        }
        serde_json::json!({
            "contractVersion": 1,
            "operation": "analyze_track",
            "audioPath": paths[0],
            "scope": scope,
        })
    };
    let mut child = Command::new(&python)
        .arg("-m")
        .arg("audiosous_analysis")
        .current_dir(&root)
        .env("PYTHONPATH", &root)
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("The analysis engine could not be started. {error}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(request.to_string().as_bytes())
            .map_err(|error| format!("The analysis engine could not be started. {error}"))?;
    }
    let stdout = child
        .stdout
        .take()
        .ok_or("The analysis engine could not be started.")?;
    let stderr = child
        .stderr
        .take()
        .ok_or("The analysis engine could not be started.")?;
    let stdout_thread = thread::spawn(move || read_capped(stdout, STDOUT_LIMIT));
    let stderr_thread = thread::spawn(move || read_capped(stderr, STDERR_LIMIT));
    let status = wait_for(&mut child, TIMEOUT)?;
    let stdout_bytes = join_read(stdout_thread)?;
    let stderr_text = join_read(stderr_thread)
        .map(|bytes| String::from_utf8_lossy(&bytes).to_string())
        .unwrap_or_default();
    let duration_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
    for (path, stamp_before) in paths.iter().zip(before.iter()) {
        if stamp(path)? != *stamp_before {
            return Err("The stem changed while it was being analyzed.".into());
        }
    }
    parse_response(&stdout_bytes, &stderr_text, status.success(), &before[0], duration_ms)
}

fn parse_response(
    stdout_bytes: &[u8],
    stderr_text: &str,
    success: bool,
    stamp: &FileStamp,
    duration_ms: u64,
) -> Result<AnalyzeTrackResponse, String> {
    let parsed: serde_json::Value = match serde_json::from_slice(stdout_bytes) {
        Ok(value) => value,
        Err(_) => {
            let detail = format!("The analysis engine stopped unexpectedly. {}", tail(stderr_text));
            return Ok(failure("Unable to analyze this stem.", &detail, stamp, duration_ms));
        }
    };
    if parsed.get("contractVersion").and_then(|value| value.as_i64()) != Some(1) {
        let detail = tail(stderr_text);
        return Ok(failure(
            "The analysis engine returned an unfamiliar result.",
            &detail,
            stamp,
            duration_ms,
        ));
    }
    if parsed.get("ok").and_then(|value| value.as_bool()) != Some(true) {
        let message = parsed
            .pointer("/error/message")
            .and_then(|value| value.as_str())
            .unwrap_or("Unable to analyze this stem.");
        let detail = parsed
            .pointer("/error/detail")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        return Ok(failure(message, detail, stamp, duration_ms));
    }
    if !success {
        let detail = tail(stderr_text);
        return Ok(failure("Unable to analyze this stem.", &detail, stamp, duration_ms));
    }
    let Some(measurement) = parsed.get("measurement").cloned() else {
        let detail = tail(stderr_text);
        return Ok(failure(
            "The analysis engine returned an unfamiliar result.",
            &detail,
            stamp,
            duration_ms,
        ));
    };
    let measurement_json = serde_json::to_string(&measurement).map_err(|error| error.to_string())?;
    Ok(AnalyzeTrackResponse {
        ok: true,
        message: String::new(),
        detail: String::new(),
        measurement_json,
        file_size_bytes: stamp.size,
        modified_at_ns: stamp.modified_at_ns.clone(),
        duration_ms,
    })
}

fn failure(message: &str, detail: &str, stamp: &FileStamp, duration_ms: u64) -> AnalyzeTrackResponse {
    AnalyzeTrackResponse {
        ok: false,
        message: message.to_string(),
        detail: detail.to_string(),
        measurement_json: "{}".into(),
        file_size_bytes: stamp.size,
        modified_at_ns: stamp.modified_at_ns.clone(),
        duration_ms,
    }
}

fn analysis_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../services/analysis")
}

fn python_interpreter() -> Result<PathBuf, String> {
    if let Ok(path) = std::env::var("AUDIOSOUS_PYTHON") {
        let python = PathBuf::from(path);
        if python.is_file() {
            return Ok(python);
        }
        return Err("AUDIOSOUS_PYTHON does not point at a Python interpreter.".into());
    }
    let venv = analysis_root().join(".venv/bin/python");
    if venv.is_file() {
        return Ok(venv);
    }
    Err("The analysis engine is not installed. From services/analysis, create .venv and install the package.".into())
}

fn stamp(path: &Path) -> Result<FileStamp, String> {
    let meta = fs::metadata(path).map_err(|error| error.to_string())?;
    Ok(FileStamp {
        size: meta.len(),
        modified_at_ns: modified_at_ns(&meta),
    })
}

fn modified_at_ns(meta: &fs::Metadata) -> String {
    meta.modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos().to_string())
        .unwrap_or_else(|| "0".to_string())
}

fn wait_for(child: &mut Child, limit: Duration) -> Result<ExitStatus, String> {
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) if started.elapsed() > limit => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("Analysis took too long and was stopped.".into());
            }
            Ok(None) => thread::sleep(Duration::from_millis(40)),
            Err(error) => return Err(error.to_string()),
        }
    }
}

fn read_capped(mut reader: impl Read, limit: usize) -> Result<Vec<u8>, String> {
    let mut buffer = Vec::new();
    let mut chunk = [0_u8; 8192];
    loop {
        let read = reader.read(&mut chunk).map_err(|error| error.to_string())?;
        if read == 0 {
            return Ok(buffer);
        }
        if buffer.len() + read > limit {
            return Err("The analysis engine returned too much data.".into());
        }
        buffer.extend_from_slice(&chunk[..read]);
    }
}

fn join_read(handle: thread::JoinHandle<Result<Vec<u8>, String>>) -> Result<Vec<u8>, String> {
    handle
        .join()
        .map_err(|_| "The analysis engine was interrupted.".to_string())?
}

fn tail(text: &str) -> String {
    let trimmed = text.trim();
    let start = trimmed.len().saturating_sub(500);
    trimmed[start..].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("audiosous-analysis-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn write_sine(path: &Path, frequency: f32, amplitude: f32) {
        let sample_rate = 48_000_u32;
        let frames = sample_rate as usize * 2;
        let mut data = Vec::with_capacity(frames * 2);
        for index in 0..frames {
            let time = index as f32 / sample_rate as f32;
            let sample = (amplitude * (2.0 * std::f32::consts::PI * frequency * time).sin()).clamp(-1.0, 1.0);
            let pcm = (sample * 32_767.0).round() as i16;
            data.extend_from_slice(&pcm.to_le_bytes());
        }
        let data_len = data.len() as u32;
        let mut header = Vec::with_capacity(44);
        header.extend_from_slice(b"RIFF");
        header.extend_from_slice(&(36 + data_len).to_le_bytes());
        header.extend_from_slice(b"WAVE");
        header.extend_from_slice(b"fmt ");
        header.extend_from_slice(&16_u32.to_le_bytes());
        header.extend_from_slice(&1_u16.to_le_bytes());
        header.extend_from_slice(&1_u16.to_le_bytes());
        header.extend_from_slice(&sample_rate.to_le_bytes());
        header.extend_from_slice(&(sample_rate * 2).to_le_bytes());
        header.extend_from_slice(&2_u16.to_le_bytes());
        header.extend_from_slice(&16_u16.to_le_bytes());
        header.extend_from_slice(b"data");
        header.extend_from_slice(&data_len.to_le_bytes());
        header.extend_from_slice(&data);
        fs::write(path, header).unwrap();
    }

    #[test]
    fn refuses_media_paths_outside_the_project() {
        let root = temp_root("escape");
        let bundle = root.join("Song");
        fs::create_dir_all(bundle.join("media")).unwrap();
        let project = bundle.join("project.amix");
        fs::write(&project, b"{}").unwrap();
        assert!(analyze_project_track(&project, "media/../secret.wav").is_err());
        assert!(analyze_project_track(&project, "/etc/passwd").is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn measures_a_bass_tone_without_changing_the_file() {
        if python_interpreter().is_err() {
            eprintln!("skipping sidecar test; analysis venv is not installed");
            return;
        }
        let root = temp_root("tone");
        let bundle = root.join("Song");
        fs::create_dir_all(bundle.join("media")).unwrap();
        let project = bundle.join("project.amix");
        fs::write(&project, b"{}").unwrap();
        let audio = bundle.join("media/track-bass__bass.wav");
        write_sine(&audio, 100.0, 0.5);
        let before = fs::read(&audio).unwrap();
        let response = analyze_project_track(&project, "media/track-bass__bass.wav").unwrap();
        assert_eq!(fs::read(&audio).unwrap(), before);
        assert!(response.ok, "{}", response.detail);
        let measurement: serde_json::Value = serde_json::from_str(&response.measurement_json).unwrap();
        let bass = measurement["bandEnergy"]
            .as_array()
            .unwrap()
            .iter()
            .find(|band| band["id"] == "bass")
            .unwrap();
        assert!(bass["normalizedEnergy"].as_f64().unwrap() > 0.7);
        let peak = measurement["levels"]["peakDbfs"].as_f64().unwrap();
        assert!((-7.0..-5.0).contains(&peak));
        let _ = fs::remove_dir_all(&root);
    }
}
