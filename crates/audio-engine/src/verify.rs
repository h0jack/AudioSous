//! Checks a candidate EQ filter on the 48 kHz playback proxy.
//!
//! The planner predicts a filter's effect from cached band levels. This runs the native filters
//! over real proxy audio for the windows where the conflict happens and measures the level inside
//! the conflict range and overall, with and without the candidate. It reads short windows only,
//! never the original high-resolution source.

use std::path::Path;

use crate::dynamics::{DynKind, DynSpec, DynamicsChain};
use crate::eq::{EqChain, FilterKind, FilterSpec};
use crate::proxy::{ProxyReader, PLAYBACK_RATE};
use crate::spatial::{process_interleaved, SpatialParams};

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

/// Stereo statistics of one track after its saved EQ and one pan/width setting, before the fader.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StereoStats {
    pub left_db: f64,
    pub right_db: f64,
    pub correlation: f64,
    /// How much quieter the stem is folded to mono than in stereo: 10·log10(((L² + R²) / 2) / ((L + R) / 2)²).
    pub mono_loss_db: f64,
    pub peak_dbfs: f64,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpatialCheck {
    pub before: StereoStats,
    pub after: StereoStats,
    pub seconds: f64,
}

/// Runs a track's proxy through its saved EQ and the native spatial stage at the current and the
/// candidate pan/width, over the windows where the conflict happens, and measures both.
pub fn check_spatial(
    proxy: &Path,
    windows: &[(f64, f64)],
    saved: &[FilterSpec],
    before: SpatialParams,
    after: SpatialParams,
    max_seconds: f64,
) -> Result<SpatialCheck, String> {
    let (header, mut reader) = ProxyReader::open(proxy)?;
    let channels = usize::from(header.channels).clamp(1, 2);
    let rate = PLAYBACK_RATE as f32;
    // left², right², left·right, mono², peak, for before and after.
    let mut sums = [[0.0_f64; 5]; 2];
    let mut counted = 0_usize;
    let budget = (max_seconds.max(0.5) * f64::from(PLAYBACK_RATE)) as usize;
    let mut buffer = Vec::with_capacity(CHUNK_FRAMES * channels);
    let mut placed = Vec::with_capacity(CHUNK_FRAMES * 2);
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
        let mut eq = EqChain::new(saved, rate);
        let mut position = 0_usize;
        let wanted = (last - first) as usize;
        while position < wanted && counted < budget {
            let frames = (wanted - position).min(CHUNK_FRAMES);
            let got = reader.read_interleaved(frames, &mut buffer)?;
            if got == 0 {
                break;
            }
            let mut filtered = buffer[..got * channels].to_vec();
            eq.process_interleaved(&mut filtered, channels);
            let skip = SETTLE_FRAMES.saturating_sub(position).min(got);
            for (slot, params) in [before, after].into_iter().enumerate() {
                process_interleaved(&filtered, channels, params, &mut placed);
                let sum = &mut sums[slot];
                for frame in placed.chunks(2).skip(skip) {
                    let (left, right) = (f64::from(frame[0]), f64::from(frame[1]));
                    sum[0] += left * left;
                    sum[1] += right * right;
                    sum[2] += left * right;
                    sum[3] += (0.5 * (left + right)).powi(2);
                    sum[4] = sum[4].max(left.abs()).max(right.abs());
                }
            }
            counted += got - skip;
            position += got;
        }
    }
    if counted == 0 {
        return Err("No proxy audio in the requested windows.".into());
    }
    let stats = |sum: &[f64; 5]| {
        let n = counted as f64;
        let db = |value: f64| 10.0 * (value / n).max(1e-20).log10();
        let norm = (sum[0] * sum[1]).sqrt();
        StereoStats {
            left_db: db(sum[0]),
            right_db: db(sum[1]),
            correlation: if norm > 1e-20 { (sum[2] / norm).clamp(-1.0, 1.0) } else { 1.0 },
            mono_loss_db: 10.0 * ((0.5 * (sum[0] + sum[1])).max(1e-20) / sum[3].max(1e-20)).log10(),
            peak_dbfs: 20.0 * sum[4].max(1e-10).log10(),
        }
    };
    Ok(SpatialCheck {
        before: stats(&sums[0]),
        after: stats(&sums[1]),
        seconds: counted as f64 / f64::from(PLAYBACK_RATE),
    })
}

/// Levels of one track's processed audio over the checked windows, before the fader.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LevelStats {
    pub rms_db: f64,
    pub peak_dbfs: f64,
    pub crest_db: f64,
    /// Sustained level: the median 50 ms RMS inside each 400 ms window where the stem plays (window and cells
    /// within 30 dB of the loudest cell, above −60 dBFS), then the 10th, 50th, and 90th percentile over windows.
    pub p10_db: f64,
    pub p50_db: f64,
    pub p90_db: f64,
    /// Median of attack energy (first 10 ms) over body energy (40–140 ms), dB, at onsets found in the
    /// unprocessed audio. Energy, not the first peak: no detector without lookahead can touch the first samples.
    pub transient_db: Option<f64>,
    /// Level inside the conflict band while the key plays and while it does not (keyed checks with a band).
    pub band_on_db: Option<f64>,
    pub band_off_db: Option<f64>,
    /// Whole-band level while the key plays and while it does not (keyed checks).
    pub level_on_db: Option<f64>,
    pub level_off_db: Option<f64>,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DynamicsCheck {
    pub before: LevelStats,
    pub after: LevelStats,
    /// Reduction from nodes of the checked kind in the processed audio, sampled every control step, dB. For a keyed
    /// check, p50 and p95 are over the time the key plays (what the row is for); the maximum is over everything.
    pub reduction_p50_db: f64,
    pub reduction_p95_db: f64,
    pub reduction_max_db: f64,
    /// Share of the time the key plays (keyed checks).
    pub key_on_share: Option<f64>,
    /// Share of key-off time the checked kind is back within 0.5 dB of no reduction (keyed checks).
    pub recovered_share: Option<f64>,
    pub seconds: f64,
}

pub struct DynamicsCheckInput<'a> {
    pub proxy: &'a Path,
    /// The key track's proxy. Keyed nodes in `before` and `after` read it as key index 0.
    pub key_proxy: Option<&'a Path>,
    /// Seconds on the proxy timeline. At most `max_seconds` are read.
    pub windows: &'a [(f64, f64)],
    /// Saved static EQ that runs before the dynamics in this scope.
    pub saved_eq: &'a [FilterSpec],
    /// Dynamics in effect now, and with the candidate (a replaced node is left out of `after`).
    pub before: &'a [DynSpec],
    pub after: &'a [DynSpec],
    /// Which kind's reduction to report.
    pub kind: DynKind,
    /// A conflict band to measure while the key plays and while it does not, Hz.
    pub band: Option<(f32, f32)>,
    pub max_seconds: f64,
}

const MS: usize = 48;
const TEN_MS: usize = 480;

/// Runs a track's proxy through its saved EQ and the native dynamics, now and with the candidate, over the
/// windows where the problem happens, and measures the level distribution, crest, transients, the reduction the
/// candidate actually applies, and (keyed) the conflict band while the key plays and while it does not.
pub fn check_dynamics(input: &DynamicsCheckInput<'_>) -> Result<DynamicsCheck, String> {
    let (header, mut reader) = ProxyReader::open(input.proxy)?;
    let channels = usize::from(header.channels).clamp(1, 2);
    let mut key_reader = match input.key_proxy {
        Some(path) => Some(ProxyReader::open(path)?),
        None => None,
    };
    let rate = PLAYBACK_RATE as f32;
    let budget = (input.max_seconds.max(0.5) * f64::from(PLAYBACK_RATE)) as usize;
    let band_filters = input.band.map(|(low, high)| {
        let pass = |kind, frequency_hz| FilterSpec { kind, frequency_hz, gain_db: 0.0, q: 0.707 };
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
    });
    let reduction_channel = match input.kind {
        DynKind::Compressor => 0,
        DynKind::Ducking => 1,
        DynKind::DynamicEq => 2,
        _ => 3,
    };
    // Per 1 ms: peak and power, unprocessed and processed. Per 10 ms: power, band power, key power, reduction.
    let mut ms = [Vec::new(), Vec::new()];
    let mut tens: Vec<[f64; 6]> = Vec::new();
    // Each control-step reading, with the 10 ms row it falls in (to split key-on from key-off afterwards).
    let mut reductions: Vec<(f32, usize)> = Vec::new();
    let mut counted = 0_usize;
    let mut buffer = Vec::with_capacity(CHUNK_FRAMES * channels);
    let mut key_buffer = Vec::with_capacity(CHUNK_FRAMES * 2);
    for &(start, end) in input.windows {
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
        let key_channels = match key_reader.as_mut() {
            Some((key_header, key)) => {
                key.seek_frame(first.min(key_header.frames))?;
                usize::from(key_header.channels).clamp(1, 2)
            }
            None => 1,
        };
        let mut eq = EqChain::new(input.saved_eq, rate);
        let mut chains = [DynamicsChain::new(input.before, rate), DynamicsChain::new(input.after, rate)];
        let mut bands = band_filters.as_ref().map(|filters| [EqChain::new(filters, rate), EqChain::new(filters, rate)]);
        let mut position = 0_usize;
        let wanted = (last - first) as usize;
        let mut acc_ms = [[0.0_f64; 2]; 2];
        let mut acc_ten = [0.0_f64; 6];
        while position < wanted && counted < budget {
            let frames = (wanted - position).min(CHUNK_FRAMES);
            let got = reader.read_interleaved(frames, &mut buffer)?;
            if got == 0 {
                break;
            }
            let key_got = match key_reader.as_mut() {
                Some((_, key)) => key.read_interleaved(got, &mut key_buffer)?,
                None => 0,
            };
            let mut audio = buffer[..got * channels].to_vec();
            eq.process_interleaved(&mut audio, channels);
            let mut outputs = [audio.clone(), audio];
            let mut max_reduction = vec![0.0_f32; got];
            let mut key_values = vec![0.0_f32; got];
            for frame in 0..got {
                let key = if frame < key_got {
                    let at = frame * key_channels;
                    if key_channels > 1 { 0.5 * (key_buffer[at] + key_buffer[at + 1]) } else { key_buffer[at] }
                } else {
                    0.0
                };
                for (slot, chain) in chains.iter_mut().enumerate() {
                    let at = frame * channels;
                    let mut sample = [outputs[slot][at], if channels > 1 { outputs[slot][at + 1] } else { 0.0 }];
                    let readings = chain.process_frame(&mut sample, channels, &[key]);
                    outputs[slot][at] = sample[0];
                    if channels > 1 {
                        outputs[slot][at + 1] = sample[1];
                    }
                    if slot == 1 {
                        max_reduction[frame] = readings[reduction_channel];
                    }
                }
                key_values[frame] = key;
            }
            let mut band_power = [vec![0.0_f64; got], vec![0.0_f64; got]];
            if let Some(filters) = bands.as_mut() {
                for slot in 0..2 {
                    let mut filtered = outputs[slot].clone();
                    filters[slot].process_interleaved(&mut filtered, channels);
                    for frame in 0..got {
                        let at = frame * channels;
                        band_power[slot][frame] = (0..channels).map(|channel| f64::from(filtered[at + channel]).powi(2)).sum::<f64>() / channels as f64;
                    }
                }
            }
            for frame in 0..got {
                let local = position + frame;
                let at = frame * channels;
                for slot in 0..2 {
                    let power = (0..channels).map(|channel| f64::from(outputs[slot][at + channel]).powi(2)).sum::<f64>() / channels as f64;
                    let peak = (0..channels).map(|channel| f64::from(outputs[slot][at + channel].abs())).fold(0.0, f64::max);
                    acc_ms[slot][0] = acc_ms[slot][0].max(peak);
                    acc_ms[slot][1] += power;
                    acc_ten[slot] += power;
                    acc_ten[2 + slot] += band_power[slot][frame];
                }
                acc_ten[4] += f64::from(key_values[frame]).powi(2);
                acc_ten[5] = acc_ten[5].max(f64::from(max_reduction[frame]));
                if (local + 1) % CONTROL_STEP == 0 && local >= SETTLE_FRAMES {
                    reductions.push((max_reduction[frame], tens.len()));
                }
                if (local + 1) % MS == 0 {
                    if local >= SETTLE_FRAMES {
                        for slot in 0..2 {
                            ms[slot].push((acc_ms[slot][0], acc_ms[slot][1] / MS as f64));
                        }
                    }
                    acc_ms = [[0.0; 2]; 2];
                }
                if (local + 1) % TEN_MS == 0 {
                    if local >= SETTLE_FRAMES {
                        let n = TEN_MS as f64;
                        tens.push([acc_ten[0] / n, acc_ten[1] / n, acc_ten[2] / n, acc_ten[3] / n, acc_ten[4] / n, acc_ten[5]]);
                    }
                    acc_ten = [0.0; 6];
                }
                if local >= SETTLE_FRAMES {
                    counted += 1;
                }
            }
            position += got;
        }
    }
    if tens.is_empty() {
        return Err("No proxy audio in the requested windows.".into());
    }
    let db = |power: f64| 10.0 * power.max(1e-20).log10();
    let keyed = input.key_proxy.is_some();
    let key_max = tens.iter().map(|row| row[4]).fold(0.0, f64::max);
    // The key plays where its 10 ms level is within 15 dB of its loudest: the part of a hit or phrase a duck answers.
    let key_on: Vec<bool> = tens.iter().map(|row| keyed && row[4] > 1e-6 && db(row[4]) >= db(key_max) - 15.0).collect();
    // 50 ms cells (five 10 ms rows); a cell plays when it is within 30 dB of the loudest cell and above −60 dBFS.
    let cell_power = |slot: usize| -> Vec<f64> { tens.chunks(5).map(|rows| rows.iter().map(|row| row[slot]).sum::<f64>() / rows.len() as f64).collect() };
    let reference = cell_power(0);
    let loudest = reference.iter().copied().fold(0.0, f64::max);
    let playing: Vec<bool> = reference.iter().map(|power| *power > 1e-6 && db(*power) >= db(loudest) - 30.0).collect();
    let onsets = find_onsets(&ms[0]);
    let stats = |slot: usize| -> LevelStats {
        let power = tens.iter().map(|row| row[slot]).sum::<f64>() / tens.len() as f64;
        let peak = ms[slot].iter().map(|cell| cell.0).fold(0.0, f64::max);
        let cells = cell_power(slot);
        // Sustained level per 400 ms window: the median of its playing 50 ms cells, if most of them play.
        let mut windows: Vec<f64> = cells
            .chunks(8)
            .zip(playing.chunks(8))
            .filter_map(|(values, on)| {
                let mut levels: Vec<f64> = values.iter().zip(on.iter()).filter(|(_, on)| **on).map(|(value, _)| db(*value)).collect();
                if levels.len() * 8 < values.len() * 5 {
                    return None;
                }
                levels.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
                Some(levels[levels.len() / 2])
            })
            .collect();
        windows.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let pick = |share: f64| if windows.is_empty() { db(power) } else { windows[((windows.len() - 1) as f64 * share).round() as usize] };
        let split = |column: usize, on: bool| -> Option<f64> {
            let rows: Vec<f64> = tens.iter().zip(key_on.iter()).filter(|(_, key)| **key == on).map(|(row, _)| row[column]).collect();
            (keyed && !rows.is_empty()).then(|| db(rows.iter().sum::<f64>() / rows.len() as f64))
        };
        let has_band = input.band.is_some();
        LevelStats {
            rms_db: db(power),
            peak_dbfs: 20.0 * peak.max(1e-10).log10(),
            crest_db: 20.0 * peak.max(1e-10).log10() - db(power),
            p10_db: pick(0.1),
            p50_db: pick(0.5),
            p90_db: pick(0.9),
            transient_db: transient_of(&ms[slot], &onsets),
            band_on_db: if has_band { split(2 + slot, true) } else { None },
            band_off_db: if has_band { split(2 + slot, false) } else { None },
            level_on_db: split(slot, true),
            level_off_db: split(slot, false),
        }
    };
    let largest = reductions.iter().map(|(value, _)| *value).fold(0.0_f32, f32::max);
    let mut sorted: Vec<f32> = reductions.iter().filter(|(_, row)| !keyed || key_on.get(*row).copied().unwrap_or(false)).map(|(value, _)| *value).collect();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let pick = |share: f64| if sorted.is_empty() { 0.0 } else { f64::from(sorted[((sorted.len() - 1) as f64 * share).round() as usize]) };
    let off: Vec<f64> = tens.iter().zip(key_on.iter()).filter(|(_, key)| !**key).map(|(row, _)| row[5]).collect();
    Ok(DynamicsCheck {
        before: stats(0),
        after: stats(1),
        reduction_p50_db: pick(0.5),
        reduction_p95_db: pick(0.95),
        reduction_max_db: f64::from(largest),
        key_on_share: keyed.then(|| key_on.iter().filter(|on| **on).count() as f64 / key_on.len() as f64),
        recovered_share: (keyed && !off.is_empty()).then(|| off.iter().filter(|value| **value < 0.5).count() as f64 / off.len() as f64),
        seconds: counted as f64 / f64::from(PLAYBACK_RATE),
    })
}

const CONTROL_STEP: usize = crate::dynamics::CONTROL_FRAMES as usize;

/// Onsets in 1 ms (peak, power) cells: a peak 9 dB over the quietest of the previous 20 ms, above −50 dBFS,
/// at least 60 ms after the last one.
fn find_onsets(cells: &[(f64, f64)]) -> Vec<usize> {
    let mut out = Vec::new();
    let mut last: Option<usize> = None;
    for index in 20..cells.len() {
        let peak = cells[index].0;
        if peak < 10_f64.powf(-50.0 / 20.0) {
            continue;
        }
        let floor = cells[index - 20..index].iter().map(|cell| cell.0).fold(f64::MAX, f64::min).max(1e-6);
        if 20.0 * (peak / floor).log10() >= 9.0 && last.map_or(true, |at| index - at >= 60) {
            out.push(index);
            last = Some(index);
        }
    }
    out
}

/// Median attack energy (first 10 ms) over body energy (40–140 ms) at the given onsets, dB; None with fewer than
/// 4 usable onsets.
fn transient_of(cells: &[(f64, f64)], onsets: &[usize]) -> Option<f64> {
    let mut values: Vec<f64> = onsets
        .iter()
        .filter(|at| **at + 140 <= cells.len())
        .map(|at| {
            let attack = cells[*at..*at + 10].iter().map(|cell| cell.1).sum::<f64>() / 10.0;
            let body = cells[*at + 40..*at + 140].iter().map(|cell| cell.1).sum::<f64>() / 100.0;
            10.0 * attack.max(1e-20).log10() - 10.0 * body.max(1e-20).log10()
        })
        .collect();
    if values.len() < 4 {
        return None;
    }
    values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    Some(values[values.len() / 2])
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

    #[test]
    fn measures_correlation_and_mono_loss_before_and_after_a_width_change() {
        let dir = std::env::temp_dir().join(format!("audiosous-verify-space-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let source = dir.join("wide.wav");
        // Stereo: a shared component plus independent noise per side, so correlation sits near 0.5.
        // SplitMix64 per sample, so the three seeds are independent.
        let hash = |value: u32, seed: u32| {
            let mut x = u64::from(value).wrapping_add(u64::from(seed) << 32).wrapping_mul(0x9e37_79b9_7f4a_7c15);
            x ^= x >> 30;
            x = x.wrapping_mul(0xbf58_476d_1ce4_e5b9);
            x ^= x >> 27;
            x = x.wrapping_mul(0x94d0_49bb_1331_11eb);
            x ^= x >> 31;
            (x >> 40) as f32 / (1_u64 << 24) as f32 - 0.5
        };
        let frames = 48_000 * 3;
        let mut body = Vec::with_capacity(44 + frames * 8);
        let data = (frames * 8) as u32;
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
        for frame in 0..frames as u32 {
            let shared = hash(frame, 1);
            body.extend_from_slice(&(0.3 * (shared + 0.58 * hash(frame, 2))).to_le_bytes());
            body.extend_from_slice(&(0.3 * (shared + 0.58 * hash(frame, 3))).to_le_bytes());
        }
        std::fs::write(&source, body).unwrap();
        let proxy = dir.join("wide.proxy");
        ensure_proxy(&source, &proxy, 1, 1, &AtomicBool::new(false), &mut |_| {}).unwrap();
        let neutral = SpatialParams { pan: 0.0, width: 1.0 };
        let wider = SpatialParams { pan: 0.0, width: 1.5 };
        let check = check_spatial(&proxy, &[(0.2, 2.8)], &[], neutral, wider, 10.0).unwrap();
        // Shared power 1, side power 0.58² each: correlation 1 / (1 + 0.3364) ≈ 0.75.
        assert!((check.before.correlation - 0.748).abs() < 0.03, "before {}", check.before.correlation);
        // Mid/side power ratio r = (1 − ρ)/(1 + ρ); widening scales side power by w², so ρ' = (1 − w²r)/(1 + w²r).
        let ratio = (1.0 - check.before.correlation) / (1.0 + check.before.correlation);
        let predicted = (1.0 - 2.25 * ratio) / (1.0 + 2.25 * ratio);
        assert!((check.after.correlation - predicted).abs() < 0.02, "after {} predicted {predicted}", check.after.correlation);
        let predicted_loss = 10.0 * (1.0 + 2.25 * ratio).log10();
        assert!((check.after.mono_loss_db - predicted_loss).abs() < 0.1, "mono loss {} predicted {predicted_loss}", check.after.mono_loss_db);
        assert!(check.after.mono_loss_db > check.before.mono_loss_db);
        let narrower = check_spatial(&proxy, &[(0.2, 2.8)], &[], neutral, SpatialParams { pan: 0.0, width: 0.0 }, 10.0).unwrap();
        assert!(narrower.after.correlation > 0.999 && narrower.after.mono_loss_db.abs() < 0.01);
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn proxy_of(dir: &Path, name: &str, frames: usize, sample: impl Fn(usize) -> f32) -> std::path::PathBuf {
        let source = dir.join(format!("{name}.wav"));
        write_wav(&source, frames, sample);
        let proxy = dir.join(format!("{name}.proxy"));
        ensure_proxy(&source, &proxy, 1, 1, &AtomicBool::new(false), &mut |_| {}).unwrap();
        proxy
    }

    #[test]
    fn a_compressor_check_measures_its_reduction_and_the_narrower_level_spread() {
        let dir = std::env::temp_dir().join(format!("audiosous-verify-comp-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // A bass line whose notes alternate 0.5 and 0.15 every second: about 10 dB of note-to-note swing.
        let proxy = proxy_of(&dir, "uneven", 48_000 * 6, |frame| {
            let loud = (frame / 48_000) % 2 == 0;
            (if loud { 0.5 } else { 0.15 }) * (2.0 * std::f32::consts::PI * 70.0 * frame as f32 / 48_000.0).sin()
        });
        let compressor = DynSpec::compressor(-20.0, 3.0, 10.0, 80.0, 6.0, 0.0);
        let check = check_dynamics(&DynamicsCheckInput {
            proxy: &proxy,
            key_proxy: None,
            windows: &[(0.5, 5.5)],
            saved_eq: &[],
            before: &[],
            after: &[compressor],
            kind: DynKind::Compressor,
            band: None,
            max_seconds: 20.0,
        })
        .unwrap();
        let spread_before = check.before.p90_db - check.before.p10_db;
        let spread_after = check.after.p90_db - check.after.p10_db;
        assert!(spread_before > 9.0, "spread before {spread_before}");
        assert!(spread_after < spread_before - 4.0, "spread after {spread_after}");
        // The loud notes sit 11 dB over threshold: about 7 dB of reduction at ratio 3.
        assert!((check.reduction_p95_db - 7.0).abs() < 1.0, "p95 reduction {}", check.reduction_p95_db);
        assert!(check.reduction_p50_db < check.reduction_p95_db);
        assert!(check.after.rms_db < check.before.rms_db);
        assert!(check.key_on_share.is_none() && check.before.band_on_db.is_none());
        assert!((check.seconds - 5.0 + SETTLE_FRAMES as f64 / 48_000.0).abs() < 0.05);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_ducking_check_measures_the_band_while_the_key_plays_and_the_recovery_after() {
        let dir = std::env::temp_dir().join(format!("audiosous-verify-duck-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let bass = proxy_of(&dir, "bass", 48_000 * 4, |frame| 0.3 * (2.0 * std::f32::consts::PI * 80.0 * frame as f32 / 48_000.0).sin());
        let kick = proxy_of(&dir, "kick", 48_000 * 4, |frame| {
            let local = (frame % 24_000) as f32 / 48_000.0;
            (-local / 0.03).exp() * (2.0 * std::f32::consts::PI * 60.0 * local).sin() * 0.8
        });
        let duck = DynSpec::ducking(0, false, -14.0, -3.0, 5.0, 60.0);
        let check = check_dynamics(&DynamicsCheckInput {
            proxy: &bass,
            key_proxy: Some(&kick),
            windows: &[(0.2, 3.8)],
            saved_eq: &[],
            before: &[],
            after: &[duck],
            kind: DynKind::Ducking,
            band: Some((40.0, 120.0)),
            max_seconds: 20.0,
        })
        .unwrap();
        let on = check.before.band_on_db.unwrap() - check.after.band_on_db.unwrap();
        let off = check.before.band_off_db.unwrap() - check.after.band_off_db.unwrap();
        assert!(on > 1.5, "band reduction while the kick plays {on}");
        assert!(off < 0.6, "and little while it does not {off}");
        assert!(check.reduction_max_db <= 3.01 && check.reduction_max_db > 2.5);
        assert!(check.recovered_share.unwrap() > 0.6, "recovered {:?}", check.recovered_share);
        let share = check.key_on_share.unwrap();
        assert!(share > 0.05 && share < 0.5, "key on {share}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_transient_check_reads_attack_against_body_at_the_same_onsets() {
        let dir = std::env::temp_dir().join(format!("audiosous-verify-transient-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let snare = proxy_of(&dir, "snare", 48_000 * 4, |frame| {
            let local = (frame % 12_000) as f32 / 48_000.0;
            let envelope = if local < 0.004 { 1.0 } else { 0.3 * (-local / 0.1).exp() };
            envelope * 0.5 * (2.0 * std::f32::consts::PI * 190.0 * local).sin().signum()
        });
        let check = check_dynamics(&DynamicsCheckInput {
            proxy: &snare,
            key_proxy: None,
            windows: &[(0.1, 3.9)],
            saved_eq: &[],
            before: &[],
            after: &[DynSpec::transient(-0.2, 0.0)],
            kind: DynKind::Transient,
            band: None,
            max_seconds: 20.0,
        })
        .unwrap();
        let before = check.before.transient_db.unwrap();
        let after = check.after.transient_db.unwrap();
        assert!(before > 8.0, "snare attack over body {before}");
        assert!(after < before - 0.5, "an attack cut lowers it: {before} → {after}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
