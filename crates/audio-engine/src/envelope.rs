//! Time-resolved level envelopes for dynamics planning, measured from the 48 kHz playback proxy.
//!
//! EQ band frames (about 0.4 s) are fine for phrase-level masking but far too coarse for a kick against a bass
//! or a snare's attack against its body. This reads each stem once and keeps, every 10 ms:
//!
//! - `rms`: the stereo-linked mean square, `(L² + R²) / 2`, over the 10 ms (the compressor's detector input),
//! - `peak`: the largest `|L|` or `|R|` in the 10 ms,
//! - `low`: the RMS of the mono mid through a fourth-order Butterworth low-pass at 150 Hz (the kick and bass range).
//!
//! Values are dB, quantized to 0.5 dB in one byte (`dB = byte / 2 − 100`; 0 means −100 dBFS or less) and
//! stored base64, so a 141 s stem is about 57 KB of JSON and a 6-minute song about 140 KB. The cache is
//! `cache/analysis/<trackId>__envelope.json` with the same identity rule as the band and stereo frames.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::bands::BandsIdentity;
use crate::eq::{EqChain, FilterKind, FilterSpec};
use crate::proxy::{ProxyReader, PLAYBACK_RATE};

/// Bump when any number this produces would no longer compare with an older cache.
pub const ENVELOPE_VERSION: u32 = 1;
/// 10 ms at 48 kHz.
pub const ENVELOPE_HOP: usize = 480;
pub const ENVELOPE_LOW_HZ: f32 = 150.0;
const FLOOR_DB: f32 = -100.0;
const STEP_DB: f32 = 0.5;

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvelopeFrames {
    pub version: u32,
    pub sample_rate: u32,
    pub channels: u16,
    pub duration_seconds: f64,
    pub hop_seconds: f64,
    pub frame_count: usize,
    pub low_hz: f32,
    /// One byte per frame, base64: dB = byte / 2 − 100.
    pub rms: String,
    pub peak: String,
    pub low: String,
}

/// 0.5 dB steps from −100 dB (byte 0) to +27.5 dB (byte 255).
pub fn quantize_db(db: f32) -> u8 {
    if !db.is_finite() || db <= FLOOR_DB {
        return 0;
    }
    ((db - FLOOR_DB) / STEP_DB).round().clamp(0.0, 255.0) as u8
}

pub fn dequantize_db(byte: u8) -> f32 {
    f32::from(byte) * STEP_DB + FLOOR_DB
}

pub fn measure_envelope_frames(proxy: &Path, cancel: &AtomicBool) -> Result<EnvelopeFrames, String> {
    let (header, mut reader) = ProxyReader::open(proxy)?;
    let channels = usize::from(header.channels).max(1);
    let total = header.frames as usize;
    let rate = PLAYBACK_RATE as f32;
    let frame_count = total.div_ceil(ENVELOPE_HOP);
    let butterworth = |q: f32| FilterSpec { kind: FilterKind::LowPass, frequency_hz: ENVELOPE_LOW_HZ, gain_db: 0.0, q };
    let mut low_pass = EqChain::new(&[butterworth(0.541_196_1), butterworth(1.306_563)], rate);
    let mut rms = Vec::with_capacity(frame_count);
    let mut peak = Vec::with_capacity(frame_count);
    let mut low = Vec::with_capacity(frame_count);
    let (mut power, mut top, mut low_power, mut count) = (0.0_f64, 0.0_f32, 0.0_f64, 0_usize);
    let mut block = Vec::with_capacity(ENVELOPE_HOP * 64 * channels);
    let mut mid = Vec::with_capacity(ENVELOPE_HOP * 64);
    let mut position = 0_usize;
    while position < total {
        if cancel.load(Ordering::Relaxed) {
            return Err("Envelope measurement was cancelled.".into());
        }
        let got = reader.read_interleaved((total - position).min(ENVELOPE_HOP * 64), &mut block)?;
        if got == 0 {
            break;
        }
        let samples = &block[..got * channels];
        mid.clear();
        mid.extend(samples.chunks(channels).map(|frame| 0.5 * (frame[0] + if channels >= 2 { frame[1] } else { frame[0] })));
        low_pass.process_interleaved(&mut mid, 1);
        for (frame, filtered) in samples.chunks(channels).zip(mid.iter()) {
            let left = frame[0];
            let right = if channels >= 2 { frame[1] } else { frame[0] };
            power += 0.5 * (f64::from(left).powi(2) + f64::from(right).powi(2));
            top = top.max(left.abs()).max(right.abs());
            low_power += f64::from(*filtered).powi(2);
            count += 1;
            if count == ENVELOPE_HOP {
                rms.push(power / count as f64);
                peak.push(top);
                low.push(low_power / count as f64);
                (power, top, low_power, count) = (0.0, 0.0, 0.0, 0);
            }
        }
        position += got;
    }
    if count > 0 {
        rms.push(power / count as f64);
        peak.push(top);
        low.push(low_power / count as f64);
    }
    let db_power = |value: f64| if value > 1e-20 { (10.0 * value.log10()) as f32 } else { f32::NEG_INFINITY };
    let encode = |values: Vec<u8>| encode_base64(&values);
    Ok(EnvelopeFrames {
        version: ENVELOPE_VERSION,
        sample_rate: PLAYBACK_RATE,
        channels: header.channels,
        duration_seconds: total as f64 / f64::from(PLAYBACK_RATE),
        hop_seconds: ENVELOPE_HOP as f64 / f64::from(PLAYBACK_RATE),
        frame_count: rms.len(),
        low_hz: ENVELOPE_LOW_HZ,
        rms: encode(rms.iter().map(|value| quantize_db(db_power(*value))).collect()),
        peak: encode(peak.iter().map(|value| quantize_db(20.0 * value.max(1e-10).log10())).collect()),
        low: encode(low.iter().map(|value| quantize_db(db_power(*value))).collect()),
    })
}

/// Envelope frames for dynamics planning, from `cache/analysis/<trackId>__envelope.json` or measured now.
pub fn cached_envelope_frames(bundle: &Path, track_id: &str, source: &Path, cancel: &AtomicBool) -> Result<String, String> {
    let proxy_name = crate::proxy::proxy_file_name(track_id)?;
    let meta = std::fs::metadata(source).map_err(|error| error.to_string())?;
    let modified = meta
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| u64::try_from(duration.as_nanos()).unwrap_or(u64::MAX))
        .unwrap_or(0);
    let identity = BandsIdentity {
        version: ENVELOPE_VERSION,
        source_size: meta.len(),
        source_modified_ns: modified.to_string(),
        proxy_version: crate::proxy::PROXY_VERSION,
        resampler_id: crate::proxy::RESAMPLER_ID,
    };
    let cache_dir = bundle.join("cache").join("analysis");
    let cache = cache_dir.join(format!("{}__envelope.json", proxy_name.trim_end_matches(".proxy")));
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
    let frames = measure_envelope_frames(&proxy, cancel)?;
    let text = serde_json::to_string(&serde_json::json!({ "kind": "envelope-frames", "identity": identity, "envelope": frames }))
        .map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&cache_dir).map_err(|error| error.to_string())?;
    let temporary = cache.with_extension("json.tmp");
    std::fs::write(&temporary, &text).map_err(|error| error.to_string())?;
    std::fs::rename(&temporary, &cache).map_err(|error| error.to_string())?;
    Ok(text)
}

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn encode_base64(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let value = (u32::from(chunk[0]) << 16) | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8) | u32::from(*chunk.get(2).unwrap_or(&0));
        out.push(ALPHABET[(value >> 18) as usize & 63] as char);
        out.push(ALPHABET[(value >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { ALPHABET[(value >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { ALPHABET[value as usize & 63] as char } else { '=' });
    }
    out
}

#[cfg(test)]
pub fn decode_base64(text: &str) -> Vec<u8> {
    let value_of = |byte: u8| ALPHABET.iter().position(|item| *item == byte).unwrap_or(0) as u32;
    let mut out = Vec::new();
    for chunk in text.as_bytes().chunks(4) {
        let value = (value_of(chunk[0]) << 18) | (value_of(chunk[1]) << 12) | (value_of(chunk[2]) << 6) | value_of(chunk[3]);
        out.push((value >> 16) as u8);
        if chunk[2] != b'=' {
            out.push((value >> 8) as u8);
        }
        if chunk[3] != b'=' {
            out.push(value as u8);
        }
    }
    out
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
    fn base64_and_quantization_round_trip() {
        for length in 0..9 {
            let bytes: Vec<u8> = (0..length).map(|index| (index * 37 + 11) as u8).collect();
            assert_eq!(decode_base64(&encode_base64(&bytes)), bytes);
        }
        assert_eq!(encode_base64(b"Man"), "TWFu");
        assert_eq!(quantize_db(-120.0), 0);
        assert_eq!(quantize_db(f32::NEG_INFINITY), 0);
        assert_eq!(dequantize_db(quantize_db(-12.3)), -12.5);
        assert_eq!(dequantize_db(quantize_db(-12.2)), -12.0);
        assert_eq!(quantize_db(40.0), 255);
    }

    #[test]
    fn measures_level_peak_and_low_band_every_10_ms() {
        let dir = std::env::temp_dir().join(format!("audiosous-envelope-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let source = dir.join("steps.wav");
        // 0–1 s: a 0.5 sine at 60 Hz (low). 1–2 s: a 0.5 sine at 2 kHz (not low). 2–3 s: silence.
        write_wav(&source, 48_000 * 3, |frame| {
            let time = frame as f32 / 48_000.0;
            if time < 1.0 {
                0.5 * (2.0 * std::f32::consts::PI * 60.0 * time).sin()
            } else if time < 2.0 {
                0.5 * (2.0 * std::f32::consts::PI * 2_000.0 * time).sin()
            } else {
                0.0
            }
        });
        let proxy = dir.join("steps.proxy");
        ensure_proxy(&source, &proxy, 1, 1, &AtomicBool::new(false), &mut |_| {}).unwrap();
        let frames = measure_envelope_frames(&proxy, &AtomicBool::new(false)).unwrap();
        assert_eq!(frames.frame_count, 300);
        let series = |text: &str| decode_base64(text).into_iter().map(dequantize_db).collect::<Vec<f32>>();
        let (rms, peak, low) = (series(&frames.rms), series(&frames.peak), series(&frames.low));
        assert_eq!(rms.len(), 300);
        assert!((rms[50] + 9.0).abs() <= 0.5, "60 Hz RMS {}", rms[50]);
        assert!((peak[50] + 6.0).abs() <= 0.5, "60 Hz peak {}", peak[50]);
        assert!((low[50] + 9.0).abs() <= 0.75, "60 Hz is low {}", low[50]);
        assert!((rms[150] + 9.0).abs() <= 0.5);
        assert!(low[150] < -60.0, "2 kHz is not low: {}", low[150]);
        assert_eq!(rms[250], -100.0);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
