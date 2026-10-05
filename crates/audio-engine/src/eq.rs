//! Static per-track EQ.
//!
//! Each band is a second-order section with the RBJ Audio EQ Cookbook responses
//! (high-pass, low-pass, peaking bell, low shelf, high shelf), run in Andrew Simper's
//! trapezoidal state-variable form. The magnitude response is the cookbook biquad's
//! exactly (both use the bilinear transform prewarped at the band frequency). The SVF
//! form is used instead of a direct-form biquad because its coefficients can be moved
//! sample by sample without the state blowing up, so a section boundary or an edit
//! ramps the filter instead of switching it.
//!
//! The control thread designs coefficients and publishes them through atomics.
//! The callback only reads them, interpolates during a short ramp, and filters.
//! Nothing here allocates, locks, or does I/O on the audio thread.

use std::sync::atomic::{AtomicU64, Ordering};

use crate::proxy::PLAYBACK_RATE;

pub const MAX_TRACK_BANDS: usize = 6;
pub const MAX_SECTION_BANDS: usize = 4;
pub const SLOTS: usize = MAX_TRACK_BANDS + MAX_SECTION_BANDS;
pub const MAX_EQ_REGIONS: usize = 64;
/// 30 ms at 48 kHz. Long enough to avoid a click at a section boundary, short enough to sound immediate.
pub const EQ_RAMP_FRAMES: u32 = 1_440;

const MIN_HZ: f32 = 20.0;
const MAX_HZ: f32 = 20_000.0;
const MIN_Q: f32 = 0.1;
const MAX_Q: f32 = 10.0;
const MAX_ABS_GAIN_DB: f32 = 24.0;

const ENGINE_TRACKS: usize = 64;

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum FilterKind {
    HighPass,
    LowPass,
    Bell,
    LowShelf,
    HighShelf,
}

#[derive(Clone, Copy, Debug, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilterSpec {
    pub kind: FilterKind,
    pub frequency_hz: f32,
    pub gain_db: f32,
    pub q: f32,
}

impl FilterSpec {
    /// Clamped to safe bounds for `sample_rate`. Returns `None` for a non-finite parameter.
    pub fn sanitized(self, sample_rate: f32) -> Option<Self> {
        if !self.frequency_hz.is_finite() || !self.gain_db.is_finite() || !self.q.is_finite() {
            return None;
        }
        let ceiling = MAX_HZ.min(sample_rate * 0.45);
        Some(Self {
            kind: self.kind,
            frequency_hz: self.frequency_hz.clamp(MIN_HZ, ceiling.max(MIN_HZ)),
            gain_db: self.gain_db.clamp(-MAX_ABS_GAIN_DB, MAX_ABS_GAIN_DB),
            q: self.q.clamp(MIN_Q, MAX_Q),
        })
    }
}

/// `out = m0·v0 + m1·v1 + m2·v2` with `g = tan(πf/fs)` and damping `k`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SvfCoefs {
    pub g: f32,
    pub k: f32,
    pub m0: f32,
    pub m1: f32,
    pub m2: f32,
}

impl SvfCoefs {
    pub const IDENTITY: Self = Self {
        g: 0.1,
        k: 1.0,
        m0: 1.0,
        m1: 0.0,
        m2: 0.0,
    };

    pub fn design(spec: FilterSpec, sample_rate: f32) -> Self {
        let Some(spec) = spec.sanitized(sample_rate) else {
            return Self::IDENTITY;
        };
        let w = (std::f64::consts::PI * f64::from(spec.frequency_hz) / f64::from(sample_rate)).tan();
        let q = f64::from(spec.q);
        let a = 10_f64.powf(f64::from(spec.gain_db) / 40.0);
        let (g, k, m0, m1, m2) = match spec.kind {
            FilterKind::LowPass => (w, 1.0 / q, 0.0, 0.0, 1.0),
            FilterKind::HighPass => (w, 1.0 / q, 1.0, -1.0 / q, -1.0),
            FilterKind::Bell => {
                let k = 1.0 / (q * a);
                (w, k, 1.0, k * (a * a - 1.0), 0.0)
            }
            FilterKind::LowShelf => {
                let k = 1.0 / q;
                (w / a.sqrt(), k, 1.0, k * (a - 1.0), a * a - 1.0)
            }
            FilterKind::HighShelf => {
                let k = 1.0 / q;
                (w * a.sqrt(), k, a * a, k * (1.0 - a) * a, 1.0 - a * a)
            }
        };
        Self {
            g: g as f32,
            k: k as f32,
            m0: m0 as f32,
            m1: m1 as f32,
            m2: m2 as f32,
        }
    }

    pub fn is_identity(&self) -> bool {
        self.m0 == 1.0 && self.m1 == 0.0 && self.m2 == 0.0
    }

    /// Same damping and frequency, no effect. Fading to or from this keeps the state meaningful.
    fn bypassed(&self) -> Self {
        Self {
            m0: 1.0,
            m1: 0.0,
            m2: 0.0,
            ..*self
        }
    }

    fn lerp(&self, other: &Self, t: f32) -> Self {
        Self {
            g: self.g + (other.g - self.g) * t,
            k: self.k + (other.k - self.k) * t,
            m0: self.m0 + (other.m0 - self.m0) * t,
            m1: self.m1 + (other.m1 - self.m1) * t,
            m2: self.m2 + (other.m2 - self.m2) * t,
        }
    }

    fn pack(&self) -> [u64; 3] {
        [
            u64::from(self.g.to_bits()) | (u64::from(self.k.to_bits()) << 32),
            u64::from(self.m0.to_bits()) | (u64::from(self.m1.to_bits()) << 32),
            u64::from(self.m2.to_bits()),
        ]
    }

    fn unpack(words: [u64; 3]) -> Self {
        Self {
            g: f32::from_bits(words[0] as u32),
            k: f32::from_bits((words[0] >> 32) as u32),
            m0: f32::from_bits(words[1] as u32),
            m1: f32::from_bits((words[1] >> 32) as u32),
            m2: f32::from_bits(words[2] as u32),
        }
    }
}

#[derive(Clone, Copy, Default)]
pub(crate) struct SvfState {
    ic1: f32,
    ic2: f32,
}

#[derive(Clone, Copy)]
pub(crate) struct Taps {
    a1: f32,
    a2: f32,
    a3: f32,
}

impl Taps {
    pub(crate) fn of(coefs: &SvfCoefs) -> Self {
        let a1 = 1.0 / (1.0 + coefs.g * (coefs.g + coefs.k));
        let a2 = coefs.g * a1;
        Self {
            a1,
            a2,
            a3: coefs.g * a2,
        }
    }
}

#[inline(always)]
pub(crate) fn tick(state: &mut SvfState, taps: &Taps, coefs: &SvfCoefs, input: f32) -> f32 {
    let v3 = input - state.ic2;
    let v1 = taps.a1 * state.ic1 + taps.a2 * v3;
    let v2 = state.ic2 + taps.a2 * state.ic1 + taps.a3 * v3;
    state.ic1 = 2.0 * v1 - state.ic1;
    state.ic2 = 2.0 * v2 - state.ic2;
    coefs.m0 * input + coefs.m1 * v1 + coefs.m2 * v2
}

/// One band in the audio thread: what it is now, where it is going, and its filter memory.
#[derive(Clone, Copy)]
struct Slot {
    current: SvfCoefs,
    start: SvfCoefs,
    target: SvfCoefs,
    taps: Taps,
    ramp: u32,
    ramping: bool,
    active: bool,
    state: [SvfState; 2],
}

impl Slot {
    fn idle() -> Self {
        Self {
            current: SvfCoefs::IDENTITY,
            start: SvfCoefs::IDENTITY,
            target: SvfCoefs::IDENTITY,
            taps: Taps::of(&SvfCoefs::IDENTITY),
            ramp: 0,
            ramping: false,
            active: false,
            state: [SvfState::default(); 2],
        }
    }

    fn retarget(&mut self, next: SvfCoefs) {
        let next = if next.is_identity() {
            self.current.bypassed()
        } else {
            next
        };
        if next == self.target {
            return;
        }
        if !self.active {
            if next.is_identity() {
                self.target = next;
                self.current = next;
                return;
            }
            // An idle band wakes from silence: same frequency and damping, no mix. The fade hides the cold state.
            self.state = [SvfState::default(); 2];
            self.current = next.bypassed();
            self.active = true;
        }
        self.start = self.current;
        self.target = next;
        self.ramp = 0;
        self.ramping = true;
    }

    #[inline(always)]
    fn advance(&mut self) {
        if !self.ramping {
            return;
        }
        self.ramp += 1;
        if self.ramp >= EQ_RAMP_FRAMES {
            self.current = self.target;
            self.ramping = false;
            if self.current.is_identity() {
                self.active = false;
            }
        } else {
            self.current = self
                .start
                .lerp(&self.target, self.ramp as f32 / EQ_RAMP_FRAMES as f32);
        }
        self.taps = Taps::of(&self.current);
    }

    fn settle(&mut self) {
        self.current = self.target;
        self.ramping = false;
        self.active = !self.current.is_identity();
        self.taps = Taps::of(&self.current);
    }
}

/// A Track × Section window with its extra bands, in proxy frames.
#[derive(Clone, Copy)]
struct Region {
    track: u8,
    start: u64,
    end: u64,
    bands: [SvfCoefs; MAX_SECTION_BANDS],
}

/// What the control thread last published, as plain values.
#[derive(Clone, Copy)]
struct Table {
    tracks: [[SvfCoefs; MAX_TRACK_BANDS]; ENGINE_TRACKS],
    regions: [Region; MAX_EQ_REGIONS],
    region_count: usize,
    /// A track has at least one band or one region.
    used: u64,
}

impl Table {
    fn empty() -> Self {
        Self {
            tracks: [[SvfCoefs::IDENTITY; MAX_TRACK_BANDS]; ENGINE_TRACKS],
            regions: [Region {
                track: 0,
                start: 0,
                end: 0,
                bands: [SvfCoefs::IDENTITY; MAX_SECTION_BANDS],
            }; MAX_EQ_REGIONS],
            region_count: 0,
            used: 0,
        }
    }
}

/// Designed EQ for every loaded track, ready to publish.
pub struct EqTable {
    table: Box<Table>,
}

pub struct TrackEqInput<'a> {
    pub track_index: usize,
    pub filters: &'a [FilterSpec],
    pub regions: &'a [(u64, u64, &'a [FilterSpec])],
}

impl EqTable {
    pub fn empty() -> Self {
        Self {
            table: Box::new(Table::empty()),
        }
    }

    /// Designs every band at the playback rate. Extra filters past the slot count are ignored.
    pub fn design(tracks: &[TrackEqInput<'_>]) -> Self {
        let mut table = Box::new(Table::empty());
        let rate = PLAYBACK_RATE as f32;
        for track in tracks {
            if track.track_index >= ENGINE_TRACKS {
                continue;
            }
            let mut used = false;
            for (slot, spec) in track.filters.iter().take(MAX_TRACK_BANDS).enumerate() {
                let coefs = SvfCoefs::design(*spec, rate);
                used |= !coefs.is_identity();
                table.tracks[track.track_index][slot] = coefs;
            }
            for (start, end, filters) in track.regions {
                if table.region_count >= MAX_EQ_REGIONS || end <= start {
                    continue;
                }
                let mut bands = [SvfCoefs::IDENTITY; MAX_SECTION_BANDS];
                for (slot, spec) in filters.iter().take(MAX_SECTION_BANDS).enumerate() {
                    bands[slot] = SvfCoefs::design(*spec, rate);
                }
                if bands.iter().all(SvfCoefs::is_identity) {
                    continue;
                }
                table.regions[table.region_count] = Region {
                    track: track.track_index as u8,
                    start: *start,
                    end: *end,
                    bands,
                };
                table.region_count += 1;
                used = true;
            }
            if used && track.track_index < 64 {
                table.used |= 1 << track.track_index;
            }
        }
        Self { table }
    }
}

const TRACK_WORDS: usize = ENGINE_TRACKS * MAX_TRACK_BANDS * 3;
const REGION_WORDS: usize = MAX_EQ_REGIONS * (3 + MAX_SECTION_BANDS * 3);

/// Lock-free EQ table. The control thread writes between an odd and an even sequence;
/// the audio thread copies it only when the sequence moved, and retries a torn copy.
pub struct PublishedEq {
    sequence: AtomicU64,
    region_count: AtomicU64,
    used: AtomicU64,
    tracks: Box<[AtomicU64]>,
    regions: Box<[AtomicU64]>,
}

impl PublishedEq {
    pub fn empty() -> Self {
        Self {
            sequence: AtomicU64::new(0),
            region_count: AtomicU64::new(0),
            used: AtomicU64::new(0),
            tracks: (0..TRACK_WORDS).map(|_| AtomicU64::new(0)).collect(),
            regions: (0..REGION_WORDS).map(|_| AtomicU64::new(0)).collect(),
        }
    }

    pub fn publish(&self, eq: &EqTable) {
        let table = &eq.table;
        let start = self.sequence.fetch_add(1, Ordering::AcqRel);
        self.region_count
            .store(table.region_count as u64, Ordering::Relaxed);
        self.used.store(table.used, Ordering::Relaxed);
        for track in 0..ENGINE_TRACKS {
            for band in 0..MAX_TRACK_BANDS {
                let words = table.tracks[track][band].pack();
                let base = (track * MAX_TRACK_BANDS + band) * 3;
                for (offset, word) in words.iter().enumerate() {
                    self.tracks[base + offset].store(*word, Ordering::Relaxed);
                }
            }
        }
        for index in 0..table.region_count {
            let region = &table.regions[index];
            let base = index * (3 + MAX_SECTION_BANDS * 3);
            self.regions[base].store(u64::from(region.track), Ordering::Relaxed);
            self.regions[base + 1].store(region.start, Ordering::Relaxed);
            self.regions[base + 2].store(region.end, Ordering::Relaxed);
            for band in 0..MAX_SECTION_BANDS {
                let words = region.bands[band].pack();
                for (offset, word) in words.iter().enumerate() {
                    self.regions[base + 3 + band * 3 + offset].store(*word, Ordering::Relaxed);
                }
            }
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
            into.region_count =
                (self.region_count.load(Ordering::Relaxed) as usize).min(MAX_EQ_REGIONS);
            into.used = self.used.load(Ordering::Relaxed);
            for track in 0..ENGINE_TRACKS {
                for band in 0..MAX_TRACK_BANDS {
                    let base = (track * MAX_TRACK_BANDS + band) * 3;
                    into.tracks[track][band] = SvfCoefs::unpack([
                        self.tracks[base].load(Ordering::Relaxed),
                        self.tracks[base + 1].load(Ordering::Relaxed),
                        self.tracks[base + 2].load(Ordering::Relaxed),
                    ]);
                }
            }
            for index in 0..into.region_count {
                let base = index * (3 + MAX_SECTION_BANDS * 3);
                let region = &mut into.regions[index];
                region.track = self.regions[base].load(Ordering::Relaxed) as u8;
                region.start = self.regions[base + 1].load(Ordering::Relaxed);
                region.end = self.regions[base + 2].load(Ordering::Relaxed);
                for band in 0..MAX_SECTION_BANDS {
                    let at = base + 3 + band * 3;
                    region.bands[band] = SvfCoefs::unpack([
                        self.regions[at].load(Ordering::Relaxed),
                        self.regions[at + 1].load(Ordering::Relaxed),
                        self.regions[at + 2].load(Ordering::Relaxed),
                    ]);
                }
            }
            if self.sequence.load(Ordering::Acquire) == start {
                return start;
            }
        }
    }
}

#[derive(Clone, Copy)]
struct TrackEq {
    slots: [Slot; SLOTS],
    /// Proxy frames over which the current section assignment holds.
    span_start: u64,
    span_end: u64,
    region: Option<usize>,
    live: bool,
}

impl TrackEq {
    fn idle() -> Self {
        Self {
            slots: [Slot::idle(); SLOTS],
            span_start: 0,
            span_end: 0,
            region: None,
            live: false,
        }
    }
}

/// Audio-thread EQ state. Created once on the control thread, then touched only by
/// whichever of the callback or the mixer thread holds the rings.
pub struct EqRuntime {
    seen: u64,
    table: Box<Table>,
    tracks: Box<[TrackEq]>,
    first: bool,
}

impl EqRuntime {
    pub fn new() -> Self {
        Self {
            seen: u64::MAX,
            table: Box::new(Table::empty()),
            tracks: (0..ENGINE_TRACKS).map(|_| TrackEq::idle()).collect(),
            first: true,
        }
    }

    /// Picks up a new table once per block. Changed bands ramp; nothing switches.
    pub fn refresh(&mut self, published: &PublishedEq) {
        if published.sequence() == self.seen {
            return;
        }
        self.seen = published.load_into(&mut self.table);
        let first = self.first;
        self.first = false;
        for (index, track) in self.tracks.iter_mut().enumerate() {
            for band in 0..MAX_TRACK_BANDS {
                track.slots[band].retarget(self.table.tracks[index][band]);
                if first {
                    track.slots[band].settle();
                }
            }
            // Force the section assignment to be read again from the new table.
            track.span_start = 1;
            track.span_end = 0;
            track.live = track.live || self.table.used & (1 << index) != 0;
        }
    }

    /// Forgets every band and its memory. Called by the control thread while the audio thread is idle.
    pub fn reset(&mut self) {
        self.seen = u64::MAX;
        self.first = true;
        *self.table = Table::empty();
        for track in self.tracks.iter_mut() {
            *track = TrackEq::idle();
        }
    }

    #[inline(always)]
    pub fn track_live(&self, index: usize) -> bool {
        index < ENGINE_TRACKS && self.tracks[index].live
    }

    /// Filters one frame of `channels` samples in place. `frame` is the proxy frame being played.
    #[inline]
    pub fn process(&mut self, index: usize, frame: u64, channels: usize, sample: &mut [f32; 2]) {
        let table = &self.table;
        let track = &mut self.tracks[index];
        if frame < track.span_start || frame >= track.span_end {
            assign_region(table, index, track, frame);
        }
        let mut any = false;
        for slot in track.slots.iter_mut() {
            if !slot.active {
                continue;
            }
            any = true;
            slot.advance();
            if !slot.active {
                continue;
            }
            for channel in 0..channels {
                sample[channel] = tick(&mut slot.state[channel], &slot.taps, &slot.current, sample[channel]);
            }
        }
        if !any && table.used & (1 << index) == 0 {
            track.live = false;
        }
    }
}

impl Default for EqRuntime {
    fn default() -> Self {
        Self::new()
    }
}

fn assign_region(table: &Table, index: usize, track: &mut TrackEq, frame: u64) {
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
    track.region = found;
    // Retargeting to the bands a slot already has is a no-op, so a loop wrap inside one section costs nothing.
    for band in 0..MAX_SECTION_BANDS {
        let next = found
            .map(|at| table.regions[at].bands[band])
            .unwrap_or(SvfCoefs::IDENTITY);
        track.slots[MAX_TRACK_BANDS + band].retarget(next);
    }
}

/// Offline helper for tests and evaluation: runs `filters` in series over interleaved audio.
pub struct EqChain {
    bands: Vec<(SvfCoefs, Taps, [SvfState; 2])>,
}

impl EqChain {
    pub fn new(filters: &[FilterSpec], sample_rate: f32) -> Self {
        Self {
            bands: filters
                .iter()
                .map(|spec| {
                    let coefs = SvfCoefs::design(*spec, sample_rate);
                    (coefs, Taps::of(&coefs), [SvfState::default(); 2])
                })
                .collect(),
        }
    }

    pub fn process_interleaved(&mut self, samples: &mut [f32], channels: usize) {
        let channels = channels.clamp(1, 2);
        for frame in samples.chunks_mut(channels) {
            for (coefs, taps, states) in self.bands.iter_mut() {
                for (channel, sample) in frame.iter_mut().enumerate() {
                    *sample = tick(&mut states[channel], taps, coefs, *sample);
                }
            }
        }
    }
}

/// RBJ cookbook magnitude in dB at `hz`, the reference the tests hold the SVF to.
pub fn cookbook_magnitude_db(spec: FilterSpec, hz: f64, sample_rate: f64) -> f64 {
    let Some(spec) = spec.sanitized(sample_rate as f32) else {
        return 0.0;
    };
    let w0 = 2.0 * std::f64::consts::PI * f64::from(spec.frequency_hz) / sample_rate;
    let (sin, cos) = w0.sin_cos();
    let q = f64::from(spec.q);
    let alpha = sin / (2.0 * q);
    let a = 10_f64.powf(f64::from(spec.gain_db) / 40.0);
    let (b0, b1, b2, a0, a1, a2) = match spec.kind {
        FilterKind::LowPass => ((1.0 - cos) / 2.0, 1.0 - cos, (1.0 - cos) / 2.0, 1.0 + alpha, -2.0 * cos, 1.0 - alpha),
        FilterKind::HighPass => ((1.0 + cos) / 2.0, -(1.0 + cos), (1.0 + cos) / 2.0, 1.0 + alpha, -2.0 * cos, 1.0 - alpha),
        FilterKind::Bell => (1.0 + alpha * a, -2.0 * cos, 1.0 - alpha * a, 1.0 + alpha / a, -2.0 * cos, 1.0 - alpha / a),
        FilterKind::LowShelf => {
            let root = 2.0 * a.sqrt() * alpha;
            (
                a * ((a + 1.0) - (a - 1.0) * cos + root),
                2.0 * a * ((a - 1.0) - (a + 1.0) * cos),
                a * ((a + 1.0) - (a - 1.0) * cos - root),
                (a + 1.0) + (a - 1.0) * cos + root,
                -2.0 * ((a - 1.0) + (a + 1.0) * cos),
                (a + 1.0) + (a - 1.0) * cos - root,
            )
        }
        FilterKind::HighShelf => {
            let root = 2.0 * a.sqrt() * alpha;
            (
                a * ((a + 1.0) + (a - 1.0) * cos + root),
                -2.0 * a * ((a - 1.0) + (a + 1.0) * cos),
                a * ((a + 1.0) + (a - 1.0) * cos - root),
                (a + 1.0) - (a - 1.0) * cos + root,
                2.0 * ((a - 1.0) - (a + 1.0) * cos),
                (a + 1.0) - (a - 1.0) * cos - root,
            )
        }
    };
    let w = 2.0 * std::f64::consts::PI * hz / sample_rate;
    let (s1, c1) = w.sin_cos();
    let (s2, c2) = (2.0 * w).sin_cos();
    let num_re = b0 + b1 * c1 + b2 * c2;
    let num_im = -(b1 * s1 + b2 * s2);
    let den_re = a0 + a1 * c1 + a2 * c2;
    let den_im = -(a1 * s1 + a2 * s2);
    let magnitude = ((num_re * num_re + num_im * num_im) / (den_re * den_re + den_im * den_im)).sqrt();
    20.0 * magnitude.max(1e-12).log10()
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: f32 = 48_000.0;

    fn spec(kind: FilterKind, frequency_hz: f32, gain_db: f32, q: f32) -> FilterSpec {
        FilterSpec {
            kind,
            frequency_hz,
            gain_db,
            q,
        }
    }

    /// Steady-state gain of a sine through `filters`, measured after the transient settles.
    fn sine_gain_db(filters: &[FilterSpec], hz: f32) -> f64 {
        let mut chain = EqChain::new(filters, RATE);
        let frames = (RATE as usize) * 2;
        let mut samples: Vec<f32> = (0..frames)
            .map(|index| (2.0 * std::f32::consts::PI * hz * index as f32 / RATE).sin() * 0.5)
            .collect();
        chain.process_interleaved(&mut samples, 1);
        let tail = &samples[frames / 2..];
        let rms = (tail.iter().map(|value| f64::from(*value) * f64::from(*value)).sum::<f64>() / tail.len() as f64).sqrt();
        20.0 * (rms / (0.5 / 2_f64.sqrt())).log10()
    }

    fn check_against_cookbook(filter: FilterSpec) {
        for hz in [30.0, 60.0, 100.0, 250.0, 700.0, 1_500.0, 3_000.0, 6_000.0, 12_000.0, 18_000.0] {
            let measured = sine_gain_db(&[filter], hz);
            let expected = cookbook_magnitude_db(filter, f64::from(hz), f64::from(RATE));
            let tolerance = if expected < -30.0 { 1.5 } else { 0.1 };
            assert!(
                (measured - expected).abs() < tolerance,
                "{filter:?} at {hz} Hz: measured {measured:.3} dB, cookbook {expected:.3} dB"
            );
        }
    }

    #[test]
    fn bell_matches_the_cookbook_and_hits_its_gain_at_center() {
        let filter = spec(FilterKind::Bell, 2_400.0, -1.4, 1.0);
        check_against_cookbook(filter);
        assert!((sine_gain_db(&[filter], 2_400.0) + 1.4).abs() < 0.05);
        assert!(sine_gain_db(&[filter], 100.0).abs() < 0.05);
        let boost = spec(FilterKind::Bell, 82.0, 3.0, 1.2);
        check_against_cookbook(boost);
        assert!((sine_gain_db(&[boost], 82.0) - 3.0).abs() < 0.05);
    }

    #[test]
    fn high_pass_and_low_pass_match_the_cookbook() {
        let hpf = spec(FilterKind::HighPass, 68.0, 0.0, 0.707);
        check_against_cookbook(hpf);
        assert!((sine_gain_db(&[hpf], 68.0) + 3.01).abs() < 0.1);
        assert!(sine_gain_db(&[hpf], 30.0) < -12.0);
        assert!(sine_gain_db(&[hpf], 1_000.0).abs() < 0.05);
        let lpf = spec(FilterKind::LowPass, 9_000.0, 0.0, 0.707);
        check_against_cookbook(lpf);
        assert!((sine_gain_db(&[lpf], 9_000.0) + 3.01).abs() < 0.1);
        assert!(sine_gain_db(&[lpf], 200.0).abs() < 0.05);
    }

    #[test]
    fn shelves_match_the_cookbook() {
        let low = spec(FilterKind::LowShelf, 150.0, -3.0, 0.707);
        check_against_cookbook(low);
        assert!((sine_gain_db(&[low], 30.0) + 3.0).abs() < 0.15);
        assert!(sine_gain_db(&[low], 5_000.0).abs() < 0.05);
        let high = spec(FilterKind::HighShelf, 8_000.0, 2.0, 0.707);
        check_against_cookbook(high);
        assert!((sine_gain_db(&[high], 18_000.0) - 2.0).abs() < 0.2);
        assert!(sine_gain_db(&[high], 300.0).abs() < 0.05);
    }

    #[test]
    fn multiple_filters_add_in_decibels() {
        let filters = [
            spec(FilterKind::Bell, 2_400.0, -1.4, 1.0),
            spec(FilterKind::Bell, 1_800.0, -1.0, 1.0),
            spec(FilterKind::HighPass, 60.0, 0.0, 0.707),
        ];
        for hz in [100.0_f32, 1_000.0, 2_000.0, 5_000.0] {
            let expected: f64 = filters
                .iter()
                .map(|filter| cookbook_magnitude_db(*filter, f64::from(hz), f64::from(RATE)))
                .sum();
            let measured = sine_gain_db(&filters, hz);
            assert!((measured - expected).abs() < 0.1, "{hz} Hz {measured} vs {expected}");
        }
    }

    #[test]
    fn every_legal_filter_is_stable_and_finite() {
        let kinds = [
            FilterKind::HighPass,
            FilterKind::LowPass,
            FilterKind::Bell,
            FilterKind::LowShelf,
            FilterKind::HighShelf,
        ];
        let mut noise = 0x1234_5678_u32;
        let input: Vec<f32> = (0..9_600)
            .map(|_| {
                noise ^= noise << 13;
                noise ^= noise >> 17;
                noise ^= noise << 5;
                (noise as f32 / u32::MAX as f32) * 2.0 - 1.0
            })
            .collect();
        for kind in kinds {
            for frequency_hz in [20.0_f32, 45.0, 120.0, 900.0, 4_000.0, 12_000.0, 20_000.0] {
                for gain_db in [-18.0_f32, -6.0, 0.0, 4.0, 12.0] {
                    for q in [0.1_f32, 0.4, 0.707, 2.0, 4.0, 10.0] {
                        let filter = spec(kind, frequency_hz, gain_db, q);
                        let coefs = SvfCoefs::design(filter, RATE);
                        assert!(coefs.g > 0.0 && coefs.k > 0.0, "{filter:?} {coefs:?}");
                        let mut samples = input.clone();
                        EqChain::new(&[filter], RATE).process_interleaved(&mut samples, 1);
                        let peak = samples.iter().fold(0.0_f32, |max, value| max.max(value.abs()));
                        assert!(samples.iter().all(|value| value.is_finite()), "{filter:?} produced NaN");
                        // Twelve dB of boost at Q 10 rings, but a unit-bounded input cannot run away.
                        assert!(peak < 40.0, "{filter:?} ran away to {peak}");
                    }
                }
            }
        }
        let broken = spec(FilterKind::Bell, f32::NAN, -3.0, 1.0);
        assert!(SvfCoefs::design(broken, RATE).is_identity());
    }

    #[test]
    fn bypassed_band_is_bit_exact() {
        let mut runtime = EqRuntime::new();
        let published = PublishedEq::empty();
        published.publish(&EqTable::empty());
        runtime.refresh(&published);
        assert!(!runtime.track_live(0));
        let mut sample = [0.25_f32, -0.5];
        runtime.process(0, 0, 2, &mut sample);
        assert_eq!(sample, [0.25, -0.5]);
    }

    /// Plays a sine through the runtime as the engine would, starting at `start_frame`.
    fn run(runtime: &mut EqRuntime, start_frame: u64, frames: usize, hz: f32) -> Vec<f32> {
        (0..frames)
            .map(|offset| {
                let frame = start_frame + offset as u64;
                let value = (2.0 * std::f32::consts::PI * hz * frame as f32 / RATE).sin() * 0.5;
                let mut sample = [value, value];
                if runtime.track_live(0) {
                    runtime.process(0, frame, 1, &mut sample);
                }
                sample[0]
            })
            .collect()
    }

    fn largest_step(samples: &[f32]) -> f32 {
        samples
            .windows(2)
            .map(|pair| (pair[1] - pair[0]).abs())
            .fold(0.0, f32::max)
    }

    fn rms_db(samples: &[f32]) -> f64 {
        let rms = (samples.iter().map(|value| f64::from(*value) * f64::from(*value)).sum::<f64>() / samples.len() as f64).sqrt();
        20.0 * (rms / (0.5 / 2_f64.sqrt())).log10()
    }

    #[test]
    fn a_parameter_update_ramps_instead_of_switching() {
        let mut runtime = EqRuntime::new();
        let published = PublishedEq::empty();
        let cut = [spec(FilterKind::Bell, 1_000.0, -6.0, 1.0)];
        published.publish(&EqTable::design(&[TrackEqInput {
            track_index: 0,
            filters: &cut,
            regions: &[],
        }]));
        runtime.refresh(&published);
        let before = run(&mut runtime, 0, 9_600, 1_000.0);
        assert!((rms_db(&before[4_800..]) + 6.0).abs() < 0.1, "first table applies at once");

        published.publish(&EqTable::empty());
        runtime.refresh(&published);
        let during = run(&mut runtime, 9_600, 4_800, 1_000.0);
        // A 1 kHz sine at 0.5 moves at most ~0.066 per sample. A hard switch would jump by the 6 dB difference.
        assert!(largest_step(&during) < 0.08, "step {}", largest_step(&during));
        assert!((rms_db(&during[2_400..]) - 0.0).abs() < 0.1, "bypassed after the ramp");
        assert!(!runtime.track_live(0) || runtime.tracks[0].slots.iter().all(|slot| !slot.active));
    }

    #[test]
    fn a_section_band_fades_in_at_its_boundary_and_out_after_it() {
        let mut runtime = EqRuntime::new();
        let published = PublishedEq::empty();
        let section = [spec(FilterKind::Bell, 1_800.0, -6.0, 1.0)];
        let regions = [(24_000_u64, 48_000_u64, &section[..])];
        published.publish(&EqTable::design(&[TrackEqInput {
            track_index: 0,
            filters: &[],
            regions: &regions,
        }]));
        runtime.refresh(&published);
        let audio = run(&mut runtime, 0, 72_000, 1_800.0);
        assert!(rms_db(&audio[12_000..23_000]).abs() < 0.05, "no EQ before the section");
        assert!((rms_db(&audio[30_000..47_000]) + 6.0).abs() < 0.1, "section band inside");
        assert!(rms_db(&audio[54_000..71_000]).abs() < 0.1, "released after the section");
        let entry = &audio[23_900..24_000 + EQ_RAMP_FRAMES as usize + 100];
        let exit = &audio[47_900..48_000 + EQ_RAMP_FRAMES as usize + 100];
        assert!(largest_step(entry) < 0.125, "entry step {}", largest_step(entry));
        assert!(largest_step(exit) < 0.125, "exit step {}", largest_step(exit));
        // Halfway through the entry ramp the cut is partial: neither switched off nor fully on.
        let mid = rms_db(&audio[24_000 + 600..24_000 + 840]);
        assert!(mid < -0.5 && mid > -5.5, "mid-ramp level {mid}");
    }

    #[test]
    fn moving_between_two_sections_retargets_the_same_band() {
        let mut runtime = EqRuntime::new();
        let published = PublishedEq::empty();
        let first = [spec(FilterKind::Bell, 2_000.0, -3.0, 1.0)];
        let second = [spec(FilterKind::Bell, 2_000.0, -1.0, 1.0)];
        let regions = [(0_u64, 24_000_u64, &first[..]), (24_000, 48_000, &second[..])];
        published.publish(&EqTable::design(&[TrackEqInput {
            track_index: 0,
            filters: &[],
            regions: &regions,
        }]));
        runtime.refresh(&published);
        let audio = run(&mut runtime, 0, 48_000, 2_000.0);
        assert!((rms_db(&audio[12_000..23_000]) + 3.0).abs() < 0.1);
        assert!((rms_db(&audio[30_000..47_000]) + 1.0).abs() < 0.1);
        assert!(largest_step(&audio[23_000..27_000]) < 0.14);
    }

    #[test]
    fn a_seek_into_a_section_picks_up_its_bands() {
        let mut runtime = EqRuntime::new();
        let published = PublishedEq::empty();
        let section = [spec(FilterKind::Bell, 1_000.0, -6.0, 1.0)];
        let regions = [(96_000_u64, 192_000_u64, &section[..])];
        published.publish(&EqTable::design(&[TrackEqInput {
            track_index: 0,
            filters: &[],
            regions: &regions,
        }]));
        runtime.refresh(&published);
        run(&mut runtime, 0, 4_800, 1_000.0);
        let after_seek = run(&mut runtime, 120_000, 24_000, 1_000.0);
        assert!((rms_db(&after_seek[4_800..]) + 6.0).abs() < 0.1);
    }

    #[test]
    fn published_table_round_trips() {
        let published = PublishedEq::empty();
        let filters = [spec(FilterKind::HighShelf, 6_000.0, -2.0, 0.707)];
        let section = [spec(FilterKind::Bell, 300.0, -1.5, 0.9)];
        let regions = [(10_u64, 20_u64, &section[..])];
        let designed = EqTable::design(&[TrackEqInput {
            track_index: 3,
            filters: &filters,
            regions: &regions,
        }]);
        published.publish(&designed);
        let mut table = Table::empty();
        published.load_into(&mut table);
        assert_eq!(table.region_count, 1);
        assert_eq!(table.used, 1 << 3);
        assert_eq!(table.tracks[3][0], SvfCoefs::design(filters[0], RATE));
        assert_eq!(table.regions[0].bands[0], SvfCoefs::design(section[0], RATE));
        assert_eq!((table.regions[0].start, table.regions[0].end, table.regions[0].track), (10, 20, 3));
    }
}
