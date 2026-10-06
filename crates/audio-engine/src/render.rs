//! The mix graph, run offline: the same per-frame order and the same EQ, dynamics, and spatial runtimes the device
//! callback uses, at any sample rate, fed from any frame source.
//!
//! `bounce.rs` drives it from the 48 kHz playback proxies (acceptance renders and the Full Mix render check).
//! `export.rs` drives it from the original stems, resampled once to the export rate with a long sinc when their
//! rate differs, so a finished file keeps the source quality instead of the playback proxy's.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use rubato::{Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction};

use crate::bounce::BounceSettings;
use crate::dynamics::{DynamicsRuntime, PublishedDynamics};
use crate::engine::{dynamics_table_for_at, eq_table_for_at, gain_schedule_for_at, spatial_regions_for_at};
use crate::mix::GainRegion;
use crate::eq::{EqRuntime, PublishedEq};
use crate::mix::linear_gain;
use crate::proxy::ProxyReader;
use crate::source::SourceReader;
use crate::spatial::{PublishedSpatial, SpatialParams, SpatialRuntime, SpatialTable};

/// Frames rendered per step.
pub const RENDER_CHUNK: usize = 4_096;

/// One track's audio at the render rate, as interleaved frames of one or two channels.
pub trait FrameSource {
    fn channels(&self) -> usize;
    /// Frames this source has in all (at the render rate).
    fn frames(&self) -> u64;
    /// Reads up to `frames` frames into `out` (interleaved, cleared first). Returns the frames read; 0 at the end.
    fn read(&mut self, frames: usize, out: &mut Vec<f32>) -> Result<usize, String>;
}

/// A playback proxy (always 48 kHz).
pub struct ProxySource {
    reader: ProxyReader,
    channels: usize,
    frames: u64,
    position: u64,
}

impl ProxySource {
    pub fn open(path: &Path, start_frame: u64) -> Result<Self, String> {
        let (header, mut reader) = ProxyReader::open(path)?;
        let start = start_frame.min(header.frames);
        if start > 0 {
            reader.seek_frame(start)?;
        }
        Ok(Self { reader, channels: usize::from(header.channels).clamp(1, 2), frames: header.frames, position: start })
    }
}

impl FrameSource for ProxySource {
    fn channels(&self) -> usize {
        self.channels
    }
    fn frames(&self) -> u64 {
        self.frames
    }
    fn read(&mut self, frames: usize, out: &mut Vec<f32>) -> Result<usize, String> {
        let wanted = frames.min(self.frames.saturating_sub(self.position) as usize);
        if wanted == 0 {
            out.clear();
            return Ok(0);
        }
        let got = self.reader.read_interleaved(wanted, out)?;
        self.position += got as u64;
        Ok(got)
    }
}

/// Quality of the export resampler: a 256-tap Blackman-Harris windowed sinc, cut off at 95% of the lower Nyquist.
fn export_sinc() -> SincInterpolationParameters {
    SincInterpolationParameters { sinc_len: 256, f_cutoff: 0.95, oversampling_factor: 256, interpolation: SincInterpolationType::Cubic, window: WindowFunction::BlackmanHarris2 }
}

/// An original stem, decoded in blocks and, when its rate differs from the render rate, resampled once. The
/// resampler's delay is removed, so frame 0 is the stem's first sample on every track whatever its rate.
pub struct SourceStream {
    reader: SourceReader,
    channels: usize,
    resampler: Option<SincFixedIn<f32>>,
    input: Vec<Vec<f32>>,
    output: Vec<Vec<f32>>,
    /// Resampled frames waiting to be read, planar.
    pending: Vec<Vec<f32>>,
    pending_at: usize,
    skip: usize,
    input_done: bool,
    total: u64,
    produced: u64,
}

impl SourceStream {
    pub fn open(path: &Path, rate: u32) -> Result<Self, String> {
        let reader = SourceReader::open(path)?;
        let format = reader.format().clone();
        let channels = usize::from(format.playback_channels).clamp(1, 2);
        let (resampler, total, skip) = if format.sample_rate == rate {
            (None, format.frames, 0)
        } else {
            let ratio = f64::from(rate) / f64::from(format.sample_rate);
            let resampler = SincFixedIn::<f32>::new(ratio, 1.0, export_sinc(), RENDER_CHUNK, channels).map_err(|error| format!("Could not start the export resampler: {error}"))?;
            let skip = resampler.output_delay();
            (Some(resampler), (format.frames as f64 * ratio).round() as u64, skip)
        };
        let output = resampler.as_ref().map(|item| item.output_buffer_allocate(true)).unwrap_or_default();
        Ok(Self { reader, channels, resampler, input: vec![Vec::new(); channels], output, pending: vec![Vec::new(); channels], pending_at: 0, skip, input_done: false, total, produced: 0 })
    }

    pub fn source_rate(&self) -> u32 {
        self.reader.format().sample_rate
    }

    fn pending_len(&self) -> usize {
        self.pending[0].len() - self.pending_at
    }

    /// Runs the resampler until `wanted` frames are waiting or the stem has ended.
    fn fill(&mut self, wanted: usize) -> Result<(), String> {
        let Some(resampler) = self.resampler.as_mut() else {
            return Ok(());
        };
        if self.pending_at > 0 {
            for channel in &mut self.pending {
                channel.drain(..self.pending_at);
            }
            self.pending_at = 0;
        }
        while self.pending[0].len() < wanted && self.produced + (self.pending[0].len() as u64) < self.total {
            let produced = if self.input_done {
                let (_, produced) = resampler.process_partial_into_buffer(None::<&[Vec<f32>]>, &mut self.output, None).map_err(|error| format!("Export resample failed: {error}"))?;
                if produced == 0 {
                    break;
                }
                produced
            } else {
                let need = resampler.input_frames_next();
                let count = self.reader.read_planar(need, &mut self.input)?;
                if count < need {
                    self.input_done = true;
                }
                if count == 0 {
                    continue;
                }
                for channel in &mut self.input {
                    channel.truncate(count);
                }
                let (_, produced) = if count < need {
                    resampler.process_partial_into_buffer(Some(&self.input), &mut self.output, None)
                } else {
                    resampler.process_into_buffer(&self.input, &mut self.output, None)
                }
                .map_err(|error| format!("Export resample failed: {error}"))?;
                produced
            };
            let drop = self.skip.min(produced);
            self.skip -= drop;
            for (channel, out) in self.pending.iter_mut().zip(self.output.iter()) {
                channel.extend_from_slice(&out[drop..produced]);
            }
        }
        Ok(())
    }
}

impl FrameSource for SourceStream {
    fn channels(&self) -> usize {
        self.channels
    }
    fn frames(&self) -> u64 {
        self.total
    }
    fn read(&mut self, frames: usize, out: &mut Vec<f32>) -> Result<usize, String> {
        out.clear();
        let left = self.total.saturating_sub(self.produced) as usize;
        let frames = frames.min(left);
        if frames == 0 {
            return Ok(0);
        }
        if self.resampler.is_none() {
            let got = self.reader.read_planar(frames, &mut self.input)?;
            for frame in 0..got {
                for channel in 0..self.channels {
                    out.push(self.input[channel][frame]);
                }
            }
            self.produced += got as u64;
            return Ok(got);
        }
        self.fill(frames)?;
        let got = frames.min(self.pending_len());
        for frame in 0..got {
            for channel in 0..self.channels {
                out.push(self.pending[channel][self.pending_at + frame]);
            }
        }
        self.pending_at += got;
        self.produced += got as u64;
        Ok(got)
    }
}

/// A track's fader and mute for a render.
pub struct GraphTrack {
    pub id: String,
    pub gain_db: f32,
    pub muted: bool,
}

/// The processing graph of one mix at one rate: EQ (track, then section), dynamics (with sidechain keys from every
/// track's raw frame), width and pan, the fader with its 10 ms slew and section gain windows, then the sum.
pub struct MixGraph {
    eq: EqRuntime,
    dynamics: DynamicsRuntime,
    spatial: SpatialRuntime,
    schedule: Vec<GainRegion>,
    faders: Vec<f32>,
    muted: Vec<bool>,
    gains: Vec<f32>,
    keys: Vec<f32>,
    step: f32,
}

impl MixGraph {
    pub fn new(tracks: &[GraphTrack], settings: BounceSettings, rate: u32) -> Self {
        let ids: Vec<String> = tracks.iter().map(|track| track.id.clone()).collect();
        let published_eq = PublishedEq::empty();
        published_eq.publish(&eq_table_for_at(&ids, settings.eq, rate));
        let published_dynamics = PublishedDynamics::empty();
        published_dynamics.publish(&dynamics_table_for_at(&ids, settings.dynamics, rate));
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
        published_spatial.publish(&SpatialTable::build(&base, &spatial_regions_for_at(&ids, &regions, rate)));
        let mut eq = EqRuntime::with_rate(rate);
        eq.refresh(&published_eq);
        let mut dynamics = DynamicsRuntime::with_rate(rate as f32);
        dynamics.refresh(&published_dynamics);
        let mut spatial = SpatialRuntime::with_rate(rate);
        spatial.refresh(&published_spatial);
        let faders: Vec<f32> = tracks.iter().map(|track| linear_gain(track.gain_db)).collect();
        let muted: Vec<bool> = tracks.iter().map(|track| track.muted).collect();
        Self {
            eq,
            dynamics,
            spatial,
            schedule: gain_schedule_for_at(&ids, settings.gain_regions, rate),
            gains: faders.iter().zip(muted.iter()).map(|(fader, muted)| if *muted { 0.0 } else { *fader }).collect(),
            faders,
            muted,
            keys: vec![0.0; tracks.len()],
            step: 1.0 / (0.01 * rate as f32),
        }
    }

    /// Mixes `frames` frames starting at song frame `start`. `inputs[i]` is track i's interleaved block and how many
    /// frames it has (a stem that ended is silent). Appends interleaved stereo to `out`.
    pub fn render(&mut self, start: u64, frames: usize, inputs: &[(usize, &[f32], usize)], out: &mut Vec<f32>) {
        for frame in 0..frames {
            let file_frame = start + frame as u64;
            for (index, (channels, buffer, got)) in inputs.iter().enumerate() {
                self.keys[index] = if frame < *got {
                    let at = frame * channels;
                    if *channels > 1 { 0.5 * (buffer[at] + buffer[at + 1]) } else { buffer[at] }
                } else {
                    0.0
                };
            }
            let (mut left, mut right) = (0.0_f32, 0.0_f32);
            for (index, (channels, buffer, got)) in inputs.iter().enumerate() {
                let target = if self.muted[index] {
                    0.0
                } else {
                    self.schedule
                        .iter()
                        .find(|region| region.track_index as usize == index && file_frame >= region.start_frame && file_frame < region.end_frame)
                        .map(|region| region.gain)
                        .unwrap_or(self.faders[index])
                };
                self.gains[index] += (target - self.gains[index]).clamp(-self.step, self.step);
                if frame >= *got {
                    continue;
                }
                let at = frame * channels;
                let mut sample = [buffer[at], if *channels > 1 { buffer[at + 1] } else { 0.0 }];
                if self.eq.track_live(index) {
                    self.eq.process(index, file_frame, *channels, &mut sample);
                }
                if self.dynamics.track_live(index) {
                    self.dynamics.process(index, file_frame, *channels, &mut sample, &self.keys);
                }
                let (placed_left, placed_right) = self.spatial.process(index, file_frame, *channels, sample);
                left += placed_left * self.gains[index];
                right += placed_right * self.gains[index];
            }
            out.push(left);
            out.push(right);
        }
    }
}

/// How far a render has come, for progress.
#[derive(Clone, Copy, Debug)]
pub struct RenderProgress {
    pub frames_done: u64,
    pub frames_total: u64,
}

/// Renders `seconds` of the mix from `sources` through the graph at `rate`, handing each interleaved stereo chunk to
/// `sink`. Stops with an error when `cancel` is set.
pub fn render_mix(sources: &mut [Box<dyn FrameSource>], graph: &mut MixGraph, rate: u32, seconds: f64, cancel: &AtomicBool, sink: &mut dyn FnMut(&[f32]) -> Result<(), String>, progress: &mut dyn FnMut(RenderProgress)) -> Result<u64, String> {
    let total = (seconds.max(0.0) * f64::from(rate)).round() as u64;
    let mut buffers: Vec<Vec<f32>> = vec![Vec::with_capacity(RENDER_CHUNK * 2); sources.len()];
    let mut got = vec![0_usize; sources.len()];
    let mut out = Vec::with_capacity(RENDER_CHUNK * 2);
    let mut position = 0_u64;
    while position < total {
        if cancel.load(Ordering::Relaxed) {
            return Err(CANCELLED.into());
        }
        let frames = (total - position).min(RENDER_CHUNK as u64) as usize;
        for (index, source) in sources.iter_mut().enumerate() {
            got[index] = source.read(frames, &mut buffers[index])?;
        }
        let inputs: Vec<(usize, &[f32], usize)> = sources.iter().zip(buffers.iter()).zip(got.iter()).map(|((source, buffer), got)| (source.channels(), buffer.as_slice(), *got)).collect();
        out.clear();
        graph.render(position, frames, &inputs, &mut out);
        sink(&out)?;
        position += frames as u64;
        progress(RenderProgress { frames_done: position, frames_total: total });
    }
    Ok(total)
}

pub const CANCELLED: &str = "Export was cancelled.";
