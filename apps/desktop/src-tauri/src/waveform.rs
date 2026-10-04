use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use audiosous_audio::{measure_peaks, MEASURE_CANCELLED};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::bundle;

static MEASURE_GENERATION: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WaveformProgress {
    track_id: String,
    ratio: f32,
}

pub fn cancel_measure() {
    MEASURE_GENERATION.fetch_add(1, Ordering::AcqRel);
}

pub fn measure(
    app: AppHandle,
    project_file: &str,
    relative_path: &str,
    track_id: &str,
) -> Result<(), String> {
    let job = MEASURE_GENERATION.fetch_add(1, Ordering::AcqRel) + 1;
    let project = PathBuf::from(project_file);
    let source = bundle::resolve_project_media_file(&project, relative_path)?;
    let file_size = std::fs::metadata(&source)
        .map_err(|error| error.to_string())?
        .len();
    let cache_path = format!("cache/waveforms/{track_id}.peaks");
    let mut last_percent = 0_u32;
    let bytes = measure_peaks(
        &source,
        file_size,
        &|| MEASURE_GENERATION.load(Ordering::Acquire) != job,
        &mut |ratio| {
            let percent = (ratio * 100.0) as u32;
            if percent == last_percent && ratio < 1.0 {
                return;
            }
            last_percent = percent;
            let _ = app.emit(
                "waveform-measure-progress",
                WaveformProgress {
                    track_id: track_id.to_string(),
                    ratio,
                },
            );
        },
    )?;
    if MEASURE_GENERATION.load(Ordering::Acquire) != job {
        return Err(MEASURE_CANCELLED.into());
    }
    bundle::write_project_cache(&project, &cache_path, &bytes)
}
