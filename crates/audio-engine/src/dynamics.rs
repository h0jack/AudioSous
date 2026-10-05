//! Per-track dynamics: dynamic EQ, compressor, transient shaper, and sidechain ducking.
//!
//! Order inside the callback, per track:
//!
//! ```text
//! ring → static EQ → dynamic EQ → compressor → transient → ducking → width → pan/balance → gain → sum
//! ```
//!
//! The order is fixed by stage. Each track has fixed slots per stage (3 dynamic EQ, 1 compressor, 1 transient,
//! 2 ducking for the whole song; 2, 1, 1, 1 more for the section under the playhead), and a stage runs the
//! track's slots before the section's.
//!
//! **Sidechain keys.** A ducking or dynamic EQ node can follow another track. The key is that track's own source
//! for the same frame: the mono mid of the ring sample, before its EQ, dynamics, fader, mute, and solo. The mix
//! loop pulls every track's frame first and only then processes any of them, so every key for a frame exists
//! before any target reads it, and the result does not depend on track order. A muted key still ducks, the way
//! a pre-fader send does.
//!
//! **Detectors.**
//! - Compressor: stereo-linked RMS, `(L² + R²) / 2` through a one-pole average with a 5 ms time constant.
//!   The static curve is the usual soft-knee one: no reduction below `threshold − knee/2`, `(1 − 1/ratio)·over`
//!   above `threshold + knee/2`, and the quadratic between. Attack and release act on the gain reduction in dB
//!   (smooth branching: the reduction rises with the attack time constant and falls with the release one), so the
//!   detector itself never pumps. Reduction is capped at 30 dB. Makeup is added after, and is 0 unless set.
//! - Ducking: the key level is a peak follower (instant rise, 30 ms fall) for a transient key such as a kick,
//!   or a 50 ms RMS for a smooth key such as a vocal or lead. The duck reaches its full range when the key is
//!   6 dB over threshold and rises in proportion from the threshold. Attack and release smooth the duck in dB.
//! - Dynamic EQ: the detector is the key track (or the track itself) through a band-pass at the node's frequency
//!   and Q, as an RMS with a 10 ms (transient key) or 50 ms (smooth key) time constant. The bell dips by
//!   `range × activation`, activation 0…1 over the same 6 dB span, smoothed by attack and release. The bell is
//!   the static EQ's SVF, so at 0 dB it is exactly the input.
//! - Transient shaper: the level is `max(|L|, |R|)` held over the last 12 ms (1 ms block peaks in a 12-block ring),
//!   so a steady tone down to 40 Hz reads as a flat level and the shaper leaves it alone. Three envelopes follow that
//!   level: fast (0.5 ms rise, 20 ms fall), slow-rising (12 ms rise, 20 ms fall), and slow-falling (0.5 ms rise,
//!   300 ms fall). Fast over slow-rising is the attack part of a hit; slow-falling over fast is its tail. Each is read in dB, clamped to 0…12 dB, and scaled by its
//!   amount (±0.3 attack, ±0.2 sustain at most in the schema), so +30% attack is at most +3.6 dB on a hit's onset.
//!   Silence (below −100 dBFS) is left alone.
//!
//! Gains and filter coefficients are computed every 16 frames (0.33 ms) and gains are interpolated per sample.
//! A node that appears, disappears, or starts at a section boundary fades its effect over 30 ms; its detector
//! state starts cold behind that fade. A parameter edit takes effect at the next control step, and the attack
//! and release smoothing keep it from stepping. A seek snaps: nodes start at full effect with fresh detectors.
//!
//! Nothing here allocates, locks, or does I/O on the audio thread. The control thread publishes the table
//! through a sequence-locked set of atomics; the audio thread copies it only when the sequence moves.

use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};

use crate::eq::{tick, SvfCoefs, SvfState, Taps};
use crate::proxy::PLAYBACK_RATE;

/// Frames between gain and coefficient updates.
pub const CONTROL_FRAMES: u32 = 16;
/// 30 ms at 48 kHz, the same ramp EQ and spatial use.
pub const DYNAMICS_RAMP_FRAMES: u32 = 1_440;
pub const TRACK_DYNAMICS_SLOTS: usize = 7;
pub const SECTION_DYNAMICS_SLOTS: usize = 5;
pub const MAX_DYNAMICS_REGIONS: usize = 64;
/// A key this far over threshold gives the full range of a duck or a dynamic EQ.
pub const KEY_SPAN_DB: f32 = 6.0;
pub const MAX_REDUCTION_DB: f32 = 30.0;
pub const TRANSIENT_SPAN_DB: f32 = 12.0;
/// Meter channels per track: compressor, ducking, dynamic EQ (reduction in dB, ≥ 0), transient (|gain| in dB).
pub const METER_CHANNELS: usize = 4;

const ENGINE_TRACKS: usize = 64;
const RMS_MS: f32 = 5.0;
const KEY_PEAK_RELEASE_MS: f32 = 30.0;
const KEY_SMOOTH_MS: f32 = 50.0;
const BAND_TRANSIENT_MS: f32 = 10.0;
const TRANSIENT_FAST_ATTACK_MS: f32 = 0.5;
const TRANSIENT_RELEASE_MS: f32 = 20.0;
const TRANSIENT_SLOW_ATTACK_MS: f32 = 12.0;
const TRANSIENT_HOLD_RELEASE_MS: f32 = 300.0;
const TRANSIENT_SILENCE: f32 = 1e-5;
/// The transient level is held over HOLD_BLOCKS blocks of HOLD_BLOCK frames: 12 × 1 ms.
const HOLD_BLOCK: u32 = 48;
const HOLD_BLOCKS: usize = 12;
const FLOOR: f32 = 1e-12;
const SPEC_WORDS: usize = 7;
const METER_FALL_DB: f32 = 0.5;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum DynKind {
    Off = 0,
    Compressor = 1,
    Ducking = 2,
    Transient = 3,
    DynamicEq = 4,
}

impl DynKind {
    fn from_u8(value: u8) -> Self {
        match value {
            1 => Self::Compressor,
            2 => Self::Ducking,
            3 => Self::Transient,
            4 => Self::DynamicEq,
            _ => Self::Off,
        }
    }

    /// Position in the stage order: dynamic EQ, compressor, transient, ducking.
    fn stage(self) -> u8 {
        match self {
            Self::DynamicEq => 0,
            Self::Compressor => 1,
            Self::Transient => 2,
            Self::Ducking => 3,
            Self::Off => 4,
        }
    }
}

/// One dynamics node as plain values. Fields a kind does not use are ignored.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DynSpec {
    pub kind: DynKind,
    pub threshold_db: f32,
    pub ratio: f32,
    pub attack_ms: f32,
    pub release_ms: f32,
    pub knee_db: f32,
    pub makeup_db: f32,
    /// Largest reduction of a duck or dynamic EQ, ≤ 0 dB.
    pub range_db: f32,
    pub frequency_hz: f32,
    pub q: f32,
    pub attack_amount: f32,
    pub sustain_amount: f32,
    /// Key track index, or −1: a dynamic EQ then detects on its own signal, and a duck does nothing.
    pub key: i32,
    pub smooth_key: bool,
}

impl DynSpec {
    pub const OFF: Self = Self {
        kind: DynKind::Off,
        threshold_db: 0.0,
        ratio: 1.0,
        attack_ms: 10.0,
        release_ms: 100.0,
        knee_db: 0.0,
        makeup_db: 0.0,
        range_db: 0.0,
        frequency_hz: 1_000.0,
        q: 1.0,
        attack_amount: 0.0,
        sustain_amount: 0.0,
        key: -1,
        smooth_key: false,
    };

    pub fn compressor(threshold_db: f32, ratio: f32, attack_ms: f32, release_ms: f32, knee_db: f32, makeup_db: f32) -> Self {
        Self { kind: DynKind::Compressor, threshold_db, ratio, attack_ms, release_ms, knee_db, makeup_db, ..Self::OFF }
    }

    pub fn ducking(key: usize, smooth_key: bool, threshold_db: f32, range_db: f32, attack_ms: f32, release_ms: f32) -> Self {
        Self { kind: DynKind::Ducking, key: key as i32, smooth_key, threshold_db, range_db, attack_ms, release_ms, ..Self::OFF }
    }

    pub fn transient(attack_amount: f32, sustain_amount: f32) -> Self {
        Self { kind: DynKind::Transient, attack_amount, sustain_amount, ..Self::OFF }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn dynamic_eq(frequency_hz: f32, q: f32, key: Option<usize>, smooth_key: bool, threshold_db: f32, range_db: f32, attack_ms: f32, release_ms: f32) -> Self {
        Self {
            kind: DynKind::DynamicEq,
            frequency_hz,
            q,
            key: key.map(|index| index as i32).unwrap_or(-1),
            smooth_key,
            threshold_db,
            range_db,
            attack_ms,
            release_ms,
            ..Self::OFF
        }
    }

    /// Finite and inside the legal ranges for `sample_rate`. A non-finite value turns the node off.
    pub fn sanitized(self, sample_rate: f32) -> Self {
        let values = [
            self.threshold_db,
            self.ratio,
            self.attack_ms,
            self.release_ms,
            self.knee_db,
            self.makeup_db,
            self.range_db,
            self.frequency_hz,
            self.q,
            self.attack_amount,
            self.sustain_amount,
        ];
        if self.kind == DynKind::Off || values.iter().any(|value| !value.is_finite()) {
            return Self::OFF;
        }
        let ceiling = 20_000.0_f32.min(sample_rate * 0.45);
        let key = if (0..ENGINE_TRACKS as i32).contains(&self.key) { self.key } else { -1 };
        if self.kind == DynKind::Ducking && key < 0 {
            return Self::OFF;
        }
        Self {
            kind: self.kind,
            threshold_db: self.threshold_db.clamp(-80.0, 0.0),
            ratio: self.ratio.clamp(1.0, 30.0),
            attack_ms: self.attack_ms.clamp(0.05, 500.0),
            release_ms: self.release_ms.clamp(1.0, 5_000.0),
            knee_db: self.knee_db.clamp(0.0, 36.0),
            makeup_db: self.makeup_db.clamp(-24.0, 24.0),
            range_db: self.range_db.clamp(-MAX_REDUCTION_DB, 0.0),
            frequency_hz: self.frequency_hz.clamp(20.0, ceiling.max(20.0)),
            q: self.q.clamp(0.1, 10.0),
            attack_amount: self.attack_amount.clamp(-1.0, 1.0),
            sustain_amount: self.sustain_amount.clamp(-1.0, 1.0),
            key,
            smooth_key: self.smooth_key,
        }
    }

    fn pack(&self) -> [u64; SPEC_WORDS] {
        let pair = |a: f32, b: f32| u64::from(a.to_bits()) | (u64::from(b.to_bits()) << 32);
        [
            pair(self.threshold_db, self.ratio),
            pair(self.attack_ms, self.release_ms),
            pair(self.knee_db, self.makeup_db),
            pair(self.range_db, self.frequency_hz),
            pair(self.q, self.attack_amount),
            u64::from(self.sustain_amount.to_bits()) | (u64::from(self.key as u32) << 32),
            u64::from(self.kind as u8) | (u64::from(self.smooth_key) << 8),
        ]
    }

    fn unpack(words: [u64; SPEC_WORDS]) -> Self {
        let low = |word: u64| f32::from_bits(word as u32);
        let high = |word: u64| f32::from_bits((word >> 32) as u32);
        Self {
            threshold_db: low(words[0]),
            ratio: high(words[0]),
            attack_ms: low(words[1]),
            release_ms: high(words[1]),
            knee_db: low(words[2]),
            makeup_db: high(words[2]),
            range_db: low(words[3]),
            frequency_hz: high(words[3]),
            q: low(words[4]),
            attack_amount: high(words[4]),
            sustain_amount: low(words[5]),
            key: (words[5] >> 32) as u32 as i32,
            kind: DynKind::from_u8((words[6] & 0xff) as u8),
            smooth_key: (words[6] >> 8) & 1 == 1,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum KeyDetectorKind {
    Transient,
    Smooth,
}

/// A dynamics node as the desktop sends it. Keys name tracks; the control thread resolves them to indices.
#[derive(Clone, Debug, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(tag = "type", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum DynamicsNodeSpec {
    Compressor { threshold_db: f32, ratio: f32, attack_ms: f32, release_ms: f32, knee_db: f32, makeup_db: f32 },
    Ducking { key_track_id: String, key_detector: KeyDetectorKind, threshold_db: f32, range_db: f32, attack_ms: f32, release_ms: f32 },
    Transient { attack: f32, sustain: f32 },
    DynamicEq {
        frequency_hz: f32,
        q: f32,
        key_track_id: Option<String>,
        key_detector: KeyDetectorKind,
        threshold_db: f32,
        range_db: f32,
        attack_ms: f32,
        release_ms: f32,
    },
}

impl DynamicsNodeSpec {
    /// Plain values with the key resolved. A key that names no loaded track (or the track itself) makes the node
    /// inert: `None`, so it is skipped rather than guessed.
    pub fn resolve(&self, own: usize, key_index: impl Fn(&str) -> Option<usize>) -> Option<DynSpec> {
        let key = |id: &str| key_index(id).filter(|index| *index != own);
        Some(match self {
            Self::Compressor { threshold_db, ratio, attack_ms, release_ms, knee_db, makeup_db } => {
                DynSpec::compressor(*threshold_db, *ratio, *attack_ms, *release_ms, *knee_db, *makeup_db)
            }
            Self::Ducking { key_track_id, key_detector, threshold_db, range_db, attack_ms, release_ms } => {
                DynSpec::ducking(key(key_track_id)?, *key_detector == KeyDetectorKind::Smooth, *threshold_db, *range_db, *attack_ms, *release_ms)
            }
            Self::Transient { attack, sustain } => DynSpec::transient(*attack, *sustain),
            Self::DynamicEq { frequency_hz, q, key_track_id, key_detector, threshold_db, range_db, attack_ms, release_ms } => {
                let index = match key_track_id {
                    Some(id) => Some(key(id)?),
                    None => None,
                };
                DynSpec::dynamic_eq(*frequency_hz, *q, index, *key_detector == KeyDetectorKind::Smooth, *threshold_db, *range_db, *attack_ms, *release_ms)
            }
        })
    }
}

/// Soft-knee gain reduction in dB (≥ 0) for a detector level.
#[inline]
pub fn reduction_db(level_db: f32, threshold_db: f32, ratio: f32, knee_db: f32) -> f32 {
    let over = level_db - threshold_db;
    let slope = 1.0 - 1.0 / ratio.max(1.0);
    if knee_db > 0.0 && 2.0 * over.abs() <= knee_db {
        slope * (over + 0.5 * knee_db).powi(2) / (2.0 * knee_db)
    } else if over > 0.0 {
        slope * over
    } else {
        0.0
    }
}

#[inline(always)]
fn db_to_gain(db: f32) -> f32 {
    10_f32.powf(db / 20.0)
}

/// One-pole coefficient for a time constant, applied once per `step` samples.
fn coefficient(ms: f32, rate: f32, step: f32) -> f32 {
    let samples = (ms * 0.001 * rate).max(1e-3);
    1.0 - (-step / samples).exp()
}

/// The audio-thread state of one node: what it is, how much of it is mixed in, and its detector and filter memory.
#[derive(Clone, Copy)]
struct Slot {
    spec: DynSpec,
    active: bool,
    mix: f32,
    target: f32,
    /// Gain-reduction smoothing per control step.
    att: f32,
    rel: f32,
    /// Detector averaging per sample.
    det: f32,
    peak_fall: f32,
    env: f32,
    env2: f32,
    env3: f32,
    /// Reduction in dB (compressor, duck), activation 0…1 (dynamic EQ), or gain in dB (transient).
    gr: f32,
    gain: f32,
    step: f32,
    reading: f32,
    coefs: SvfCoefs,
    taps: Taps,
    state: [SvfState; 2],
    key_coefs: SvfCoefs,
    key_taps: Taps,
    key_state: SvfState,
    t_fast_att: f32,
    t_fast_rel: f32,
    t_slow_att: f32,
    t_hold_rel: f32,
    /// Peak of each of the last 1 ms blocks, the running block, and the held level they give.
    held: [f32; HOLD_BLOCKS],
    held_at: usize,
    block_peak: f32,
    block_count: u32,
    level: f32,
}

impl Slot {
    fn idle() -> Self {
        Self {
            spec: DynSpec::OFF,
            active: false,
            mix: 0.0,
            target: 0.0,
            att: 1.0,
            rel: 1.0,
            det: 1.0,
            peak_fall: 0.0,
            env: 0.0,
            env2: 0.0,
            env3: 0.0,
            gr: 0.0,
            gain: 1.0,
            step: 0.0,
            reading: 0.0,
            coefs: SvfCoefs::IDENTITY,
            taps: Taps::of(&SvfCoefs::IDENTITY),
            state: [SvfState::default(); 2],
            key_coefs: SvfCoefs::IDENTITY,
            key_taps: Taps::of(&SvfCoefs::IDENTITY),
            key_state: SvfState::default(),
            t_fast_att: 1.0,
            t_fast_rel: 1.0,
            t_slow_att: 1.0,
            t_hold_rel: 1.0,
            held: [0.0; HOLD_BLOCKS],
            held_at: 0,
            block_peak: 0.0,
            block_count: 0,
            level: 0.0,
        }
    }

    fn configure(&mut self, spec: DynSpec, rate: f32) {
        self.spec = spec;
        let control = CONTROL_FRAMES as f32;
        self.att = coefficient(spec.attack_ms, rate, control);
        self.rel = coefficient(spec.release_ms, rate, control);
        self.peak_fall = (-1.0 / (KEY_PEAK_RELEASE_MS * 0.001 * rate)).exp();
        self.det = match spec.kind {
            DynKind::Compressor => coefficient(RMS_MS, rate, 1.0),
            DynKind::Ducking => coefficient(KEY_SMOOTH_MS, rate, 1.0),
            DynKind::DynamicEq => coefficient(if spec.smooth_key { KEY_SMOOTH_MS } else { BAND_TRANSIENT_MS }, rate, 1.0),
            _ => 1.0,
        };
        self.t_fast_att = coefficient(TRANSIENT_FAST_ATTACK_MS, rate, 1.0);
        self.t_fast_rel = coefficient(TRANSIENT_RELEASE_MS, rate, 1.0);
        self.t_slow_att = coefficient(TRANSIENT_SLOW_ATTACK_MS, rate, 1.0);
        self.t_hold_rel = coefficient(TRANSIENT_HOLD_RELEASE_MS, rate, 1.0);
        if spec.kind == DynKind::DynamicEq {
            let g = (std::f64::consts::PI * f64::from(spec.frequency_hz) / f64::from(rate)).tan() as f32;
            let k = 1.0 / spec.q;
            // Constant-peak band-pass for the detector: k·v1 is unity at the center frequency.
            self.key_coefs = SvfCoefs { g, k, m0: 0.0, m1: k, m2: 0.0 };
            self.key_taps = Taps::of(&self.key_coefs);
            self.design_bell(self.mix * spec.range_db * self.gr);
        }
    }

    fn design_bell(&mut self, gain_db: f32) {
        let a = 10_f32.powf(gain_db / 40.0);
        let k = 1.0 / (self.spec.q * a);
        let g = self.key_coefs.g;
        self.coefs = SvfCoefs { g, k, m0: 1.0, m1: k * (a * a - 1.0), m2: 0.0 };
        self.taps = Taps::of(&self.coefs);
    }

    fn clear_state(&mut self) {
        self.env = 0.0;
        self.env2 = 0.0;
        self.env3 = 0.0;
        self.gr = 0.0;
        self.gain = 1.0;
        self.step = 0.0;
        self.reading = 0.0;
        self.state = [SvfState::default(); 2];
        self.key_state = SvfState::default();
        self.held = [0.0; HOLD_BLOCKS];
        self.held_at = 0;
        self.block_peak = 0.0;
        self.block_count = 0;
        self.level = 0.0;
    }

    /// Moves toward `next`. A node that appears fades in from no effect; one that goes away fades out.
    fn retarget(&mut self, next: DynSpec, rate: f32, instant: bool) {
        if next.kind == DynKind::Off {
            if self.active {
                self.target = 0.0;
                if instant {
                    self.deactivate();
                }
            }
            return;
        }
        if !self.active {
            self.clear_state();
            self.mix = if instant { 1.0 } else { 0.0 };
            self.target = 1.0;
            self.active = true;
            self.configure(next, rate);
            return;
        }
        if next != self.spec {
            self.configure(next, rate);
        }
        self.target = 1.0;
        if instant {
            self.mix = 1.0;
        }
    }

    /// After a seek: full effect at once and fresh detectors, because the output was silent.
    fn settle(&mut self, rate: f32) {
        if !self.active {
            return;
        }
        if self.target == 0.0 {
            self.deactivate();
            return;
        }
        self.clear_state();
        self.mix = 1.0;
        let spec = self.spec;
        self.configure(spec, rate);
    }

    fn deactivate(&mut self) {
        self.active = false;
        self.mix = 0.0;
        self.target = 0.0;
        self.spec = DynSpec::OFF;
        self.clear_state();
    }

    /// Once per control step. Returns false when a faded-out node has finished and stopped.
    #[inline]
    fn advance_mix(&mut self) -> bool {
        let step = CONTROL_FRAMES as f32 / DYNAMICS_RAMP_FRAMES as f32;
        if self.mix < self.target {
            self.mix = (self.mix + step).min(self.target);
        } else if self.mix > self.target {
            self.mix = (self.mix - step).max(self.target);
        } else if self.target == 0.0 && (self.gain - 1.0).abs() < 1e-6 {
            self.deactivate();
            return false;
        }
        true
    }

    #[inline(always)]
    fn set_gain(&mut self, target: f32) {
        self.step = (target - self.gain) / CONTROL_FRAMES as f32;
    }

    #[inline(always)]
    fn apply_gain(&mut self, sample: &mut [f32; 2], channels: usize) {
        self.gain += self.step;
        for value in sample.iter_mut().take(channels) {
            *value *= self.gain;
        }
    }

    #[inline(always)]
    fn smooth(&mut self, target: f32) {
        let coef = if target > self.gr { self.att } else { self.rel };
        self.gr += coef * (target - self.gr);
    }

    /// Processes one frame in place. `control` marks the frames where gains and coefficients are recomputed.
    #[inline]
    fn run(&mut self, sample: &mut [f32; 2], channels: usize, keys: &[f32], control: bool) {
        if control && !self.advance_mix() {
            return;
        }
        match self.spec.kind {
            DynKind::Compressor => {
                let power = if channels > 1 { 0.5 * (sample[0] * sample[0] + sample[1] * sample[1]) } else { sample[0] * sample[0] };
                self.env += self.det * (power - self.env);
                if control {
                    let level = 10.0 * (self.env + FLOOR).log10();
                    let target = reduction_db(level, self.spec.threshold_db, self.spec.ratio, self.spec.knee_db).min(MAX_REDUCTION_DB);
                    self.smooth(target);
                    self.reading = self.gr * self.mix;
                    self.set_gain(db_to_gain(self.mix * (self.spec.makeup_db - self.gr)));
                }
                self.apply_gain(sample, channels);
            }
            DynKind::Ducking => {
                let key = keys.get(self.spec.key as usize).copied().unwrap_or(0.0);
                if self.spec.smooth_key {
                    self.env += self.det * (key * key - self.env);
                } else {
                    let level = key.abs();
                    self.env = if level > self.env { level } else { self.env * self.peak_fall };
                }
                if control {
                    let key_db = if self.spec.smooth_key { 10.0 * (self.env + FLOOR).log10() } else { 20.0 * (self.env + 1e-6).log10() };
                    let activation = ((key_db - self.spec.threshold_db) / KEY_SPAN_DB).clamp(0.0, 1.0);
                    self.smooth(-self.spec.range_db * activation);
                    self.reading = self.gr * self.mix;
                    self.set_gain(db_to_gain(-self.gr * self.mix));
                }
                self.apply_gain(sample, channels);
            }
            DynKind::DynamicEq => {
                let source = if self.spec.key >= 0 {
                    keys.get(self.spec.key as usize).copied().unwrap_or(0.0)
                } else if channels > 1 {
                    0.5 * (sample[0] + sample[1])
                } else {
                    sample[0]
                };
                let band = tick(&mut self.key_state, &self.key_taps, &self.key_coefs, source);
                self.env += self.det * (band * band - self.env);
                if control {
                    let band_db = 10.0 * (self.env + FLOOR).log10();
                    let activation = ((band_db - self.spec.threshold_db) / KEY_SPAN_DB).clamp(0.0, 1.0);
                    self.smooth(activation);
                    let gain_db = self.spec.range_db * self.gr * self.mix;
                    self.reading = -gain_db;
                    self.design_bell(gain_db);
                }
                for channel in 0..channels {
                    sample[channel] = tick(&mut self.state[channel], &self.taps, &self.coefs, sample[channel]);
                }
            }
            DynKind::Transient => {
                let peak = if channels > 1 { sample[0].abs().max(sample[1].abs()) } else { sample[0].abs() };
                self.block_peak = self.block_peak.max(peak);
                self.block_count += 1;
                if self.block_count == HOLD_BLOCK {
                    self.held[self.held_at] = self.block_peak;
                    self.held_at = (self.held_at + 1) % HOLD_BLOCKS;
                    self.level = self.held.iter().copied().fold(0.0, f32::max);
                    self.block_peak = 0.0;
                    self.block_count = 0;
                }
                // A rise shows at once; a fall waits for the hold.
                let level = self.level.max(self.block_peak);
                self.env += if level > self.env { self.t_fast_att } else { self.t_fast_rel } * (level - self.env);
                self.env2 += if level > self.env2 { self.t_slow_att } else { self.t_fast_rel } * (level - self.env2);
                self.env3 += if level > self.env3 { self.t_fast_att } else { self.t_hold_rel } * (level - self.env3);
                if control {
                    let gain_db = if self.env3 < TRANSIENT_SILENCE {
                        0.0
                    } else {
                        let attack = (20.0 * ((self.env + 1e-6) / (self.env2 + 1e-6)).log10()).clamp(0.0, TRANSIENT_SPAN_DB);
                        let sustain = (20.0 * ((self.env3 + 1e-6) / (self.env + 1e-6)).log10()).clamp(0.0, TRANSIENT_SPAN_DB);
                        (self.spec.attack_amount * attack + self.spec.sustain_amount * sustain).clamp(-TRANSIENT_SPAN_DB, TRANSIENT_SPAN_DB)
                    };
                    self.gr = gain_db;
                    self.reading = (gain_db * self.mix).abs();
                    self.set_gain(db_to_gain(gain_db * self.mix));
                }
                self.apply_gain(sample, channels);
            }
            DynKind::Off => {}
        }
    }

    fn meter_channel(&self) -> usize {
        match self.spec.kind {
            DynKind::Compressor => 0,
            DynKind::Ducking => 1,
            DynKind::DynamicEq => 2,
            _ => 3,
        }
    }
}

/// Fixed slot layouts: [dynamic EQ ×3, compressor, transient, ducking ×2] for the track and
/// [dynamic EQ ×2, compressor, transient, ducking] for the section. Extra nodes of a kind are dropped.
fn place<const N: usize>(specs: &[DynSpec], dynamic_eq: usize, ducking: usize, rate: f32) -> [DynSpec; N] {
    let mut out = [DynSpec::OFF; N];
    let (mut eq, mut duck) = (0, 0);
    let mut comp = false;
    let mut trans = false;
    for spec in specs.iter().map(|spec| spec.sanitized(rate)) {
        match spec.kind {
            DynKind::DynamicEq if eq < dynamic_eq => {
                out[eq] = spec;
                eq += 1;
            }
            DynKind::Compressor if !comp => {
                out[dynamic_eq] = spec;
                comp = true;
            }
            DynKind::Transient if !trans => {
                out[dynamic_eq + 1] = spec;
                trans = true;
            }
            DynKind::Ducking if duck < ducking => {
                out[dynamic_eq + 2 + duck] = spec;
                duck += 1;
            }
            _ => {}
        }
    }
    out
}

/// Stage order across a track's and a section's slots: (section?, index).
const ORDER: [(bool, usize); TRACK_DYNAMICS_SLOTS + SECTION_DYNAMICS_SLOTS] = [
    (false, 0),
    (false, 1),
    (false, 2),
    (true, 0),
    (true, 1),
    (false, 3),
    (true, 2),
    (false, 4),
    (true, 3),
    (false, 5),
    (false, 6),
    (true, 4),
];

#[derive(Clone, Copy)]
struct Region {
    track: u8,
    start: u64,
    end: u64,
    specs: [DynSpec; SECTION_DYNAMICS_SLOTS],
}

impl Region {
    const EMPTY: Self = Self { track: 0, start: 0, end: 0, specs: [DynSpec::OFF; SECTION_DYNAMICS_SLOTS] };
}

#[derive(Clone)]
struct Table {
    tracks: [[DynSpec; TRACK_DYNAMICS_SLOTS]; ENGINE_TRACKS],
    regions: [Region; MAX_DYNAMICS_REGIONS],
    region_count: usize,
    used: u64,
}

impl Table {
    fn empty() -> Self {
        Self {
            tracks: [[DynSpec::OFF; TRACK_DYNAMICS_SLOTS]; ENGINE_TRACKS],
            regions: [Region::EMPTY; MAX_DYNAMICS_REGIONS],
            region_count: 0,
            used: 0,
        }
    }
}

pub struct TrackDynamicsInput<'a> {
    pub track_index: usize,
    pub nodes: &'a [DynSpec],
    /// Section windows in proxy frames, each with its extra nodes.
    pub regions: &'a [(u64, u64, &'a [DynSpec])],
}

/// Every loaded track's dynamics, ready to publish.
pub struct DynamicsTable {
    table: Box<Table>,
}

impl DynamicsTable {
    pub fn empty() -> Self {
        Self { table: Box::new(Table::empty()) }
    }

    pub fn build(tracks: &[TrackDynamicsInput<'_>]) -> Self {
        let rate = PLAYBACK_RATE as f32;
        let mut table = Box::new(Table::empty());
        for track in tracks {
            if track.track_index >= ENGINE_TRACKS {
                continue;
            }
            let own = place::<TRACK_DYNAMICS_SLOTS>(track.nodes, 3, 2, rate);
            let mut used = own.iter().any(|spec| spec.kind != DynKind::Off);
            table.tracks[track.track_index] = own;
            for (start, end, nodes) in track.regions {
                if table.region_count >= MAX_DYNAMICS_REGIONS || end <= start {
                    continue;
                }
                let specs = place::<SECTION_DYNAMICS_SLOTS>(nodes, 2, 1, rate);
                if specs.iter().all(|spec| spec.kind == DynKind::Off) {
                    continue;
                }
                table.regions[table.region_count] = Region { track: track.track_index as u8, start: *start, end: *end, specs };
                table.region_count += 1;
                used = true;
            }
            if used {
                table.used |= 1 << track.track_index;
            }
        }
        Self { table }
    }
}

const TRACK_WORDS: usize = ENGINE_TRACKS * TRACK_DYNAMICS_SLOTS * SPEC_WORDS;
const REGION_STRIDE: usize = 3 + SECTION_DYNAMICS_SLOTS * SPEC_WORDS;

/// Lock-free dynamics table, published like the EQ table: written between an odd and an even sequence,
/// copied by the audio thread only when the sequence moved, retried when torn.
pub struct PublishedDynamics {
    sequence: AtomicU64,
    region_count: AtomicU64,
    used: AtomicU64,
    tracks: Box<[AtomicU64]>,
    regions: Box<[AtomicU64]>,
}

impl PublishedDynamics {
    pub fn empty() -> Self {
        let off = DynSpec::OFF.pack();
        Self {
            sequence: AtomicU64::new(0),
            region_count: AtomicU64::new(0),
            used: AtomicU64::new(0),
            tracks: (0..TRACK_WORDS).map(|index| AtomicU64::new(off[index % SPEC_WORDS])).collect(),
            regions: (0..MAX_DYNAMICS_REGIONS * REGION_STRIDE).map(|_| AtomicU64::new(0)).collect(),
        }
    }

    pub fn publish(&self, dynamics: &DynamicsTable) {
        let table = &dynamics.table;
        let start = self.sequence.fetch_add(1, Ordering::AcqRel);
        self.region_count.store(table.region_count as u64, Ordering::Relaxed);
        self.used.store(table.used, Ordering::Relaxed);
        for track in 0..ENGINE_TRACKS {
            for slot in 0..TRACK_DYNAMICS_SLOTS {
                let base = (track * TRACK_DYNAMICS_SLOTS + slot) * SPEC_WORDS;
                for (offset, word) in table.tracks[track][slot].pack().iter().enumerate() {
                    self.tracks[base + offset].store(*word, Ordering::Relaxed);
                }
            }
        }
        for index in 0..table.region_count {
            let region = &table.regions[index];
            let base = index * REGION_STRIDE;
            self.regions[base].store(u64::from(region.track), Ordering::Relaxed);
            self.regions[base + 1].store(region.start, Ordering::Relaxed);
            self.regions[base + 2].store(region.end, Ordering::Relaxed);
            for slot in 0..SECTION_DYNAMICS_SLOTS {
                for (offset, word) in region.specs[slot].pack().iter().enumerate() {
                    self.regions[base + 3 + slot * SPEC_WORDS + offset].store(*word, Ordering::Relaxed);
                }
            }
        }
        self.sequence.store(start.wrapping_add(2), Ordering::Release);
    }

    fn sequence(&self) -> u64 {
        self.sequence.load(Ordering::Acquire)
    }

    fn load_into(&self, into: &mut Table) -> u64 {
        loop {
            let start = self.sequence.load(Ordering::Acquire);
            if start & 1 == 1 {
                std::hint::spin_loop();
                continue;
            }
            into.region_count = (self.region_count.load(Ordering::Relaxed) as usize).min(MAX_DYNAMICS_REGIONS);
            into.used = self.used.load(Ordering::Relaxed);
            let read = |words: &[AtomicU64], base: usize| {
                let mut out = [0_u64; SPEC_WORDS];
                for (offset, word) in out.iter_mut().enumerate() {
                    *word = words[base + offset].load(Ordering::Relaxed);
                }
                DynSpec::unpack(out)
            };
            for track in 0..ENGINE_TRACKS {
                for slot in 0..TRACK_DYNAMICS_SLOTS {
                    into.tracks[track][slot] = read(&self.tracks, (track * TRACK_DYNAMICS_SLOTS + slot) * SPEC_WORDS);
                }
            }
            for index in 0..into.region_count {
                let base = index * REGION_STRIDE;
                let region = &mut into.regions[index];
                region.track = self.regions[base].load(Ordering::Relaxed) as u8;
                region.start = self.regions[base + 1].load(Ordering::Relaxed);
                region.end = self.regions[base + 2].load(Ordering::Relaxed);
                for slot in 0..SECTION_DYNAMICS_SLOTS {
                    region.specs[slot] = read(&self.regions, base + 3 + slot * SPEC_WORDS);
                }
            }
            if self.sequence.load(Ordering::Acquire) == start {
                return start;
            }
        }
    }
}

/// Per-track meters written by the audio thread once per block, read by the control side.
/// Each channel holds the block's largest reading, falling by at most 0.5 dB per block.
pub struct DynamicsMeters {
    values: Box<[AtomicU32]>,
}

impl DynamicsMeters {
    pub fn new() -> Self {
        Self { values: (0..ENGINE_TRACKS * METER_CHANNELS).map(|_| AtomicU32::new(0.0_f32.to_bits())).collect() }
    }

    /// [compressor reduction, duck reduction, dynamic EQ reduction, |transient gain|], dB.
    pub fn read(&self, index: usize) -> [f32; METER_CHANNELS] {
        let mut out = [0.0; METER_CHANNELS];
        if index < ENGINE_TRACKS {
            for (channel, value) in out.iter_mut().enumerate() {
                *value = f32::from_bits(self.values[index * METER_CHANNELS + channel].load(Ordering::Relaxed));
            }
        }
        out
    }

    pub fn clear(&self) {
        for value in self.values.iter() {
            value.store(0.0_f32.to_bits(), Ordering::Relaxed);
        }
    }
}

impl Default for DynamicsMeters {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone, Copy)]
struct TrackDyn {
    own: [Slot; TRACK_DYNAMICS_SLOTS],
    section: [Slot; SECTION_DYNAMICS_SLOTS],
    span_start: u64,
    span_end: u64,
    counter: u32,
    live: bool,
    snap: bool,
    meter: [f32; METER_CHANNELS],
}

impl TrackDyn {
    fn idle() -> Self {
        Self {
            own: [Slot::idle(); TRACK_DYNAMICS_SLOTS],
            section: [Slot::idle(); SECTION_DYNAMICS_SLOTS],
            span_start: 1,
            span_end: 0,
            counter: 0,
            live: false,
            snap: true,
            meter: [0.0; METER_CHANNELS],
        }
    }
}

/// Audio-thread dynamics state. Created once on the control thread, then touched only by whichever of the
/// callback or the mixer thread holds the rings (the same ownership rule as the EQ and spatial runtimes).
pub struct DynamicsRuntime {
    seen: u64,
    table: Box<Table>,
    tracks: Box<[TrackDyn]>,
    rate: f32,
}

impl DynamicsRuntime {
    pub fn new() -> Self {
        Self::with_rate(PLAYBACK_RATE as f32)
    }

    fn with_rate(rate: f32) -> Self {
        Self {
            seen: u64::MAX,
            table: Box::new(Table::empty()),
            tracks: (0..ENGINE_TRACKS).map(|_| TrackDyn::idle()).collect(),
            rate,
        }
    }

    /// Picks up a new table once per block. New nodes fade in, removed ones fade out, edits apply in place.
    pub fn refresh(&mut self, published: &PublishedDynamics) {
        if published.sequence() == self.seen {
            return;
        }
        self.seen = published.load_into(&mut self.table);
        let rate = self.rate;
        for (index, track) in self.tracks.iter_mut().enumerate() {
            let instant = track.snap;
            for (slot, spec) in track.own.iter_mut().zip(self.table.tracks[index].iter()) {
                slot.retarget(*spec, rate, instant);
            }
            track.span_start = 1;
            track.span_end = 0;
            track.live = track.live || self.table.used & (1 << index) != 0;
        }
    }

    /// After a seek. Called by the control thread while the audio thread is idle.
    pub fn snap(&mut self) {
        for track in self.tracks.iter_mut() {
            track.snap = true;
            track.span_start = 1;
            track.span_end = 0;
        }
    }

    /// Forgets every node and its memory. Called by the control thread while the audio thread is idle.
    pub fn reset(&mut self) {
        self.seen = u64::MAX;
        *self.table = Table::empty();
        for track in self.tracks.iter_mut() {
            *track = TrackDyn::idle();
        }
    }

    #[inline(always)]
    pub fn track_live(&self, index: usize) -> bool {
        index < ENGINE_TRACKS && self.tracks[index].live
    }

    /// Processes one frame of a track in place. `keys` holds every track's mono source sample for this frame.
    #[inline]
    pub fn process(&mut self, index: usize, frame: u64, channels: usize, sample: &mut [f32; 2], keys: &[f32]) {
        let rate = self.rate;
        let table = &self.table;
        let track = &mut self.tracks[index];
        if frame < track.span_start || frame >= track.span_end {
            assign_region(table, index, track, frame, rate);
        }
        if track.snap {
            track.snap = false;
            for slot in track.own.iter_mut().chain(track.section.iter_mut()) {
                slot.settle(rate);
            }
            track.counter = 0;
        }
        let control = track.counter == 0;
        track.counter = if control { CONTROL_FRAMES - 1 } else { track.counter - 1 };
        let mut any = false;
        for (section, at) in ORDER {
            let slot = if section { &mut track.section[at] } else { &mut track.own[at] };
            if !slot.active {
                continue;
            }
            any = true;
            slot.run(sample, channels, keys, control);
            if control {
                let channel = slot.meter_channel();
                track.meter[channel] = track.meter[channel].max(slot.reading);
            }
        }
        if !any && table.used & (1 << index) == 0 {
            track.live = false;
        }
    }

    /// Writes the block's readings to the meters and starts the next block.
    pub fn end_block(&mut self, meters: &DynamicsMeters, count: usize) {
        for (index, track) in self.tracks.iter_mut().enumerate().take(count.min(ENGINE_TRACKS)) {
            for channel in 0..METER_CHANNELS {
                let at = index * METER_CHANNELS + channel;
                let previous = f32::from_bits(meters.values[at].load(Ordering::Relaxed));
                let next = track.meter[channel].max(previous - METER_FALL_DB).max(0.0);
                meters.values[at].store(next.to_bits(), Ordering::Relaxed);
                track.meter[channel] = 0.0;
            }
        }
    }
}

impl Default for DynamicsRuntime {
    fn default() -> Self {
        Self::new()
    }
}

fn assign_region(table: &Table, index: usize, track: &mut TrackDyn, frame: u64, rate: f32) {
    let mut found = None;
    let mut span_start = 0_u64;
    let mut span_end = u64::MAX;
    for (at, region) in table.regions[..table.region_count].iter().enumerate() {
        if region.track as usize != index {
            continue;
        }
        if frame >= region.start && frame < region.end {
            found = Some(at);
            span_start = region.start;
            span_end = region.end;
            break;
        }
        if region.end <= frame {
            span_start = span_start.max(region.end);
        } else if region.start > frame {
            span_end = span_end.min(region.start);
        }
    }
    track.span_start = span_start;
    track.span_end = span_end;
    let instant = track.snap;
    for (slot, at) in track.section.iter_mut().zip(0..SECTION_DYNAMICS_SLOTS) {
        let next = found.map(|region| table.regions[region].specs[at]).unwrap_or(DynSpec::OFF);
        slot.retarget(next, rate, instant);
    }
}

/// Offline helper for evaluation and tests: one track's nodes at fixed values, in stage order.
pub struct DynamicsChain {
    slots: Vec<Slot>,
    counter: u32,
}

impl DynamicsChain {
    /// Nodes are sorted into stage order; within a stage the given order holds. Keys index into the `keys`
    /// slice passed to `process_frame`.
    pub fn new(specs: &[DynSpec], sample_rate: f32) -> Self {
        let mut ordered: Vec<DynSpec> = specs.iter().map(|spec| spec.sanitized(sample_rate)).filter(|spec| spec.kind != DynKind::Off).collect();
        ordered.sort_by_key(|spec| spec.kind.stage());
        let slots = ordered
            .into_iter()
            .map(|spec| {
                let mut slot = Slot::idle();
                slot.retarget(spec, sample_rate, true);
                slot
            })
            .collect();
        Self { slots, counter: 0 }
    }

    pub fn is_empty(&self) -> bool {
        self.slots.is_empty()
    }

    /// One frame in place. Returns this frame's readings: [compressor, duck, dynamic EQ, |transient|] dB.
    #[inline]
    pub fn process_frame(&mut self, sample: &mut [f32; 2], channels: usize, keys: &[f32]) -> [f32; METER_CHANNELS] {
        let control = self.counter == 0;
        self.counter = if control { CONTROL_FRAMES - 1 } else { self.counter - 1 };
        let mut readings = [0.0_f32; METER_CHANNELS];
        for slot in self.slots.iter_mut() {
            if !slot.active {
                continue;
            }
            slot.run(sample, channels, keys, control);
            let channel = slot.meter_channel();
            readings[channel] = readings[channel].max(slot.reading);
        }
        readings
    }

    /// Interleaved audio in place. `key` is a mono key (one value per frame) read as key index 0.
    pub fn process_interleaved(&mut self, samples: &mut [f32], channels: usize, key: Option<&[f32]>) {
        let channels = channels.clamp(1, 2);
        for (frame, values) in samples.chunks_mut(channels).enumerate() {
            let mut sample = [values[0], if channels > 1 { values[1] } else { 0.0 }];
            let keys = [key.and_then(|key| key.get(frame).copied()).unwrap_or(0.0)];
            self.process_frame(&mut sample, channels, &keys);
            values[0] = sample[0];
            if channels > 1 {
                values[1] = sample[1];
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: f32 = 48_000.0;

    fn sine(hz: f32, amplitude: f32, frames: usize) -> Vec<f32> {
        (0..frames).map(|frame| amplitude * (2.0 * std::f32::consts::PI * hz * frame as f32 / RATE).sin()).collect()
    }

    fn rms_db(samples: &[f32]) -> f32 {
        let power = samples.iter().map(|value| value * value).sum::<f32>() / samples.len().max(1) as f32;
        10.0 * (power + 1e-20).log10()
    }

    fn peak_db(samples: &[f32]) -> f32 {
        20.0 * samples.iter().fold(0.0_f32, |max, value| max.max(value.abs())).max(1e-10).log10()
    }

    /// Mono audio through one chain, with an optional key; returns the output and the per-frame readings.
    fn run(specs: &[DynSpec], input: &[f32], key: Option<&[f32]>) -> (Vec<f32>, Vec<[f32; METER_CHANNELS]>) {
        let mut chain = DynamicsChain::new(specs, RATE);
        let mut out = Vec::with_capacity(input.len());
        let mut readings = Vec::with_capacity(input.len());
        for (frame, value) in input.iter().enumerate() {
            let mut sample = [*value, 0.0];
            let keys = [key.map(|key| key[frame]).unwrap_or(0.0)];
            readings.push(chain.process_frame(&mut sample, 1, &keys));
            out.push(sample[0]);
        }
        (out, readings)
    }

    #[test]
    fn static_curve_follows_ratio_threshold_and_knee() {
        assert_eq!(reduction_db(-30.0, -20.0, 4.0, 0.0), 0.0);
        assert!((reduction_db(-10.0, -20.0, 4.0, 0.0) - 7.5).abs() < 1e-5);
        assert!((reduction_db(-10.0, -20.0, 2.0, 0.0) - 5.0).abs() < 1e-5);
        // Knee: (1 − 1/ratio)·knee/8 at the threshold, continuous at both edges.
        assert!((reduction_db(-20.0, -20.0, 2.0, 6.0) - 0.375).abs() < 1e-5);
        assert!(reduction_db(-23.0, -20.0, 2.0, 6.0).abs() < 1e-5);
        assert!((reduction_db(-17.0, -20.0, 2.0, 6.0) - 1.5).abs() < 1e-4);
        assert!((reduction_db(-16.9, -20.0, 2.0, 6.0) - 1.55).abs() < 1e-3);
        assert_eq!(reduction_db(0.0, -20.0, 1.0, 0.0), 0.0);
    }

    #[test]
    fn steady_signal_settles_at_the_static_curve() {
        // A 0.5 sine is −9.03 dB RMS. Threshold −21, ratio 3: 12 dB over gives 8 dB of reduction.
        let input = sine(220.0, 0.5, 48_000);
        let (out, readings) = run(&[DynSpec::compressor(-21.0, 3.0, 5.0, 80.0, 0.0, 0.0)], &input, None);
        let change = rms_db(&out[24_000..]) - rms_db(&input[24_000..]);
        assert!((change + 8.0).abs() < 0.3, "steady reduction {change}");
        assert!((readings[47_999][0] - 8.0).abs() < 0.3, "meter {}", readings[47_999][0]);
        // Below threshold: untouched.
        let (quiet, readings) = run(&[DynSpec::compressor(-6.0, 3.0, 5.0, 80.0, 0.0, 0.0)], &input, None);
        assert!((rms_db(&quiet[24_000..]) - rms_db(&input[24_000..])).abs() < 0.01);
        assert!(readings[47_999][0] < 1e-3);
    }

    #[test]
    fn ratio_sets_the_amount_and_makeup_adds_after() {
        let input = sine(220.0, 0.5, 48_000);
        let reduction = |ratio: f32| {
            let (out, _) = run(&[DynSpec::compressor(-21.0, ratio, 5.0, 80.0, 0.0, 0.0)], &input, None);
            rms_db(&input[24_000..]) - rms_db(&out[24_000..])
        };
        assert!((reduction(1.5) - 4.0).abs() < 0.3);
        assert!((reduction(2.0) - 6.0).abs() < 0.3);
        assert!((reduction(4.0) - 9.0).abs() < 0.3);
        let (made_up, _) = run(&[DynSpec::compressor(-21.0, 2.0, 5.0, 80.0, 0.0, 2.0)], &input, None);
        assert!((rms_db(&input[24_000..]) - rms_db(&made_up[24_000..]) - 4.0).abs() < 0.3);
    }

    #[test]
    fn attack_and_release_follow_their_time_constants() {
        // Quiet for 0.25 s, loud for 0.5 s, quiet again.
        let input: Vec<f32> = (0..48_000)
            .map(|frame| {
                let loud = (12_000..36_000).contains(&frame);
                (if loud { 0.5 } else { 0.05 }) * (2.0 * std::f32::consts::PI * 220.0 * frame as f32 / RATE).sin()
            })
            .collect();
        let spec = DynSpec::compressor(-21.0, 3.0, 20.0, 100.0, 0.0, 0.0);
        let (_, readings) = run(&[spec], &input, None);
        let at = |seconds: f32| readings[(seconds * RATE) as usize][0];
        // After one attack time constant the reduction is near 63% of the 8 dB target (plus the 5 ms detector).
        let after_attack = at(0.25 + 0.025);
        assert!(after_attack > 3.5 && after_attack < 6.5, "attack {after_attack}");
        assert!(at(0.74) > 7.6);
        // After one release time constant it has fallen to about 37%.
        let after_release = at(0.75 + 0.105);
        assert!(after_release > 2.0 && after_release < 4.0, "release {after_release}");
        assert!(at(0.99) < 1.0);
        // A slower attack lets more of the onset through (10–31 ms after it; the first cycle precedes any detector).
        let (fast, _) = run(&[DynSpec::compressor(-21.0, 3.0, 2.0, 100.0, 0.0, 0.0)], &input, None);
        let (slow, _) = run(&[DynSpec::compressor(-21.0, 3.0, 60.0, 100.0, 0.0, 0.0)], &input, None);
        assert!(rms_db(&slow[12_480..13_500]) > rms_db(&fast[12_480..13_500]) + 2.0);
    }

    #[test]
    fn a_transient_passes_a_slow_attack_and_the_body_is_reduced() {
        // A 2 ms click on a sustained tone.
        let input: Vec<f32> = (0..48_000)
            .map(|frame| {
                let body = 0.3 * (2.0 * std::f32::consts::PI * 110.0 * frame as f32 / RATE).sin();
                if (24_000..24_096).contains(&frame) { body + 0.6 } else { body }
            })
            .collect();
        let (out, readings) = run(&[DynSpec::compressor(-20.0, 3.0, 30.0, 150.0, 6.0, 0.0)], &input, None);
        let click_in = peak_db(&input[24_000..24_096]);
        let click_out = peak_db(&out[24_000..24_096]);
        // Body is already compressed when the click arrives, so the click is lowered only by the standing reduction.
        let standing = readings[23_990][0];
        assert!((click_in - click_out - standing).abs() < 1.0, "click {click_in} → {click_out}, standing {standing}");
        assert!(readings[24_200][0] < standing + 2.0, "a 2 ms click barely moves a 30 ms attack");
    }

    #[test]
    fn threshold_crossing_starts_reduction_only_above_it() {
        let ramp: Vec<f32> = (0..96_000)
            .map(|frame| {
                let amplitude = 0.01 * 10_f32.powf(frame as f32 / 96_000.0 * 2.0);
                amplitude * (2.0 * std::f32::consts::PI * 220.0 * frame as f32 / RATE).sin()
            })
            .collect();
        let (_, readings) = run(&[DynSpec::compressor(-20.0, 4.0, 1.0, 50.0, 0.0, 0.0)], &ramp, None);
        // RMS = amplitude − 3 dB; −20 dB RMS is crossed where amplitude reaches about 0.141: 2/3 of the way up.
        let crossing = readings.iter().position(|reading| reading[0] > 0.2).unwrap() as f32 / 96_000.0;
        assert!((crossing - 0.6).abs() < 0.06, "crossed at {crossing}");
    }

    #[test]
    fn bypass_is_bit_exact_and_an_empty_chain_does_nothing() {
        let input = sine(330.0, 0.4, 4_800);
        let (out, _) = run(&[], &input, None);
        assert_eq!(out, input);
        let mut runtime = DynamicsRuntime::new();
        let published = PublishedDynamics::empty();
        published.publish(&DynamicsTable::empty());
        runtime.refresh(&published);
        assert!(!runtime.track_live(0));
        // A dynamic EQ that never triggers is exactly the input: its bell sits at 0 dB.
        let (idle, _) = run(&[DynSpec::dynamic_eq(2_400.0, 1.0, Some(0), true, -20.0, -3.0, 10.0, 100.0)], &input, Some(&vec![0.0; 4_800]));
        assert_eq!(idle, input);
    }

    #[test]
    fn every_legal_setting_stays_finite_and_bounded() {
        let mut noise = 0x2468_ace1_u32;
        let input: Vec<f32> = (0..9_600)
            .map(|_| {
                noise ^= noise << 13;
                noise ^= noise >> 17;
                noise ^= noise << 5;
                (noise as f32 / u32::MAX as f32) * 2.0 - 1.0
            })
            .collect();
        let key: Vec<f32> = input.iter().rev().copied().collect();
        for threshold in [-60.0, -24.0, 0.0] {
            for ratio in [1.0, 2.2, 20.0] {
                for attack in [0.1, 35.0, 250.0] {
                    for release in [5.0, 140.0, 2_000.0] {
                        let specs = [
                            DynSpec::compressor(threshold, ratio, attack, release, 6.0, 12.0),
                            DynSpec::ducking(0, false, threshold, -12.0, attack, release),
                            DynSpec::dynamic_eq(20.0, 0.3, Some(0), true, threshold, -12.0, attack, release),
                            DynSpec::dynamic_eq(20_000.0, 6.0, None, false, threshold, -12.0, attack, release),
                            DynSpec::transient(0.3, -0.2),
                        ];
                        let (out, _) = run(&specs, &input, Some(&key));
                        assert!(out.iter().all(|value| value.is_finite()));
                        assert!(peak_db(&out) < 18.0, "ran away: {}", peak_db(&out));
                    }
                }
            }
        }
        let broken = DynSpec::compressor(f32::NAN, 2.0, 10.0, 100.0, 0.0, 0.0);
        assert_eq!(broken.sanitized(RATE).kind, DynKind::Off);
        assert_eq!(DynSpec::ducking(99, false, -20.0, -2.0, 5.0, 100.0).sanitized(RATE).kind, DynKind::Off);
    }

    /// A kick-like key: a 60 Hz burst every 0.5 s that decays over 80 ms.
    fn kick_key(frames: usize) -> Vec<f32> {
        (0..frames)
            .map(|frame| {
                let local = frame % 24_000;
                let time = local as f32 / RATE;
                (-time / 0.08).exp() * (2.0 * std::f32::consts::PI * 60.0 * time).sin() * 0.8
            })
            .collect()
    }

    #[test]
    fn a_key_pulse_ducks_the_target_and_it_recovers() {
        let frames = 48_000 * 2;
        let target = sine(80.0, 0.3, frames);
        let key = kick_key(frames);
        // The key peaks near −2 dB and falls about 11 dB per 100 ms: full depth for its first ~55 ms.
        let spec = DynSpec::ducking(0, false, -14.0, -3.0, 5.0, 80.0);
        let (out, readings) = run(&[spec], &target, Some(&key));
        // During a hit (20–50 ms in) the bass is down by the full 3 dB.
        let hit = 24_000 + 960..24_000 + 2_400;
        assert!((rms_db(&target[hit.clone()]) - rms_db(&out[hit]) - 3.0).abs() < 0.4);
        // 400 ms after the hit, it has recovered.
        let late = 24_000 + 19_200..24_000 + 21_600;
        assert!((rms_db(&target[late.clone()]) - rms_db(&out[late])).abs() < 0.15);
        let deepest = readings.iter().map(|reading| reading[1]).fold(0.0, f32::max);
        assert!(deepest <= 3.0 + 1e-3 && deepest > 2.7, "deepest duck {deepest}");
        // The duck starts within a few attack times of the hit.
        let start = readings[24_000..].iter().position(|reading| reading[1] > 1.5).unwrap();
        assert!(start < 960, "duck reached half depth after {start} frames");
    }

    #[test]
    fn a_smooth_key_rides_a_phrase_without_pumping() {
        let frames = 48_000 * 3;
        let target = sine(400.0, 0.3, frames);
        // A lead phrase from 1 s to 2 s, with a 5 Hz tremolo.
        let key: Vec<f32> = (0..frames)
            .map(|frame| {
                let time = frame as f32 / RATE;
                if (1.0..2.0).contains(&time) { 0.4 * (1.0 + 0.5 * (2.0 * std::f32::consts::PI * 5.0 * time).sin()) * (2.0 * std::f32::consts::PI * 700.0 * time).sin() } else { 0.0 }
            })
            .collect();
        let spec = DynSpec::ducking(0, true, -30.0, -2.0, 40.0, 300.0);
        let (_, readings) = run(&[spec], &target, Some(&key));
        let inside: Vec<f32> = readings[60_000..90_000].iter().map(|reading| reading[1]).collect();
        let low = inside.iter().copied().fold(f32::MAX, f32::min);
        let high = inside.iter().copied().fold(0.0, f32::max);
        assert!(high <= 2.0 + 1e-3 && low > 1.6, "duck inside the phrase {low}…{high}");
        assert!(readings[47_000][1] < 0.01, "no duck before the phrase");
        assert!(readings[143_000][1] < 0.2, "released after the phrase");
    }

    #[test]
    fn a_dynamic_eq_dips_only_its_band_and_only_while_the_key_plays() {
        let frames = 48_000 * 2;
        // Target: 2.4 kHz and 300 Hz at equal level.
        let target: Vec<f32> = (0..frames)
            .map(|frame| {
                let time = frame as f32 / RATE;
                0.2 * (2.0 * std::f32::consts::PI * 2_400.0 * time).sin() + 0.2 * (2.0 * std::f32::consts::PI * 300.0 * time).sin()
            })
            .collect();
        // Key: 2.4 kHz from 0.5 s to 1.5 s.
        let key: Vec<f32> = (0..frames)
            .map(|frame| {
                let time = frame as f32 / RATE;
                if (0.5..1.5).contains(&time) { 0.3 * (2.0 * std::f32::consts::PI * 2_400.0 * time).sin() } else { 0.0 }
            })
            .collect();
        let spec = DynSpec::dynamic_eq(2_400.0, 1.1, Some(0), true, -30.0, -3.0, 10.0, 150.0);
        let (out, readings) = run(&[spec], &target, Some(&key));
        let band = |samples: &[f32], hz: f32| {
            // Correlate with the probe sine: the amplitude of that component.
            let (mut re, mut im) = (0.0_f64, 0.0_f64);
            for (index, value) in samples.iter().enumerate() {
                let phase = 2.0 * std::f64::consts::PI * f64::from(hz) * index as f64 / f64::from(RATE);
                re += f64::from(*value) * phase.cos();
                im += f64::from(*value) * phase.sin();
            }
            20.0 * ((re * re + im * im).sqrt() * 2.0 / samples.len() as f64).log10()
        };
        let inside = 48_000..67_200;
        let before = 4_800..19_200;
        let dip = band(&target[inside.clone()], 2_400.0) - band(&out[inside.clone()], 2_400.0);
        assert!((dip - 3.0).abs() < 0.3, "band dip {dip}");
        assert!((band(&target[inside.clone()], 300.0) - band(&out[inside], 300.0)).abs() < 0.3, "300 Hz untouched");
        assert!((band(&target[before.clone()], 2_400.0) - band(&out[before], 2_400.0)).abs() < 0.05, "no dip without the key");
        let deepest = readings.iter().map(|reading| reading[2]).fold(0.0, f32::max);
        assert!(deepest <= 3.0 + 1e-3, "range respected: {deepest}");
        // A key outside the band does not trigger it.
        let off_band: Vec<f32> = (0..frames).map(|frame| 0.3 * (2.0 * std::f32::consts::PI * 150.0 * frame as f32 / RATE).sin()).collect();
        let (_, quiet) = run(&[spec], &target, Some(&off_band));
        assert!(quiet.iter().map(|reading| reading[2]).fold(0.0, f32::max) < 0.5);
    }

    #[test]
    fn a_dynamic_eq_without_a_key_follows_its_own_band() {
        let frames = 48_000;
        let target: Vec<f32> = (0..frames)
            .map(|frame| {
                let time = frame as f32 / RATE;
                let loud = if (0.5..1.0).contains(&time) { 0.4 } else { 0.02 };
                loud * (2.0 * std::f32::consts::PI * 3_000.0 * time).sin()
            })
            .collect();
        let spec = DynSpec::dynamic_eq(3_000.0, 1.0, None, false, -20.0, -4.0, 2.0, 80.0);
        let (_, readings) = run(&[spec], &target, None);
        assert!(readings[20_000][2] < 0.01);
        assert!((readings[40_000][2] - 4.0).abs() < 0.1);
    }

    /// A drum-like hit every 0.25 s: a sharp 4 ms attack over a body that decays over 120 ms.
    fn drum(frames: usize) -> Vec<f32> {
        (0..frames)
            .map(|frame| {
                let local = (frame % 12_000) as f32 / RATE;
                let envelope = if local < 0.004 { 1.0 } else { 0.35 * (-local / 0.12).exp() };
                envelope * (2.0 * std::f32::consts::PI * 200.0 * local).sin().signum() * 0.5
            })
            .collect()
    }

    fn attack_and_tail(samples: &[f32]) -> (f32, f32) {
        let mut attack = 0.0;
        let mut tail = 0.0;
        for hit in 1..7 {
            let start = hit * 12_000;
            attack += rms_db(&samples[start..start + 192]);
            tail += rms_db(&samples[start + 4_800..start + 9_600]);
        }
        (attack / 6.0, tail / 6.0)
    }

    #[test]
    fn transient_attack_and_sustain_move_the_right_part_of_a_hit() {
        let input = drum(48_000 * 2);
        let (attack_in, tail_in) = attack_and_tail(&input);
        let shaped = |attack: f32, sustain: f32| {
            let (out, _) = run(&[DynSpec::transient(attack, sustain)], &input, None);
            let (a, t) = attack_and_tail(&out);
            assert!(out.iter().all(|value| value.is_finite()));
            assert!(peak_db(&out) < peak_db(&input) + 4.0);
            (a - attack_in, t - tail_in)
        };
        let (up, up_tail) = shaped(0.2, 0.0);
        assert!(up > 0.8, "attack +20% raised the attack by {up}");
        assert!(up_tail.abs() < 0.4, "and left the tail ({up_tail})");
        let (down, _) = shaped(-0.2, 0.0);
        assert!(down < -0.8, "attack −20% lowered it by {down}");
        let (_, more) = shaped(0.0, 0.2);
        assert!(more > 0.5, "sustain +20% raised the tail by {more}");
        let (_, less) = shaped(0.0, -0.2);
        assert!(less < -0.5, "sustain −20% lowered the tail by {less}");
        let (none, none_tail) = shaped(0.0, 0.0);
        assert!(none.abs() < 1e-4 && none_tail.abs() < 1e-4, "0% is a bypass");
    }

    #[test]
    fn a_steady_tone_is_left_alone_and_a_spike_is_shaped_without_its_body() {
        for hz in [40.0_f32, 100.0, 1_000.0] {
            let tone = sine(hz, 0.5, 96_000);
            let (_, readings) = run(&[DynSpec::transient(-0.3, 0.0)], &tone, None);
            let largest = readings[48_000..].iter().map(|reading| reading[3]).fold(0.0_f32, f32::max);
            assert!(largest < 0.05, "{hz} Hz tone moved by {largest} dB");
        }
        // A clap: a 3 ms spike 18 dB over a 60 ms noise body, every 0.5 s.
        let mut noise = 0x1234_5678_u32;
        let clap: Vec<f32> = (0..96_000)
            .map(|frame| {
                noise ^= noise << 13;
                noise ^= noise >> 17;
                noise ^= noise << 5;
                let value = (noise as f32 / u32::MAX as f32) * 2.0 - 1.0;
                let local = (frame % 24_000) as f32 / RATE;
                0.5 * value * if local < 0.003 { 1.0 } else { 0.12 * (-(local - 0.003) / 0.06).exp() }
            })
            .collect();
        let (out, _) = run(&[DynSpec::transient(-0.15, 0.0)], &clap, None);
        for hit in 1..4 {
            let at = hit * 24_000;
            let attack = rms_db(&out[at..at + 480]) - rms_db(&clap[at..at + 480]);
            let body = rms_db(&out[at + 1_920..at + 6_720]) - rms_db(&clap[at + 1_920..at + 6_720]);
            assert!(attack < -1.0, "attack {attack}");
            assert!(body > -0.5, "the body is left mostly alone: {body}");
        }
    }

    fn table_with(nodes: &[DynSpec], regions: &[(u64, u64, &[DynSpec])]) -> PublishedDynamics {
        let published = PublishedDynamics::empty();
        published.publish(&DynamicsTable::build(&[TrackDynamicsInput { track_index: 0, nodes, regions }]));
        published
    }

    /// Runs track 0 through the runtime as the engine would, from `start` frame; key track 1 is `key`.
    fn play(runtime: &mut DynamicsRuntime, start: u64, input: &[f32], key: &[f32]) -> Vec<f32> {
        input
            .iter()
            .enumerate()
            .map(|(offset, value)| {
                let mut sample = [*value, 0.0];
                let keys = [0.0, key[offset]];
                if runtime.track_live(0) {
                    runtime.process(0, start + offset as u64, 1, &mut sample, &keys);
                }
                sample[0]
            })
            .collect()
    }

    #[test]
    fn a_section_node_fades_in_at_its_boundary_and_out_after_it() {
        let frames = 72_000;
        let input = sine(220.0, 0.5, frames);
        let silence = vec![0.0; frames];
        let comp = [DynSpec::compressor(-21.0, 3.0, 5.0, 50.0, 0.0, 0.0)];
        let regions = [(24_000_u64, 48_000_u64, &comp[..])];
        let mut runtime = DynamicsRuntime::new();
        runtime.refresh(&table_with(&[], &regions));
        let out = play(&mut runtime, 0, &input, &silence);
        assert!((rms_db(&out[12_000..23_000]) - rms_db(&input[12_000..23_000])).abs() < 0.01, "nothing before");
        assert!((rms_db(&input[36_000..47_000]) - rms_db(&out[36_000..47_000]) - 8.0).abs() < 0.3, "compressed inside");
        assert!((rms_db(&out[60_000..71_000]) - rms_db(&input[60_000..71_000])).abs() < 0.05, "released after");
        // No step bigger than the sine's own slope at the edges.
        let step = |range: std::ops::Range<usize>| out[range].windows(2).map(|pair| (pair[1] - pair[0]).abs()).fold(0.0, f32::max);
        assert!(step(23_900..26_000) < 0.03 && step(47_900..50_000) < 0.03);
    }

    #[test]
    fn a_seek_into_a_section_starts_at_full_effect() {
        let input = sine(220.0, 0.5, 24_000);
        let key = vec![0.0; 24_000];
        let comp = [DynSpec::compressor(-21.0, 3.0, 5.0, 50.0, 0.0, 0.0)];
        let regions = [(96_000_u64, 192_000_u64, &comp[..])];
        let mut runtime = DynamicsRuntime::new();
        runtime.refresh(&table_with(&[], &regions));
        play(&mut runtime, 0, &input[..4_800], &key);
        runtime.snap();
        let after = play(&mut runtime, 120_000, &input, &key);
        // Full effect after the detector's own settling (well under the 30 ms fade it would otherwise take).
        assert!((rms_db(&input[2_400..]) - rms_db(&after[2_400..]) - 8.0).abs() < 0.3);
    }

    #[test]
    fn a_ducking_node_in_the_runtime_reads_the_key_track_and_others_are_untouched() {
        let frames = 48_000;
        let target = sine(80.0, 0.3, frames);
        let key = kick_key(frames);
        let mut runtime = DynamicsRuntime::new();
        let published = PublishedDynamics::empty();
        let duck = [DynSpec::ducking(1, false, -30.0, -3.0, 5.0, 120.0)];
        published.publish(&DynamicsTable::build(&[TrackDynamicsInput { track_index: 0, nodes: &duck, regions: &[] }]));
        runtime.refresh(&published);
        let out = play(&mut runtime, 0, &target, &key);
        assert!(rms_db(&target[960..2_880]) - rms_db(&out[960..2_880]) > 2.5);
        // Track 2 has no dynamics: not live, never touched.
        assert!(!runtime.track_live(2));
        // A missing key (out of range) is dropped when the table is built, not guessed.
        let missing = [DynSpec { key: 70, ..duck[0] }];
        let table = DynamicsTable::build(&[TrackDynamicsInput { track_index: 0, nodes: &missing, regions: &[] }]);
        assert_eq!(table.table.used, 0);
    }

    #[test]
    fn an_edit_applies_in_place_and_removing_a_node_fades_it_out() {
        let input = sine(220.0, 0.5, 48_000 * 2);
        let key = vec![0.0; input.len()];
        let mut runtime = DynamicsRuntime::new();
        let published = PublishedDynamics::empty();
        let publish = |nodes: &[DynSpec]| published.publish(&DynamicsTable::build(&[TrackDynamicsInput { track_index: 0, nodes, regions: &[] }]));
        publish(&[DynSpec::compressor(-21.0, 3.0, 5.0, 50.0, 0.0, 0.0)]);
        runtime.refresh(&published);
        let first = play(&mut runtime, 0, &input[..48_000], &key);
        assert!((rms_db(&input[24_000..48_000]) - rms_db(&first[24_000..]) - 8.0).abs() < 0.3);
        publish(&[DynSpec::compressor(-21.0, 2.0, 5.0, 50.0, 0.0, 0.0)]);
        runtime.refresh(&published);
        let edited = play(&mut runtime, 48_000, &input[48_000..72_000], &key);
        assert!((rms_db(&input[60_000..72_000]) - rms_db(&edited[12_000..]) - 6.0).abs() < 0.3);
        assert!(edited.windows(2).map(|pair| (pair[1] - pair[0]).abs()).fold(0.0, f32::max) < 0.03, "no step on an edit");
        publish(&[]);
        runtime.refresh(&published);
        let removed = play(&mut runtime, 72_000, &input[72_000..], &key);
        assert!((rms_db(&removed[12_000..]) - rms_db(&input[84_000..])).abs() < 0.05, "bypassed after the fade");
        assert!(removed.windows(2).map(|pair| (pair[1] - pair[0]).abs()).fold(0.0, f32::max) < 0.03);
        assert!(!runtime.track_live(0), "a track with nothing left stops being processed");
    }

    #[test]
    fn meters_report_the_largest_reduction_and_fall_slowly() {
        let input = sine(220.0, 0.5, 4_800);
        let key = vec![0.0; 4_800];
        let mut runtime = DynamicsRuntime::new();
        runtime.refresh(&table_with(&[DynSpec::compressor(-21.0, 3.0, 1.0, 50.0, 0.0, 0.0)], &[]));
        let meters = DynamicsMeters::new();
        play(&mut runtime, 0, &input, &key);
        runtime.end_block(&meters, 1);
        let reading = meters.read(0);
        assert!(reading[0] > 6.0 && reading[0] <= 8.2, "compressor meter {}", reading[0]);
        runtime.end_block(&meters, 1);
        assert!((meters.read(0)[0] - (reading[0] - METER_FALL_DB)).abs() < 1e-4);
    }

    #[test]
    fn published_table_round_trips_and_places_nodes_by_stage() {
        let nodes = [
            DynSpec::ducking(3, false, -24.0, -2.0, 5.0, 120.0),
            DynSpec::compressor(-18.0, 2.2, 35.0, 140.0, 6.0, 0.0),
            DynSpec::dynamic_eq(2_400.0, 1.1, Some(4), true, -30.0, -1.8, 20.0, 250.0),
            DynSpec::transient(-0.1, 0.0),
            DynSpec::compressor(-10.0, 4.0, 5.0, 50.0, 0.0, 0.0),
        ];
        let section = [DynSpec::ducking(5, true, -30.0, -1.0, 30.0, 300.0)];
        let regions = [(10_u64, 20_u64, &section[..])];
        let published = PublishedDynamics::empty();
        published.publish(&DynamicsTable::build(&[TrackDynamicsInput { track_index: 2, nodes: &nodes, regions: &regions }]));
        let mut table = Table::empty();
        published.load_into(&mut table);
        let slots = table.tracks[2];
        assert_eq!(slots[0].kind, DynKind::DynamicEq);
        assert_eq!(slots[0].key, 4);
        assert!(slots[0].smooth_key);
        assert_eq!(slots[3], nodes[1].sanitized(RATE), "the first compressor wins its slot");
        assert_eq!(slots[4].kind, DynKind::Transient);
        assert_eq!(slots[5].kind, DynKind::Ducking);
        assert_eq!(table.used, 1 << 2);
        assert_eq!((table.region_count, table.regions[0].start, table.regions[0].end), (1, 10, 20));
        assert_eq!(table.regions[0].specs[4].key, 5);
    }
}

