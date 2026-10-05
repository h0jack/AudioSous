//! Time-resolved stereo statistics for spatial planning, measured from the 48 kHz playback proxy.
//!
//! The analysis sidecar reports one balance, correlation, and mid/side figure per stem. Spatial
//! planning needs to know where a stem sits while it plays against another one, and in which
//! frequency range, so this measures second-order stereo statistics per frame and per band: left
//! power, right power, and the left/right correlation. Those three numbers are enough to predict
//! exactly (for the averaged statistics) what a width or balance change does to a stem's position,
//! image width, correlation, and mono fold-down, without touching the audio again.
//!
//! Frames use the EQ band measurement's grid (`max(0.25 s, duration / 360)`). Bands are the planner's
//! 24 log bands taken three at a time: 8 bands from 20 Hz to 20 kHz.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use realfft::RealFftPlanner;

use crate::bands::{band_edges, BandsIdentity};
use crate::proxy::{ProxyReader, PLAYBACK_RATE};

/// Bump when any number this produces would no longer compare with an older cache.
pub const STEREO_VERSION: u32 = 1;
pub const STEREO_BANDS: usize = 8;
const FFT_SIZE: usize = 8_192;
const HOP: usize = FFT_SIZE / 2;
const MAX_FRAMES: usize = 360;
const MIN_FRAME_SECONDS: f64 = 0.25;
const FLOOR_DB: f32 = -200.0;

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StereoFrames {
    pub version: u32,
    pub sample_rate: u32,
    /// Channels in the proxy. A mono proxy reports identical left and right and correlation 1.
    pub channels: u16,
    pub duration_seconds: f64,
    pub hop_seconds: f64,
    pub edges_hz: Vec<f64>,
    /// One row per frame, one value per band: mean-square power in dB, floored at -200.
    pub left_db: Vec<Vec<f32>>,
    pub right_db: Vec<Vec<f32>>,
    /// Re(Σ L·R*) / √(Σ|L|² Σ|R|²) per frame and band, −1 … +1. 1 where the band is silent.
    pub correlation: Vec<Vec<f32>>,
}

pub fn stereo_band_edges() -> Vec<f64> {
    band_edges(STEREO_BANDS * 3).into_iter().step_by(3).collect()
}

pub fn measure_stereo_frames(proxy: &Path, cancel: &AtomicBool) -> Result<StereoFrames, String> {
    let (header, mut reader) = ProxyReader::open(proxy)?;
    let channels = usize::from(header.channels).max(1);
    let total = header.frames as usize;
    let rate = f64::from(PLAYBACK_RATE);
    let duration = total as f64 / rate;
    let frame_seconds = (duration / MAX_FRAMES as f64).max(MIN_FRAME_SECONDS);
    let frame_len = ((frame_seconds * rate) as usize).max(1);
    let frame_count = total.div_ceil(frame_len).max(1);

    let mut planner = RealFftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(FFT_SIZE);
    let mut input = fft.make_input_vec();
    let mut left_spectrum = fft.make_output_vec();
    let mut right_spectrum = fft.make_output_vec();
    let window: Vec<f32> = (0..FFT_SIZE)
        .map(|index| (0.5 - 0.5 * (2.0 * std::f64::consts::PI * index as f64 / FFT_SIZE as f64).cos()) as f32)
        .collect();
    let window_power: f64 = window.iter().map(|value| f64::from(*value).powi(2)).sum();
    let scale = 2.0 / (FFT_SIZE as f64 * window_power);
    let bin_hz = rate / FFT_SIZE as f64;
    let edges = stereo_band_edges();
    let band_of: Vec<Option<usize>> = (0..left_spectrum.len()).map(|bin| locate(&edges, bin as f64 * bin_hz)).collect();

    // Per frame and band: left power, right power, cross power.
    let mut sums = vec![[[0.0_f64; 3]; STEREO_BANDS]; frame_count];
    let mut left: Vec<f32> = Vec::with_capacity(FFT_SIZE * 2);
    let mut right: Vec<f32> = Vec::with_capacity(FFT_SIZE * 2);
    let mut position = 0_usize;
    let mut segment_start = 0_usize;
    let mut block = Vec::with_capacity(HOP * 4 * channels);
    while position < total {
        if cancel.load(Ordering::Relaxed) {
            return Err("Stereo measurement was cancelled.".into());
        }
        let got = reader.read_interleaved((total - position).min(HOP * 4), &mut block)?;
        if got == 0 {
            break;
        }
        for frame in block[..got * channels].chunks(channels) {
            left.push(frame[0]);
            right.push(if channels >= 2 { frame[1] } else { frame[0] });
        }
        position += got;
        while left.len() >= FFT_SIZE {
            for (index, slot) in input.iter_mut().enumerate() {
                *slot = left[index] * window[index];
            }
            fft.process(&mut input, &mut left_spectrum).map_err(|error| error.to_string())?;
            for (index, slot) in input.iter_mut().enumerate() {
                *slot = right[index] * window[index];
            }
            fft.process(&mut input, &mut right_spectrum).map_err(|error| error.to_string())?;
            let center = segment_start + FFT_SIZE / 2;
            let target = (center / frame_len).min(frame_count - 1);
            for (bin, (l, r)) in left_spectrum.iter().zip(right_spectrum.iter()).enumerate() {
                let Some(band) = band_of[bin] else { continue };
                let cell = &mut sums[target][band];
                cell[0] += f64::from(l.norm_sqr()) * scale;
                cell[1] += f64::from(r.norm_sqr()) * scale;
                cell[2] += f64::from(l.re * r.re + l.im * r.im) * scale;
            }
            left.drain(..HOP);
            right.drain(..HOP);
            segment_start += HOP;
        }
    }
    let to_db = |power: f64| -> f32 {
        if power <= 1e-20 || !power.is_finite() {
            FLOOR_DB
        } else {
            (((10.0 * power.log10()) as f32).max(FLOOR_DB) * 100.0).round() / 100.0
        }
    };
    let mut left_db = Vec::with_capacity(frame_count);
    let mut right_db = Vec::with_capacity(frame_count);
    let mut correlation = Vec::with_capacity(frame_count);
    for frame in &sums {
        left_db.push(frame.iter().map(|cell| to_db(cell[0])).collect());
        right_db.push(frame.iter().map(|cell| to_db(cell[1])).collect());
        correlation.push(frame.iter().map(|cell| correlation_of(cell[0], cell[1], cell[2])).collect());
    }
    Ok(StereoFrames {
        version: STEREO_VERSION,
        sample_rate: PLAYBACK_RATE,
        channels: header.channels,
        duration_seconds: duration,
        hop_seconds: frame_len as f64 / rate,
        edges_hz: edges.iter().map(|edge| (edge * 100.0).round() / 100.0).collect(),
        left_db,
        right_db,
        correlation,
    })
}

fn correlation_of(left: f64, right: f64, cross: f64) -> f32 {
    let norm = (left * right).sqrt();
    if norm <= 1e-20 || !norm.is_finite() {
        return 1.0;
    }
    (((cross / norm).clamp(-1.0, 1.0) as f32) * 1_000.0).round() / 1_000.0
}

/// Stereo frames for one track from `cache/analysis/<trackId>__stereo.json`, measured again when the
/// source, the proxy format, or this measurement changed. Returns the cache file's JSON text.
pub fn cached_stereo_frames(bundle: &Path, track_id: &str, source: &Path, cancel: &AtomicBool) -> Result<String, String> {
    let proxy_name = crate::proxy::proxy_file_name(track_id)?;
    let meta = std::fs::metadata(source).map_err(|error| error.to_string())?;
    let modified = meta
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| u64::try_from(duration.as_nanos()).unwrap_or(u64::MAX))
        .unwrap_or(0);
    let identity = BandsIdentity {
        version: STEREO_VERSION,
        source_size: meta.len(),
        source_modified_ns: modified.to_string(),
        proxy_version: crate::proxy::PROXY_VERSION,
        resampler_id: crate::proxy::RESAMPLER_ID,
    };
    let cache_dir = bundle.join("cache").join("analysis");
    let cache = cache_dir.join(format!("{}__stereo.json", proxy_name.trim_end_matches(".proxy")));
    if let Ok(text) = std::fs::read_to_string(&cache) {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
            let cached: Option<BandsIdentity> = value.get("identity").and_then(|item| serde_json::from_value(item.clone()).ok());
            if cached.as_ref() == Some(&identity) {
                return Ok(text);
            }
        }
    }
    let proxy = bundle.join("cache").join("playback").join(&proxy_name);
    crate::proxy::ensure_proxy(source, &proxy, meta.len(), modified, cancel, &mut |_| {})?;
    let frames = measure_stereo_frames(&proxy, cancel)?;
    let text = serde_json::to_string(&serde_json::json!({ "kind": "stereo-frames", "identity": identity, "stereo": frames }))
        .map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&cache_dir).map_err(|error| error.to_string())?;
    let temporary = cache.with_extension("json.tmp");
    std::fs::write(&temporary, &text).map_err(|error| error.to_string())?;
    std::fs::rename(&temporary, &cache).map_err(|error| error.to_string())?;
    Ok(text)
}

fn locate(edges: &[f64], hz: f64) -> Option<usize> {
    if hz < edges[0] || hz >= edges[edges.len() - 1] {
        return None;
    }
    edges.windows(2).position(|pair| hz >= pair[0] && hz < pair[1])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proxy::ensure_proxy;

    fn write_wav(path: &Path, channels: u16, frames: usize, sample: impl Fn(usize) -> (f32, f32)) {
        let bytes = 4 * usize::from(channels);
        let mut body = Vec::with_capacity(44 + frames * bytes);
        let data = (frames * bytes) as u32;
        body.extend_from_slice(b"RIFF");
        body.extend_from_slice(&(36 + data).to_le_bytes());
        body.extend_from_slice(b"WAVEfmt ");
        body.extend_from_slice(&16_u32.to_le_bytes());
        body.extend_from_slice(&3_u16.to_le_bytes());
        body.extend_from_slice(&channels.to_le_bytes());
        body.extend_from_slice(&48_000_u32.to_le_bytes());
        body.extend_from_slice(&(48_000 * bytes as u32).to_le_bytes());
        body.extend_from_slice(&(bytes as u16).to_le_bytes());
        body.extend_from_slice(&32_u16.to_le_bytes());
        body.extend_from_slice(b"data");
        body.extend_from_slice(&data.to_le_bytes());
        for frame in 0..frames {
            let (left, right) = sample(frame);
            body.extend_from_slice(&left.to_le_bytes());
            if channels == 2 {
                body.extend_from_slice(&right.to_le_bytes());
            }
        }
        std::fs::write(path, body).unwrap();
    }

    /// SplitMix64 per sample, so different seeds give independent channels.
    fn noise(seed: u32) -> impl Fn(usize) -> f32 {
        move |index| {
            let mut x = (index as u64).wrapping_add(u64::from(seed) << 32).wrapping_mul(0x9e37_79b9_7f4a_7c15);
            x ^= x >> 30;
            x = x.wrapping_mul(0xbf58_476d_1ce4_e5b9);
            x ^= x >> 27;
            x = x.wrapping_mul(0x94d0_49bb_1331_11eb);
            x ^= x >> 31;
            ((x >> 40) as f32 / (1_u64 << 24) as f32 - 0.5) * 0.5
        }
    }

    fn measure(name: &str, channels: u16, sample: impl Fn(usize) -> (f32, f32)) -> StereoFrames {
        let dir = std::env::temp_dir().join(format!("audiosous-stereo-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let source = dir.join("source.wav");
        write_wav(&source, channels, 48_000 * 6, sample);
        let proxy = dir.join("source.proxy");
        ensure_proxy(&source, &proxy, 1, 1, &AtomicBool::new(false), &mut |_| {}).unwrap();
        let frames = measure_stereo_frames(&proxy, &AtomicBool::new(false)).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        frames
    }

    fn mid_frame(frames: &StereoFrames) -> usize {
        frames.left_db.len() / 2
    }

    #[test]
    fn identical_channels_read_as_centered_and_fully_correlated() {
        let source = noise(3);
        let frames = measure("same", 2, move |index| (source(index), source(index)));
        let at = mid_frame(&frames);
        assert_eq!(frames.edges_hz.len(), STEREO_BANDS + 1);
        for band in 2..STEREO_BANDS {
            assert!((frames.left_db[at][band] - frames.right_db[at][band]).abs() < 0.01);
            assert!(frames.correlation[at][band] > 0.999, "band {band}: {}", frames.correlation[at][band]);
        }
    }

    #[test]
    fn independent_channels_read_as_decorrelated_and_antiphase_as_negative() {
        let (left, right) = (noise(5), noise(9));
        let frames = measure("wide", 2, move |index| (left(index), right(index)));
        let at = mid_frame(&frames);
        for band in 3..STEREO_BANDS {
            assert!(frames.correlation[at][band].abs() < 0.15, "band {band}: {}", frames.correlation[at][band]);
        }
        let source = noise(11);
        let frames = measure("anti", 2, move |index| (source(index), -source(index)));
        let at = mid_frame(&frames);
        assert!(frames.correlation[at][5] < -0.999);
    }

    #[test]
    fn a_left_heavy_stem_and_a_mono_stem() {
        let source = noise(13);
        // Right channel 6 dB under the left.
        let frames = measure("left", 2, move |index| (source(index), 0.5 * source(index)));
        let at = mid_frame(&frames);
        assert!((frames.left_db[at][5] - frames.right_db[at][5] - 6.02).abs() < 0.05);
        let mono = noise(17);
        let frames = measure("mono", 1, move |index| (mono(index), 0.0));
        assert_eq!(frames.channels, 1);
        let at = mid_frame(&frames);
        assert_eq!(frames.left_db[at], frames.right_db[at]);
        assert!(frames.correlation[at].iter().all(|value| *value > 0.999));
    }
}
