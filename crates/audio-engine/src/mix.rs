const MAX_TRACKS: usize = 64;
#[cfg(test)]
const RAMP_SECONDS: f32 = 0.01;

#[derive(Clone, Copy)]
pub struct TrackMix {
    pub gain: f32,
    pub pan: f32,
    pub mute: bool,
    pub solo: bool,
    pub channels: u16,
    pub active: bool,
}

impl Default for TrackMix {
    fn default() -> Self {
        Self {
            gain: 1.0,
            pan: 0.0,
            mute: false,
            solo: false,
            channels: 2,
            active: false,
        }
    }
}

#[derive(Clone, Copy)]
pub struct MixSnapshot {
    pub tracks: [TrackMix; MAX_TRACKS],
    pub count: usize,
    pub any_solo: bool,
}

impl MixSnapshot {
    pub fn silent() -> Self {
        Self {
            tracks: [TrackMix::default(); MAX_TRACKS],
            count: 0,
            any_solo: false,
        }
    }
}

pub fn linear_gain(db: f32) -> f32 {
    if db <= -96.0 {
        0.0
    } else {
        10_f32.powf(db / 20.0)
    }
}

pub fn equal_power_pan(pan: f32) -> (f32, f32) {
    let position = ((pan.clamp(-1.0, 1.0) + 1.0) * 0.5).clamp(0.0, 1.0);
    ((1.0 - position).sqrt(), position.sqrt())
}

#[cfg(test)]
pub trait FramePull {
    fn pull(&mut self, dst: &mut [f32]) -> bool;
    fn channels(&self) -> usize;
    fn eof(&self) -> bool;
}

#[cfg(test)]
pub struct SlicePull<'a> {
    pub samples: &'a [f32],
    pub cursor: usize,
    pub channel_count: usize,
    pub ended: bool,
}

#[cfg(test)]
impl FramePull for SlicePull<'_> {
    fn pull(&mut self, dst: &mut [f32]) -> bool {
        let channels = self.channel_count;
        if self.cursor + channels > self.samples.len() {
            return false;
        }
        dst[..channels].copy_from_slice(&self.samples[self.cursor..self.cursor + channels]);
        self.cursor += channels;
        true
    }

    fn channels(&self) -> usize {
        self.channel_count
    }

    fn eof(&self) -> bool {
        self.ended
    }
}

/// Mixes already-buffered frames into an interleaved stereo buffer.
/// Missing frames become silence. A dry track that has not ended counts as one underrun.
#[cfg(test)]
pub fn mix_frames(
    pulls: &mut [&mut dyn FramePull],
    mix: &MixSnapshot,
    gains: &mut [f32],
    sample_rate: f32,
    out: &mut [f32],
) -> (u64, Option<usize>) {
    let frames = out.len() / 2;
    let step = 1.0 / (RAMP_SECONDS * sample_rate.max(1.0));
    let mut underruns = 0_u64;
    let mut underrun_track = None;
    let mut counted = [false; MAX_TRACKS];
    for frame in 0..frames {
        let mut left = 0.0;
        let mut right = 0.0;
        for (index, pull) in pulls.iter_mut().enumerate() {
            if index >= mix.count || index >= gains.len() {
                break;
            }
            let track = mix.tracks[index];
            if !track.active {
                continue;
            }
            let audible = !track.mute && (!mix.any_solo || track.solo);
            let target = if audible { track.gain } else { 0.0 };
            let delta = target - gains[index];
            gains[index] += delta.clamp(-step, step);
            let channels = pull.channels().clamp(1, 2);
            let mut sample = [0.0_f32; 2];
            let got = pull.pull(&mut sample[..channels]);
            if !got {
                if !pull.eof() && !counted[index] {
                    counted[index] = true;
                    underruns += 1;
                    if underrun_track.is_none() {
                        underrun_track = Some(index);
                    }
                }
                continue;
            }
            let (pan_left, pan_right) = equal_power_pan(track.pan);
            let gain = gains[index];
            if channels == 1 {
                left += sample[0] * gain * pan_left;
                right += sample[0] * gain * pan_right;
            } else {
                left += sample[0] * gain * pan_left;
                right += sample[1] * gain * pan_right;
            }
        }
        out[frame * 2] = left;
        out[frame * 2 + 1] = right;
    }
    (underruns, underrun_track)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mono(samples: &'static [f32], gain: f32, pan: f32) -> (SlicePull<'static>, TrackMix) {
        (
            SlicePull {
                samples,
                cursor: 0,
                channel_count: 1,
                ended: true,
            },
            TrackMix {
                gain,
                pan,
                mute: false,
                solo: false,
                channels: 1,
                active: true,
            },
        )
    }

    #[test]
    fn center_pan_is_equal_power_and_mute_is_silent() {
        let (mut pull, track) = mono(&[1.0], 1.0, 0.0);
        let mut mix = MixSnapshot::silent();
        mix.count = 1;
        mix.tracks[0] = track;
        let mut gains = [1.0];
        let mut out = [0.0; 2];
        mix_frames(&mut [&mut pull], &mix, &mut gains, 48_000.0, &mut out);
        let expected = (0.5_f32).sqrt();
        assert!((out[0] - expected).abs() < 0.0001);
        assert!((out[1] - expected).abs() < 0.0001);

        let (mut muted_pull, mut muted) = mono(&[1.0], 1.0, 0.0);
        muted.mute = true;
        mix.tracks[0] = muted;
        gains[0] = 0.0;
        out = [0.0; 2];
        mix_frames(&mut [&mut muted_pull], &mix, &mut gains, 48_000.0, &mut out);
        assert_eq!(out, [0.0, 0.0]);
    }

    #[test]
    fn solo_silences_the_other_track_and_a_dry_ring_counts_an_underrun() {
        let (mut kick, mut kick_mix) = mono(&[1.0], 1.0, -1.0);
        kick_mix.solo = true;
        let (mut bass, bass_mix) = mono(&[1.0], 1.0, 1.0);
        let mut mix = MixSnapshot::silent();
        mix.count = 2;
        mix.any_solo = true;
        mix.tracks[0] = kick_mix;
        mix.tracks[1] = bass_mix;
        let mut gains = [1.0, 0.0];
        let mut out = [0.0; 2];
        mix_frames(
            &mut [&mut kick, &mut bass],
            &mix,
            &mut gains,
            48_000.0,
            &mut out,
        );
        assert!(out[0] > 0.9);
        assert!(out[1].abs() < 0.0001);

        let mut dry = SlicePull {
            samples: &[],
            cursor: 0,
            channel_count: 1,
            ended: false,
        };
        mix.any_solo = false;
        mix.tracks[0].solo = false;
        gains[0] = 1.0;
        let (underruns, track) = mix_frames(&mut [&mut dry], &mix, &mut gains, 48_000.0, &mut out);
        assert_eq!(underruns, 1);
        assert_eq!(track, Some(0));
        assert_eq!(out, [0.0, 0.0]);
    }

    #[test]
    fn gain_ramps_instead_of_jumping() {
        let (mut pull, track) = mono(&[1.0, 1.0, 1.0, 1.0], 1.0, -1.0);
        let mut mix = MixSnapshot::silent();
        mix.count = 1;
        mix.tracks[0] = track;
        let mut gains = [0.0];
        let mut out = [0.0; 8];
        mix_frames(&mut [&mut pull], &mix, &mut gains, 48_000.0, &mut out);
        assert!(out[0] > 0.0 && out[0] < 0.01);
        assert!(out[6] > out[0]);
        assert!(out[6] < 1.0);
    }
}
