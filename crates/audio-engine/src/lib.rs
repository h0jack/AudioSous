//! Native playback engine.
//!
//! The audio callback mixes samples that are already in per-track ring buffers.
//! Disk reads, resampling, and Tauri commands stay on other threads.

mod bands;
mod bounce;
mod dynamics;
mod engine;
mod envelope;
mod eq;
mod mix;
mod mixcheck;
mod peaks;
mod proxy;
mod source;
mod spatial;
mod stereo;
mod verify;

pub use bands::{band_edges, cached_band_frames, measure_band_frames, BandFrames, BandsIdentity, BANDS_VERSION};
pub use bounce::{bounce, bounce_range, BounceSettings, BounceTrack};
pub use mixcheck::{check_mix, merge_windows, MixCheck, MixSectionSpec, MixVariantSpec, SectionLevel, MIX_CHECK_PREROLL};
pub use dynamics::{reduction_db, DynKind, DynSpec, DynamicsChain, DynamicsNodeSpec, KeyDetectorKind, CONTROL_FRAMES, DYNAMICS_RAMP_FRAMES, KEY_SPAN_DB};
pub use envelope::{cached_envelope_frames, dequantize_db, measure_envelope_frames, EnvelopeFrames, ENVELOPE_HOP, ENVELOPE_VERSION};
pub use engine::{DynamicsMeter, Engine, EngineStatus, LoadedTrack, TrackDynamics, TrackDynamicsRegion, TrackEq, TrackEqRegion, TrackGainRegion, TrackSpatial, TrackSpatialRegion};
pub use eq::{
    cookbook_magnitude_db, EqChain, FilterKind, FilterSpec, EQ_RAMP_FRAMES, MAX_SECTION_BANDS,
    MAX_TRACK_BANDS,
};
pub use peaks::{measure_peaks, MEASURE_CANCELLED};
pub use spatial::{process_interleaved as spatial_process_interleaved, SpatialParams, MAX_SPATIAL_REGIONS, MAX_WIDTH, SPATIAL_RAMP_FRAMES};
pub use proxy::{ensure_proxy, proxy_file_name, PLAYBACK_RATE, PROXY_VERSION, RESAMPLER_ID};
pub use stereo::{cached_stereo_frames, measure_stereo_frames, stereo_band_edges, StereoFrames, STEREO_BANDS, STEREO_VERSION};
pub use verify::{check_candidate, check_dynamics, check_spatial, CandidateCheck, DynamicsCheck, DynamicsCheckInput, LevelStats, SpatialCheck, StereoStats};
