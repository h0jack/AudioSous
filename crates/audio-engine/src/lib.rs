//! Native playback engine.
//!
//! The audio callback mixes samples that are already in per-track ring buffers.
//! Disk reads, resampling, and Tauri commands stay on other threads.

mod engine;
mod mix;
mod peaks;
mod proxy;
mod source;

pub use engine::{Engine, EngineStatus, LoadedTrack};
pub use peaks::{measure_peaks, MEASURE_CANCELLED};
pub use proxy::{proxy_file_name, PLAYBACK_RATE, PROXY_VERSION, RESAMPLER_ID};
