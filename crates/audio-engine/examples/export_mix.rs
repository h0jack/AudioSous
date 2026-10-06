//! Acceptance harness for export: renders a real project's mix from its original stems to WAV, FLAC, and MP3 at
//! Streaming Balanced (−14 LUFS, −1 dBTP), verifies each file, and compares the source render with the playback
//! bounce from the proxies before the loudness stage.
//!
//!   npx vite-node apps/desktop/scripts/auto-mix-project.ts -- target/acceptance/m7-good.json
//!   cargo run --release -p audiosous-audio --example export_mix -- target/acceptance/m7-good-automix [variant]
//!
//! Reads OUT_DIR/export.json; writes OUT_DIR/exports/<variant>.<ext> and prints each export's report.

use std::path::{Path, PathBuf};
use std::time::Instant;

use audiosous_audio::{
    bounce, export_mix, ExportFormat, ExportJob, ExportMetadata, ExportProgress, ExportSettings, ExportSource, LoudnessMeter, LoudnessTarget, MixVariantSpec, Mp3Quality, WavDepth,
};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    project: PathBuf,
    duration_seconds: f64,
    project_rate: f64,
    sources: Vec<Source>,
    variants: std::collections::HashMap<String, MixVariantSpec>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Source {
    track_id: String,
    path: PathBuf,
}

fn peak_memory_mb() -> Option<f64> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    let line = status.lines().find(|line| line.starts_with("VmHWM:"))?;
    Some(line.split_whitespace().nth(1)?.parse::<f64>().ok()? / 1024.0)
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).filter(|arg| arg != "--").collect();
    let dir = PathBuf::from(args.first().expect("Pass the folder with export.json."));
    let variant_name = args.get(1).cloned().unwrap_or_else(|| "recommended".into());
    let request: Request = serde_json::from_str(&std::fs::read_to_string(dir.join("export.json")).expect("export.json")).expect("export.json is valid");
    let mix = request.variants.get(&variant_name).unwrap_or_else(|| panic!("no variant {variant_name}")).clone();
    let out = dir.join("exports");
    std::fs::create_dir_all(&out).unwrap();
    let sources: Vec<ExportSource> = request.sources.iter().map(|source| ExportSource { track_id: source.track_id.clone(), path: source.path.clone() }).collect();
    let project_rate = request.project_rate.round() as u32;
    println!("Export acceptance: {} ({variant_name}), {:.1} s, stems at {} Hz", request.project.display(), request.duration_seconds, project_rate);
    let balanced = LoudnessTarget::Target { integrated_lufs: -14.0, ceiling_dbtp: -1.0 };
    let metadata = ExportMetadata { title: Some(request.project.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default()), artist: Some("Audiosous acceptance".into()), album: None, track_number: Some(1), year: Some(2026) };
    let cases: Vec<(&str, ExportFormat, u32, LoudnessTarget)> = vec![
        ("preserve-float-48k", ExportFormat::Wav { depth: WavDepth::Float32 }, 48_000, LoudnessTarget::Preserve { ceiling_dbtp: 24.0 }),
        ("balanced-24bit-48k", ExportFormat::Wav { depth: WavDepth::Pcm24 }, 48_000, balanced),
        ("balanced-24bit-96k", ExportFormat::Flac { bits: 24 }, project_rate.min(96_000), balanced),
        ("balanced-24bit-project-rate-wav", ExportFormat::Wav { depth: WavDepth::Pcm24 }, project_rate.min(192_000), balanced),
        ("balanced-320k-48k", ExportFormat::Mp3 { quality: Mp3Quality::Cbr320 }, 48_000, balanced),
        ("balanced-16bit-44k", ExportFormat::Flac { bits: 16 }, 44_100, balanced),
    ];
    for (label, format, rate, loudness) in cases {
        let output = out.join(format!("{variant_name}-{label}.{}", format.extension()));
        let job = ExportJob { sources: sources.clone(), mix: mix.clone(), duration_seconds: request.duration_seconds, settings: ExportSettings { format, sample_rate: rate, loudness, metadata: metadata.clone() }, output: output.clone() };
        let started = Instant::now();
        match export_mix(&job, None, &ExportProgress::new()) {
            Ok(report) => {
                println!(
                    "\n{label}: {} {} Hz → {}\n  integrated {:.2} LUFS, true peak {:.2} dBTP, sample peak {:.2} dBFS, LRA {:.1} LU, duration {:.3} s, {:.1} MB\n  mix before stage {:.2} LUFS / {:.2} dBTP; gain {:+.2} dB; limiter max {:.2} dB, over 1 dB {:.2}%, active {:.2}%\n  render {:.1} s ({:.1}× real time), total {:.1} s, peak memory {:.0} MB",
                    report.format,
                    report.sample_rate,
                    output.file_name().unwrap().to_string_lossy(),
                    report.integrated_lufs,
                    report.true_peak_dbtp,
                    report.sample_peak_dbfs,
                    report.loudness_range_lu,
                    report.duration_seconds,
                    report.file_bytes as f64 / 1e6,
                    report.mix.integrated_lufs,
                    report.mix.true_peak_dbtp,
                    report.gain_db,
                    report.limiter.max_reduction_db,
                    report.limiter.share_over_1db * 100.0,
                    report.limiter.active_share * 100.0,
                    report.render_seconds,
                    report.render_speed,
                    started.elapsed().as_secs_f64(),
                    peak_memory_mb().unwrap_or(0.0),
                );
                for line in report.verification.iter().chain(report.warnings.iter()) {
                    println!("  {line}");
                }
            }
            Err(error) => println!("\n{label}: FAILED {error}"),
        }
    }

    // A/B before the loudness stage: the source render (sinc-resampled from the stems) against the playback bounce
    // from the proxies (FFT-resampled), the same mix graph.
    let (tracks, settings) = mix
        .bounce_inputs(|id| {
            let proxy = request.project.join("cache/playback").join(format!("{id}.proxy"));
            if proxy.is_file() { Ok(proxy) } else { Err(format!("no proxy for {id}")) }
        })
        .expect("proxies");
    let started = Instant::now();
    let played = bounce(&tracks, settings, request.duration_seconds).expect("bounce");
    let bounce_seconds = started.elapsed().as_secs_f64();
    let exported = read_float_wav(&out.join(format!("{variant_name}-preserve-float-48k.wav")));
    let mut a = LoudnessMeter::new(48_000, 2);
    a.push(&exported);
    let mut b = LoudnessMeter::new(48_000, 2);
    b.push(&played);
    let (ra, rb) = (a.report(), b.report());
    let (lag, residual_db) = aligned_residual(&exported, &played);
    println!(
        "\nA/B before the loudness stage (48 kHz): source render {:.3} LUFS / {:.2} dBTP, proxy bounce {:.3} LUFS / {:.2} dBTP (bounce {:.1} s)\n  difference {:.3} LU; best alignment {lag} frames (the proxy's resampler delay); residual after alignment {residual_db:.1} dB under the signal",
        ra.integrated_lufs, ra.true_peak_dbtp, rb.integrated_lufs, rb.true_peak_dbtp, bounce_seconds, ra.integrated_lufs - rb.integrated_lufs
    );
}

fn read_float_wav(path: &Path) -> Vec<f32> {
    let bytes = std::fs::read(path).expect("wav");
    let data = bytes.windows(4).position(|window| window == b"data").expect("data chunk") + 8;
    bytes[data..].chunks_exact(4).map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]])).collect()
}

/// The lag (proxy minus source, frames) that lines the two renders up best over 20 s from 30 s in, and the residual
/// level there relative to the source render.
fn aligned_residual(source: &[f32], proxy: &[f32]) -> (i64, f64) {
    let start = 48_000 * 30;
    let length = 48_000 * 20;
    let mono = |data: &[f32], at: usize| 0.5 * (data[2 * at] + data[2 * at + 1]);
    let mut best = (0_i64, f64::MAX);
    for lag in -6_000_i64..=6_000 {
        let mut energy = 0.0_f64;
        for frame in (start..start + 48_000 * 2).step_by(3) {
            let other = (frame as i64 + lag) as usize;
            if 2 * other + 1 >= proxy.len() || 2 * frame + 1 >= source.len() {
                continue;
            }
            let difference = f64::from(mono(source, frame) - mono(proxy, other));
            energy += difference * difference;
        }
        if energy < best.1 {
            best = (lag, energy);
        }
    }
    let lag = best.0;
    let (mut signal, mut residual) = (0.0_f64, 0.0_f64);
    for frame in start..start + length {
        let other = (frame as i64 + lag) as usize;
        if 2 * other + 1 >= proxy.len() || 2 * frame + 1 >= source.len() {
            continue;
        }
        for channel in 0..2 {
            let a = f64::from(source[2 * frame + channel]);
            let b = f64::from(proxy[2 * other + channel]);
            signal += a * a;
            residual += (a - b) * (a - b);
        }
    }
    (lag, 10.0 * (signal / residual.max(1e-30)).log10())
}
