//! Finished-file export: the applied mix rendered offline from the original stems, an optional distribution
//! loudness stage, encoding, and verification of the written file.
//!
//! ```text
//! original stems ──► (resample once to the export rate) ──► mix graph (render.rs: EQ, dynamics, space, gain)
//!        ──► temporary float render, measured (BS.1770 loudness, true peak, block peaks)
//!        ──► distribution stage: one gain to the target, the true-peak limiter only if a peak needs it
//!        ──► encoder (WAV / FLAC / MP3) to a temporary file ──► decoded and measured ──► renamed into place
//! ```
//!
//! The mix itself is never changed to reach a loudness: the stage is one gain and a safety limiter after the mix
//! bus, and a target that needs heavy limiting is reported before anything is written. Nothing here is real time;
//! it runs on its own thread and never touches the device callback.

use std::fs::{self, File};
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Instant;

use serde::{Deserialize, Serialize};

use crate::encode::{decode_and_measure, open_writer, ExportFormat, ExportMetadata, Mp3Quality};
use crate::limiter::{LimiterStats, TruePeakLimiter};
use crate::loudness::{to_db, LoudnessMeter, LoudnessReport, TruePeakDetector};
use crate::mixcheck::MixVariantSpec;
use crate::render::{render_mix, FrameSource, GraphTrack, MixGraph, SourceStream, CANCELLED};

/// The longest a single export may be, seconds.
pub const MAX_EXPORT_SECONDS: f64 = 60.0 * 60.0;
/// Heavy limiting, conservatively: more than this at any moment…
pub const HEAVY_MAX_REDUCTION_DB: f64 = 6.0;
/// …or more than 3 dB of reduction for more than this share of the song.
pub const HEAVY_SHARE_OVER_3DB: f64 = 0.05;
/// What the "safer level" allows: at most 3 dB of reduction, and at most this share of the song over 1 dB.
const SAFE_MAX_REDUCTION_DB: f64 = 3.0;
const SAFE_SHARE_OVER_1DB: f64 = 0.05;
const BLOCK_SECONDS: f64 = 0.05;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "mode", rename_all = "kebab-case")]
pub enum LoudnessTarget {
    /// Keep the mix's level; the limiter only catches a true peak over the ceiling.
    #[serde(rename_all = "camelCase")]
    Preserve { ceiling_dbtp: f64 },
    /// One gain to reach `integrated_lufs`, the limiter keeping true peaks under the ceiling.
    #[serde(rename_all = "camelCase")]
    Target { integrated_lufs: f64, ceiling_dbtp: f64 },
}

impl LoudnessTarget {
    pub fn ceiling(&self) -> f64 {
        match self {
            Self::Preserve { ceiling_dbtp } | Self::Target { ceiling_dbtp, .. } => *ceiling_dbtp,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSettings {
    pub format: ExportFormat,
    pub sample_rate: u32,
    pub loudness: LoudnessTarget,
    #[serde(default)]
    pub metadata: ExportMetadata,
}

/// One stem: its id (as the mix variant names it) and its original file.
#[derive(Clone, Debug)]
pub struct ExportSource {
    pub track_id: String,
    pub path: PathBuf,
}

pub struct ExportJob {
    pub sources: Vec<ExportSource>,
    /// The applied mix as the engine plays it: faders, section gain, EQ, space, dynamics.
    pub mix: MixVariantSpec,
    pub duration_seconds: f64,
    pub settings: ExportSettings,
    /// The finished file. Temporaries are written next to it and renamed into place.
    pub output: PathBuf,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ExportStage {
    Rendering,
    Analyzing,
    Deciding,
    Mastering,
    Encoding,
    Verifying,
    Done,
    Failed,
    Cancelled,
}

/// Shared between the export thread and whoever polls it. Only atomics and short-held locks; never the callback.
pub struct ExportProgress {
    pub cancel: AtomicBool,
    pub frames_done: AtomicU64,
    pub frames_total: AtomicU64,
    stage: Mutex<(ExportStage, String)>,
}

impl ExportProgress {
    pub fn new() -> Self {
        Self { cancel: AtomicBool::new(false), frames_done: AtomicU64::new(0), frames_total: AtomicU64::new(0), stage: Mutex::new((ExportStage::Rendering, String::new())) }
    }

    pub fn set(&self, stage: ExportStage, detail: impl Into<String>) {
        if let Ok(mut current) = self.stage.lock() {
            *current = (stage, detail.into());
        }
    }

    pub fn stage(&self) -> (ExportStage, String) {
        self.stage.lock().map(|current| current.clone()).unwrap_or((ExportStage::Failed, String::new()))
    }

    fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }
}

impl Default for ExportProgress {
    fn default() -> Self {
        Self::new()
    }
}

/// What the render measured, before any distribution processing.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MixAnalysis {
    pub loudness: LoudnessReport,
    pub duration_seconds: f64,
    pub render_seconds: f64,
    /// Realtime factor of the render (song seconds per wall-clock second).
    pub render_speed: f64,
}

/// The distribution stage as planned from the analysis: the gain, and the limiting it would need.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MasterPlan {
    pub gain_db: f64,
    pub ceiling_dbtp: f64,
    pub target_lufs: Option<f64>,
    /// Estimated from the measured peaks: the largest reduction and the share of the song over 1 and 3 dB.
    pub estimated_max_reduction_db: f64,
    pub estimated_share_over_1db: f64,
    pub estimated_share_over_3db: f64,
    pub limiting_needed: bool,
    pub heavy: bool,
    /// The loudest target that keeps limiting light (≤ 3 dB, and over 1 dB for ≤ 5% of the song), when lower.
    pub safer_target_lufs: Option<f64>,
}

/// Everything the finished file was measured to be.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportReport {
    pub output: String,
    pub format: String,
    pub sample_rate: u32,
    pub bit_depth: Option<u32>,
    pub bitrate_kbps: Option<u32>,
    pub channels: usize,
    pub duration_seconds: f64,
    pub file_bytes: u64,
    /// Measured on the decoded file.
    pub integrated_lufs: f64,
    pub true_peak_dbtp: f64,
    pub sample_peak_dbfs: f64,
    pub loudness_range_lu: f64,
    /// The mix before the distribution stage.
    pub mix: LoudnessReport,
    pub gain_db: f64,
    pub target_lufs: Option<f64>,
    pub ceiling_dbtp: f64,
    pub limiter: LimiterStats,
    pub verification: Vec<String>,
    pub warnings: Vec<String>,
    pub render_seconds: f64,
    pub total_seconds: f64,
    pub render_speed: f64,
}

/// The render on disk and what it measured, waiting for the distribution stage.
pub struct PreparedExport {
    pub analysis: MixAnalysis,
    pub plan: MasterPlan,
    raw: PathBuf,
    block_peaks_db: Vec<f32>,
    frames: u64,
    started: Instant,
}

impl PreparedExport {
    /// Removes the temporary render. Called on cancel and after finishing.
    pub fn discard(&self) {
        let _ = fs::remove_file(&self.raw);
    }
}

/// How the person resolved heavy limiting.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum LimitingChoice {
    Continue,
    Safer,
}

fn partial_path(output: &Path, suffix: &str) -> PathBuf {
    let name = output.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_else(|| "export".into());
    output.with_file_name(format!(".{name}.{suffix}.partial"))
}

/// Renders the mix from the original stems to a temporary float file and measures it, then plans the distribution
/// stage. Nothing is written at the output path.
pub fn prepare_export(job: &ExportJob, progress: &ExportProgress) -> Result<PreparedExport, String> {
    let settings = &job.settings;
    let rate = settings.sample_rate;
    if !(8_000..=384_000).contains(&rate) {
        return Err(format!("{rate} Hz is not a sample rate Audiosous exports."));
    }
    if matches!(settings.format, ExportFormat::Mp3 { .. }) && rate != 44_100 && rate != 48_000 {
        return Err("MP3 export is 44.1 or 48 kHz.".into());
    }
    if !(job.duration_seconds > 0.0 && job.duration_seconds <= MAX_EXPORT_SECONDS) {
        return Err("The project has no length to export.".into());
    }
    if let Some(parent) = job.output.parent() {
        if !parent.as_os_str().is_empty() && !parent.is_dir() {
            return Err(format!("The folder {} does not exist.", parent.display()));
        }
    }
    let started = Instant::now();
    progress.set(ExportStage::Rendering, "Opening stems");
    let (tracks, bounce) = job.mix.bounce_inputs(|id| job.sources.iter().find(|source| source.track_id == id).map(|source| source.path.clone()).ok_or_else(|| format!("No source file for track {id}.")))?;
    let mut sources: Vec<Box<dyn FrameSource>> = Vec::with_capacity(tracks.len());
    for track in &tracks {
        if !track.proxy.is_file() {
            return Err(format!("A stem is missing: {}.", track.proxy.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default()));
        }
        sources.push(Box::new(SourceStream::open(&track.proxy, rate)?));
    }
    let graph_tracks: Vec<GraphTrack> = tracks.iter().map(|track| GraphTrack { id: track.id.clone(), gain_db: track.gain_db, muted: track.muted }).collect();
    let mut graph = MixGraph::new(&graph_tracks, bounce, rate);
    let raw = partial_path(&job.output, "render");
    let mut file = BufWriter::with_capacity(1 << 20, File::create(&raw).map_err(|error| format!("Could not write next to the export ({error}).").to_string())?);
    let mut meter = LoudnessMeter::new(rate, 2);
    let mut blocks = BlockPeaks::new(rate);
    progress.frames_total.store((job.duration_seconds * f64::from(rate)).round() as u64, Ordering::Relaxed);
    progress.set(ExportStage::Rendering, "Rendering mix");
    let mut bytes = Vec::with_capacity(crate::render::RENDER_CHUNK * 8);
    let result = render_mix(
        &mut sources,
        &mut graph,
        rate,
        job.duration_seconds,
        &progress.cancel,
        &mut |chunk| {
            meter.push(chunk);
            blocks.push(chunk);
            bytes.clear();
            for sample in chunk {
                bytes.extend_from_slice(&sample.to_le_bytes());
            }
            file.write_all(&bytes).map_err(|error| format!("Could not write the render ({error})."))
        },
        &mut |done| progress.frames_done.store(done.frames_done, Ordering::Relaxed),
    );
    let frames = match result {
        Ok(frames) => frames,
        Err(error) => {
            drop(file);
            let _ = fs::remove_file(&raw);
            return Err(error);
        }
    };
    file.flush().map_err(|error| error.to_string())?;
    drop(file);
    let render_seconds = started.elapsed().as_secs_f64();
    progress.set(ExportStage::Analyzing, "Analyzing loudness");
    let loudness = meter.report();
    let block_peaks_db = blocks.finish();
    let duration_seconds = frames as f64 / f64::from(rate);
    let analysis = MixAnalysis { loudness, duration_seconds, render_seconds, render_speed: if render_seconds > 0.0 { duration_seconds / render_seconds } else { 0.0 } };
    let plan = plan_master(&analysis.loudness, &block_peaks_db, settings.loudness);
    Ok(PreparedExport { analysis, plan, raw, block_peaks_db, frames, started })
}

/// True peak per 50 ms block, dBTP: what the limiter would see, for estimating how much it would act.
struct BlockPeaks {
    detector: TruePeakDetector,
    block: usize,
    count: usize,
    peak: f32,
    out: Vec<f32>,
}

impl BlockPeaks {
    fn new(rate: u32) -> Self {
        Self { detector: TruePeakDetector::new(rate, 2), block: ((f64::from(rate) * BLOCK_SECONDS) as usize).max(1), count: 0, peak: 0.0, out: Vec::new() }
    }
    fn push(&mut self, chunk: &[f32]) {
        for frame in chunk.chunks_exact(2) {
            self.peak = self.peak.max(self.detector.push(frame));
            self.count += 1;
            if self.count == self.block {
                self.out.push(to_db(self.peak) as f32);
                self.count = 0;
                self.peak = 0.0;
            }
        }
    }
    fn finish(mut self) -> Vec<f32> {
        if self.count > 0 {
            self.out.push(to_db(self.peak) as f32);
        }
        self.out
    }
}

/// Plans the distribution stage: the gain the target needs, and how much the limiter would have to do for it.
pub fn plan_master(loudness: &LoudnessReport, block_peaks_db: &[f32], target: LoudnessTarget) -> MasterPlan {
    let ceiling = target.ceiling();
    let (gain_db, target_lufs) = match target {
        LoudnessTarget::Preserve { .. } => (0.0, None),
        LoudnessTarget::Target { integrated_lufs, .. } => {
            if loudness.integrated_lufs <= -70.0 {
                (0.0, Some(integrated_lufs))
            } else {
                (integrated_lufs - loudness.integrated_lufs, Some(integrated_lufs))
            }
        }
    };
    let estimate = |gain: f64| -> (f64, f64, f64) {
        let max = (loudness.true_peak_dbtp + gain - ceiling).max(0.0);
        let blocks = block_peaks_db.len().max(1) as f64;
        let over = |reduction: f64| block_peaks_db.iter().filter(|peak| f64::from(**peak) + gain - ceiling > reduction).count() as f64 / blocks;
        (max, over(1.0), over(3.0))
    };
    let (max, over_1, over_3) = estimate(gain_db);
    let heavy = max > HEAVY_MAX_REDUCTION_DB || over_3 > HEAVY_SHARE_OVER_3DB;
    let safer_target_lufs = if heavy && target_lufs.is_some() {
        let mut sorted: Vec<f64> = block_peaks_db.iter().map(|peak| f64::from(*peak)).collect();
        sorted.sort_by(|left, right| left.partial_cmp(right).unwrap_or(std::cmp::Ordering::Equal));
        let p95 = sorted.get(((sorted.len().max(1) - 1) as f64 * (1.0 - SAFE_SHARE_OVER_1DB)) as usize).copied().unwrap_or(loudness.true_peak_dbtp);
        let safe_gain = gain_db.min(ceiling + SAFE_MAX_REDUCTION_DB - loudness.true_peak_dbtp).min(ceiling + 1.0 - p95);
        Some(((loudness.integrated_lufs + safe_gain) * 10.0).floor() / 10.0)
    } else {
        None
    };
    MasterPlan { gain_db, ceiling_dbtp: ceiling, target_lufs, estimated_max_reduction_db: max, estimated_share_over_1db: over_1, estimated_share_over_3db: over_3, limiting_needed: max > 0.0, heavy, safer_target_lufs }
}

/// Streams the render through gain and the limiter, into `sink`. Returns the limiter's statistics and the
/// measurement of what came out (before encoding).
fn master_pass(prepared: &PreparedExport, gain_db: f64, ceiling_dbtp: f64, rate: u32, progress: &ExportProgress, sink: &mut dyn FnMut(&[f32]) -> Result<(), String>) -> Result<(LimiterStats, LoudnessReport), String> {
    let gain = 10_f64.powf(gain_db / 20.0) as f32;
    let mut limiter = TruePeakLimiter::new(rate, 2, ceiling_dbtp);
    let mut meter = LoudnessMeter::new(rate, 2);
    let mut reader = BufReader::with_capacity(1 << 20, File::open(&prepared.raw).map_err(|error| error.to_string())?);
    let mut bytes = vec![0_u8; crate::render::RENDER_CHUNK * 8];
    let mut samples = Vec::with_capacity(crate::render::RENDER_CHUNK * 2);
    let mut out = Vec::with_capacity(crate::render::RENDER_CHUNK * 2 + 4_096);
    let mut done = 0_u64;
    loop {
        if progress.cancelled() {
            return Err(CANCELLED.into());
        }
        let mut filled = 0;
        while filled < bytes.len() {
            let read = reader.read(&mut bytes[filled..]).map_err(|error| error.to_string())?;
            if read == 0 {
                break;
            }
            filled += read;
        }
        if filled < 8 {
            break;
        }
        samples.clear();
        for chunk in bytes[..filled - filled % 8].chunks_exact(4) {
            samples.push(f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]) * gain);
        }
        out.clear();
        limiter.process(&samples, &mut out);
        meter.push(&out);
        sink(&out)?;
        done += (samples.len() / 2) as u64;
        progress.frames_done.store(done, Ordering::Relaxed);
    }
    out.clear();
    limiter.flush(&mut out);
    meter.push(&out);
    sink(&out)?;
    Ok((limiter.stats(), meter.report()))
}

/// Applies the distribution stage, encodes, verifies the file by decoding it, and renames it into place.
pub fn finish_export(job: &ExportJob, prepared: &PreparedExport, choice: Option<LimitingChoice>, progress: &ExportProgress) -> Result<ExportReport, String> {
    let settings = &job.settings;
    let rate = settings.sample_rate;
    let mut plan = prepared.plan.clone();
    let requested = plan.target_lufs;
    let mut safer_chosen = false;
    if choice == Some(LimitingChoice::Safer) {
        if let (Some(safer), LoudnessTarget::Target { ceiling_dbtp, .. }) = (plan.safer_target_lufs, settings.loudness) {
            plan = plan_master(&prepared.analysis.loudness, &prepared.block_peaks_db, LoudnessTarget::Target { integrated_lufs: safer, ceiling_dbtp });
            safer_chosen = true;
        }
    }
    let ceiling = plan.ceiling_dbtp;
    let mut gain_db = plan.gain_db;
    let mut warnings = Vec::new();
    let mut verification = Vec::new();

    // Limiting takes a little loudness away; with a target, measure without encoding and correct the gain. The safer
    // level is a promise of light limiting, so it is not pushed back up toward a number.
    if let (Some(target), true, false) = (plan.target_lufs, plan.limiting_needed, safer_chosen) {
        for pass in 1..=2 {
            progress.set(ExportStage::Mastering, format!("Applying distribution level (check {pass})"));
            let (_, measured) = master_pass(prepared, gain_db, ceiling, rate, progress, &mut |_| Ok(()))?;
            let shortfall = target - measured.integrated_lufs;
            if shortfall.abs() <= 0.1 || measured.integrated_lufs <= -70.0 {
                break;
            }
            gain_db += shortfall.clamp(-3.0, 3.0);
        }
    }

    let output = &job.output;
    let partial = partial_path(output, "encode");
    let lossy = settings.format.is_lossy();
    let mut internal_ceiling = ceiling;
    let mut attempt = 0;
    let (stats, mastered, decoded) = loop {
        attempt += 1;
        progress.set(ExportStage::Encoding, format!("Encoding {}", settings.format.describe()));
        let _ = fs::remove_file(&partial);
        let mut writer = open_writer(settings.format, &partial, rate, 2, &settings.metadata)?;
        let result = master_pass(prepared, gain_db, internal_ceiling, rate, progress, &mut |chunk| writer.write(chunk));
        let (stats, mastered) = match result {
            Ok(value) => value,
            Err(error) => {
                drop(writer);
                let _ = fs::remove_file(&partial);
                let _ = fs::remove_file(partial.with_extension("pcm.partial"));
                return Err(error);
            }
        };
        if let Err(error) = writer.finish() {
            let _ = fs::remove_file(&partial);
            return Err(error);
        }
        if progress.cancelled() {
            let _ = fs::remove_file(&partial);
            return Err(CANCELLED.into());
        }
        progress.set(ExportStage::Verifying, "Verifying output");
        let decoded = match decode_and_measure(&partial, &progress.cancel) {
            Ok(decoded) => decoded,
            Err(error) => {
                let _ = fs::remove_file(&partial);
                return Err(error);
            }
        };
        // A lossy encoder can raise peaks; a lossless file can overshoot by an interpolation rounding. Try again a
        // little lower (twice at most) rather than ship a file over the ceiling.
        let allowed = if lossy { 0.3 } else { 0.1 };
        let over = decoded.loudness.true_peak_dbtp - ceiling;
        if over > allowed && attempt < 3 && (stats.max_reduction_db > 0.0 || matches!(settings.loudness, LoudnessTarget::Target { .. }) || over > 0.0) {
            internal_ceiling -= over + 0.05;
            continue;
        }
        break (stats, mastered, decoded);
    };

    // Verification: the file exists, decodes completely, and is what was asked for.
    let expected = prepared.frames;
    let frames_ok = if lossy { (decoded.frames as i64 - expected as i64).abs() <= 1_152 } else { decoded.frames == expected };
    let checks = [
        (decoded.sample_rate == rate, format!("Sample rate {} Hz", decoded.sample_rate)),
        (decoded.channels == 2, format!("{} channels", decoded.channels)),
        (frames_ok, format!("Length {:.3} s ({} frames; {} rendered)", decoded.frames as f64 / f64::from(rate), decoded.frames, expected)),
        ((decoded.loudness.integrated_lufs - mastered.integrated_lufs).abs() <= if lossy { 0.5 } else { 0.05 }, format!("Loudness {:.1} LUFS decoded, {:.1} LUFS before encoding", decoded.loudness.integrated_lufs, mastered.integrated_lufs)),
    ];
    for (ok, line) in &checks {
        if !ok {
            let _ = fs::remove_file(&partial);
            return Err(format!("The exported file did not verify: {line}. Nothing was saved."));
        }
        verification.push(format!("✓ {line}"));
    }
    verification.insert(0, "✓ Decoded completely".into());
    if decoded.loudness.true_peak_dbtp > ceiling + 0.05 {
        warnings.push(format!("The true peak is {:.1} dBTP, {:.1} dB over the {:.1} dBTP ceiling{}.", decoded.loudness.true_peak_dbtp, decoded.loudness.true_peak_dbtp - ceiling, ceiling, if lossy { " after MP3 encoding; a lower ceiling (for example −1.5 dBTP) leaves the encoder more room" } else { "" }));
    } else {
        verification.push(format!("✓ True peak {:.1} dBTP, under the {:.1} dBTP ceiling", decoded.loudness.true_peak_dbtp, ceiling));
    }
    if safer_chosen {
        verification.push(format!("Safer level: {:.1} LUFS instead of the {:.1} LUFS target, to keep limiting light", decoded.loudness.integrated_lufs, requested.unwrap_or(plan.gain_db)));
    } else if let Some(target) = plan.target_lufs {
        let miss = decoded.loudness.integrated_lufs - target;
        if miss.abs() > 0.5 {
            warnings.push(format!("The file measures {:.1} LUFS, {:.1} dB from the {:.1} LUFS target.", decoded.loudness.integrated_lufs, miss.abs(), target));
        }
    }
    if stats.max_reduction_db > HEAVY_MAX_REDUCTION_DB || stats.share_over_3db > HEAVY_SHARE_OVER_3DB {
        warnings.push(format!("The limiter reduced peaks by up to {:.1} dB and by more than 3 dB for {:.0}% of the song. This changes the mix noticeably.", stats.max_reduction_db, stats.share_over_3db * 100.0));
    }

    if progress.cancelled() {
        let _ = fs::remove_file(&partial);
        return Err(CANCELLED.into());
    }
    fs::rename(&partial, output).map_err(|error| {
        let _ = fs::remove_file(&partial);
        format!("The export could not be moved into place ({error}).")
    })?;
    let file_bytes = fs::metadata(output).map(|meta| meta.len()).unwrap_or(0);
    verification.push(format!("✓ Saved {}", output.display()));
    progress.set(ExportStage::Done, "Export completed");
    let duration_seconds = decoded.frames as f64 / f64::from(rate);
    Ok(ExportReport {
        output: output.display().to_string(),
        format: settings.format.describe(),
        sample_rate: rate,
        bit_depth: settings.format.pcm_bits().or(match settings.format {
            ExportFormat::Wav { .. } => Some(32),
            _ => None,
        }),
        bitrate_kbps: match settings.format {
            ExportFormat::Mp3 { quality: Mp3Quality::Cbr320 } => Some(320),
            ExportFormat::Mp3 { quality: Mp3Quality::V0 } => Some(((file_bytes as f64 * 8.0) / duration_seconds.max(0.001) / 1_000.0).round() as u32),
            _ => None,
        },
        channels: decoded.channels,
        duration_seconds,
        file_bytes,
        integrated_lufs: decoded.loudness.integrated_lufs,
        true_peak_dbtp: decoded.loudness.true_peak_dbtp,
        sample_peak_dbfs: decoded.loudness.sample_peak_dbfs,
        loudness_range_lu: decoded.loudness.loudness_range_lu,
        mix: prepared.analysis.loudness,
        gain_db,
        target_lufs: requested,
        ceiling_dbtp: ceiling,
        limiter: stats,
        verification,
        warnings,
        render_seconds: prepared.analysis.render_seconds,
        total_seconds: prepared.started.elapsed().as_secs_f64(),
        render_speed: prepared.analysis.render_speed,
    })
}

/// The whole export without stopping for a decision: heavy limiting is resolved with `choice` (default: continue).
pub fn export_mix(job: &ExportJob, choice: Option<LimitingChoice>, progress: &ExportProgress) -> Result<ExportReport, String> {
    let prepared = prepare_export(job, progress)?;
    let result = finish_export(job, &prepared, choice, progress);
    prepared.discard();
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bounce::{bounce, BounceTrack};
    use crate::encode::{ExportFormat, Mp3Quality, WavDepth};
    use crate::proxy::ensure_proxy;
    use serde_json::json;

    fn write_wav(path: &Path, rate: u32, channels: u16, frames: usize, sample: impl Fn(usize, usize) -> f32) {
        let data = (frames * channels as usize * 4) as u32;
        let mut body = Vec::with_capacity(44 + data as usize);
        body.extend_from_slice(b"RIFF");
        body.extend_from_slice(&(36 + data).to_le_bytes());
        body.extend_from_slice(b"WAVEfmt ");
        body.extend_from_slice(&16_u32.to_le_bytes());
        body.extend_from_slice(&3_u16.to_le_bytes());
        body.extend_from_slice(&channels.to_le_bytes());
        body.extend_from_slice(&rate.to_le_bytes());
        body.extend_from_slice(&(rate * u32::from(channels) * 4).to_le_bytes());
        body.extend_from_slice(&(channels * 4).to_le_bytes());
        body.extend_from_slice(&32_u16.to_le_bytes());
        body.extend_from_slice(b"data");
        body.extend_from_slice(&data.to_le_bytes());
        for frame in 0..frames {
            for channel in 0..channels as usize {
                body.extend_from_slice(&sample(frame, channel).to_le_bytes());
            }
        }
        fs::write(path, body).unwrap();
    }

    struct Fixture {
        dir: PathBuf,
        sources: Vec<ExportSource>,
        proxies: Vec<(String, PathBuf)>,
        seconds: f64,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    /// Kick hits every half second, a sustained bass, and a stereo pad with a 1 kHz part, at `rate`.
    fn fixture(name: &str, rate: u32, seconds: f64, level: f32) -> Fixture {
        let dir = std::env::temp_dir().join(format!("audiosous-export-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let frames = (seconds * f64::from(rate)) as usize;
        let r = rate as f32;
        let tau = std::f32::consts::TAU;
        let kick = dir.join("kick.wav");
        write_wav(&kick, rate, 1, frames, |frame, _| {
            let local = (frame % (rate as usize / 2)) as f32 / r;
            level * 0.8 * (-local / 0.08).exp() * (tau * 60.0 * local).sin()
        });
        let bass = dir.join("bass.wav");
        write_wav(&bass, rate, 1, frames, |frame, _| level * 0.3 * (tau * 80.0 * frame as f32 / r).sin());
        let pad = dir.join("pad.wav");
        write_wav(&pad, rate, 2, frames, |frame, channel| {
            let t = frame as f32 / r;
            level * (0.15 * (tau * 1_000.0 * t + channel as f32).sin() + 0.1 * (tau * 330.0 * t).sin())
        });
        let mut sources = Vec::new();
        let mut proxies = Vec::new();
        for (id, path) in [("kick", kick), ("bass", bass), ("pad", pad)] {
            let proxy = dir.join(format!("{id}.proxy"));
            let size = fs::metadata(&path).unwrap().len();
            ensure_proxy(&path, &proxy, size, 1, &AtomicBool::new(false), &mut |_| {}).unwrap();
            sources.push(ExportSource { track_id: id.into(), path });
            proxies.push((id.to_string(), proxy));
        }
        Fixture { dir, sources, proxies, seconds }
    }

    fn variant(extra: serde_json::Value) -> MixVariantSpec {
        let mut base = json!({
            "name": "mix",
            "tracks": [
                { "id": "kick", "gainDb": 0.0, "muted": false },
                { "id": "bass", "gainDb": 0.0, "muted": false },
                { "id": "pad", "gainDb": 0.0, "muted": false }
            ],
            "gainRegions": [], "eq": [], "spatial": [], "dynamics": []
        });
        for (key, value) in extra.as_object().unwrap() {
            base[key] = value.clone();
        }
        serde_json::from_value(base).unwrap()
    }

    fn job(fixture: &Fixture, mix: MixVariantSpec, format: ExportFormat, rate: u32, loudness: LoudnessTarget) -> ExportJob {
        ExportJob { sources: fixture.sources.clone(), mix, duration_seconds: fixture.seconds, settings: ExportSettings { format, sample_rate: rate, loudness, metadata: ExportMetadata::default() }, output: fixture.dir.join(format!("out-{}.{}", format.describe().replace(' ', "_"), format.extension())) }
    }

    fn decode(path: &Path) -> Vec<f32> {
        use symphonia::core::audio::SampleBuffer;
        let file = File::open(path).unwrap();
        let stream = symphonia::core::io::MediaSourceStream::new(Box::new(file), Default::default());
        let probed = symphonia::default::get_probe().format(&Default::default(), stream, &Default::default(), &Default::default()).unwrap();
        let mut format = probed.format;
        let track = format.default_track().unwrap().clone();
        let mut decoder = symphonia::default::get_codecs().make(&track.codec_params, &Default::default()).unwrap();
        let mut out = Vec::new();
        while let Ok(packet) = format.next_packet() {
            let decoded = decoder.decode(&packet).unwrap();
            let mut buffer = SampleBuffer::<f32>::new(decoded.capacity() as u64, *decoded.spec());
            buffer.copy_interleaved_ref(decoded);
            out.extend_from_slice(buffer.samples());
        }
        out
    }

    const LEAVE_LEVEL: LoudnessTarget = LoudnessTarget::Preserve { ceiling_dbtp: 24.0 };

    /// Every processing type, rendered from the original stems for export, equals the playback DSP's own render
    /// (the bounce, itself tested equal to the realtime engine) before the loudness stage, and audibly does something.
    #[test]
    fn export_renders_every_kind_of_processing_exactly_as_playback() {
        let fixture = fixture("ab", 48_000, 2.0, 1.0);
        let filter = |kind: &str, hz: f64, gain: f64| json!({ "kind": kind, "frequencyHz": hz, "gainDb": gain, "q": 1.0 });
        let cases = vec![
            ("dry", json!({})),
            ("gain", json!({ "tracks": [{ "id": "kick", "gainDb": -3.0, "muted": false }, { "id": "bass", "gainDb": 2.0, "muted": false }, { "id": "pad", "gainDb": 0.0, "muted": true }] })),
            ("section gain", json!({ "gainRegions": [{ "trackId": "bass", "startSeconds": 0.5, "endSeconds": 1.5, "gainDb": -6.0 }] })),
            ("eq", json!({ "eq": [{ "trackId": "bass", "filters": [filter("bell", 80.0, -6.0)], "regions": [] }] })),
            ("section eq", json!({ "eq": [{ "trackId": "pad", "filters": [], "regions": [{ "startSeconds": 0.5, "endSeconds": 1.5, "filters": [filter("high-shelf", 2_000.0, -6.0)] }] }] })),
            ("space", json!({ "spatial": [{ "trackId": "pad", "pan": 0.4, "width": 0.6, "regions": [] }, { "trackId": "bass", "pan": -0.3, "width": 1.0, "regions": [{ "startSeconds": 1.0, "endSeconds": 2.0, "pan": 0.3, "width": 1.0 }] }] })),
            ("compressor", json!({ "dynamics": [{ "trackId": "bass", "nodes": [{ "type": "compressor", "thresholdDb": -24.0, "ratio": 3.0, "attackMs": 10.0, "releaseMs": 100.0, "kneeDb": 6.0, "makeupDb": 0.0 }], "regions": [] }] })),
            ("sidechain", json!({ "dynamics": [{ "trackId": "bass", "nodes": [{ "type": "ducking", "keyTrackId": "kick", "keyDetector": "transient", "thresholdDb": -20.0, "rangeDb": -4.0, "attackMs": 5.0, "releaseMs": 80.0 }], "regions": [] }] })),
            ("transient", json!({ "dynamics": [{ "trackId": "kick", "nodes": [{ "type": "transient", "attack": 0.4, "sustain": -0.3 }], "regions": [] }] })),
            ("dynamic eq", json!({ "dynamics": [{ "trackId": "pad", "nodes": [{ "type": "dynamic-eq", "frequencyHz": 1000.0, "q": 1.5, "keyTrackId": null, "keyDetector": "smooth", "thresholdDb": -30.0, "rangeDb": -6.0, "attackMs": 10.0, "releaseMs": 120.0 }], "regions": [] }] })),
            ("section dynamics", json!({ "dynamics": [{ "trackId": "bass", "nodes": [], "regions": [{ "startSeconds": 0.5, "endSeconds": 1.5, "nodes": [{ "type": "compressor", "thresholdDb": -30.0, "ratio": 4.0, "attackMs": 5.0, "releaseMs": 80.0, "kneeDb": 6.0, "makeupDb": 0.0 }] }] }] })),
        ];
        let mut dry = Vec::new();
        for (name, extra) in cases {
            let mix = variant(extra);
            let report = export_mix(&job(&fixture, mix.clone(), ExportFormat::Wav { depth: WavDepth::Float32 }, 48_000, LEAVE_LEVEL), None, &ExportProgress::new()).unwrap();
            assert_eq!(report.gain_db, 0.0);
            assert_eq!(report.limiter.max_reduction_db, 0.0, "{name}");
            let exported = decode(Path::new(&report.output));
            let (tracks, settings) = mix.bounce_inputs(|id| Ok(fixture.proxies.iter().find(|(track, _)| track == id).unwrap().1.clone())).unwrap();
            let tracks: Vec<BounceTrack> = tracks;
            let played = bounce(&tracks, settings, fixture.seconds).unwrap();
            assert_eq!(exported.len(), played.len(), "{name}: length");
            let difference = exported.iter().zip(played.iter()).map(|(a, b)| (a - b).abs()).fold(0.0_f32, f32::max);
            assert!(difference < 1e-5, "{name}: export and playback differ by {difference}");
            if name == "dry" {
                dry = exported;
            } else {
                let change = exported.iter().zip(dry.iter()).map(|(a, b)| (a - b).abs()).fold(0.0_f32, f32::max);
                assert!(change > 1e-3, "{name}: the processing did nothing ({change})");
            }
            fs::remove_file(&report.output).unwrap();
        }
    }

    #[test]
    fn wav_flac_and_mp3_reach_streaming_balanced_and_verify() {
        let fixture = fixture("formats", 48_000, 3.0, 0.5);
        let target = LoudnessTarget::Target { integrated_lufs: -14.0, ceiling_dbtp: -1.0 };
        let mut formats = vec![ExportFormat::Wav { depth: WavDepth::Pcm24 }, ExportFormat::Flac { bits: 24 }, ExportFormat::Flac { bits: 16 }, ExportFormat::Wav { depth: WavDepth::Pcm16 }];
        if crate::encode::lame_available().is_ok() {
            formats.push(ExportFormat::Mp3 { quality: Mp3Quality::Cbr320 });
            formats.push(ExportFormat::Mp3 { quality: Mp3Quality::V0 });
        }
        for format in formats {
            let report = export_mix(&job(&fixture, variant(json!({})), format, 48_000, target), None, &ExportProgress::new()).unwrap();
            let lossy = format.is_lossy();
            assert_eq!(report.sample_rate, 48_000);
            assert_eq!(report.channels, 2);
            assert!((report.duration_seconds - 3.0).abs() < if lossy { 0.03 } else { 1e-9 }, "{format:?}: {}", report.duration_seconds);
            assert!((report.integrated_lufs - -14.0).abs() < if lossy { 0.5 } else { 0.2 }, "{format:?}: {}", report.integrated_lufs);
            assert!(report.true_peak_dbtp <= -1.0 + if lossy { 0.3 } else { 0.1 }, "{format:?}: {}", report.true_peak_dbtp);
            assert!(report.verification.iter().any(|line| line.contains("Decoded completely")));
            assert!(Path::new(&report.output).is_file());
            let leftovers: Vec<_> = fs::read_dir(&fixture.dir).unwrap().filter_map(|entry| entry.ok()).filter(|entry| entry.file_name().to_string_lossy().ends_with(".partial")).collect();
            assert!(leftovers.is_empty(), "temporary files left: {leftovers:?}");
        }
    }

    #[test]
    fn lossless_exports_are_byte_identical() {
        let fixture = fixture("determinism", 48_000, 1.0, 0.5);
        let target = LoudnessTarget::Target { integrated_lufs: -14.0, ceiling_dbtp: -1.0 };
        for format in [ExportFormat::Flac { bits: 24 }, ExportFormat::Wav { depth: WavDepth::Pcm16 }] {
            let first = export_mix(&job(&fixture, variant(json!({})), format, 48_000, target), None, &ExportProgress::new()).unwrap();
            let bytes = fs::read(&first.output).unwrap();
            let second = export_mix(&job(&fixture, variant(json!({})), format, 48_000, target), None, &ExportProgress::new()).unwrap();
            assert_eq!(bytes, fs::read(&second.output).unwrap(), "{format:?}");
        }
    }

    /// Stems at 48 kHz exported at 44.1 kHz: resampled once from the source, the same length and loudness.
    #[test]
    fn exports_at_another_rate_from_the_sources() {
        let fixture = fixture("rate", 48_000, 1.5, 0.5);
        let at_48 = export_mix(&job(&fixture, variant(json!({})), ExportFormat::Wav { depth: WavDepth::Float32 }, 48_000, LEAVE_LEVEL), None, &ExportProgress::new()).unwrap();
        let at_44 = export_mix(&job(&fixture, variant(json!({})), ExportFormat::Flac { bits: 24 }, 44_100, LEAVE_LEVEL), None, &ExportProgress::new()).unwrap();
        assert_eq!(at_44.sample_rate, 44_100);
        assert!((at_44.duration_seconds - 1.5).abs() < 1e-9);
        assert!((at_44.integrated_lufs - at_48.integrated_lufs).abs() < 0.1, "{} vs {}", at_44.integrated_lufs, at_48.integrated_lufs);
    }

    #[test]
    fn plans_the_distribution_stage_for_quiet_near_loud_and_spiky_mixes() {
        let report = |integrated: f64, peak: f64| LoudnessReport { integrated_lufs: integrated, true_peak_dbtp: peak, ..Default::default() };
        let target = LoudnessTarget::Target { integrated_lufs: -14.0, ceiling_dbtp: -1.0 };
        let steady = |peak: f32| vec![peak - 3.0; 100];
        // Too quiet with room under the ceiling: one gain, no limiting.
        let quiet = plan_master(&report(-30.0, -18.0), &steady(-18.0), target);
        assert!((quiet.gain_db - 16.0).abs() < 1e-9 && !quiet.limiting_needed && !quiet.heavy);
        // Already near the target.
        let near = plan_master(&report(-14.3, -2.5), &steady(-2.5), target);
        assert!((near.gain_db - 0.3).abs() < 1e-9 && !near.limiting_needed);
        // Too loud: turned down, never up.
        let loud = plan_master(&report(-8.0, 0.5), &steady(0.5), target);
        assert!((loud.gain_db - -6.0).abs() < 1e-9 && !loud.limiting_needed);
        // High peaks, low loudness: reaching −14 would need ~9 dB of limiting. Heavy, with a safer level offered.
        let mut spiky_blocks = vec![-20.0_f32; 100];
        for block in spiky_blocks.iter_mut().step_by(5) {
            *block = -1.0;
        }
        let spiky = plan_master(&report(-23.0, -1.0), &spiky_blocks, target);
        assert!(spiky.heavy && spiky.estimated_max_reduction_db > 8.0, "{spiky:?}");
        let safer = spiky.safer_target_lufs.unwrap();
        assert!(safer < -14.0 && safer >= -23.0, "{safer}");
        let again = plan_master(&report(-23.0, -1.0), &spiky_blocks, LoudnessTarget::Target { integrated_lufs: safer, ceiling_dbtp: -1.0 });
        assert!(again.estimated_max_reduction_db <= 3.0 + 1e-9 && !again.heavy, "{again:?}");
        // Preserve never changes the level.
        assert_eq!(plan_master(&report(-9.0, 1.0), &steady(1.0), LoudnessTarget::Preserve { ceiling_dbtp: -1.0 }).gain_db, 0.0);
    }

    /// A clicky mix whose loudness target needs heavy limiting: warned before writing, and the safer level keeps the
    /// limiting light while the full target is reached only by limiting hard.
    #[test]
    fn heavy_limiting_is_flagged_and_the_safer_level_is_lighter() {
        let dir = std::env::temp_dir().join(format!("audiosous-export-heavy-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let rate = 48_000;
        let path = dir.join("clicks.wav");
        write_wav(&path, rate, 1, rate as usize * 4, |frame, _| {
            let t = frame as f32 / rate as f32;
            let click = if frame % 12_000 < 40 { 0.95 } else { 0.0 };
            click + 0.02 * (std::f32::consts::TAU * 220.0 * t).sin()
        });
        let fixture = Fixture { dir: dir.clone(), sources: vec![ExportSource { track_id: "clicks".into(), path }], proxies: vec![], seconds: 4.0 };
        let mix: MixVariantSpec = serde_json::from_value(json!({ "name": "mix", "tracks": [{ "id": "clicks", "gainDb": 0.0, "muted": false }], "gainRegions": [], "eq": [], "spatial": [], "dynamics": [] })).unwrap();
        let export = job(&fixture, mix, ExportFormat::Wav { depth: WavDepth::Pcm24 }, rate, LoudnessTarget::Target { integrated_lufs: -9.0, ceiling_dbtp: -1.0 });
        let progress = ExportProgress::new();
        let prepared = prepare_export(&export, &progress).unwrap();
        assert!(prepared.plan.heavy, "{:?}", prepared.plan);
        let safer = finish_export(&export, &prepared, Some(LimitingChoice::Safer), &progress).unwrap();
        assert!(safer.limiter.max_reduction_db < 4.0, "{:?}", safer.limiter);
        assert!(safer.warnings.is_empty(), "{:?}", safer.warnings);
        let forced = finish_export(&export, &prepared, Some(LimitingChoice::Continue), &progress).unwrap();
        assert!(forced.limiter.max_reduction_db > HEAVY_MAX_REDUCTION_DB, "{:?}", forced.limiter);
        assert!(forced.warnings.iter().any(|line| line.contains("changes the mix noticeably")));
        assert!(forced.true_peak_dbtp <= -0.9);
        prepared.discard();
    }

    #[test]
    fn cancel_leaves_nothing_behind() {
        let fixture = fixture("cancel", 48_000, 2.0, 0.5);
        let export = job(&fixture, variant(json!({})), ExportFormat::Flac { bits: 24 }, 48_000, LEAVE_LEVEL);
        let progress = ExportProgress::new();
        progress.cancel.store(true, Ordering::Relaxed);
        assert_eq!(export_mix(&export, None, &progress).unwrap_err(), CANCELLED);
        let partial: Vec<_> = fs::read_dir(&fixture.dir).unwrap().filter_map(|entry| entry.ok()).filter(|entry| entry.file_name().to_string_lossy().contains("partial") || entry.path() == export.output).collect();
        assert!(partial.is_empty(), "{partial:?}");
        // Cancelled after the render: the temporary render goes too.
        let progress = ExportProgress::new();
        let prepared = prepare_export(&export, &progress).unwrap();
        progress.cancel.store(true, Ordering::Relaxed);
        assert!(finish_export(&export, &prepared, None, &progress).is_err());
        prepared.discard();
        let left: Vec<_> = fs::read_dir(&fixture.dir).unwrap().filter_map(|entry| entry.ok()).filter(|entry| entry.file_name().to_string_lossy().contains("partial")).collect();
        assert!(left.is_empty(), "{left:?}");
        assert!(!export.output.exists());
    }

    #[test]
    fn a_missing_stem_is_named() {
        let fixture = fixture("missing", 48_000, 0.5, 0.5);
        fs::remove_file(&fixture.sources[1].path).unwrap();
        let error = export_mix(&job(&fixture, variant(json!({})), ExportFormat::Wav { depth: WavDepth::Pcm24 }, 48_000, LEAVE_LEVEL), None, &ExportProgress::new()).unwrap_err();
        assert!(error.contains("bass.wav"), "{error}");
    }
}
