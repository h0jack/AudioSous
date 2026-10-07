//! Is the exported audio the modified mix? Renders a project's stems untouched and as saved (from the original
//! stems, through the export graph, no loudness stage), measures how much and where the saved mix differs, and
//! compares an exported file against both.
//!
//!   npx vite-node apps/desktop/scripts/mix-variants.ts -- PROJECT_DIR OUT.json
//!   cargo run --release -p audiosous-audio --example compare_mix -- OUT.json [EXPORTED_FILE]

use std::path::PathBuf;
use std::sync::atomic::AtomicBool;

use audiosous_audio::{render_mix, FrameSource, GraphTrack, LoudnessMeter, LoudnessReport, MixGraph, MixVariantSpec, SourceStream, TruePeakLimiter};
use realfft::RealFftPlanner;
use serde::Deserialize;

const RATE: u32 = 48_000;
const BANDS: [f64; 10] = [31.5, 63.0, 125.0, 250.0, 500.0, 1_000.0, 2_000.0, 4_000.0, 8_000.0, 16_000.0];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    duration_seconds: f64,
    sources: Vec<Source>,
    variants: std::collections::HashMap<String, MixVariantSpec>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Source {
    track_id: String,
    path: PathBuf,
}

fn render(request: &Request, mix: &MixVariantSpec) -> Vec<f32> {
    let (tracks, settings) = mix
        .bounce_inputs(|id| request.sources.iter().find(|source| source.track_id == id).map(|source| source.path.clone()).ok_or_else(|| format!("no source for {id}")))
        .unwrap();
    let mut sources: Vec<Box<dyn FrameSource>> = tracks.iter().map(|track| Box::new(SourceStream::open(&track.proxy, RATE).unwrap()) as Box<dyn FrameSource>).collect();
    let graph_tracks: Vec<GraphTrack> = tracks.iter().map(|track| GraphTrack { id: track.id.clone(), gain_db: track.gain_db, muted: track.muted }).collect();
    let mut graph = MixGraph::new(&graph_tracks, settings, RATE);
    let mut out = Vec::new();
    render_mix(&mut sources, &mut graph, RATE, request.duration_seconds, &AtomicBool::new(false), &mut |chunk| {
        out.extend_from_slice(chunk);
        Ok(())
    }, &mut |_| {})
    .unwrap();
    out
}

fn loudness(audio: &[f32]) -> LoudnessReport {
    let mut meter = LoudnessMeter::new(RATE, 2);
    meter.push(audio);
    meter.report()
}

/// Long-term average spectrum in octave bands (Welch, 8192-point Hann), dB of mean power per band.
fn octaves(audio: &[f32]) -> Vec<f64> {
    let size = 8_192;
    let mut planner = RealFftPlanner::<f64>::new();
    let fft = planner.plan_fft_forward(size);
    let window: Vec<f64> = (0..size).map(|n| 0.5 - 0.5 * (2.0 * std::f64::consts::PI * n as f64 / size as f64).cos()).collect();
    let mut power = vec![0.0_f64; size / 2 + 1];
    let mut input = fft.make_input_vec();
    let mut output = fft.make_output_vec();
    let frames = audio.len() / 2;
    let mut count = 0;
    let mut start = 0;
    while start + size <= frames {
        for n in 0..size {
            input[n] = 0.5 * f64::from(audio[2 * (start + n)] + audio[2 * (start + n) + 1]) * window[n];
        }
        fft.process(&mut input, &mut output).unwrap();
        for (bin, value) in output.iter().enumerate() {
            power[bin] += value.norm_sqr();
        }
        count += 1;
        start += size / 2;
    }
    BANDS
        .iter()
        .map(|center| {
            let (low, high) = (center / 2_f64.sqrt(), center * 2_f64.sqrt());
            let bins: Vec<f64> = (0..power.len()).filter(|bin| {
                let hz = *bin as f64 * f64::from(RATE) / size as f64;
                hz >= low && hz < high
            }).map(|bin| power[bin] / count.max(1) as f64).collect();
            10.0 * (bins.iter().sum::<f64>().max(1e-30)).log10()
        })
        .collect()
}

fn decode(path: &std::path::Path) -> (u32, Vec<f32>) {
    use symphonia::core::audio::SampleBuffer;
    let file = std::fs::File::open(path).unwrap();
    let stream = symphonia::core::io::MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = symphonia::core::probe::Hint::new();
    if let Some(extension) = path.extension().and_then(|value| value.to_str()) {
        hint.with_extension(extension);
    }
    let probed = symphonia::default::get_probe().format(&hint, stream, &symphonia::core::formats::FormatOptions { enable_gapless: true, ..Default::default() }, &Default::default()).unwrap();
    let mut format = probed.format;
    let track = format.default_track().unwrap().clone();
    let rate = track.codec_params.sample_rate.unwrap();
    let mut decoder = symphonia::default::get_codecs().make(&track.codec_params, &Default::default()).unwrap();
    let mut out = Vec::new();
    while let Ok(packet) = format.next_packet() {
        let decoded = decoder.decode(&packet).unwrap();
        let mut buffer = SampleBuffer::<f32>::new(decoded.capacity() as u64, *decoded.spec());
        buffer.copy_interleaved_ref(decoded);
        out.extend_from_slice(buffer.samples());
    }
    (rate, out)
}

fn rms_db(audio: &[f32]) -> f64 {
    let sum: f64 = audio.iter().map(|value| f64::from(*value) * f64::from(*value)).sum();
    10.0 * (sum / audio.len().max(1) as f64).max(1e-30).log10()
}

/// Residual after the best single gain between `a` and `b`, dB under `a` (higher = more alike).
fn likeness(a: &[f32], b: &[f32]) -> f64 {
    let n = a.len().min(b.len());
    let (mut ab, mut bb, mut aa) = (0.0_f64, 0.0_f64, 0.0_f64);
    for i in 0..n {
        ab += f64::from(a[i]) * f64::from(b[i]);
        bb += f64::from(b[i]) * f64::from(b[i]);
        aa += f64::from(a[i]) * f64::from(a[i]);
    }
    let gain = ab / bb.max(1e-30);
    let residual: f64 = (0..n).map(|i| (f64::from(a[i]) - gain * f64::from(b[i])).powi(2)).sum();
    10.0 * (aa / residual.max(1e-30)).log10()
}

fn print_row(label: &str, report: &LoudnessReport, audio: &[f32]) {
    println!(
        "  {label:<22} {:>7.2} LUFS  true peak {:>6.2} dBTP  RMS {:>6.2} dB  peak-to-loudness {:>5.1} dB  LRA {:>4.1} LU",
        report.integrated_lufs, report.true_peak_dbtp, rms_db(audio), report.true_peak_dbtp - report.integrated_lufs, report.loudness_range_lu
    );
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).filter(|arg| arg != "--").collect();
    let request: Request = serde_json::from_str(&std::fs::read_to_string(&args[0]).unwrap()).unwrap();
    let untouched = render(&request, &request.variants["untouched"]);
    let saved = render(&request, &request.variants["saved"]);
    let (lu, ls) = (loudness(&untouched), loudness(&saved));
    println!("Renders from the original stems at 48 kHz, no loudness stage ({:.1} s):", request.duration_seconds);
    print_row("stems untouched", &lu, &untouched);
    print_row("saved mix", &ls, &saved);
    let difference: Vec<f32> = saved.iter().zip(untouched.iter()).map(|(a, b)| a - b).collect();
    println!("\nThe saved mix differs from the untouched stems by a signal {:.1} dB under the music (0 dB = as loud as the music).", rms_db(&untouched) - rms_db(&difference));
    let (bu, bs, bd) = (octaves(&untouched), octaves(&saved), octaves(&difference));
    let offset = ls.integrated_lufs - lu.integrated_lufs;
    println!("\nOctave bands, saved minus untouched (raw / loudness-matched by {:+.2} dB) and the difference signal under the music:", offset);
    for (index, center) in BANDS.iter().enumerate() {
        println!("  {:>7} Hz  {:+6.2} dB  {:+6.2} dB   change {:>5.1} dB under", center, bs[index] - bu[index], bs[index] - bu[index] - offset, bu[index] - bd[index]);
    }
    if let Some(file) = args.get(1) {
        let path = PathBuf::from(file);
        let (rate, exported) = decode(&path);
        println!("\nExported file {} ({rate} Hz, {:.1} s):", path.display(), exported.len() as f64 / 2.0 / f64::from(rate));
        if rate != RATE {
            println!("  (not 48 kHz; band and likeness comparisons skipped)");
            return;
        }
        let le = loudness(&exported);
        print_row("exported", &le, &exported);
        println!("  Likeness after one gain (higher = closer): to the saved mix {:.1} dB, to the untouched stems {:.1} dB", likeness(&exported, &saved), likeness(&exported, &untouched));
        // The same distribution stage on both renders: whichever the file matches is what was exported.
        let master = |audio: &[f32], reference: &LoudnessReport| {
            let gain = 10_f32.powf(((le.integrated_lufs - reference.integrated_lufs) / 20.0) as f32);
            let scaled: Vec<f32> = audio.iter().map(|value| value * gain).collect();
            let mut limiter = TruePeakLimiter::new(RATE, 2, -1.0);
            let mut out = Vec::with_capacity(scaled.len());
            limiter.process(&scaled, &mut out);
            limiter.flush(&mut out);
            (out, limiter.stats().max_reduction_db)
        };
        let (saved_master, saved_reduction) = master(&saved, &ls);
        let (untouched_master, _) = master(&untouched, &lu);
        println!("  Both renders through the same gain and limiter (saved needed up to {saved_reduction:.1} dB): the file matches the saved mix to {:.1} dB, the untouched stems to {:.1} dB", likeness(&exported, &saved_master), likeness(&exported, &untouched_master));
        let be = octaves(&exported);
        let shift = le.integrated_lufs - ls.integrated_lufs;
        println!("  Octave bands, exported minus saved mix, loudness-matched (what the export stage and encoder changed):");
        for (index, center) in BANDS.iter().enumerate() {
            println!("    {:>7} Hz  {:+6.2} dB", center, be[index] - bs[index] - shift);
        }
    }
}
