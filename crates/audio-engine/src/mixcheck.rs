//! Whole-mix check: renders mix variants (Current, a full-mix candidate) from the playback proxies through the
//! same EQ, dynamics, spatial, and gain runtimes as playback (`bounce.rs`), over chosen windows of the song, and
//! measures what a plan can only estimate: the sample peak, the level, the mono fold-down, the correlation, and the
//! level of each section, so a candidate's clipping, mono collapse, level shifts, and section steps are read on audio.
//!
//! Each window is rendered from one second before it, cold like after a seek, and that second is dropped.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::bounce::{bounce_range, BounceSettings, BounceTrack};
use crate::dynamics::DynamicsNodeSpec;
use crate::engine::{TrackDynamics, TrackDynamicsRegion, TrackEq, TrackEqRegion, TrackGainRegion, TrackSpatial, TrackSpatialRegion};
use crate::eq::FilterSpec;
use crate::proxy::PLAYBACK_RATE;

/// Seconds rendered before each window and dropped, so filters and detectors are settled when it starts.
pub const MIX_CHECK_PREROLL: f64 = 1.0;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MixVariantSpec {
    pub name: String,
    pub tracks: Vec<MixTrackSpec>,
    pub gain_regions: Vec<MixGainRegionSpec>,
    pub eq: Vec<MixEqSpec>,
    pub spatial: Vec<MixSpatialSpec>,
    pub dynamics: Vec<MixDynamicsSpec>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MixTrackSpec {
    pub id: String,
    pub gain_db: f32,
    pub muted: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MixGainRegionSpec {
    pub track_id: String,
    pub start_seconds: f64,
    pub end_seconds: f64,
    pub gain_db: f32,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MixEqSpec {
    pub track_id: String,
    pub filters: Vec<FilterSpec>,
    pub regions: Vec<MixEqRegionSpec>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MixEqRegionSpec {
    pub start_seconds: f64,
    pub end_seconds: f64,
    pub filters: Vec<FilterSpec>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MixSpatialSpec {
    pub track_id: String,
    pub pan: f32,
    pub width: f32,
    pub regions: Vec<MixSpatialRegionSpec>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MixSpatialRegionSpec {
    pub start_seconds: f64,
    pub end_seconds: f64,
    pub pan: f32,
    pub width: f32,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MixDynamicsSpec {
    pub track_id: String,
    pub nodes: Vec<DynamicsNodeSpec>,
    pub regions: Vec<MixDynamicsRegionSpec>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MixDynamicsRegionSpec {
    pub start_seconds: f64,
    pub end_seconds: f64,
    pub nodes: Vec<DynamicsNodeSpec>,
}

impl MixVariantSpec {
    /// The engine settings for an offline render, with each track's proxy from `proxy_for`.
    pub fn bounce_inputs(&self, proxy_for: impl Fn(&str) -> Result<PathBuf, String>) -> Result<(Vec<BounceTrack>, BounceSettings), String> {
        let mut tracks = Vec::with_capacity(self.tracks.len());
        for track in &self.tracks {
            tracks.push(BounceTrack { id: track.id.clone(), proxy: proxy_for(&track.id)?, gain_db: track.gain_db, muted: track.muted });
        }
        let settings = BounceSettings {
            eq: self
                .eq
                .iter()
                .map(|track| TrackEq {
                    track_id: track.track_id.clone(),
                    filters: track.filters.clone(),
                    regions: track.regions.iter().map(|region| TrackEqRegion { start_seconds: region.start_seconds, end_seconds: region.end_seconds, filters: region.filters.clone() }).collect(),
                })
                .collect(),
            spatial: self
                .spatial
                .iter()
                .map(|track| TrackSpatial {
                    track_id: track.track_id.clone(),
                    pan: track.pan,
                    width: track.width,
                    regions: track.regions.iter().map(|region| TrackSpatialRegion { start_seconds: region.start_seconds, end_seconds: region.end_seconds, pan: region.pan, width: region.width }).collect(),
                })
                .collect(),
            dynamics: self
                .dynamics
                .iter()
                .map(|track| TrackDynamics {
                    track_id: track.track_id.clone(),
                    nodes: track.nodes.clone(),
                    regions: track.regions.iter().map(|region| TrackDynamicsRegion { start_seconds: region.start_seconds, end_seconds: region.end_seconds, nodes: region.nodes.clone() }).collect(),
                })
                .collect(),
            gain_regions: self
                .gain_regions
                .iter()
                .map(|region| TrackGainRegion { track_id: region.track_id.clone(), start_seconds: region.start_seconds, end_seconds: region.end_seconds, gain_db: region.gain_db })
                .collect(),
        };
        Ok((tracks, settings))
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MixSectionSpec {
    pub id: String,
    pub start_seconds: f64,
    pub end_seconds: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SectionLevel {
    pub id: String,
    /// Mean stereo power over the rendered part of the section, dB; null when no window falls in it.
    pub rms_db: Option<f64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MixCheck {
    pub name: String,
    /// Seconds rendered and measured (pre-roll excluded).
    pub seconds: f64,
    pub peak_dbfs: f64,
    pub rms_db: f64,
    /// Stereo power over the power of (L + R) / 2, dB: what folding to mono loses.
    pub mono_loss_db: f64,
    pub correlation: f64,
    pub sections: Vec<SectionLevel>,
}

/// Renders each variant over the same windows and measures it. Windows are clamped to the song and merged.
pub fn check_mix(
    variants: &[MixVariantSpec],
    windows: &[(f64, f64)],
    sections: &[MixSectionSpec],
    duration_seconds: f64,
    proxy_for: impl Fn(&str) -> Result<PathBuf, String>,
) -> Result<Vec<MixCheck>, String> {
    let windows = merge_windows(windows, duration_seconds);
    let mut out = Vec::with_capacity(variants.len());
    for variant in variants {
        let mut acc = Accumulator::new(sections);
        for &(start, end) in &windows {
            let (tracks, settings) = variant.bounce_inputs(&proxy_for)?;
            let from = (start - MIX_CHECK_PREROLL).max(0.0);
            let audio = bounce_range(&tracks, settings, from, end - from)?;
            let skip = (((start - from) * f64::from(PLAYBACK_RATE)) as usize) * 2;
            acc.add(&audio[skip.min(audio.len())..], start);
        }
        out.push(acc.finish(&variant.name));
    }
    Ok(out)
}

/// Sorted, clamped to the song, overlaps merged.
pub fn merge_windows(windows: &[(f64, f64)], duration_seconds: f64) -> Vec<(f64, f64)> {
    let mut sorted: Vec<(f64, f64)> = windows
        .iter()
        .map(|&(start, end)| (start.max(0.0), end.min(duration_seconds)))
        .filter(|(start, end)| end - start > 0.05)
        .collect();
    sorted.sort_by(|left, right| left.0.partial_cmp(&right.0).unwrap_or(std::cmp::Ordering::Equal));
    let mut merged: Vec<(f64, f64)> = Vec::with_capacity(sorted.len());
    for (start, end) in sorted {
        match merged.last_mut() {
            Some(last) if start <= last.1 => last.1 = last.1.max(end),
            _ => merged.push((start, end)),
        }
    }
    merged
}

struct Accumulator<'a> {
    sections: &'a [MixSectionSpec],
    frames: u64,
    peak: f32,
    left: f64,
    right: f64,
    cross: f64,
    mono: f64,
    section_power: Vec<(f64, u64)>,
}

impl<'a> Accumulator<'a> {
    fn new(sections: &'a [MixSectionSpec]) -> Self {
        Self { sections, frames: 0, peak: 0.0, left: 0.0, right: 0.0, cross: 0.0, mono: 0.0, section_power: vec![(0.0, 0); sections.len()] }
    }

    fn add(&mut self, interleaved: &[f32], start_seconds: f64) {
        for (frame, pair) in interleaved.chunks_exact(2).enumerate() {
            let (l, r) = (f64::from(pair[0]), f64::from(pair[1]));
            self.peak = self.peak.max(pair[0].abs()).max(pair[1].abs());
            self.left += l * l;
            self.right += r * r;
            self.cross += l * r;
            let m = 0.5 * (l + r);
            self.mono += m * m;
            self.frames += 1;
            let seconds = start_seconds + frame as f64 / f64::from(PLAYBACK_RATE);
            if let Some(index) = self.sections.iter().position(|section| seconds >= section.start_seconds && seconds < section.end_seconds) {
                self.section_power[index].0 += 0.5 * (l * l + r * r);
                self.section_power[index].1 += 1;
            }
        }
    }

    fn finish(self, name: &str) -> MixCheck {
        let frames = self.frames.max(1) as f64;
        let stereo = 0.5 * (self.left + self.right) / frames;
        let mono = self.mono / frames;
        let db = |power: f64| 10.0 * power.max(1e-20).log10();
        let denominator = (self.left * self.right).sqrt();
        MixCheck {
            name: name.to_string(),
            seconds: self.frames as f64 / f64::from(PLAYBACK_RATE),
            peak_dbfs: 20.0 * f64::from(self.peak).max(1e-10).log10(),
            rms_db: db(stereo),
            mono_loss_db: if stereo > 1e-20 { db(stereo) - db(mono) } else { 0.0 },
            correlation: if denominator > 1e-20 { self.cross / denominator } else { 1.0 },
            sections: self
                .sections
                .iter()
                .zip(self.section_power.iter())
                .map(|(section, (power, count))| SectionLevel { id: section.id.clone(), rms_db: (*count > 0).then(|| db(power / *count as f64)) })
                .collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proxy::ensure_proxy;
    use std::sync::atomic::AtomicBool;

    fn write_wav(path: &std::path::Path, frames: usize, channels: u16, sample: impl Fn(usize, usize) -> f32) {
        let data = (frames * 4 * channels as usize) as u32;
        let mut body = Vec::with_capacity(44 + data as usize);
        body.extend_from_slice(b"RIFF");
        body.extend_from_slice(&(36 + data).to_le_bytes());
        body.extend_from_slice(b"WAVEfmt ");
        body.extend_from_slice(&16_u32.to_le_bytes());
        body.extend_from_slice(&3_u16.to_le_bytes());
        body.extend_from_slice(&channels.to_le_bytes());
        body.extend_from_slice(&48_000_u32.to_le_bytes());
        body.extend_from_slice(&(48_000_u32 * 4 * u32::from(channels)).to_le_bytes());
        body.extend_from_slice(&(4 * channels).to_le_bytes());
        body.extend_from_slice(&32_u16.to_le_bytes());
        body.extend_from_slice(b"data");
        body.extend_from_slice(&data.to_le_bytes());
        for frame in 0..frames {
            for channel in 0..channels as usize {
                body.extend_from_slice(&sample(frame, channel).to_le_bytes());
            }
        }
        std::fs::write(path, body).unwrap();
    }

    fn proxy(dir: &std::path::Path, name: &str, channels: u16, sample: impl Fn(usize, usize) -> f32) -> PathBuf {
        let source = dir.join(format!("{name}.wav"));
        write_wav(&source, 48_000 * 4, channels, sample);
        let out = dir.join(format!("{name}.proxy"));
        let size = std::fs::metadata(&source).unwrap().len();
        ensure_proxy(&source, &out, size, 1, &AtomicBool::new(false), &mut |_| {}).unwrap();
        out
    }

    fn variant(name: &str, gain_db: f32, width: f32) -> MixVariantSpec {
        MixVariantSpec {
            name: name.into(),
            tracks: vec![MixTrackSpec { id: "a".into(), gain_db, muted: false }],
            gain_regions: vec![],
            eq: vec![],
            spatial: vec![MixSpatialSpec { track_id: "a".into(), pan: 0.0, width, regions: vec![] }],
            dynamics: vec![],
        }
    }

    #[test]
    fn measures_level_peak_mono_and_sections_and_follows_the_settings() {
        let dir = std::env::temp_dir().join(format!("audiosous-mixcheck-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // A stereo tone with a decorrelated side: mid 0.5, side 0.2.
        let path = proxy(&dir, "a", 2, |frame, channel| {
            let t = frame as f32 / 48_000.0;
            let mid = 0.5 * (2.0 * std::f32::consts::PI * 220.0 * t).sin();
            let side = 0.2 * (2.0 * std::f32::consts::PI * 330.0 * t).sin();
            if channel == 0 { mid + side } else { mid - side }
        });
        let sections = vec![MixSectionSpec { id: "one".into(), start_seconds: 0.0, end_seconds: 2.0 }, MixSectionSpec { id: "two".into(), start_seconds: 2.0, end_seconds: 4.0 }];
        let checks = check_mix(&[variant("current", 0.0, 1.0), variant("quieter", -6.0, 1.0), variant("mono", 0.0, 0.0)], &[(0.5, 1.5), (2.5, 3.5)], &sections, 4.0, |_| Ok(path.clone())).unwrap();
        let (current, quieter, mono) = (&checks[0], &checks[1], &checks[2]);
        assert!((current.seconds - 2.0).abs() < 0.01, "{}", current.seconds);
        assert!((current.rms_db - quieter.rms_db - 6.0).abs() < 0.05, "{} {}", current.rms_db, quieter.rms_db);
        assert!((current.peak_dbfs - quieter.peak_dbfs - 6.0).abs() < 0.05);
        assert!(current.mono_loss_db > 0.3, "decorrelated side folds away: {}", current.mono_loss_db);
        assert!(mono.mono_loss_db.abs() < 0.01, "width 0 is mono: {}", mono.mono_loss_db);
        assert!(mono.correlation > 0.999);
        assert!(current.sections.iter().all(|section| section.rms_db.is_some()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn windows_are_clamped_sorted_and_merged() {
        assert_eq!(merge_windows(&[(5.0, 9.0), (-1.0, 2.0), (8.0, 12.0), (20.0, 30.0)], 25.0), vec![(0.0, 2.0), (5.0, 12.0), (20.0, 25.0)]);
    }

    #[test]
    fn a_window_render_equals_the_same_span_of_a_full_render() {
        let dir = std::env::temp_dir().join(format!("audiosous-mixwindow-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = proxy(&dir, "b", 1, |frame, _| 0.4 * (2.0 * std::f32::consts::PI * 110.0 * frame as f32 / 48_000.0).sin());
        let spec = variant("x", -3.0, 1.0);
        let (tracks, settings) = spec.bounce_inputs(|_| Ok(path.clone())).unwrap();
        let full = crate::bounce::bounce(&tracks, settings, 3.0).unwrap();
        let (tracks, settings) = spec.bounce_inputs(|_| Ok(path.clone())).unwrap();
        let window = bounce_range(&tracks, settings, 1.0, 1.0).unwrap();
        let offset = 48_000 * 2;
        // No EQ or dynamics state to settle and the fader is already at its target: the samples are the same.
        let difference = window.iter().zip(full[offset..offset + window.len()].iter()).map(|(a, b)| (a - b).abs()).fold(0.0_f32, f32::max);
        assert!(difference < 1e-6, "window and full render differ by {difference}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
