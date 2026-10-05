//! Checks a candidate EQ filter on the 48 kHz playback proxy.
//!
//! The planner predicts a filter's effect from cached band levels. This runs the native filters
//! over real proxy audio for the windows where the conflict happens and measures the level inside
//! the conflict range and overall, with and without the candidate. It reads short windows only,
//! never the original high-resolution source.

use std::path::Path;

use crate::eq::{EqChain, FilterKind, FilterSpec};
use crate::proxy::{ProxyReader, PLAYBACK_RATE};

const SETTLE_FRAMES: usize = 2_400;
const CHUNK_FRAMES: usize = 8_192;

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateCheck {
    pub region_before_db: f64,
    pub region_after_db: f64,
    pub total_before_db: f64,
    pub total_after_db: f64,
    pub seconds: f64,
}

/// `windows` are seconds on the proxy timeline. At most `max_seconds` are read.
pub fn check_candidate(
    proxy: &Path,
    windows: &[(f64, f64)],
    saved: &[FilterSpec],
    candidate: &[FilterSpec],
    low_hz: f32,
    high_hz: f32,
    max_seconds: f64,
) -> Result<CandidateCheck, String> {
    let (header, mut reader) = ProxyReader::open(proxy)?;
    let channels = usize::from(header.channels).clamp(1, 2);
    let rate = PLAYBACK_RATE as f32;
    let band = |low: f32, high: f32| -> Vec<FilterSpec> {
        let pass = |kind, frequency_hz| FilterSpec {
            kind,
            frequency_hz,
            gain_db: 0.0,
            q: 0.707,
        };
        // Fourth-order edges: two high-pass and two low-pass sections.
        let mut filters = Vec::new();
        if low > 25.0 {
            filters.push(pass(FilterKind::HighPass, low));
            filters.push(pass(FilterKind::HighPass, low));
        }
        if high < 19_000.0 {
            filters.push(pass(FilterKind::LowPass, high));
            filters.push(pass(FilterKind::LowPass, high));
        }
        filters
    };
    let region = band(low_hz.max(20.0), high_hz.min(20_000.0));
    let after_filters: Vec<FilterSpec> = saved.iter().chain(candidate.iter()).copied().collect();
    let mut sums = [0.0_f64; 4];
    let mut counted = 0_usize;
    let budget = (max_seconds.max(0.5) * f64::from(PLAYBACK_RATE)) as usize;
    let mut buffer = Vec::with_capacity(CHUNK_FRAMES * channels);
    for &(start, end) in windows {
        if counted >= budget {
            break;
        }
        if !(start.is_finite() && end.is_finite()) || end <= start {
            continue;
        }
        let first = (start * f64::from(PLAYBACK_RATE)) as u64;
        let last = ((end * f64::from(PLAYBACK_RATE)) as u64).min(header.frames);
        if last <= first {
            continue;
        }
        reader.seek_frame(first)?;
        let mut before = EqChain::new(saved, rate);
        let mut after = EqChain::new(&after_filters, rate);
        let mut before_region = EqChain::new(&region, rate);
        let mut after_region = EqChain::new(&region, rate);
        let mut position = 0_usize;
        let wanted = (last - first) as usize;
        while position < wanted && counted < budget {
            let frames = (wanted - position).min(CHUNK_FRAMES);
            let got = reader.read_interleaved(frames, &mut buffer)?;
            if got == 0 {
                break;
            }
            let samples = &buffer[..got * channels];
            let mut dry = samples.to_vec();
            let mut wet = samples.to_vec();
            before.process_interleaved(&mut dry, channels);
            after.process_interleaved(&mut wet, channels);
            let mut dry_region = dry.clone();
            let mut wet_region = wet.clone();
            before_region.process_interleaved(&mut dry_region, channels);
            after_region.process_interleaved(&mut wet_region, channels);
            for frame in 0..got {
                if position + frame < SETTLE_FRAMES {
                    continue;
                }
                for channel in 0..channels {
                    let at = frame * channels + channel;
                    sums[0] += f64::from(dry_region[at]).powi(2);
                    sums[1] += f64::from(wet_region[at]).powi(2);
                    sums[2] += f64::from(dry[at]).powi(2);
                    sums[3] += f64::from(wet[at]).powi(2);
                }
                counted += 1;
            }
            position += got;
        }
    }
    if counted == 0 {
        return Err("No proxy audio in the requested windows.".into());
    }
    let db = |sum: f64| 10.0 * (sum / (counted * channels) as f64).max(1e-20).log10();
    Ok(CandidateCheck {
        region_before_db: db(sums[0]),
        region_after_db: db(sums[1]),
        total_before_db: db(sums[2]),
        total_after_db: db(sums[3]),
        seconds: counted as f64 / f64::from(PLAYBACK_RATE),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proxy::ensure_proxy;
    use std::sync::atomic::AtomicBool;

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
    fn measures_a_cut_inside_its_region_and_not_outside() {
        let dir = std::env::temp_dir().join(format!("audiosous-verify-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let source = dir.join("two-tones.wav");
        // 2.5 kHz and 200 Hz at equal level for 3 seconds.
        write_wav(&source, 48_000 * 3, |frame| {
            let time = frame as f32 / 48_000.0;
            0.25 * (2.0 * std::f32::consts::PI * 2_500.0 * time).sin() + 0.25 * (2.0 * std::f32::consts::PI * 200.0 * time).sin()
        });
        let proxy = dir.join("two-tones.proxy");
        ensure_proxy(&source, &proxy, 1, 1, &AtomicBool::new(false), &mut |_| {}).unwrap();
        let cut = FilterSpec {
            kind: FilterKind::Bell,
            frequency_hz: 2_500.0,
            gain_db: -3.0,
            q: 1.0,
        };
        let check = check_candidate(&proxy, &[(0.5, 2.5)], &[], &[cut], 1_800.0, 3_500.0, 10.0).unwrap();
        let region = check.region_after_db - check.region_before_db;
        let total = check.total_after_db - check.total_before_db;
        assert!((region + 3.0).abs() < 0.3, "region change {region}");
        // Half the power is the 2.5 kHz tone, so the whole signal drops by about 10·log10((1 + 0.5) / 2).
        assert!((total + 1.25).abs() < 0.3, "total change {total}");
        assert!((check.seconds - 2.0 + SETTLE_FRAMES as f64 / 48_000.0).abs() < 0.05);
        let elsewhere = check_candidate(&proxy, &[(0.5, 2.5)], &[], &[cut], 150.0, 260.0, 10.0).unwrap();
        assert!((elsewhere.region_after_db - elsewhere.region_before_db).abs() < 0.2);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
