//! Acceptance harness for dynamics: runs every row's proxy check and bounces each audition variant through the
//! native DSP, from the files `plan-dynamics-project.ts` writes.
//!
//!   cargo run --release -p audiosous-audio --example bounce_mix -- OUT_DIR [--wav]
//!
//! Reads OUT_DIR/checks.json and OUT_DIR/bounce.json. Prints predicted against measured numbers for each row,
//! and level statistics for each variant (Current, Dynamics Candidate, level-matched candidate, reviewed).
//! With --wav it writes OUT_DIR/<variant>.wav (32-bit float, 48 kHz) for listening.

use std::path::{Path, PathBuf};
use std::time::Instant;

use audiosous_audio::{
    bounce, check_dynamics, BounceSettings, BounceTrack, DynKind, DynamicsCheckInput, DynamicsNodeSpec, FilterSpec, TrackDynamics, TrackDynamicsRegion, TrackEq, TrackEqRegion,
    TrackGainRegion, TrackSpatial, TrackSpatialRegion,
};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Checks {
    project: PathBuf,
    requests: Vec<CheckRequest>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CheckRequest {
    id: String,
    track_id: String,
    key_track_id: Option<String>,
    windows: Vec<(f64, f64)>,
    saved_eq: Vec<FilterSpec>,
    before: Vec<DynamicsNodeSpec>,
    after: Vec<DynamicsNodeSpec>,
    kind: String,
    band: Option<(f32, f32)>,
    predicted: serde_json::Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Bounce {
    project: PathBuf,
    duration_seconds: f64,
    variants: Vec<Variant>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Variant {
    name: String,
    tracks: Vec<VariantTrack>,
    gain_regions: Vec<GainRegionDto>,
    eq: Vec<EqDto>,
    spatial: Vec<SpatialDto>,
    dynamics: Vec<DynamicsDto>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VariantTrack {
    id: String,
    gain_db: f32,
    muted: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GainRegionDto {
    track_id: String,
    start_seconds: f64,
    end_seconds: f64,
    gain_db: f32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EqDto {
    track_id: String,
    filters: Vec<FilterSpec>,
    regions: Vec<EqRegionDto>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EqRegionDto {
    start_seconds: f64,
    end_seconds: f64,
    filters: Vec<FilterSpec>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SpatialDto {
    track_id: String,
    pan: f32,
    width: f32,
    regions: Vec<SpatialRegionDto>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SpatialRegionDto {
    start_seconds: f64,
    end_seconds: f64,
    pan: f32,
    width: f32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DynamicsDto {
    track_id: String,
    nodes: Vec<DynamicsNodeSpec>,
    regions: Vec<DynamicsRegionDto>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DynamicsRegionDto {
    start_seconds: f64,
    end_seconds: f64,
    nodes: Vec<DynamicsNodeSpec>,
}

fn proxy(project: &Path, track_id: &str) -> PathBuf {
    project.join("cache/playback").join(format!("{track_id}.proxy"))
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).filter(|arg| arg != "--").collect();
    let out = PathBuf::from(args.iter().find(|arg| !arg.starts_with("--")).expect("output folder"));
    let wav = args.iter().any(|arg| arg == "--wav");

    let checks: Checks = serde_json::from_str(&std::fs::read_to_string(out.join("checks.json")).expect("checks.json")).expect("checks JSON");
    let mut results = Vec::new();
    println!("Proxy checks (native dynamics on the 48 kHz playback proxies):");
    for request in &checks.requests {
        let key = request.key_track_id.clone();
        let resolve = |nodes: &[DynamicsNodeSpec]| nodes.iter().filter_map(|node| node.resolve(usize::MAX, |id| (key.as_deref() == Some(id)).then_some(0))).collect::<Vec<_>>();
        let kind = match request.kind.as_str() {
            "compressor" => DynKind::Compressor,
            "ducking" => DynKind::Ducking,
            "dynamic-eq" => DynKind::DynamicEq,
            _ => DynKind::Transient,
        };
        let key_proxy = request.key_track_id.as_ref().map(|id| proxy(&checks.project, id));
        let tick = Instant::now();
        let measured = check_dynamics(&DynamicsCheckInput {
            proxy: &proxy(&checks.project, &request.track_id),
            key_proxy: key_proxy.as_deref(),
            windows: &request.windows,
            saved_eq: &request.saved_eq,
            before: &resolve(&request.before),
            after: &resolve(&request.after),
            kind,
            band: request.band,
            max_seconds: 30.0,
        });
        match measured {
            Ok(check) => {
                let p = &request.predicted;
                let number = |key: &str| p.get(key).and_then(|value| value.as_f64());
                println!("\n  {} ({} s read in {:?})", request.id, check.seconds.round(), tick.elapsed());
                println!(
                    "    reduction p50/p95/max: predicted {:.1}/{:.1}/{:.1} dB, measured {:.1}/{:.1}/{:.1} dB",
                    number("reductionP50Db").unwrap_or(0.0),
                    number("reductionP95Db").unwrap_or(0.0),
                    number("reductionMaxDb").unwrap_or(0.0),
                    check.reduction_p50_db,
                    check.reduction_p95_db,
                    check.reduction_max_db
                );
                println!("    level: predicted {:+.2} dB, measured {:+.2} dB", number("levelChangeDb").unwrap_or(0.0), check.after.rms_db - check.before.rms_db);
                if kind == DynKind::Compressor {
                    println!(
                        "    sustained spread: predicted {:.1} → {:.1} dB, measured {:.1} → {:.1} dB; crest measured {:.1} → {:.1} dB",
                        number("spreadBeforeDb").unwrap_or(0.0),
                        number("spreadAfterDb").unwrap_or(0.0),
                        check.before.p90_db - check.before.p10_db,
                        check.after.p90_db - check.after.p10_db,
                        check.before.crest_db,
                        check.after.crest_db
                    );
                }
                if let (Some(before), Some(after)) = (check.before.band_on_db, check.after.band_on_db) {
                    let off = match (check.before.band_off_db, check.after.band_off_db) {
                        (Some(b), Some(a)) => a - b,
                        _ => 0.0,
                    };
                    println!(
                        "    band {:?} while the key plays {:+.2} dB, while it rests {:+.2} dB; key plays {:.0}% of the time; recovered {:.0}% of key-off time",
                        request.band.unwrap_or((0.0, 0.0)),
                        after - before,
                        off,
                        100.0 * check.key_on_share.unwrap_or(0.0),
                        100.0 * check.recovered_share.unwrap_or(0.0)
                    );
                }
                if let (DynKind::Transient, Some(before), Some(after)) = (kind, check.before.transient_db, check.after.transient_db) {
                    println!(
                        "    attack over body: predicted {:.1} → {:.1} dB (10 ms model), measured {:.1} → {:.1} dB (1 ms)",
                        number("transientBeforeDb").unwrap_or(0.0),
                        number("transientAfterDb").unwrap_or(0.0),
                        before,
                        after
                    );
                }
                results.push(serde_json::json!({ "id": request.id, "result": check }));
            }
            Err(error) => {
                println!("\n  {}: could not be checked: {error}", request.id);
                results.push(serde_json::json!({ "id": request.id, "error": error }));
            }
        }
    }
    std::fs::write(out.join("checks-result.json"), serde_json::to_string_pretty(&results).unwrap()).unwrap();

    let plan: Bounce = serde_json::from_str(&std::fs::read_to_string(out.join("bounce.json")).expect("bounce.json")).expect("bounce JSON");
    println!("\nBounces (native DSP from the playback proxies, {:.1} s):", plan.duration_seconds);
    for variant in plan.variants {
        let tracks: Vec<BounceTrack> = variant.tracks.iter().map(|track| BounceTrack { id: track.id.clone(), proxy: proxy(&plan.project, &track.id), gain_db: track.gain_db, muted: track.muted }).collect();
        let settings = BounceSettings {
            eq: variant
                .eq
                .into_iter()
                .map(|track| TrackEq {
                    track_id: track.track_id,
                    filters: track.filters,
                    regions: track.regions.into_iter().map(|region| TrackEqRegion { start_seconds: region.start_seconds, end_seconds: region.end_seconds, filters: region.filters }).collect(),
                })
                .collect(),
            spatial: variant
                .spatial
                .into_iter()
                .map(|track| TrackSpatial {
                    track_id: track.track_id,
                    pan: track.pan,
                    width: track.width,
                    regions: track
                        .regions
                        .into_iter()
                        .map(|region| TrackSpatialRegion { start_seconds: region.start_seconds, end_seconds: region.end_seconds, pan: region.pan, width: region.width })
                        .collect(),
                })
                .collect(),
            dynamics: variant
                .dynamics
                .into_iter()
                .map(|track| TrackDynamics {
                    track_id: track.track_id,
                    nodes: track.nodes,
                    regions: track.regions.into_iter().map(|region| TrackDynamicsRegion { start_seconds: region.start_seconds, end_seconds: region.end_seconds, nodes: region.nodes }).collect(),
                })
                .collect(),
            gain_regions: variant
                .gain_regions
                .into_iter()
                .map(|region| TrackGainRegion { track_id: region.track_id, start_seconds: region.start_seconds, end_seconds: region.end_seconds, gain_db: region.gain_db })
                .collect(),
        };
        let tick = Instant::now();
        let audio = bounce(&tracks, settings, plan.duration_seconds).expect("bounce");
        let elapsed = tick.elapsed();
        let peak = audio.iter().fold(0.0_f32, |max, value| max.max(value.abs()));
        let power = audio.iter().map(|value| f64::from(*value).powi(2)).sum::<f64>() / audio.len().max(1) as f64;
        let rms = 10.0 * power.max(1e-20).log10();
        let peak_db = 20.0 * f64::from(peak).max(1e-10).log10();
        // Short-term (400 ms) level spread of the whole mix: p90 − p10 where it plays.
        let window = 48_000 * 2 * 4 / 10;
        let mut levels: Vec<f64> = audio.chunks(window).map(|chunk| 10.0 * (chunk.iter().map(|value| f64::from(*value).powi(2)).sum::<f64>() / chunk.len() as f64).max(1e-20).log10()).filter(|db| *db > -60.0).collect();
        levels.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let pick = |share: f64| levels.get(((levels.len().max(1) - 1) as f64 * share).round() as usize).copied().unwrap_or(-100.0);
        // Mono fold-down: stereo power against the power of (L + R) / 2, and the channel correlation.
        let (mut l2, mut r2, mut lr, mut m2) = (0.0_f64, 0.0_f64, 0.0_f64, 0.0_f64);
        for pair in audio.chunks_exact(2) {
            let (l, r) = (f64::from(pair[0]), f64::from(pair[1]));
            l2 += l * l;
            r2 += r * r;
            lr += l * r;
            m2 += 0.25 * (l + r) * (l + r);
        }
        let mono_loss = 10.0 * (0.5 * (l2 + r2)).max(1e-20).log10() - 10.0 * m2.max(1e-20).log10();
        let correlation = if l2 > 0.0 && r2 > 0.0 { lr / (l2 * r2).sqrt() } else { 1.0 };
        println!(
            "  {:<22} peak {:+.2} dBFS, RMS {:.2} dB, crest {:.1} dB, 400 ms level spread {:.1} dB, mono loss {:.2} dB, correlation {:.3} ({:?})",
            variant.name,
            peak_db,
            rms,
            peak_db - rms,
            pick(0.9) - pick(0.1),
            mono_loss,
            correlation,
            elapsed
        );
        if wav {
            write_wav(&out.join(format!("{}.wav", variant.name)), &audio);
        }
    }
    if wav {
        println!("\nWrote the bounces to {}", out.display());
    }
}

fn write_wav(path: &Path, samples: &[f32]) {
    let data = (samples.len() * 4) as u32;
    let mut body = Vec::with_capacity(44 + samples.len() * 4);
    body.extend_from_slice(b"RIFF");
    body.extend_from_slice(&(36 + data).to_le_bytes());
    body.extend_from_slice(b"WAVEfmt ");
    body.extend_from_slice(&16_u32.to_le_bytes());
    body.extend_from_slice(&3_u16.to_le_bytes());
    body.extend_from_slice(&2_u16.to_le_bytes());
    body.extend_from_slice(&48_000_u32.to_le_bytes());
    body.extend_from_slice(&(48_000_u32 * 8).to_le_bytes());
    body.extend_from_slice(&8_u16.to_le_bytes());
    body.extend_from_slice(&32_u16.to_le_bytes());
    body.extend_from_slice(b"data");
    body.extend_from_slice(&data.to_le_bytes());
    for sample in samples {
        body.extend_from_slice(&sample.to_le_bytes());
    }
    std::fs::write(path, body).expect("write WAV");
}
