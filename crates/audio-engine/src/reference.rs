//! Reference songs: decoding one (WAV, AIFF, FLAC, MP3) to a 48 kHz stereo float WAV the engine can play beside the
//! stems, and measuring a "profile" — the same measurement for a reference and for the mix — so the two can be
//! compared: loudness and dynamics, the tonal shape of the body of the song, and how much of each band is in the
//! sides.
//!
//! The tonal and stereo bands are the EQ planner's grid (24 log bands, 20 Hz – 20 kHz), so the reference planner can
//! read a gap and a stem's contribution on the same bands. Only the body of the song is averaged: frames more than
//! 20 dB under the loud end (the 95th percentile) are left out, so a quiet intro or a fade does not tilt the shape.

use std::fs::File;
use std::path::Path;

use realfft::RealFftPlanner;
use rubato::{Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction};
use serde::{Deserialize, Serialize};

use crate::encode::{AudioWriter, WavDepth, WavWriter};
use crate::loudness::{LoudnessMeter, LoudnessReport};

pub const PROFILE_VERSION: u32 = 1;
pub const PROFILE_BANDS: usize = 24;
pub const PROFILE_RATE: u32 = 48_000;
const FRAME: usize = 4_096;
const BODY_RANGE_DB: f64 = 20.0;

/// What a song measures as: the same numbers for a reference and for a mix.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SongProfile {
    pub version: u32,
    pub duration_seconds: f64,
    pub loudness: LoudnessReportDto,
    /// Band edges, Hz (25).
    pub edges_hz: Vec<f64>,
    /// Long-term mid ((L+R)/2) and side ((L−R)/2) power per band over the body of the song, dB.
    pub mid_db: Vec<f64>,
    pub side_db: Vec<f64>,
    /// Share of the song counted as its body.
    pub body_share: f64,
    /// Sample peak over the RMS of the body, dB.
    pub crest_db: f64,
    /// Correlation of left and right below 120 Hz over the body (1 = mono).
    pub low_correlation: f64,
}

/// `LoudnessReport` with serde both ways, for the cache.
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoudnessReportDto {
    pub integrated_lufs: f64,
    pub loudness_range_lu: f64,
    pub sample_peak_dbfs: f64,
    pub true_peak_dbtp: f64,
    pub max_short_term_lufs: f64,
}

impl From<LoudnessReport> for LoudnessReportDto {
    fn from(report: LoudnessReport) -> Self {
        Self { integrated_lufs: report.integrated_lufs, loudness_range_lu: report.loudness_range_lu, sample_peak_dbfs: report.sample_peak_dbfs, true_peak_dbtp: report.true_peak_dbtp, max_short_term_lufs: report.max_short_term_lufs }
    }
}

pub fn profile_edges() -> Vec<f64> {
    (0..=PROFILE_BANDS).map(|index| 20.0 * 1_000_f64.powf(index as f64 / PROFILE_BANDS as f64)).collect()
}

/// Measures interleaved stereo at 48 kHz.
pub fn profile(audio: &[f32]) -> SongProfile {
    let mut meter = LoudnessMeter::new(PROFILE_RATE, 2);
    meter.push(audio);
    let loudness = meter.report();
    let edges = profile_edges();
    let frames = audio.len() / 2;
    let mut planner = RealFftPlanner::<f64>::new();
    let fft = planner.plan_fft_forward(FRAME);
    let window: Vec<f64> = (0..FRAME).map(|n| 0.5 - 0.5 * (2.0 * std::f64::consts::PI * n as f64 / FRAME as f64).cos()).collect();
    let bin_band: Vec<Option<usize>> = (0..=FRAME / 2)
        .map(|bin| {
            let hz = bin as f64 * f64::from(PROFILE_RATE) / FRAME as f64;
            (0..PROFILE_BANDS).find(|band| hz >= edges[*band] && hz < edges[band + 1])
        })
        .collect();
    let (mut mid_in, mut side_in) = (fft.make_input_vec(), fft.make_input_vec());
    let (mut mid_out, mut side_out) = (fft.make_output_vec(), fft.make_output_vec());
    // Per frame: its level, and mid and side power per band.
    let mut rows: Vec<(f64, [f64; PROFILE_BANDS], [f64; PROFILE_BANDS], f64, f64, f64)> = Vec::new();
    let mut start = 0;
    while start + FRAME <= frames {
        let (mut energy, mut low_lr, mut low_ll, mut low_rr) = (0.0_f64, 0.0_f64, 0.0_f64, 0.0_f64);
        for n in 0..FRAME {
            let left = f64::from(audio[2 * (start + n)]);
            let right = f64::from(audio[2 * (start + n) + 1]);
            energy += left * left + right * right;
            mid_in[n] = 0.5 * (left + right) * window[n];
            side_in[n] = 0.5 * (left - right) * window[n];
        }
        fft.process(&mut mid_in, &mut mid_out).unwrap_or(());
        fft.process(&mut side_in, &mut side_out).unwrap_or(());
        let (mut mid, mut side) = ([0.0_f64; PROFILE_BANDS], [0.0_f64; PROFILE_BANDS]);
        for (bin, band) in bin_band.iter().enumerate() {
            if let Some(band) = band {
                mid[*band] += mid_out[bin].norm_sqr();
                side[*band] += side_out[bin].norm_sqr();
            }
            let hz = bin as f64 * f64::from(PROFILE_RATE) / FRAME as f64;
            if hz > 20.0 && hz < 120.0 {
                // L = M + S, R = M − S per bin.
                let (m, s) = (mid_out[bin], side_out[bin]);
                let (l, r) = (m + s, m - s);
                low_lr += l.re * r.re + l.im * r.im;
                low_ll += l.norm_sqr();
                low_rr += r.norm_sqr();
            }
        }
        rows.push((10.0 * (energy / (2.0 * FRAME as f64)).max(1e-20).log10(), mid, side, low_lr, low_ll, low_rr));
        start += FRAME / 2;
    }
    let mut levels: Vec<f64> = rows.iter().map(|row| row.0).collect();
    levels.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let loud = levels.get(((levels.len().max(1) - 1) as f64 * 0.95) as usize).copied().unwrap_or(-120.0);
    let body: Vec<_> = rows.iter().filter(|row| row.0 >= loud - BODY_RANGE_DB && row.0 > -90.0).collect();
    let count = body.len().max(1) as f64;
    let mut mid_db = vec![0.0; PROFILE_BANDS];
    let mut side_db = vec![0.0; PROFILE_BANDS];
    for band in 0..PROFILE_BANDS {
        let mid: f64 = body.iter().map(|row| row.1[band]).sum::<f64>() / count;
        let side: f64 = body.iter().map(|row| row.2[band]).sum::<f64>() / count;
        mid_db[band] = round2(10.0 * mid.max(1e-20).log10());
        side_db[band] = round2(10.0 * side.max(1e-20).log10());
    }
    let (lr, ll, rr) = body.iter().fold((0.0, 0.0, 0.0), |sum, row| (sum.0 + row.3, sum.1 + row.4, sum.2 + row.5));
    let body_rms = body.iter().map(|row| 10_f64.powf(row.0 / 10.0)).sum::<f64>() / count;
    SongProfile {
        version: PROFILE_VERSION,
        duration_seconds: frames as f64 / f64::from(PROFILE_RATE),
        loudness: loudness.into(),
        edges_hz: edges,
        mid_db,
        side_db,
        body_share: round2(body.len() as f64 / rows.len().max(1) as f64),
        crest_db: round2(loudness.sample_peak_dbfs - 10.0 * body_rms.max(1e-20).log10()),
        low_correlation: if ll > 0.0 && rr > 0.0 { round2(lr / (ll * rr).sqrt()) } else { 1.0 },
    }
}

fn round2(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

/// Decodes any supported file to interleaved stereo at 48 kHz (mono is doubled; more channels keep the first two).
pub fn decode_to_48k(path: &Path) -> Result<Vec<f32>, String> {
    use symphonia::core::audio::SampleBuffer;
    let file = File::open(path).map_err(|error| format!("Could not open {}: {error}", path.display()))?;
    let stream = symphonia::core::io::MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = symphonia::core::probe::Hint::new();
    if let Some(extension) = path.extension().and_then(|value| value.to_str()) {
        hint.with_extension(extension);
    }
    let probed = symphonia::default::get_probe()
        .format(&hint, stream, &symphonia::core::formats::FormatOptions { enable_gapless: true, ..Default::default() }, &Default::default())
        .map_err(|_| "This file is not audio Audiosous can read (WAV, AIFF, FLAC, or MP3).".to_string())?;
    let mut format = probed.format;
    let track = format.default_track().ok_or("The file has no audio track.")?.clone();
    let rate = track.codec_params.sample_rate.ok_or("The file has no sample rate.")?;
    let mut decoder = symphonia::default::get_codecs().make(&track.codec_params, &Default::default()).map_err(|error| format!("The file could not be decoded: {error}"))?;
    let mut stereo: Vec<f32> = Vec::new();
    loop {
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(symphonia::core::errors::Error::IoError(error)) if error.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(symphonia::core::errors::Error::ResetRequired) => break,
            Err(error) => return Err(format!("The file is damaged: {error}")),
        };
        if packet.track_id() != track.id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(decoded) => decoded,
            Err(symphonia::core::errors::Error::DecodeError(_)) => continue,
            Err(error) => return Err(format!("The file could not be decoded: {error}")),
        };
        let spec = *decoded.spec();
        let channels = spec.channels.count().max(1);
        let mut buffer = SampleBuffer::<f32>::new(decoded.capacity() as u64, spec);
        buffer.copy_interleaved_ref(decoded);
        for frame in buffer.samples().chunks_exact(channels) {
            stereo.push(frame[0]);
            stereo.push(if channels > 1 { frame[1] } else { frame[0] });
        }
    }
    if stereo.is_empty() {
        return Err("The file has no audio.".into());
    }
    if rate == PROFILE_RATE {
        return Ok(stereo);
    }
    let ratio = f64::from(PROFILE_RATE) / f64::from(rate);
    let chunk = 4_096;
    let parameters = SincInterpolationParameters { sinc_len: 256, f_cutoff: 0.95, oversampling_factor: 256, interpolation: SincInterpolationType::Cubic, window: WindowFunction::BlackmanHarris2 };
    let mut resampler = SincFixedIn::<f32>::new(ratio, 1.0, parameters, chunk, 2).map_err(|error| error.to_string())?;
    let frames = stereo.len() / 2;
    let expected = (frames as f64 * ratio).round() as usize;
    let mut skip = resampler.output_delay();
    let mut out = Vec::with_capacity(expected * 2 + 8);
    let mut output = resampler.output_buffer_allocate(true);
    let mut input = vec![Vec::with_capacity(chunk); 2];
    let mut position = 0;
    let push = |output: &Vec<Vec<f32>>, produced: usize, skip: &mut usize, out: &mut Vec<f32>| {
        let drop = (*skip).min(produced);
        *skip -= drop;
        for frame in drop..produced {
            out.push(output[0][frame]);
            out.push(output[1][frame]);
        }
    };
    while position < frames {
        let take = chunk.min(frames - position);
        for channel in 0..2 {
            input[channel].clear();
            input[channel].extend((position..position + take).map(|frame| stereo[2 * frame + channel]));
        }
        let (_, produced) = if take < chunk { resampler.process_partial_into_buffer(Some(&input), &mut output, None) } else { resampler.process_into_buffer(&input, &mut output, None) }.map_err(|error| error.to_string())?;
        push(&output, produced, &mut skip, &mut out);
        position += take;
    }
    while out.len() / 2 < expected {
        let (_, produced) = resampler.process_partial_into_buffer(None::<&[Vec<f32>]>, &mut output, None).map_err(|error| error.to_string())?;
        if produced == 0 {
            break;
        }
        push(&output, produced, &mut skip, &mut out);
    }
    out.truncate(expected * 2);
    Ok(out)
}

/// Converts a reference song to `dest` (48 kHz stereo float WAV, playable and measurable like a stem) and profiles it.
pub fn import_reference(source: &Path, dest: &Path) -> Result<SongProfile, String> {
    let audio = decode_to_48k(source)?;
    let partial = dest.with_extension("wav.partial");
    let mut writer: Box<dyn AudioWriter> = Box::new(WavWriter::create(&partial, PROFILE_RATE, 2, WavDepth::Float32)?);
    for chunk in audio.chunks(1 << 16) {
        writer.write(chunk)?;
    }
    writer.finish()?;
    std::fs::rename(&partial, dest).map_err(|error| error.to_string())?;
    Ok(profile(&audio))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn noise(frames: usize, seed: u64) -> Vec<f32> {
        let mut state = seed;
        (0..frames * 2)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                ((state >> 40) as f32 / (1_u64 << 24) as f32 - 0.5) * 0.2
            })
            .collect()
    }

    #[test]
    fn mono_has_no_sides_and_full_low_correlation() {
        let mut audio = noise(PROFILE_RATE as usize * 4, 7);
        for frame in audio.chunks_exact_mut(2) {
            frame[1] = frame[0];
        }
        let profile = profile(&audio);
        assert!(profile.side_db.iter().all(|db| *db < -150.0), "{:?}", profile.side_db);
        assert!(profile.low_correlation > 0.99);
        assert_eq!(profile.mid_db.len(), PROFILE_BANDS);
    }

    #[test]
    fn independent_channels_have_equal_mid_and_side() {
        let profile = profile(&noise(PROFILE_RATE as usize * 4, 11));
        for band in 4..PROFILE_BANDS - 1 {
            assert!((profile.mid_db[band] - profile.side_db[band]).abs() < 1.5, "band {band}: {} vs {}", profile.mid_db[band], profile.side_db[band]);
        }
        assert!(profile.low_correlation.abs() < 0.2);
    }

    #[test]
    fn a_quiet_intro_does_not_tilt_the_shape() {
        let rate = PROFILE_RATE as usize;
        let body = noise(rate * 6, 3);
        let mut with_intro: Vec<f32> = (0..rate * 6 * 2).map(|index| if index % 2 == 0 { 0.001 * ((index as f32) * 0.01).sin() } else { 0.0 }).collect();
        with_intro.extend_from_slice(&body);
        let (a, b) = (profile(&body), profile(&with_intro));
        for band in 4..PROFILE_BANDS - 1 {
            assert!((a.mid_db[band] - b.mid_db[band]).abs() < 0.5, "band {band}");
        }
        assert!(b.body_share < 0.6);
    }

    #[test]
    fn imports_and_resamples_a_reference() {
        let dir = std::env::temp_dir().join(format!("audiosous-reference-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let source = dir.join("ref.flac");
        let mut writer = crate::encode::open_writer(crate::encode::ExportFormat::Flac { bits: 24 }, &source, 44_100, 2, &Default::default()).unwrap();
        let tone: Vec<f32> = (0..44_100 * 2).flat_map(|frame| {
            let value = (0.5 * (2.0 * std::f64::consts::PI * 1_000.0 * frame as f64 / 44_100.0).sin()) as f32;
            [value, value]
        }).collect();
        writer.write(&tone).unwrap();
        writer.finish().unwrap();
        let dest = dir.join("ref.wav");
        let profile = import_reference(&source, &dest).unwrap();
        assert!((profile.duration_seconds - 2.0).abs() < 0.01, "{}", profile.duration_seconds);
        let loudest = (0..PROFILE_BANDS).max_by(|a, b| profile.mid_db[*a].partial_cmp(&profile.mid_db[*b]).unwrap()).unwrap();
        assert!(profile.edges_hz[loudest] <= 1_000.0 && profile.edges_hz[loudest + 1] > 1_000.0);
        assert_eq!(decode_to_48k(&dest).unwrap().len(), 96_000 * 2);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
