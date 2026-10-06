//! Export jobs in the shell: one export at a time on its own thread, polled by the webview like the audio status.
//! A target that needs heavy limiting stops after the render with the numbers, and waits for the person to choose
//! the safer level, to continue, or to cancel. Nothing is written at the output path until the file has verified.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;

use audiosous_audio::{finish_export, prepare_export, ExportJob, ExportProgress, ExportReport, ExportSettings, ExportSource, ExportStage, LimitingChoice, MasterPlan, MixAnalysis, MixVariantSpec, CANCELLED};
use serde::{Deserialize, Serialize};

use crate::bundle;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportTrack {
    pub track_id: String,
    pub relative_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
    pub tracks: Vec<ExportTrack>,
    pub mix: MixVariantSpec,
    pub duration_seconds: f64,
    pub settings: ExportSettings,
    /// Absolute path the person chose in the save dialog.
    pub output: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportStatus {
    pub job_id: u64,
    pub stage: ExportStage,
    pub detail: String,
    pub frames_done: u64,
    pub frames_total: u64,
    pub sample_rate: u32,
    pub analysis: Option<MixAnalysis>,
    pub plan: Option<MasterPlan>,
    pub report: Option<ExportReport>,
    pub error: Option<String>,
    /// Peak resident memory of the app while this job ran, MB (Linux; null elsewhere).
    pub peak_memory_mb: Option<f64>,
}

struct Job {
    progress: Arc<ExportProgress>,
    sample_rate: u32,
    analysis: Mutex<Option<MixAnalysis>>,
    plan: Mutex<Option<MasterPlan>>,
    outcome: Mutex<Option<Result<ExportReport, String>>>,
    decide: Mutex<Option<Sender<Option<LimitingChoice>>>>,
    peak_memory_mb: Mutex<Option<f64>>,
}

#[derive(Default)]
pub struct ExportHost {
    next: AtomicU64,
    jobs: Mutex<HashMap<u64, Arc<Job>>>,
}

fn sources(project_file: &str, tracks: &[ExportTrack]) -> Result<Vec<ExportSource>, String> {
    let project = PathBuf::from(project_file);
    tracks
        .iter()
        .map(|track| Ok(ExportSource { track_id: track.track_id.clone(), path: bundle::resolve_project_media_file(&project, &track.relative_path)? }))
        .collect()
}

fn checked_output(output: &str, settings: &ExportSettings) -> Result<PathBuf, String> {
    let path = PathBuf::from(output);
    if !path.is_absolute() {
        return Err("Choose where to save the export.".into());
    }
    let extension = settings.format.extension();
    let matches = path.extension().and_then(|value| value.to_str()).is_some_and(|value| value.eq_ignore_ascii_case(extension));
    Ok(if matches { path } else { path.with_extension(extension) })
}

/// Peak resident set size of this process, MB, from /proc (Linux only).
fn peak_memory_mb() -> Option<f64> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    let line = status.lines().find(|line| line.starts_with("VmHWM:"))?;
    let kb: f64 = line.split_whitespace().nth(1)?.parse().ok()?;
    Some((kb / 1024.0 * 10.0).round() / 10.0)
}

impl ExportHost {
    pub fn start(&self, project_file: &str, request: ExportRequest) -> Result<u64, String> {
        {
            let jobs = self.jobs.lock().map_err(|_| "Export state is unavailable.")?;
            if jobs.values().any(|job| job.outcome.lock().map(|outcome| outcome.is_none()).unwrap_or(false)) {
                return Err("An export is already running.".into());
            }
        }
        let output = checked_output(&request.output, &request.settings)?;
        let job = ExportJob { sources: sources(project_file, &request.tracks)?, mix: request.mix, duration_seconds: request.duration_seconds, settings: request.settings.clone(), output };
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let (tx, rx): (Sender<Option<LimitingChoice>>, Receiver<Option<LimitingChoice>>) = channel();
        let state = Arc::new(Job {
            progress: Arc::new(ExportProgress::new()),
            sample_rate: request.settings.sample_rate,
            analysis: Mutex::new(None),
            plan: Mutex::new(None),
            outcome: Mutex::new(None),
            decide: Mutex::new(Some(tx)),
            peak_memory_mb: Mutex::new(None),
        });
        self.jobs.lock().map_err(|_| "Export state is unavailable.")?.insert(id, Arc::clone(&state));
        thread::Builder::new()
            .name("audiosous-export".into())
            .spawn(move || run(job, state, rx))
            .map_err(|error| format!("Could not start the export: {error}"))?;
        Ok(id)
    }

    pub fn status(&self, id: u64) -> Result<ExportStatus, String> {
        let job = self.job(id)?;
        let (mut stage, detail) = job.progress.stage();
        let outcome = job.outcome.lock().map(|outcome| outcome.clone()).unwrap_or(None);
        let (report, error) = match outcome {
            Some(Ok(report)) => (Some(report), None),
            Some(Err(error)) if error == CANCELLED => {
                stage = ExportStage::Cancelled;
                (None, None)
            }
            Some(Err(error)) => {
                stage = ExportStage::Failed;
                (None, Some(error))
            }
            None => (None, None),
        };
        Ok(ExportStatus {
            job_id: id,
            stage,
            detail,
            frames_done: job.progress.frames_done.load(Ordering::Relaxed),
            frames_total: job.progress.frames_total.load(Ordering::Relaxed),
            sample_rate: job.sample_rate,
            analysis: job.analysis.lock().ok().and_then(|value| value.clone()),
            plan: job.plan.lock().ok().and_then(|value| value.clone()),
            report,
            error,
            peak_memory_mb: job.peak_memory_mb.lock().ok().and_then(|value| *value),
        })
    }

    /// The person's answer to heavy limiting: None cancels.
    pub fn decide(&self, id: u64, choice: Option<LimitingChoice>) -> Result<(), String> {
        let job = self.job(id)?;
        if choice.is_none() {
            job.progress.cancel.store(true, Ordering::Relaxed);
        }
        let sender = job.decide.lock().map_err(|_| "Export state is unavailable.")?.take();
        if let Some(sender) = sender {
            let _ = sender.send(choice);
        }
        Ok(())
    }

    pub fn cancel(&self, id: u64) -> Result<(), String> {
        let job = self.job(id)?;
        job.progress.cancel.store(true, Ordering::Relaxed);
        if let Some(sender) = job.decide.lock().map_err(|_| "Export state is unavailable.")?.take() {
            let _ = sender.send(None);
        }
        Ok(())
    }

    fn job(&self, id: u64) -> Result<Arc<Job>, String> {
        self.jobs.lock().map_err(|_| "Export state is unavailable.")?.get(&id).cloned().ok_or_else(|| "No such export.".into())
    }
}

fn run(job: ExportJob, state: Arc<Job>, decisions: Receiver<Option<LimitingChoice>>) {
    let progress = Arc::clone(&state.progress);
    let finish = |result: Result<ExportReport, String>| {
        if let Ok(mut memory) = state.peak_memory_mb.lock() {
            *memory = peak_memory_mb();
        }
        if let Ok(mut outcome) = state.outcome.lock() {
            *outcome = Some(result);
        }
    };
    let prepared = match prepare_export(&job, &progress) {
        Ok(prepared) => prepared,
        Err(error) => return finish(Err(error)),
    };
    if let Ok(mut analysis) = state.analysis.lock() {
        *analysis = Some(prepared.analysis.clone());
    }
    if let Ok(mut plan) = state.plan.lock() {
        *plan = Some(prepared.plan.clone());
    }
    let mut choice = None;
    if prepared.plan.heavy {
        progress.set(ExportStage::Deciding, "Reaching this target would need heavy limiting");
        choice = decisions.recv().unwrap_or(None);
        if choice.is_none() {
            prepared.discard();
            return finish(Err(CANCELLED.into()));
        }
    }
    let result = finish_export(&job, &prepared, choice, &progress);
    prepared.discard();
    finish(result);
}

/// Shows the exported file in the system's file manager.
pub fn reveal(path: &str) -> Result<(), String> {
    let path = Path::new(path);
    if !path.exists() {
        return Err("The exported file is no longer there.".into());
    }
    let folder = path.parent().unwrap_or(path);
    let status = if cfg!(target_os = "macos") {
        std::process::Command::new("open").arg("-R").arg(path).status()
    } else if cfg!(target_os = "windows") {
        std::process::Command::new("explorer").arg(format!("/select,{}", path.display())).status()
    } else {
        std::process::Command::new("xdg-open").arg(folder).status()
    };
    status.map(|_| ()).map_err(|error| format!("Could not open the folder: {error}"))
}
