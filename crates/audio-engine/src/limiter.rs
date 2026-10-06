//! The export's final safety limiter: offline, deterministic, true-peak aware. It is the only limiter in Audiosous
//! and runs only in the export's distribution stage, never in a mix plan.
//!
//! For every frame it reads the interpolated (true) peak, works out the gain that keeps it under the ceiling, holds
//! the lowest of those over a lookahead window, lets it recover with a smooth release, and averages it over the same
//! window. The average of a window-minimum is never above the gain any peak inside the window needs, so the gain is
//! already down when a peak arrives, without a step. Audio is delayed by the lookahead plus the detector's latency
//! and `flush` returns the tail. The gain moves only where a peak needs it, so a mix that already fits is untouched.

use std::collections::VecDeque;

use crate::loudness::TruePeakDetector;

/// Lookahead and attack, ms.
pub const LIMITER_LOOKAHEAD_MS: f64 = 5.0;
/// Recovery time constant, ms. Long enough not to pump under normal amounts of limiting.
pub const LIMITER_RELEASE_MS: f64 = 150.0;

#[derive(Clone, Copy, Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LimiterStats {
    /// Largest gain reduction, dB.
    pub max_reduction_db: f64,
    /// Share of frames reduced by more than 1 dB and by more than 3 dB.
    pub share_over_1db: f64,
    pub share_over_3db: f64,
    /// Mean reduction over the frames it acted on, dB.
    pub mean_active_reduction_db: f64,
    /// Share of frames it reduced by more than 0.1 dB.
    pub active_share: f64,
}

pub struct TruePeakLimiter {
    ceiling: f32,
    channels: usize,
    lookahead: usize,
    release: f32,
    detector: TruePeakDetector,
    detector_latency: usize,
    /// Audio waiting for its gain, interleaved.
    delay: VecDeque<f32>,
    /// Required gain per frame not yet past the lookahead minimum.
    required: VecDeque<(u64, f32)>,
    /// Monotonic deque of (frame, gain) for the window minimum.
    minimum: VecDeque<(u64, f32)>,
    released: f32,
    /// Last `lookahead` released values and their sum, for the average.
    window: VecDeque<f32>,
    window_sum: f64,
    frames_in: u64,
    frames_out: u64,
    frames_detected: u64,
    stats_frames: u64,
    over_1: u64,
    over_3: u64,
    active: u64,
    active_sum: f64,
    max_reduction: f64,
    /// Virtual silent frames before the audio, so a peak in the first lookahead is limited in time too.
    lead_in: u64,
}

impl TruePeakLimiter {
    /// `ceiling_dbtp`: the highest true peak allowed out.
    pub fn new(rate: u32, channels: usize, ceiling_dbtp: f64) -> Self {
        let channels = channels.clamp(1, 2);
        let lookahead = ((LIMITER_LOOKAHEAD_MS * 0.001 * f64::from(rate)).round() as usize).max(1);
        let detector = TruePeakDetector::new(rate, channels);
        let detector_latency = detector.latency();
        let mut limiter = Self {
            ceiling: 10_f64.powf(ceiling_dbtp / 20.0) as f32,
            channels,
            lookahead,
            release: (1.0 - (-1.0 / (LIMITER_RELEASE_MS * 0.001 * f64::from(rate))).exp()) as f32,
            detector,
            detector_latency,
            delay: VecDeque::new(),
            required: VecDeque::new(),
            minimum: VecDeque::new(),
            released: 1.0,
            window: VecDeque::from(vec![1.0; lookahead]),
            window_sum: lookahead as f64,
            frames_in: 0,
            frames_out: 0,
            frames_detected: 0,
            stats_frames: 0,
            over_1: 0,
            over_3: 0,
            active: 0,
            active_sum: 0.0,
            max_reduction: 0.0,
            lead_in: 0,
        };
        let lead_in = lookahead - 1;
        let mut discard = Vec::new();
        limiter.process(&vec![0.0; lead_in * channels], &mut discard);
        limiter.lead_in = lead_in as u64;
        limiter
    }

    /// Frames of delay between input and output.
    pub fn latency(&self) -> usize {
        self.detector_latency
    }

    /// Limits interleaved `input`, appending whatever frames are ready to `out`.
    pub fn process(&mut self, input: &[f32], out: &mut Vec<f32>) {
        for frame in input.chunks_exact(self.channels) {
            self.delay.extend(frame.iter().copied());
            self.frames_in += 1;
            let peak = self.detector.push(frame);
            // The detector reports the frame `latency` frames back.
            if self.frames_in > self.detector_latency as u64 {
                self.detected(peak, out);
            }
        }
    }

    /// Pushes silence through so every input frame comes out.
    pub fn flush(&mut self, out: &mut Vec<f32>) {
        let silence = vec![0.0_f32; self.channels];
        let target = self.frames_in;
        while self.frames_out < target {
            let peak = self.detector.push(&silence);
            self.delay.extend(silence.iter().copied());
            self.detected(peak, out);
        }
        // Drop the silence that was pushed to drain the delay.
        self.delay.clear();
    }

    fn detected(&mut self, peak: f32, out: &mut Vec<f32>) {
        let frame = self.frames_detected;
        self.frames_detected += 1;
        let need = if peak > self.ceiling { self.ceiling / peak } else { 1.0 };
        while self.minimum.back().is_some_and(|(_, gain)| *gain >= need) {
            self.minimum.pop_back();
        }
        self.minimum.push_back((frame, need));
        self.required.push_back((frame, need));
        // The window minimum for frame k covers [k, k + lookahead − 1]: ready once that last frame is detected.
        if frame + 1 < self.lookahead as u64 {
            return;
        }
        let k = frame + 1 - self.lookahead as u64;
        while self.minimum.front().is_some_and(|(at, _)| *at < k) {
            self.minimum.pop_front();
        }
        let held = self.minimum.front().map(|(_, gain)| *gain).unwrap_or(1.0);
        self.required.pop_front();
        self.released = if held < self.released { held } else { self.released + (1.0 - self.released) * self.release }.min(held);
        // Recovered to within 0.005 dB is recovered: the gain returns to exactly unity between peaks.
        if self.released > 0.999_4 && held >= 1.0 {
            self.released = 1.0;
        }
        self.window_sum += f64::from(self.released) - f64::from(self.window.pop_front().unwrap_or(1.0));
        self.window.push_back(self.released);
        let gain = (self.window_sum / self.lookahead as f64).min(1.0) as f32;
        // The averaged gain belongs to frame k; that frame's audio is at the front of the delay line.
        let real = self.frames_out >= self.lead_in && self.frames_out < self.frames_in;
        for _ in 0..self.channels {
            let sample = self.delay.pop_front().unwrap_or(0.0);
            if real {
                out.push(sample * gain);
            }
        }
        if real {
            self.note(gain);
        }
        self.frames_out += 1;
    }

    fn note(&mut self, gain: f32) {
        self.stats_frames += 1;
        let reduction = -20.0 * f64::from(gain.max(1e-9)).log10();
        if reduction > 0.1 {
            self.active += 1;
            self.active_sum += reduction;
        }
        if reduction > 1.0 {
            self.over_1 += 1;
        }
        if reduction > 3.0 {
            self.over_3 += 1;
        }
        self.max_reduction = self.max_reduction.max(reduction);
    }

    pub fn stats(&self) -> LimiterStats {
        let frames = self.stats_frames.max(1) as f64;
        LimiterStats {
            max_reduction_db: self.max_reduction,
            share_over_1db: self.over_1 as f64 / frames,
            share_over_3db: self.over_3 as f64 / frames,
            mean_active_reduction_db: if self.active == 0 { 0.0 } else { self.active_sum / self.active as f64 },
            active_share: self.active as f64 / frames,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::loudness::LoudnessMeter;

    fn run(rate: u32, input: &[f32], ceiling: f64) -> (Vec<f32>, LimiterStats) {
        let mut limiter = TruePeakLimiter::new(rate, 2, ceiling);
        let mut out = Vec::new();
        for chunk in input.chunks(1_000) {
            limiter.process(chunk, &mut out);
        }
        limiter.flush(&mut out);
        (out, limiter.stats())
    }

    fn tone_with_hits(rate: u32, seconds: f64) -> Vec<f32> {
        let frames = (seconds * f64::from(rate)) as usize;
        let mut out = Vec::with_capacity(frames * 2);
        for frame in 0..frames {
            let t = frame as f64 / f64::from(rate);
            let base = 0.3 * (2.0 * std::f64::consts::PI * 220.0 * t).sin();
            // A sharp hit every half second, peaking near +4 dBFS.
            let local = t % 0.5;
            let hit = 1.3 * (-local / 0.01).exp() * (2.0 * std::f64::consts::PI * 3_000.0 * t).sin();
            let value = (base + hit) as f32;
            out.push(value);
            out.push(value * 0.9);
        }
        out
    }

    #[test]
    fn keeps_every_frame_and_the_timing() {
        let rate = 48_000;
        let input = tone_with_hits(rate, 2.0);
        let (out, _) = run(rate, &input, -1.0);
        assert_eq!(out.len(), input.len());
        // Away from the hits nothing changes and nothing moves in time.
        let at = (0.4 * rate as f64) as usize * 2;
        assert!((out[at] - input[at]).abs() < 1e-6, "{} vs {}", out[at], input[at]);
    }

    #[test]
    fn holds_the_true_peak_under_the_ceiling() {
        let rate = 48_000;
        let input = tone_with_hits(rate, 3.0);
        let (out, stats) = run(rate, &input, -1.0);
        let mut meter = LoudnessMeter::new(rate, 2);
        meter.push(&out);
        let report = meter.report();
        assert!(report.true_peak_dbtp <= -0.95, "true peak {}", report.true_peak_dbtp);
        assert!(stats.max_reduction_db > 3.0 && stats.max_reduction_db < 7.0, "{:?}", stats);
        assert!(stats.share_over_3db < 0.2, "{:?}", stats);
    }

    #[test]
    fn leaves_audio_that_fits_untouched() {
        let rate = 44_100;
        let input: Vec<f32> = tone_with_hits(rate, 1.0).iter().map(|value| value * 0.25).collect();
        let (out, stats) = run(rate, &input, -1.0);
        assert_eq!(stats.max_reduction_db, 0.0);
        assert!(out.iter().zip(input.iter()).all(|(a, b)| (a - b).abs() < 1e-7));
    }

    #[test]
    fn is_deterministic() {
        let input = tone_with_hits(48_000, 1.0);
        assert_eq!(run(48_000, &input, -1.0).0, run(48_000, &input, -1.0).0);
    }
}

