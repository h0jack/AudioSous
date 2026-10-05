//! Time-resolved band levels for EQ planning, measured from the 48 kHz playback proxy.
//!
//! The analysis sidecar's spectrogram is drawn for the eye: at 192 kHz its FFT bins are 187 Hz
//! wide, so everything under ~280 Hz lands in one band. EQ decisions about kick, bass, and
//! low-mid need real low-frequency resolution, so this measures the proxy with 8192-point FFTs
//! (5.9 Hz bins at 48 kHz), averages them into the planner's 24 log bands per frame, and keeps a
//! finer whole-file spectrum for placing a filter inside a band. It reads the proxy once, in
//! blocks, and never the original source.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use realfft::RealFftPlanner;

use crate::proxy::{ProxyReader, PLAYBACK_RATE};

/// Bump when any number this produces would no longer compare with an older cache.
pub const BANDS_VERSION: u32 = 1;
pub const BAND_COUNT: usize = 24;
pub const FINE_BINS: usize = 96;
const FFT_SIZE: usize = 8_192;
const HOP: usize = FFT_SIZE / 2;
const MAX_FRAMES: usize = 360;
const MIN_FRAME_SECONDS: f64 = 0.25;
const LOW_HZ: f64 = 20.0;
const HIGH_HZ: f64 = 20_000.0;
const FLOOR_DB: f32 = -200.0;

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BandFrames {
    pub version: u32,
    pub sample_rate: u32,
    pub duration_seconds: f64,
    pub hop_seconds: f64,
    pub edges_hz: Vec<f64>,
    /// One row per frame: band power in dB (mean square in the band, mono mid), floored at -200.
    pub frames: Vec<Vec<f32>>,
    /// Whole-file power per fine log bin, dB, at these centers.
    pub fine_hz: Vec<f64>,
    pub fine_db: Vec<f32>,
}

pub fn band_edges(count: usize) -> Vec<f64> {
    (0..=count)
        .map(|index| LOW_HZ * (HIGH_HZ / LOW_HZ).powf(index as f64 / count as f64))
        .collect()
}

pub fn measure_band_frames(proxy: &Path, cancel: &AtomicBool) -> Result<BandFrames, String> {
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
    let mut spectrum = fft.make_output_vec();
    let window: Vec<f32> = (0..FFT_SIZE)
        .map(|index| (0.5 - 0.5 * (2.0 * std::f64::consts::PI * index as f64 / FFT_SIZE as f64).cos()) as f32)
        .collect();
    let window_power: f64 = window.iter().map(|value| f64::from(*value).powi(2)).sum();
    // One-sided power per bin so the bins of one segment sum to its mean square.
    let scale = 2.0 / (FFT_SIZE as f64 * window_power);
    let bin_hz = rate / FFT_SIZE as f64;
    let edges = band_edges(BAND_COUNT);
    let fine_edges = band_edges(FINE_BINS);
    let band_of: Vec<Option<usize>> = (0..spectrum.len()).map(|bin| locate(&edges, bin as f64 * bin_hz)).collect();
    let fine_of: Vec<Option<usize>> = (0..spectrum.len()).map(|bin| locate(&fine_edges, bin as f64 * bin_hz)).collect();

    let mut frame_power = vec![vec![0.0_f64; BAND_COUNT]; frame_count];
    let mut frame_segments = vec![0_u32; frame_count];
    let mut fine_power = vec![0.0_f64; FINE_BINS];
    let mut fine_segments = 0_u32;

    // Mono mid, read in blocks into a sliding buffer of one FFT.
    let mut mono: Vec<f32> = Vec::with_capacity(FFT_SIZE * 2);
    let mut position = 0_usize;
    let mut segment_start = 0_usize;
    let mut block = Vec::with_capacity(HOP * 4 * channels);
    while position < total {
        if cancel.load(Ordering::Relaxed) {
            return Err("Band measurement was cancelled.".into());
        }
        let got = reader.read_interleaved((total - position).min(HOP * 4), &mut block)?;
        if got == 0 {
            break;
        }
        for frame in block[..got * channels].chunks(channels) {
            let sum: f32 = frame.iter().take(2).sum();
            mono.push(sum / frame.len().min(2) as f32);
        }
        position += got;
        while mono.len() >= FFT_SIZE {
            for (index, slot) in input.iter_mut().enumerate() {
                *slot = mono[index] * window[index];
            }
            fft.process(&mut input, &mut spectrum).map_err(|error| error.to_string())?;
            let center = segment_start + FFT_SIZE / 2;
            let target = (center / frame_len).min(frame_count - 1);
            for (bin, value) in spectrum.iter().enumerate() {
                let power = f64::from(value.norm_sqr()) * scale;
                if let Some(band) = band_of[bin] {
                    frame_power[target][band] += power;
                }
                if let Some(fine) = fine_of[bin] {
                    fine_power[fine] += power;
                }
            }
            frame_segments[target] += 1;
            fine_segments += 1;
            mono.drain(..HOP);
            segment_start += HOP;
        }
    }
    let to_db = |power: f64| -> f32 {
        if power <= 1e-20 || !power.is_finite() {
            FLOOR_DB
        } else {
            ((10.0 * power.log10()) as f32).max(FLOOR_DB)
        }
    };
    let frames = frame_power
        .iter()
        .zip(frame_segments.iter())
        .map(|(bands, segments)| {
            bands
                .iter()
                .map(|power| if *segments == 0 { FLOOR_DB } else { to_db(power / f64::from(*segments)) })
                .map(|db| (db * 100.0).round() / 100.0)
                .collect()
        })
        .collect();
    let fine_db = fine_power
        .iter()
        .map(|power| if fine_segments == 0 { FLOOR_DB } else { (to_db(power / f64::from(fine_segments)) * 100.0).round() / 100.0 })
        .collect();
    Ok(BandFrames {
        version: BANDS_VERSION,
        sample_rate: PLAYBACK_RATE,
        duration_seconds: duration,
        hop_seconds: frame_len as f64 / rate,
        edges_hz: edges.iter().map(|edge| (edge * 100.0).round() / 100.0).collect(),
        frames,
        fine_hz: fine_edges.windows(2).map(|pair| ((pair[0] * pair[1]).sqrt() * 100.0).round() / 100.0).collect(),
        fine_db,
    })
}

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BandsIdentity {
    pub version: u32,
    pub source_size: u64,
    pub source_modified_ns: String,
    pub proxy_version: u16,
    pub resampler_id: u32,
}

/// Band frames for one track from `cache/analysis/<trackId>__eqbands.json`, measured again when the
/// source, the proxy format, or this measurement changed. Returns the cache file's JSON text.
pub fn cached_band_frames(bundle: &Path, track_id: &str, source: &Path, cancel: &AtomicBool) -> Result<String, String> {
    let proxy_name = crate::proxy::proxy_file_name(track_id)?;
    let meta = std::fs::metadata(source).map_err(|error| error.to_string())?;
    let modified = meta
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| u64::try_from(duration.as_nanos()).unwrap_or(u64::MAX))
        .unwrap_or(0);
    let identity = BandsIdentity {
        version: BANDS_VERSION,
        source_size: meta.len(),
        source_modified_ns: modified.to_string(),
        proxy_version: crate::proxy::PROXY_VERSION,
        resampler_id: crate::proxy::RESAMPLER_ID,
    };
    let cache_dir = bundle.join("cache").join("analysis");
    let cache = cache_dir.join(format!("{}__eqbands.json", proxy_name.trim_end_matches(".proxy")));
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
    let bands = measure_band_frames(&proxy, cancel)?;
    let text = serde_json::to_string(&serde_json::json!({ "kind": "eq-bands", "identity": identity, "bands": bands }))
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

    fn write_wav(path: &Path, frames: usize, sample: impl Fn(usize) -> f32) {
        let mut body = Vec::with_capacity(44 + frames * 4);
        let data = (frames * 4) as u32;
        body.extend_from_slice(b"RIFF");
        body.extend_from_slice(&(36 + data).to_le_bytes());
        body.extend_from_slice(b"WAVEfmt ");
        body.extend_from_slice(&16_u32.to_le_bytes());
        body.extend_from_slice(&3_u16.to_le_bytes());
        body.extend_from_slice(&1_u16.to_le_bytes());
        body.extend_from_slice(&48_000_u32.to_le_bytes());
        body.extend_from_slice(&(48_000_u32 * 4).to_le_bytes());
        body.extend_from_slice(&4_u16.to_le_bytes());
        body.extend_from_slice(&32_u16.to_le_bytes());
        body.extend_from_slice(b"data");
        body.extend_from_slice(&data.to_le_bytes());
        for frame in 0..frames {
            body.extend_from_slice(&sample(frame).to_le_bytes());
        }
        std::fs::write(path, body).unwrap();
    }

    #[test]
    fn puts_a_low_tone_and_a_high_tone_in_their_own_bands_and_frames() {
        let dir = std::env::temp_dir().join(format!("audiosous-bands-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let source = dir.join("tones.wav");
        // 55 Hz for 4 s, then 2.4 kHz for 4 s, both at 0.5 peak (mean square 0.125, -9.03 dB).
        write_wav(&source, 48_000 * 8, |frame| {
            let time = frame as f32 / 48_000.0;
            let hz = if time < 4.0 { 55.0 } else { 2_400.0 };
            0.5 * (2.0 * std::f32::consts::PI * hz * time).sin()
        });
        let proxy = dir.join("tones.proxy");
        ensure_proxy(&source, &proxy, 1, 1, &AtomicBool::new(false), &mut |_| {}).unwrap();
        let bands = measure_band_frames(&proxy, &AtomicBool::new(false)).unwrap();
        assert_eq!(bands.edges_hz.len(), BAND_COUNT + 1);
        let low = locate(&band_edges(BAND_COUNT), 55.0).unwrap();
        let high = locate(&band_edges(BAND_COUNT), 2_400.0).unwrap();
        let early = &bands.frames[bands.frames.len() / 4];
        let late = &bands.frames[bands.frames.len() * 3 / 4];
        // Parseval: the tone's band carries the whole mean square.
        assert!((early[low] + 9.03).abs() < 0.5, "55 Hz band {}", early[low]);
        assert!((late[high] + 9.03).abs() < 0.5, "2.4 kHz band {}", late[high]);
        assert!(early[high] < -60.0, "no 2.4 kHz early: {}", early[high]);
        assert!(late[low] < -60.0, "no 55 Hz late: {}", late[low]);
        // Neighbouring low bands stay clear: the old spectrogram smeared 0–280 Hz together.
        assert!(early[low + 2] < early[low] - 30.0, "leak into {}: {}", low + 2, early[low + 2]);
        assert!((bands.duration_seconds - 8.0).abs() < 0.01);
        assert!(bands.frames.len() <= MAX_FRAMES);
        let peak = bands
            .fine_db
            .iter()
            .enumerate()
            .filter(|(index, _)| bands.fine_hz[*index] < 200.0)
            .max_by(|left, right| left.1.total_cmp(right.1))
            .unwrap();
        assert!((bands.fine_hz[peak.0] - 55.0).abs() < 6.0, "fine peak {}", bands.fine_hz[peak.0]);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
