//! Loudness and peak measurement for export (ITU-R BS.1770-4, EBU Tech 3341/3342).
//!
//! Integrated loudness: K-weighting (the BS.1770 shelf and high-pass, designed for the actual rate), 400 ms blocks
//! with 75% overlap, an absolute gate at −70 LUFS and a relative gate 10 LU under the gated mean. Loudness range:
//! 3 s short-term blocks every 100 ms, gated at −70 LUFS and 20 LU under their mean, 95th minus 10th percentile.
//! True peak: the signal interpolated to at least 176.4 kHz with a polyphase windowed sinc, as BS.1770 Annex 2
//! describes, so a peak between samples is seen. Everything is streaming; nothing holds the whole song.

const ABSOLUTE_GATE: f64 = -70.0;
const RELATIVE_GATE: f64 = -10.0;
const LRA_RELATIVE_GATE: f64 = -20.0;
const TAPS_PER_PHASE: usize = 16;

#[derive(Clone, Copy, Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoudnessReport {
    /// Integrated loudness, LUFS. −∞ (reported as −120) for silence.
    pub integrated_lufs: f64,
    /// Loudness range, LU.
    pub loudness_range_lu: f64,
    /// Largest sample, dBFS.
    pub sample_peak_dbfs: f64,
    /// Largest inter-sample peak, dBTP.
    pub true_peak_dbtp: f64,
    pub max_momentary_lufs: f64,
    pub max_short_term_lufs: f64,
    pub frames: u64,
    pub sample_rate: u32,
}

/// One biquad, transposed direct form II, in f64.
#[derive(Clone, Copy, Debug)]
struct Biquad {
    b: [f64; 3],
    a: [f64; 3],
    z: [f64; 2],
}

impl Biquad {
    #[inline(always)]
    fn tick(&mut self, x: f64) -> f64 {
        let y = self.b[0] * x + self.z[0];
        self.z[0] = self.b[1] * x - self.a[1] * y + self.z[1];
        self.z[1] = self.b[2] * x - self.a[2] * y;
        y
    }
}

/// The BS.1770 K-weighting pair (high shelf, then RLB high-pass), designed for `rate` the way libebur128 does.
fn k_weighting(rate: f64) -> [Biquad; 2] {
    let f0 = 1681.974_450_955_533;
    let gain = 3.999_843_853_973_347;
    let q = 0.707_175_236_955_419_6;
    let k = (std::f64::consts::PI * f0 / rate).tan();
    let vh = 10_f64.powf(gain / 20.0);
    let vb = vh.powf(0.499_666_774_154_541_6);
    let a0 = 1.0 + k / q + k * k;
    let shelf = Biquad { b: [(vh + vb * k / q + k * k) / a0, 2.0 * (k * k - vh) / a0, (vh - vb * k / q + k * k) / a0], a: [1.0, 2.0 * (k * k - 1.0) / a0, (1.0 - k / q + k * k) / a0], z: [0.0; 2] };
    let f0 = 38.135_470_876_024_44;
    let q = 0.500_327_037_323_877_3;
    let k = (std::f64::consts::PI * f0 / rate).tan();
    let a0 = 1.0 + k / q + k * k;
    let highpass = Biquad { b: [1.0, -2.0, 1.0], a: [1.0, 2.0 * (k * k - 1.0) / a0, (1.0 - k / q + k * k) / a0], z: [0.0; 2] };
    [shelf, highpass]
}

/// Oversampling for true peak: to at least 176.4 kHz, at most 4×.
pub fn true_peak_factor(rate: u32) -> usize {
    if rate >= 176_400 {
        1
    } else if rate >= 88_200 {
        2
    } else {
        4
    }
}

/// A polyphase interpolator that reports the largest absolute value between and at samples, per channel.
#[derive(Clone, Debug)]
pub struct TruePeakDetector {
    factor: usize,
    /// phases[p][t]: the filter for sub-sample position p/factor.
    phases: Vec<[f32; TAPS_PER_PHASE]>,
    history: Vec<[f32; TAPS_PER_PHASE]>,
    at: usize,
}

impl TruePeakDetector {
    pub fn new(rate: u32, channels: usize) -> Self {
        let factor = true_peak_factor(rate);
        let length = TAPS_PER_PHASE * factor;
        let center = (length as f64 - 1.0) / 2.0;
        let beta = 8.0;
        let mut phases = vec![[0.0_f32; TAPS_PER_PHASE]; factor];
        if factor == 1 {
            phases[0][TAPS_PER_PHASE / 2] = 1.0;
        } else {
            let cutoff = 0.98 / factor as f64;
            let mut taps = vec![0.0_f64; length];
            for (index, tap) in taps.iter_mut().enumerate() {
                let t = index as f64 - center;
                let sinc = if t.abs() < 1e-12 { 1.0 } else { (std::f64::consts::PI * cutoff * t).sin() / (std::f64::consts::PI * cutoff * t) };
                let ratio = (2.0 * index as f64 / (length as f64 - 1.0)) - 1.0;
                *tap = sinc * bessel_i0(beta * (1.0 - ratio * ratio).max(0.0).sqrt()) / bessel_i0(beta);
            }
            for (phase, row) in phases.iter_mut().enumerate() {
                let sum: f64 = (0..TAPS_PER_PHASE).map(|tap| taps[tap * factor + phase]).sum();
                for tap in 0..TAPS_PER_PHASE {
                    row[tap] = (taps[tap * factor + phase] / sum) as f32;
                }
            }
        }
        Self { factor, phases, history: vec![[0.0; TAPS_PER_PHASE]; channels], at: 0 }
    }

    pub fn factor(&self) -> usize {
        self.factor
    }

    /// Frames between a sample going in and the interpolated values around it being reported.
    pub fn latency(&self) -> usize {
        TAPS_PER_PHASE / 2
    }

    /// Pushes one frame and returns the largest |value| over every channel and sub-sample position of the frame
    /// `latency()` frames ago.
    #[inline]
    pub fn push(&mut self, frame: &[f32]) -> f32 {
        let at = self.at;
        self.at = (self.at + 1) % TAPS_PER_PHASE;
        let mut peak = 0.0_f32;
        for (channel, history) in self.history.iter_mut().enumerate() {
            history[at] = frame.get(channel).copied().unwrap_or(0.0);
            for phase in &self.phases {
                let mut sum = 0.0_f32;
                for (tap, coefficient) in phase.iter().enumerate() {
                    // Newest sample first.
                    sum += coefficient * history[(at + TAPS_PER_PHASE - tap) % TAPS_PER_PHASE];
                }
                peak = peak.max(sum.abs());
            }
        }
        peak
    }
}

fn bessel_i0(x: f64) -> f64 {
    let mut sum = 1.0;
    let mut term = 1.0;
    let half = x / 2.0;
    for k in 1..40 {
        term *= (half / k as f64) * (half / k as f64);
        sum += term;
        if term < 1e-12 * sum {
            break;
        }
    }
    sum
}

/// A streaming BS.1770 meter for interleaved stereo (or mono) audio.
pub struct LoudnessMeter {
    rate: u32,
    channels: usize,
    filters: Vec<[Biquad; 2]>,
    /// Mean square per 100 ms step, summed over channels.
    steps: Vec<f64>,
    step_frames: usize,
    step_sum: f64,
    step_count: usize,
    sample_peak: f32,
    true_peak: f32,
    detector: TruePeakDetector,
    frames: u64,
}

impl LoudnessMeter {
    pub fn new(rate: u32, channels: usize) -> Self {
        let channels = channels.clamp(1, 2);
        Self {
            rate,
            channels,
            filters: (0..channels).map(|_| k_weighting(f64::from(rate))).collect(),
            steps: Vec::new(),
            step_frames: (rate as usize / 10).max(1),
            step_sum: 0.0,
            step_count: 0,
            sample_peak: 0.0,
            true_peak: 0.0,
            detector: TruePeakDetector::new(rate, channels),
            frames: 0,
        }
    }

    pub fn push(&mut self, interleaved: &[f32]) {
        for frame in interleaved.chunks_exact(self.channels) {
            let mut energy = 0.0;
            for (channel, value) in frame.iter().enumerate() {
                self.sample_peak = self.sample_peak.max(value.abs());
                let [shelf, highpass] = &mut self.filters[channel];
                let weighted = highpass.tick(shelf.tick(f64::from(*value)));
                energy += weighted * weighted;
            }
            self.true_peak = self.true_peak.max(self.detector.push(frame));
            self.step_sum += energy;
            self.step_count += 1;
            if self.step_count == self.step_frames {
                self.steps.push(self.step_sum / self.step_frames as f64);
                self.step_sum = 0.0;
                self.step_count = 0;
            }
            self.frames += 1;
        }
    }

    pub fn report(&self) -> LoudnessReport {
        // Let the true-peak filter see past the last sample.
        let mut detector = self.detector.clone();
        let mut true_peak = self.true_peak;
        for _ in 0..detector.latency() {
            true_peak = true_peak.max(detector.push(&[0.0, 0.0][..self.channels]));
        }
        let momentary = windows(&self.steps, 4);
        let short_term = windows(&self.steps, 30);
        LoudnessReport {
            integrated_lufs: gated(&momentary, RELATIVE_GATE).map(lufs).unwrap_or(-120.0),
            loudness_range_lu: range(&short_term),
            sample_peak_dbfs: to_db(self.sample_peak),
            true_peak_dbtp: to_db(true_peak.max(self.sample_peak)),
            max_momentary_lufs: momentary.iter().copied().fold(f64::NEG_INFINITY, f64::max).max(1e-20).pipe(lufs),
            max_short_term_lufs: short_term.iter().copied().fold(f64::NEG_INFINITY, f64::max).max(1e-20).pipe(lufs),
            frames: self.frames,
            sample_rate: self.rate,
        }
    }
}

trait Pipe: Sized {
    fn pipe<T>(self, f: impl FnOnce(Self) -> T) -> T {
        f(self)
    }
}
impl Pipe for f64 {}

/// Mean power of every `length`-step window, hopping one 100 ms step.
fn windows(steps: &[f64], length: usize) -> Vec<f64> {
    if steps.len() < length {
        return if steps.is_empty() { Vec::new() } else { vec![steps.iter().sum::<f64>() / steps.len() as f64] };
    }
    let mut out = Vec::with_capacity(steps.len() - length + 1);
    let mut sum: f64 = steps[..length].iter().sum();
    out.push(sum / length as f64);
    for at in length..steps.len() {
        sum += steps[at] - steps[at - length];
        out.push(sum.max(0.0) / length as f64);
    }
    out
}

fn lufs(power: f64) -> f64 {
    -0.691 + 10.0 * power.max(1e-20).log10()
}

/// The mean power of the blocks over the absolute gate and `relative` LU under their own mean.
fn gated(blocks: &[f64], relative: f64) -> Option<f64> {
    let loud: Vec<f64> = blocks.iter().copied().filter(|power| lufs(*power) > ABSOLUTE_GATE).collect();
    if loud.is_empty() {
        return None;
    }
    let threshold = lufs(loud.iter().sum::<f64>() / loud.len() as f64) + relative;
    let kept: Vec<f64> = loud.into_iter().filter(|power| lufs(*power) > threshold).collect();
    if kept.is_empty() {
        return None;
    }
    Some(kept.iter().sum::<f64>() / kept.len() as f64)
}

fn range(short_term: &[f64]) -> f64 {
    let loud: Vec<f64> = short_term.iter().copied().filter(|power| lufs(*power) > ABSOLUTE_GATE).collect();
    if loud.len() < 2 {
        return 0.0;
    }
    let threshold = lufs(loud.iter().sum::<f64>() / loud.len() as f64) + LRA_RELATIVE_GATE;
    let mut levels: Vec<f64> = loud.into_iter().map(lufs).filter(|level| *level > threshold).collect();
    if levels.len() < 2 {
        return 0.0;
    }
    levels.sort_by(|left, right| left.partial_cmp(right).unwrap_or(std::cmp::Ordering::Equal));
    let at = |share: f64| levels[((levels.len() - 1) as f64 * share).round() as usize];
    at(0.95) - at(0.10)
}

pub fn to_db(linear: f32) -> f64 {
    if linear <= 0.0 {
        -120.0
    } else {
        (20.0 * f64::from(linear).log10()).max(-120.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(rate: u32, hz: f64, amplitude: f64, seconds: f64, phase: f64) -> Vec<f32> {
        let frames = (seconds * f64::from(rate)) as usize;
        let mut out = Vec::with_capacity(frames * 2);
        for frame in 0..frames {
            let value = (amplitude * (2.0 * std::f64::consts::PI * hz * frame as f64 / f64::from(rate) + phase).sin()) as f32;
            out.push(value);
            out.push(value);
        }
        out
    }

    fn measure(rate: u32, audio: &[f32]) -> LoudnessReport {
        let mut meter = LoudnessMeter::new(rate, 2);
        for chunk in audio.chunks(4_096 * 2) {
            meter.push(chunk);
        }
        meter.report()
    }

    /// EBU Tech 3341 test 1/2: a stereo 1 kHz sine at −23 dBFS reads −23 LUFS (at 48 and 44.1 kHz).
    #[test]
    fn a_reference_sine_reads_its_loudness() {
        for rate in [44_100, 48_000, 96_000] {
            let amplitude = 10_f64.powf(-23.0 / 20.0);
            let report = measure(rate, &sine(rate, 1_000.0, amplitude, 20.0, 0.0));
            assert!((report.integrated_lufs - -23.0).abs() < 0.1, "{rate}: {}", report.integrated_lufs);
            assert!((report.sample_peak_dbfs - -23.0).abs() < 0.01);
            assert!(report.loudness_range_lu < 0.1);
        }
    }

    /// EBU Tech 3341 test 3: −36 dBFS for 10 s, −23 for 60 s, −36 for 10 s reads −23 ± 0.1 (gating).
    #[test]
    fn gating_ignores_the_quiet_parts() {
        let rate = 48_000;
        let quiet = 10_f64.powf(-36.0 / 20.0);
        let loud = 10_f64.powf(-23.0 / 20.0);
        let mut audio = sine(rate, 1_000.0, quiet, 10.0, 0.0);
        audio.extend(sine(rate, 1_000.0, loud, 60.0, 0.0));
        audio.extend(sine(rate, 1_000.0, quiet, 10.0, 0.0));
        let report = measure(rate, &audio);
        assert!((report.integrated_lufs - -23.0).abs() < 0.1, "{}", report.integrated_lufs);
    }

    /// EBU Tech 3342: −20 then −30 LUFS for 20 s each reads 10 LU of range.
    #[test]
    fn loudness_range_reads_the_spread() {
        let rate = 48_000;
        let mut audio = sine(rate, 1_000.0, 10_f64.powf(-20.0 / 20.0), 20.0, 0.0);
        audio.extend(sine(rate, 1_000.0, 10_f64.powf(-30.0 / 20.0), 20.0, 0.0));
        let report = measure(rate, &audio);
        assert!((report.loudness_range_lu - 10.0).abs() < 0.2, "{}", report.loudness_range_lu);
    }

    /// A sine at a quarter of the rate sampled at ±45° never hits its crest: the sample peak is 3 dB under the true
    /// peak, which the oversampled detector sees.
    #[test]
    fn true_peak_sees_between_samples() {
        let rate = 48_000;
        let audio = sine(rate, 12_000.0, 1.0, 1.0, std::f64::consts::FRAC_PI_4);
        let report = measure(rate, &audio);
        assert!((report.sample_peak_dbfs - -3.01).abs() < 0.05, "{}", report.sample_peak_dbfs);
        assert!(report.true_peak_dbtp > -0.4 && report.true_peak_dbtp < 0.3, "{}", report.true_peak_dbtp);
    }

    #[test]
    fn silence_has_no_loudness() {
        let report = measure(48_000, &vec![0.0; 48_000 * 2]);
        assert_eq!(report.integrated_lufs, -120.0);
        assert_eq!(report.true_peak_dbtp, -120.0);
    }
}
