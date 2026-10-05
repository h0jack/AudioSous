//! Offline bounce of a mix from the 48 kHz playback proxies, for acceptance runs and listening tests.
//!
//! It drives the same EQ, dynamics, and spatial runtimes the device callback uses, built from the same tables, in
//! the same per-frame order: every track's frame is read first (so sidechain keys exist), then static EQ, dynamics,
//! width and pan, and the fader with its 10 ms slew and section gain windows. It does not open a device or use the
//! reader threads, so a 141 s project bounces in a few seconds.
//!
//! It is not an export. It plays the playback proxies, not the original sources.

use std::path::PathBuf;

use crate::dynamics::{DynamicsRuntime, PublishedDynamics};
use crate::engine::{dynamics_table_for, eq_table_for, gain_schedule_for, spatial_regions_for, TrackDynamics, TrackEq, TrackGainRegion, TrackSpatial};
use crate::eq::{EqRuntime, PublishedEq};
use crate::mix::linear_gain;
use crate::proxy::{ProxyReader, PLAYBACK_RATE};
use crate::spatial::{PublishedSpatial, SpatialParams, SpatialRuntime, SpatialTable};

const CHUNK: usize = 4_096;

pub struct BounceTrack {
    pub id: String,
    pub proxy: PathBuf,
    pub gain_db: f32,
    pub muted: bool,
}

#[derive(Default)]
pub struct BounceSettings {
    pub eq: Vec<TrackEq>,
    pub spatial: Vec<TrackSpatial>,
    pub dynamics: Vec<TrackDynamics>,
    pub gain_regions: Vec<TrackGainRegion>,
}

/// Interleaved stereo for `seconds` from the start of the song.
pub fn bounce(tracks: &[BounceTrack], settings: BounceSettings, seconds: f64) -> Result<Vec<f32>, String> {
    let ids: Vec<String> = tracks.iter().map(|track| track.id.clone()).collect();
    let published_eq = PublishedEq::empty();
    published_eq.publish(&eq_table_for(&ids, settings.eq));
    let published_dynamics = PublishedDynamics::empty();
    published_dynamics.publish(&dynamics_table_for(&ids, settings.dynamics));
    let base: Vec<(usize, SpatialParams)> = tracks
        .iter()
        .enumerate()
        .map(|(index, track)| {
            let spatial = settings.spatial.iter().find(|item| item.track_id == track.id);
            (index, SpatialParams { pan: spatial.map(|item| item.pan).unwrap_or(0.0), width: spatial.map(|item| item.width).unwrap_or(1.0) })
        })
        .collect();
    let regions: Vec<(String, crate::engine::TrackSpatialRegion)> = settings
        .spatial
        .iter()
        .flat_map(|track| track.regions.iter().map(move |region| (track.track_id.clone(), region.clone())))
        .collect();
    let published_spatial = PublishedSpatial::empty();
    published_spatial.publish(&SpatialTable::build(&base, &spatial_regions_for(&ids, &regions)));
    let schedule = gain_schedule_for(&ids, settings.gain_regions);

    let mut eq = EqRuntime::new();
    eq.refresh(&published_eq);
    let mut dynamics = DynamicsRuntime::new();
    dynamics.refresh(&published_dynamics);
    let mut spatial = SpatialRuntime::new();
    spatial.refresh(&published_spatial);

    let mut readers = Vec::with_capacity(tracks.len());
    for track in tracks {
        let (header, reader) = ProxyReader::open(&track.proxy)?;
        readers.push((usize::from(header.channels).clamp(1, 2), header.frames, reader));
    }
    let total = (seconds.max(0.0) * f64::from(PLAYBACK_RATE)) as usize;
    let mut out = Vec::with_capacity(total * 2);
    let step = 1.0 / (0.01 * PLAYBACK_RATE as f32);
    let mut gains: Vec<f32> = tracks.iter().map(|track| if track.muted { 0.0 } else { linear_gain(track.gain_db) }).collect();
    let mut buffers: Vec<Vec<f32>> = vec![Vec::new(); tracks.len()];
    let mut got = vec![0_usize; tracks.len()];
    let mut keys = vec![0.0_f32; tracks.len()];
    let mut position = 0_usize;
    while position < total {
        let frames = (total - position).min(CHUNK);
        for (index, (_, length, reader)) in readers.iter_mut().enumerate() {
            let wanted = frames.min((*length as usize).saturating_sub(position));
            got[index] = if wanted > 0 { reader.read_interleaved(wanted, &mut buffers[index])? } else { 0 };
        }
        for frame in 0..frames {
            let file_frame = (position + frame) as u64;
            for (index, (channels, _, _)) in readers.iter().enumerate() {
                keys[index] = if frame < got[index] {
                    let at = frame * channels;
                    if *channels > 1 { 0.5 * (buffers[index][at] + buffers[index][at + 1]) } else { buffers[index][at] }
                } else {
                    0.0
                };
            }
            let (mut left, mut right) = (0.0_f32, 0.0_f32);
            for (index, track) in tracks.iter().enumerate() {
                let target = if track.muted {
                    0.0
                } else {
                    schedule
                        .iter()
                        .find(|region| region.track_index as usize == index && file_frame >= region.start_frame && file_frame < region.end_frame)
                        .map(|region| region.gain)
                        .unwrap_or_else(|| linear_gain(track.gain_db))
                };
                gains[index] += (target - gains[index]).clamp(-step, step);
                if frame >= got[index] {
                    continue;
                }
                let channels = readers[index].0;
                let at = frame * channels;
                let mut sample = [buffers[index][at], if channels > 1 { buffers[index][at + 1] } else { 0.0 }];
                if eq.track_live(index) {
                    eq.process(index, file_frame, channels, &mut sample);
                }
                if dynamics.track_live(index) {
                    dynamics.process(index, file_frame, channels, &mut sample, &keys);
                }
                let (placed_left, placed_right) = spatial.process(index, file_frame, channels, sample);
                left += placed_left * gains[index];
                right += placed_right * gains[index];
            }
            out.push(left);
            out.push(right);
        }
        position += frames;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dynamics::{DynamicsNodeSpec, KeyDetectorKind};
    use crate::engine::{Engine, LoadedTrack};
    use crate::proxy::ensure_proxy;
    use std::sync::atomic::AtomicBool;

    fn write_wav(path: &std::path::Path, frames: usize, sample: impl Fn(usize) -> f32) {
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

    /// The bounce and the real engine produce the same mix for the same settings.
    #[test]
    fn a_bounce_matches_the_engine() {
        let dir = std::env::temp_dir().join(format!("audiosous-bounce-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let frames = 48_000 * 2;
        let make = |name: &str, sample: &dyn Fn(usize) -> f32| {
            let source = dir.join(format!("{name}.wav"));
            write_wav(&source, frames, sample);
            let proxy = dir.join(format!("{name}.proxy"));
            let size = std::fs::metadata(&source).unwrap().len();
            ensure_proxy(&source, &proxy, size, 1, &AtomicBool::new(false), &mut |_| {}).unwrap();
            (source, proxy, size)
        };
        let kick = make("kick", &|frame| {
            let local = (frame % 24_000) as f32 / 48_000.0;
            (-local / 0.08).exp() * (2.0 * std::f32::consts::PI * 60.0 * local).sin() * 0.8
        });
        let bass = make("bass", &|frame| 0.3 * (2.0 * std::f32::consts::PI * 80.0 * frame as f32 / 48_000.0).sin());
        let dynamics = || {
            vec![TrackDynamics {
                track_id: "bass".into(),
                nodes: vec![
                    DynamicsNodeSpec::Compressor { threshold_db: -20.0, ratio: 2.0, attack_ms: 10.0, release_ms: 100.0, knee_db: 6.0, makeup_db: 0.0 },
                    DynamicsNodeSpec::Ducking { key_track_id: "kick".into(), key_detector: KeyDetectorKind::Transient, threshold_db: -14.0, range_db: -3.0, attack_ms: 5.0, release_ms: 80.0 },
                ],
                regions: vec![],
            }]
        };
        let bounced = bounce(
            &[
                BounceTrack { id: "kick".into(), proxy: kick.1.clone(), gain_db: -3.0, muted: false },
                BounceTrack { id: "bass".into(), proxy: bass.1.clone(), gain_db: 0.0, muted: false },
            ],
            BounceSettings { dynamics: dynamics(), ..Default::default() },
            1.5,
        )
        .unwrap();
        let engine = Engine::offline();
        let loaded = |id: &str, (source, proxy, size): &(std::path::PathBuf, std::path::PathBuf, u64), gain_db: f32| LoadedTrack {
            id: id.into(),
            label: id.into(),
            source_path: source.clone(),
            proxy_path: proxy.clone(),
            source_size: *size,
            source_modified_ns: 1,
            gain_db,
            pan: 0.0,
            width: 1.0,
            muted: false,
            solo: false,
        };
        engine.load(vec![loaded("kick", &kick, -3.0), loaded("bass", &bass, 0.0)]).unwrap();
        engine.set_dynamics(dynamics());
        engine.play(0.0).unwrap();
        let mut played = Vec::new();
        let mut block = vec![0.0_f32; 960];
        while played.len() < bounced.len() {
            engine.render_block(&mut block);
            played.extend_from_slice(&block);
        }
        engine.shutdown();
        let difference = bounced.iter().zip(played.iter()).map(|(a, b)| (a - b).abs()).fold(0.0, f32::max);
        assert!(difference < 1e-4, "bounce and engine differ by {difference}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
