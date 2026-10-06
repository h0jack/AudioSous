//! Per-track spatial stage: stereo width, then pan or balance.
//!
//! Order inside the callback: ring → EQ → width → pan/balance → gain → sum.
//!
//! Width works on a stereo stem's mid/side pair, M = (L + R) / 2 and S = (L − R) / 2. The side is
//! scaled by the width and L/R are rebuilt as M ± S. The mid is never touched, so the mono fold-down
//! of a stem is the same at every width and 100% skips the matrix entirely (bit-exact). There is no
//! level compensation: narrowing only removes side energy, and widening adds it, at most ×2 in the
//! worst (fully anti-phase) case. The planner predicts that level change from measured mid/side levels
//! and the candidate headroom estimate covers peaks. A mono stem has no side, so width does nothing to
//! it; stereo is never synthesized.
//!
//! Pan uses the engine's equal-power law: a mono stem is panned, a stereo stem gets the same
//! coefficients as a balance control (each channel scaled, no crossfeed).
//!
//! Every pan or width change, including a section boundary, ramps linearly over 30 ms. A seek snaps
//! because playback is silent while the rings refill.

use std::sync::atomic::{AtomicU64, Ordering};

use crate::mix::equal_power_pan;

pub const MAX_SPATIAL_REGIONS: usize = 128;
/// 30 ms at 48 kHz, the same ramp the EQ bands use.
pub const SPATIAL_RAMP_FRAMES: u32 = 1_440;
pub const MIN_WIDTH: f32 = 0.0;
pub const MAX_WIDTH: f32 = 2.0;
const ENGINE_TRACKS: usize = 64;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SpatialParams {
    pub pan: f32,
    pub width: f32,
}

impl SpatialParams {
    pub const NEUTRAL: Self = Self { pan: 0.0, width: 1.0 };

    /// Finite and inside the legal range. A non-finite value falls back to neutral.
    pub fn sanitized(self) -> Self {
        Self {
            pan: if self.pan.is_finite() { self.pan.clamp(-1.0, 1.0) } else { 0.0 },
            width: if self.width.is_finite() { self.width.clamp(MIN_WIDTH, MAX_WIDTH) } else { 1.0 },
        }
    }

    fn pack(self) -> u64 {
        u64::from(self.pan.to_bits()) | (u64::from(self.width.to_bits()) << 32)
    }

    fn unpack(word: u64) -> Self {
        Self {
            pan: f32::from_bits(word as u32),
            width: f32::from_bits((word >> 32) as u32),
        }
    }
}

/// Width, then pan or balance, on one frame. Returns the left and right contribution before the fader.
#[inline(always)]
pub fn spatial_frame(channels: usize, sample: [f32; 2], width: f32, coefs: (f32, f32)) -> (f32, f32) {
    if channels < 2 {
        return (sample[0] * coefs.0, sample[0] * coefs.1);
    }
    let (mut left, mut right) = (sample[0], sample[1]);
    if width != 1.0 {
        let mid = 0.5 * (left + right);
        let side = 0.5 * (left - right) * width;
        left = mid + side;
        right = mid - side;
    }
    (left * coefs.0, right * coefs.1)
}

#[derive(Clone, Copy)]
struct Region {
    track: u8,
    start: u64,
    end: u64,
    params: SpatialParams,
}

impl Region {
    const EMPTY: Self = Self {
        track: 0,
        start: 0,
        end: 0,
        params: SpatialParams::NEUTRAL,
    };
}

#[derive(Clone)]
struct Table {
    base: [SpatialParams; ENGINE_TRACKS],
    regions: [Region; MAX_SPATIAL_REGIONS],
    region_count: usize,
}

impl Table {
    fn empty() -> Self {
        Self {
            base: [SpatialParams::NEUTRAL; ENGINE_TRACKS],
            regions: [Region::EMPTY; MAX_SPATIAL_REGIONS],
            region_count: 0,
        }
    }
}

/// What the control thread publishes: whole-song pan and width per track index, and section windows
/// (proxy frames) that replace them.
pub struct SpatialTable {
    table: Box<Table>,
}

pub struct SpatialRegionInput {
    pub track_index: usize,
    pub start_frame: u64,
    pub end_frame: u64,
    pub params: SpatialParams,
}

impl SpatialTable {
    /// Regions past the table size, out of range, or empty are dropped.
    pub fn build(base: &[(usize, SpatialParams)], regions: &[SpatialRegionInput]) -> Self {
        let mut table = Box::new(Table::empty());
        for (index, params) in base {
            if *index < ENGINE_TRACKS {
                table.base[*index] = params.sanitized();
            }
        }
        for region in regions {
            if table.region_count >= MAX_SPATIAL_REGIONS || region.track_index >= ENGINE_TRACKS || region.end_frame <= region.start_frame {
                continue;
            }
            table.regions[table.region_count] = Region {
                track: region.track_index as u8,
                start: region.start_frame,
                end: region.end_frame,
                params: region.params.sanitized(),
            };
            table.region_count += 1;
        }
        Self { table }
    }
}

/// Lock-free spatial table, published the same way as the mix snapshot and the EQ table:
/// written between an odd and an even sequence, copied by the audio thread only when it moved.
pub struct PublishedSpatial {
    sequence: AtomicU64,
    region_count: AtomicU64,
    base: Box<[AtomicU64]>,
    regions: Box<[AtomicU64]>,
}

impl PublishedSpatial {
    pub fn empty() -> Self {
        let neutral = SpatialParams::NEUTRAL.pack();
        Self {
            sequence: AtomicU64::new(0),
            region_count: AtomicU64::new(0),
            base: (0..ENGINE_TRACKS).map(|_| AtomicU64::new(neutral)).collect(),
            regions: (0..MAX_SPATIAL_REGIONS * 4).map(|_| AtomicU64::new(0)).collect(),
        }
    }

    pub fn publish(&self, spatial: &SpatialTable) {
        let table = &spatial.table;
        let start = self.sequence.fetch_add(1, Ordering::AcqRel);
        self.region_count.store(table.region_count as u64, Ordering::Relaxed);
        for (index, params) in table.base.iter().enumerate() {
            self.base[index].store(params.pack(), Ordering::Relaxed);
        }
        for (index, region) in table.regions[..table.region_count].iter().enumerate() {
            let at = index * 4;
            self.regions[at].store(u64::from(region.track), Ordering::Relaxed);
            self.regions[at + 1].store(region.start, Ordering::Relaxed);
            self.regions[at + 2].store(region.end, Ordering::Relaxed);
            self.regions[at + 3].store(region.params.pack(), Ordering::Relaxed);
        }
        self.sequence.store(start.wrapping_add(2), Ordering::Release);
    }

    fn sequence(&self) -> u64 {
        self.sequence.load(Ordering::Acquire)
    }

    /// Copies into `into` without allocating. Returns the sequence that was read.
    fn load_into(&self, into: &mut Table) -> u64 {
        loop {
            let start = self.sequence.load(Ordering::Acquire);
            if start & 1 == 1 {
                std::hint::spin_loop();
                continue;
            }
            into.region_count = (self.region_count.load(Ordering::Relaxed) as usize).min(MAX_SPATIAL_REGIONS);
            for (index, slot) in into.base.iter_mut().enumerate() {
                *slot = SpatialParams::unpack(self.base[index].load(Ordering::Relaxed)).sanitized();
            }
            for index in 0..into.region_count {
                let at = index * 4;
                into.regions[index] = Region {
                    track: self.regions[at].load(Ordering::Relaxed) as u8,
                    start: self.regions[at + 1].load(Ordering::Relaxed),
                    end: self.regions[at + 2].load(Ordering::Relaxed),
                    params: SpatialParams::unpack(self.regions[at + 3].load(Ordering::Relaxed)).sanitized(),
                };
            }
            if self.sequence.load(Ordering::Acquire) == start {
                return start;
            }
        }
    }
}

#[derive(Clone, Copy)]
struct TrackRamp {
    current: SpatialParams,
    from: SpatialParams,
    to: SpatialParams,
    remaining: u32,
    /// Frames one change ramps over: 30 ms at the runtime's rate.
    ramp_frames: u32,
    /// Pan coefficients for `current.pan`, recomputed only while pan moves.
    coefs: (f32, f32),
    coefs_pan: f32,
    /// Proxy frames over which the current section assignment holds.
    span_start: u64,
    span_end: u64,
    snap: bool,
}

impl TrackRamp {
    fn idle() -> Self {
        Self {
            current: SpatialParams::NEUTRAL,
            from: SpatialParams::NEUTRAL,
            to: SpatialParams::NEUTRAL,
            remaining: 0,
            ramp_frames: SPATIAL_RAMP_FRAMES,
            coefs: equal_power_pan(0.0),
            coefs_pan: 0.0,
            span_start: 1,
            span_end: 0,
            snap: true,
        }
    }

    fn retarget(&mut self, target: SpatialParams) {
        if self.snap {
            self.snap = false;
            self.current = target;
            self.from = target;
            self.to = target;
            self.remaining = 0;
            return;
        }
        if target == self.to {
            return;
        }
        self.from = self.current;
        self.to = target;
        self.remaining = self.ramp_frames;
    }

    #[inline(always)]
    fn advance(&mut self) {
        if self.remaining == 0 {
            return;
        }
        self.remaining -= 1;
        if self.remaining == 0 {
            self.current = self.to;
        } else {
            let left = self.remaining as f32 / self.ramp_frames as f32;
            self.current = SpatialParams {
                pan: self.to.pan + (self.from.pan - self.to.pan) * left,
                width: self.to.width + (self.from.width - self.to.width) * left,
            };
        }
    }
}

/// Audio-thread spatial state. Created once on the control thread, then touched only by whichever of
/// the callback or the mixer thread holds the rings (the same ownership rule as the EQ runtime).
pub struct SpatialRuntime {
    seen: u64,
    table: Box<Table>,
    tracks: Box<[TrackRamp]>,
    ramp_frames: u32,
}

impl SpatialRuntime {
    pub fn new() -> Self {
        Self::with_rate(crate::proxy::PLAYBACK_RATE)
    }

    /// A runtime for audio at `rate`: ramps last 30 ms whatever the rate. At 48 kHz this is `new()`.
    pub fn with_rate(rate: u32) -> Self {
        let ramp_frames = crate::eq::scaled_frames(SPATIAL_RAMP_FRAMES, rate);
        let mut runtime = Self { seen: u64::MAX, table: Box::new(Table::empty()), tracks: (0..ENGINE_TRACKS).map(|_| TrackRamp::idle()).collect(), ramp_frames };
        for track in runtime.tracks.iter_mut() {
            track.ramp_frames = ramp_frames;
        }
        runtime
    }

    /// Picks up a new table once per block. Changed values ramp; nothing switches.
    pub fn refresh(&mut self, published: &PublishedSpatial) {
        if published.sequence() == self.seen {
            return;
        }
        self.seen = published.load_into(&mut self.table);
        for track in self.tracks.iter_mut() {
            // Force the section assignment to be read again from the new table.
            track.span_start = 1;
            track.span_end = 0;
        }
    }

    /// The next frame of every track jumps straight to its target. Called by the control thread
    /// while the audio thread is idle, after a seek: the output was silent, so there is nothing to ramp from.
    pub fn snap(&mut self) {
        for track in self.tracks.iter_mut() {
            track.snap = true;
            track.span_start = 1;
            track.span_end = 0;
        }
    }

    /// Forgets every track. Called by the control thread while the audio thread is idle.
    pub fn reset(&mut self) {
        self.seen = u64::MAX;
        *self.table = Table::empty();
        for track in self.tracks.iter_mut() {
            *track = TrackRamp::idle();
            track.ramp_frames = self.ramp_frames;
        }
    }

    /// The pan and width being played on a track right now.
    #[cfg(test)]
    pub fn current(&self, index: usize) -> SpatialParams {
        self.tracks.get(index).map(|track| track.current).unwrap_or(SpatialParams::NEUTRAL)
    }

    /// When a track will not ramp or change section anywhere in `[first, last]` (proxy frames, no loop wrap),
    /// its width and pan coefficients for the whole block, so the mix loop can skip per-frame bookkeeping.
    /// Returns None when the block needs `process` frame by frame.
    #[inline]
    pub fn block_constant(&mut self, index: usize, first: u64, last: u64) -> Option<(f32, (f32, f32))> {
        let table = &self.table;
        let track = &mut self.tracks[index];
        if first < track.span_start || first >= track.span_end {
            let target = assign_region(table, index, track, first);
            track.retarget(target);
        }
        if track.remaining != 0 || last >= track.span_end || last < first {
            return None;
        }
        if track.current.pan != track.coefs_pan {
            track.coefs = equal_power_pan(track.current.pan);
            track.coefs_pan = track.current.pan;
        }
        Some((track.current.width, track.coefs))
    }

    /// Width then pan/balance on one frame of `channels` samples. `frame` is the proxy frame being played.
    #[inline]
    pub fn process(&mut self, index: usize, frame: u64, channels: usize, sample: [f32; 2]) -> (f32, f32) {
        let table = &self.table;
        let track = &mut self.tracks[index];
        if frame < track.span_start || frame >= track.span_end {
            let target = assign_region(table, index, track, frame);
            track.retarget(target);
        }
        track.advance();
        if track.current.pan != track.coefs_pan {
            track.coefs = equal_power_pan(track.current.pan);
            track.coefs_pan = track.current.pan;
        }
        spatial_frame(channels, sample, track.current.width, track.coefs)
    }
}

impl Default for SpatialRuntime {
    fn default() -> Self {
        Self::new()
    }
}

/// Finds the section window under `frame` (or the gap between windows) and returns the values that hold there.
fn assign_region(table: &Table, index: usize, track: &mut TrackRamp, frame: u64) -> SpatialParams {
    let mut found = None;
    let mut span_start = 0_u64;
    let mut span_end = u64::MAX;
    for region in table.regions[..table.region_count].iter() {
        if region.track as usize != index {
            continue;
        }
        if frame >= region.start && frame < region.end {
            found = Some(region.params);
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
    found.unwrap_or(table.base[index])
}

/// Offline helper for evaluation and tests: one track's spatial stage at fixed values.
pub fn process_interleaved(samples: &[f32], channels: usize, params: SpatialParams, out: &mut Vec<f32>) {
    let params = params.sanitized();
    let coefs = equal_power_pan(params.pan);
    out.clear();
    out.reserve(samples.len() / channels.max(1) * 2);
    for frame in samples.chunks(channels.max(1)) {
        let sample = [frame[0], if channels >= 2 { frame[1] } else { frame[0] }];
        let (left, right) = spatial_frame(channels.min(2), sample, params.width, coefs);
        out.push(left);
        out.push(right);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Deterministic noise in [-1, 1).
    struct Noise(u64);

    impl Noise {
        fn next(&mut self) -> f32 {
            self.0 = self.0.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
            ((self.0 >> 40) as f32 / (1_u64 << 24) as f32) * 2.0 - 1.0
        }
    }

    fn stats(frames: &[(f32, f32)]) -> (f64, f64, f64) {
        let (mut ll, mut rr, mut lr) = (0.0_f64, 0.0_f64, 0.0_f64);
        for (left, right) in frames {
            ll += f64::from(*left) * f64::from(*left);
            rr += f64::from(*right) * f64::from(*right);
            lr += f64::from(*left) * f64::from(*right);
        }
        (ll, rr, lr)
    }

    fn correlation(frames: &[(f32, f32)]) -> f64 {
        let (ll, rr, lr) = stats(frames);
        lr / (ll * rr).sqrt()
    }

    fn table(base: &[(usize, SpatialParams)], regions: &[SpatialRegionInput]) -> PublishedSpatial {
        let published = PublishedSpatial::empty();
        published.publish(&SpatialTable::build(base, regions));
        published
    }

    #[test]
    fn mono_pan_is_equal_power() {
        let half = std::f32::consts::FRAC_1_SQRT_2;
        let (left, right) = spatial_frame(1, [1.0, 0.0], 1.0, equal_power_pan(0.0));
        assert!((left - half).abs() < 1e-6 && (right - half).abs() < 1e-6);
        let (left, right) = spatial_frame(1, [1.0, 0.0], 1.0, equal_power_pan(-1.0));
        assert!((left - 1.0).abs() < 1e-6 && right.abs() < 1e-6);
        for step in -10..=10 {
            let pan = step as f32 / 10.0;
            let (left, right) = spatial_frame(1, [1.0, 0.0], 1.0, equal_power_pan(pan));
            assert!((left * left + right * right - 1.0).abs() < 1e-5, "pan {pan} power {}", left * left + right * right);
        }
        // A mono stem ignores width: there is no side to scale and nothing is synthesized.
        for width in [0.0, 0.5, 1.5, 2.0] {
            assert_eq!(spatial_frame(1, [0.3, 0.0], width, equal_power_pan(0.25)), spatial_frame(1, [0.3, 0.0], 1.0, equal_power_pan(0.25)));
        }
    }

    #[test]
    fn stereo_balance_scales_each_channel_without_crossfeed() {
        let coefs = equal_power_pan(1.0);
        let (left, right) = spatial_frame(2, [0.8, -0.4], 1.0, coefs);
        assert!(left.abs() < 1e-6, "left leaked {left}");
        assert!((right + 0.4).abs() < 1e-6);
        let coefs = equal_power_pan(-0.3);
        let (left, right) = spatial_frame(2, [0.0, 0.5], 1.0, coefs);
        assert_eq!(left, 0.0, "no crossfeed from right to left");
        assert!((right - 0.5 * coefs.1).abs() < 1e-7);
    }

    #[test]
    fn width_100_is_bit_exact_and_width_0_is_mono() {
        let mut noise = Noise(7);
        let coefs = equal_power_pan(0.2);
        for _ in 0..10_000 {
            let sample = [noise.next(), noise.next()];
            let (left, right) = spatial_frame(2, sample, 1.0, coefs);
            assert_eq!(left, sample[0] * coefs.0);
            assert_eq!(right, sample[1] * coefs.1);
            let (left, right) = spatial_frame(2, sample, 0.0, (1.0, 1.0));
            assert_eq!(left, right, "width 0 folds to mono");
            assert!((left - 0.5 * (sample[0] + sample[1])).abs() < 1e-6);
        }
    }

    #[test]
    fn width_keeps_the_mono_fold_down_and_scales_the_side() {
        let mut noise = Noise(11);
        for width in [0.0_f32, 0.5, 1.0, 1.5, 2.0] {
            for _ in 0..5_000 {
                let sample = [noise.next(), noise.next()];
                let (left, right) = spatial_frame(2, sample, width, (1.0, 1.0));
                let mono_before = 0.5 * (sample[0] + sample[1]);
                let mono_after = 0.5 * (left + right);
                assert!((mono_after - mono_before).abs() < 1e-6, "width {width} changed the mono sum");
                let side_before = 0.5 * (sample[0] - sample[1]);
                let side_after = 0.5 * (left - right);
                assert!((side_after - side_before * width).abs() < 1e-5);
                let bound = width.max(1.0) * sample[0].abs().max(sample[1].abs()) + 1e-6;
                assert!(left.abs() <= bound && right.abs() <= bound, "width {width} out of bounds");
            }
        }
    }

    #[test]
    fn correlation_follows_the_width_on_decorrelated_noise() {
        // Independent L and R: mid and side carry equal power, so the output correlation is (1 − w²) / (1 + w²).
        for width in [0.0_f32, 0.5, 1.0, 1.5, 2.0] {
            let mut noise = Noise(23);
            let frames: Vec<(f32, f32)> = (0..200_000).map(|_| spatial_frame(2, [noise.next(), noise.next()], width, (1.0, 1.0))).collect();
            let expected = (1.0 - f64::from(width).powi(2)) / (1.0 + f64::from(width).powi(2));
            let measured = correlation(&frames);
            assert!((measured - expected).abs() < 0.02, "width {width}: correlation {measured} expected {expected}");
        }
    }

    #[test]
    fn every_legal_setting_is_finite_and_bounded() {
        let mut noise = Noise(5);
        for pan_step in -10..=10 {
            for width_step in 0..=20 {
                let pan = pan_step as f32 / 10.0;
                let width = width_step as f32 / 10.0;
                let coefs = equal_power_pan(pan);
                for _ in 0..500 {
                    let (left, right) = spatial_frame(2, [noise.next(), noise.next()], width, coefs);
                    assert!(left.is_finite() && right.is_finite());
                    assert!(left.abs() <= 2.0 + 1e-5 && right.abs() <= 2.0 + 1e-5, "pan {pan} width {width}: {left} {right}");
                }
            }
        }
        let wild = SpatialParams { pan: f32::NAN, width: f32::INFINITY }.sanitized();
        assert_eq!(wild, SpatialParams { pan: 0.0, width: 1.0 });
        assert_eq!(SpatialParams { pan: 4.0, width: 9.0 }.sanitized(), SpatialParams { pan: 1.0, width: MAX_WIDTH });
        assert_eq!(SpatialParams { pan: -4.0, width: -1.0 }.sanitized(), SpatialParams { pan: -1.0, width: 0.0 });
    }

    #[test]
    fn a_change_ramps_over_30_ms_without_a_step() {
        let mut runtime = SpatialRuntime::new();
        let published = table(&[(0, SpatialParams::NEUTRAL)], &[]);
        runtime.refresh(&published);
        runtime.process(0, 0, 2, [0.5, 0.5]);
        published.publish(&SpatialTable::build(&[(0, SpatialParams { pan: 1.0, width: 0.0 })], &[]));
        runtime.refresh(&published);
        let mut previous = runtime.current(0);
        let mut largest_pan_step = 0.0_f32;
        let mut largest_width_step = 0.0_f32;
        for frame in 1..=SPATIAL_RAMP_FRAMES as u64 + 10 {
            runtime.process(0, frame, 2, [0.5, 0.5]);
            let now = runtime.current(0);
            largest_pan_step = largest_pan_step.max((now.pan - previous.pan).abs());
            largest_width_step = largest_width_step.max((now.width - previous.width).abs());
            previous = now;
        }
        assert_eq!(runtime.current(0), SpatialParams { pan: 1.0, width: 0.0 });
        let per_frame = 1.0 / SPATIAL_RAMP_FRAMES as f32;
        assert!(largest_pan_step <= per_frame * 1.01, "pan stepped {largest_pan_step}");
        assert!(largest_width_step <= per_frame * 1.01, "width stepped {largest_width_step}");
    }

    #[test]
    fn a_section_window_replaces_the_track_value_and_ramps_at_its_edges() {
        let mut runtime = SpatialRuntime::new();
        let drop = SpatialParams { pan: 0.4, width: 1.5 };
        let published = table(
            &[(0, SpatialParams { pan: -0.2, width: 1.0 }), (1, SpatialParams::NEUTRAL)],
            &[SpatialRegionInput { track_index: 0, start_frame: 48_000, end_frame: 96_000, params: drop }],
        );
        runtime.refresh(&published);
        runtime.process(0, 0, 2, [0.1, 0.1]);
        assert_eq!(runtime.current(0), SpatialParams { pan: -0.2, width: 1.0 });
        for frame in 1..48_000 {
            runtime.process(0, frame, 2, [0.1, 0.1]);
        }
        runtime.process(0, 48_000, 2, [0.1, 0.1]);
        let entering = runtime.current(0);
        assert!(entering.pan > -0.2 && entering.pan < -0.19, "starts ramping, not jumping: {entering:?}");
        for frame in 48_001..48_000 + u64::from(SPATIAL_RAMP_FRAMES) {
            runtime.process(0, frame, 2, [0.1, 0.1]);
        }
        assert_eq!(runtime.current(0), drop);
        // The other track never sees the window.
        runtime.process(1, 50_000, 2, [0.1, 0.1]);
        assert_eq!(runtime.current(1), SpatialParams::NEUTRAL);
        for frame in 48_000 + u64::from(SPATIAL_RAMP_FRAMES)..96_000 + u64::from(SPATIAL_RAMP_FRAMES) {
            runtime.process(0, frame, 2, [0.1, 0.1]);
        }
        assert_eq!(runtime.current(0), SpatialParams { pan: -0.2, width: 1.0 });
    }

    #[test]
    fn a_seek_into_a_section_starts_at_its_values() {
        let mut runtime = SpatialRuntime::new();
        let drop = SpatialParams { pan: 0.4, width: 1.5 };
        let published = table(
            &[(0, SpatialParams::NEUTRAL)],
            &[SpatialRegionInput { track_index: 0, start_frame: 48_000, end_frame: 96_000, params: drop }],
        );
        runtime.refresh(&published);
        runtime.process(0, 0, 2, [0.1, 0.1]);
        runtime.snap();
        runtime.process(0, 60_000, 2, [0.1, 0.1]);
        assert_eq!(runtime.current(0), drop);
        // A loop wrap inside the same window is not a change.
        runtime.process(0, 50_000, 2, [0.1, 0.1]);
        assert_eq!(runtime.current(0), drop);
    }

    #[test]
    fn several_tracks_and_windows_resolve_independently() {
        let mut runtime = SpatialRuntime::new();
        let regions = [
            SpatialRegionInput { track_index: 0, start_frame: 0, end_frame: 1_000, params: SpatialParams { pan: -1.0, width: 1.0 } },
            SpatialRegionInput { track_index: 0, start_frame: 2_000, end_frame: 3_000, params: SpatialParams { pan: 1.0, width: 1.0 } },
            SpatialRegionInput { track_index: 2, start_frame: 1_000, end_frame: 2_000, params: SpatialParams { pan: 0.0, width: 0.0 } },
        ];
        let published = table(&[(0, SpatialParams::NEUTRAL), (1, SpatialParams { pan: 0.5, width: 1.2 }), (2, SpatialParams::NEUTRAL)], &regions);
        runtime.refresh(&published);
        runtime.snap();
        let at = |runtime: &mut SpatialRuntime, index: usize, frame: u64| {
            runtime.snap();
            runtime.process(index, frame, 2, [0.0, 0.0]);
            runtime.current(index)
        };
        assert_eq!(at(&mut runtime, 0, 500).pan, -1.0);
        assert_eq!(at(&mut runtime, 0, 1_500).pan, 0.0);
        assert_eq!(at(&mut runtime, 0, 2_500).pan, 1.0);
        assert_eq!(at(&mut runtime, 1, 2_500), SpatialParams { pan: 0.5, width: 1.2 });
        assert_eq!(at(&mut runtime, 2, 1_500).width, 0.0);
        assert_eq!(at(&mut runtime, 2, 2_500).width, 1.0);
    }

    #[test]
    fn the_table_drops_bad_regions_and_caps_its_size() {
        let mut regions: Vec<SpatialRegionInput> = (0..MAX_SPATIAL_REGIONS + 20)
            .map(|index| SpatialRegionInput {
                track_index: index % 4,
                start_frame: index as u64 * 10,
                end_frame: index as u64 * 10 + 5,
                params: SpatialParams { pan: 0.1, width: 1.1 },
            })
            .collect();
        regions.insert(0, SpatialRegionInput { track_index: 3, start_frame: 50, end_frame: 50, params: SpatialParams::NEUTRAL });
        regions.insert(0, SpatialRegionInput { track_index: 99, start_frame: 0, end_frame: 50, params: SpatialParams::NEUTRAL });
        let built = SpatialTable::build(&[], &regions);
        assert_eq!(built.table.region_count, MAX_SPATIAL_REGIONS);
        assert_eq!(built.table.regions[0].track, 0);
        let published = PublishedSpatial::empty();
        published.publish(&built);
        let mut copy = Table::empty();
        published.load_into(&mut copy);
        assert_eq!(copy.region_count, MAX_SPATIAL_REGIONS);
        assert_eq!(copy.regions[5].params, SpatialParams { pan: 0.1, width: 1.1 });
    }

    #[test]
    fn a_constant_block_matches_frame_by_frame_processing() {
        let regions = [SpatialRegionInput { track_index: 0, start_frame: 1_000, end_frame: 5_000, params: SpatialParams { pan: 0.4, width: 1.3 } }];
        let published = table(&[(0, SpatialParams { pan: -0.2, width: 0.8 })], &regions);
        let mut fast = SpatialRuntime::new();
        let mut slow = SpatialRuntime::new();
        fast.refresh(&published);
        slow.refresh(&published);
        let mut noise = Noise(9);
        // Outside the window, inside it while it still ramps (falls back), after the ramp, and across its edge (falls back).
        for (first, last, constant) in [(0_u64, 511_u64, true), (1_000, 1_255, false), (3_000, 3_255, true), (4_900, 5_155, false)] {
            if first == 3_000 {
                for frame in 1_256..3_000 {
                    fast.process(0, frame, 2, [0.0, 0.0]);
                    slow.process(0, frame, 2, [0.0, 0.0]);
                }
            }
            let block = fast.block_constant(0, first, last);
            assert_eq!(block.is_some(), constant, "block {first}..{last}");
            for frame in first..=last {
                let sample = [noise.next(), noise.next()];
                let expected = slow.process(0, frame, 2, sample);
                let got = match block {
                    Some((width, coefs)) => spatial_frame(2, sample, width, coefs),
                    None => fast.process(0, frame, 2, sample),
                };
                assert_eq!(got, expected, "frame {frame}");
            }
        }
    }

    #[test]
    fn the_offline_helper_matches_the_runtime() {
        let mut noise = Noise(3);
        let samples: Vec<f32> = (0..2_000).map(|_| noise.next()).collect();
        let params = SpatialParams { pan: 0.3, width: 1.4 };
        let mut out = Vec::new();
        process_interleaved(&samples, 2, params, &mut out);
        let mut runtime = SpatialRuntime::new();
        runtime.refresh(&table(&[(0, params)], &[]));
        for (index, frame) in samples.chunks(2).enumerate() {
            let (left, right) = runtime.process(0, index as u64, 2, [frame[0], frame[1]]);
            assert_eq!(left, out[index * 2]);
            assert_eq!(right, out[index * 2 + 1]);
        }
    }
}
