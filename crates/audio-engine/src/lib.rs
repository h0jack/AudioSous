//! Native playback engine.
//!
//! The audio callback mixes samples that are already in per-track ring buffers.
//! Disk reads, resampling, and Tauri commands stay on other threads.

mod bands;
mod engine;
mod eq;
mod mix;
mod peaks;
mod proxy;
mod source;
mod verify;

pub use bands::{band_edges, cached_band_frames, measure_band_frames, BandFrames, BandsIdentity, BANDS_VERSION};
pub use engine::{Engine, EngineStatus, LoadedTrack, TrackEq, TrackEqRegion, TrackGainRegion};
pub use eq::{
    cookbook_magnitude_db, EqChain, FilterKind, FilterSpec, EQ_RAMP_FRAMES, MAX_SECTION_BANDS,
    MAX_TRACK_BANDS,
};
pub use peaks::{measure_peaks, MEASURE_CANCELLED};
pub use proxy::{ensure_proxy, proxy_file_name, PLAYBACK_RATE, PROXY_VERSION, RESAMPLER_ID};
pub use verify::{check_candidate, CandidateCheck};
