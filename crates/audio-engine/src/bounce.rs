//! Offline bounce of a mix from the 48 kHz playback proxies, for acceptance runs and listening tests.
//!
//! It drives the same EQ, dynamics, and spatial runtimes the device callback uses, built from the same tables, in
//! the same per-frame order: every track's frame is read first (so sidechain keys exist), then static EQ, dynamics,
//! width and pan, and the fader with its 10 ms slew and section gain windows. It does not open a device or use the
//! reader threads, so a 141 s project bounces in a few seconds.
//!
//! It is not an export. It plays the playback proxies, not the original sources; `export.rs` renders the same graph
//! (`render.rs`) from the original stems at the export rate.

use std::path::PathBuf;

use crate::engine::{TrackDynamics, TrackEq, TrackGainRegion, TrackSpatial};
use crate::proxy::PLAYBACK_RATE;
use crate::render::{FrameSource, GraphTrack, MixGraph, ProxySource};

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
    bounce_range(tracks, settings, 0.0, seconds)
}

/// Interleaved stereo for `seconds` from `start_seconds`. Filters, detectors, and ramps start cold at the start,
/// as after a seek; a caller that measures a window renders a little before it and drops that part.
pub fn bounce_range(tracks: &[BounceTrack], settings: BounceSettings, start_seconds: f64, seconds: f64) -> Result<Vec<f32>, String> {
    let graph_tracks: Vec<GraphTrack> = tracks.iter().map(|track| GraphTrack { id: track.id.clone(), gain_db: track.gain_db, muted: track.muted }).collect();
    let mut graph = MixGraph::new(&graph_tracks, settings, PLAYBACK_RATE);
    let start = (start_seconds.max(0.0) * f64::from(PLAYBACK_RATE)) as u64;
    let mut sources: Vec<Box<dyn FrameSource>> = Vec::with_capacity(tracks.len());
    for track in tracks {
        sources.push(Box::new(ProxySource::open(&track.proxy, start)?));
    }
    let total = (seconds.max(0.0) * f64::from(PLAYBACK_RATE)) as usize;
    let mut out = Vec::with_capacity(total * 2);
    let mut buffers: Vec<Vec<f32>> = vec![Vec::new(); tracks.len()];
    let mut got = vec![0_usize; tracks.len()];
    let mut position = 0_usize;
    while position < total {
        let frames = (total - position).min(CHUNK);
        for (index, source) in sources.iter_mut().enumerate() {
            got[index] = source.read(frames, &mut buffers[index])?;
        }
        let inputs: Vec<(usize, &[f32], usize)> = sources.iter().zip(buffers.iter()).zip(got.iter()).map(|((source, buffer), got)| (source.channels(), buffer.as_slice(), *got)).collect();
        graph.render(start + position as u64, frames, &inputs, &mut out);
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
