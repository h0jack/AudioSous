use std::path::Path;

use crate::source::SourceReader;

const FINE_FRAMES: usize = 256;
const MAX_PEAKS: usize = 2_000_000;
pub const MEASURE_CANCELLED: &str = "cancelled";

/// Min/max peaks in the same `ASPK` cache the timeline already reads.
/// Every channel of a frame contributes to that frame's extremes.
pub fn measure_peaks(
    path: &Path,
    file_size: u64,
    cancel: &dyn Fn() -> bool,
    progress: &mut dyn FnMut(f32),
) -> Result<Vec<u8>, String> {
    let mut reader = SourceReader::open(path)?;
    let format = reader.format().clone();
    if format.frames == 0 {
        return Err(format!("{} has no audio samples.", path.display()));
    }
    if format.bits_per_sample == 64 && !format.float {
        return Err(format!(
            "{} uses 64-bit integer audio, which cannot be measured yet.",
            path.display()
        ));
    }
    let channels = format.channels as usize;
    let width = (format.bits_per_sample / 8) as usize;
    let block = channels * width;
    if block == 0 {
        return Err(format!(
            "{} has an unsupported sample layout.",
            path.display()
        ));
    }
    let total = format.frames;
    let frames_per_read = (1024 * 1024 / block).max(1);
    let mut raw = vec![0_u8; frames_per_read * block];
    let mut mins = Vec::new();
    let mut maxs = Vec::new();
    let mut bucket_min = i16::MAX;
    let mut bucket_max = i16::MIN;
    let mut frames_in_bucket = 0_usize;
    let mut done = 0_u64;

    while done < total {
        if cancel() {
            return Err(MEASURE_CANCELLED.into());
        }
        let want = ((total - done) as usize).min(frames_per_read);
        read_exact(&mut reader, &mut raw[..want * block])?;
        for frame in 0..want {
            let base = frame * block;
            let mut sample_min = i16::MAX;
            let mut sample_max = i16::MIN;
            for channel in 0..channels {
                let offset = base + channel * width;
                let sample = peak_sample(
                    &raw[offset..offset + width],
                    format.bits_per_sample,
                    format.float,
                    format.little_endian,
                );
                sample_min = sample_min.min(sample);
                sample_max = sample_max.max(sample);
            }
            bucket_min = bucket_min.min(sample_min);
            bucket_max = bucket_max.max(sample_max);
            frames_in_bucket += 1;
            if frames_in_bucket == FINE_FRAMES {
                push_peak(&mut mins, &mut maxs, bucket_min, bucket_max)?;
                bucket_min = i16::MAX;
                bucket_max = i16::MIN;
                frames_in_bucket = 0;
            }
        }
        done += want as u64;
        progress((done as f32 / total as f32).clamp(0.0, 1.0));
    }
    if frames_in_bucket > 0 {
        push_peak(&mut mins, &mut maxs, bucket_min, bucket_max)?;
    }
    progress(1.0);
    let (mid_min, mid_max) = downsample(&mins, &maxs, 4);
    let (coarse_min, coarse_max) = downsample(&mins, &maxs, 16);
    encode_peaks(
        format.sample_rate,
        format.channels,
        format.bits_per_sample,
        file_size,
        total,
        &[
            (256, &mins, &maxs),
            (1024, &mid_min, &mid_max),
            (4096, &coarse_min, &coarse_max),
        ],
    )
}

fn push_peak(mins: &mut Vec<i16>, maxs: &mut Vec<i16>, min: i16, max: i16) -> Result<(), String> {
    if mins.len() >= MAX_PEAKS {
        return Err("This stem is too long to draw as a waveform.".into());
    }
    mins.push(min);
    maxs.push(max);
    Ok(())
}

fn downsample(mins: &[i16], maxs: &[i16], factor: usize) -> (Vec<i16>, Vec<i16>) {
    let count = mins.len().div_ceil(factor);
    let mut out_min = Vec::with_capacity(count);
    let mut out_max = Vec::with_capacity(count);
    for index in 0..count {
        let start = index * factor;
        let end = (start + factor).min(mins.len());
        let mut min = i16::MAX;
        let mut max = i16::MIN;
        for cursor in start..end {
            min = min.min(mins[cursor]);
            max = max.max(maxs[cursor]);
        }
        out_min.push(min);
        out_max.push(max);
    }
    (out_min, out_max)
}

fn read_exact(reader: &mut SourceReader, buf: &mut [u8]) -> Result<(), String> {
    let mut filled = 0;
    while filled < buf.len() {
        let read = reader.read(&mut buf[filled..])?;
        if read == 0 {
            return Err("The stem ended before all audio frames were read.".into());
        }
        filled += read;
    }
    Ok(())
}

fn peak_sample(bytes: &[u8], bits: u16, float_pcm: bool, little_endian: bool) -> i16 {
    if float_pcm {
        let value = if bits == 64 {
            let bits = if little_endian {
                u64::from_le_bytes(bytes.try_into().unwrap_or([0; 8]))
            } else {
                u64::from_be_bytes(bytes.try_into().unwrap_or([0; 8]))
            };
            f64::from_bits(bits)
        } else {
            let bits = if little_endian {
                u32::from_le_bytes(bytes.try_into().unwrap_or([0; 4]))
            } else {
                u32::from_be_bytes(bytes.try_into().unwrap_or([0; 4]))
            };
            f32::from_bits(bits) as f64
        };
        return float_to_i16(value);
    }
    if bits == 8 {
        return ((bytes[0] as i16) - 128) << 8;
    }
    if bits == 16 {
        return if little_endian {
            i16::from_le_bytes(bytes.try_into().unwrap_or([0; 2]))
        } else {
            i16::from_be_bytes(bytes.try_into().unwrap_or([0; 2]))
        };
    }
    if bits == 24 {
        let unsigned = if little_endian {
            bytes[0] as i32 | ((bytes[1] as i32) << 8) | ((bytes[2] as i32) << 16)
        } else {
            ((bytes[0] as i32) << 16) | ((bytes[1] as i32) << 8) | bytes[2] as i32
        };
        let signed = if unsigned & 0x800000 != 0 {
            unsigned - 0x1000000
        } else {
            unsigned
        };
        return (signed >> 8) as i16;
    }
    let sample = if little_endian {
        i32::from_le_bytes(bytes.try_into().unwrap_or([0; 4]))
    } else {
        i32::from_be_bytes(bytes.try_into().unwrap_or([0; 4]))
    };
    (sample >> 16) as i16
}

/// Matches JavaScript `Math.round` on the audible peak scale.
fn float_to_i16(value: f64) -> i16 {
    if !value.is_finite() {
        return 0;
    }
    let scaled = value.clamp(-1.0, 1.0) * 32_767.0;
    let rounded = (scaled + 0.5).floor();
    if rounded >= 32_767.0 {
        32_767
    } else if rounded <= -32_768.0 {
        -32_768
    } else {
        rounded as i16
    }
}

fn encode_peaks(
    sample_rate: u32,
    channels: u16,
    bits: u16,
    file_size: u64,
    frames: u64,
    levels: &[(u32, &[i16], &[i16])],
) -> Result<Vec<u8>, String> {
    let mut body = 36_usize;
    for (_, mins, maxs) in levels {
        if mins.len() != maxs.len() {
            return Err("Waveform peaks are incomplete.".into());
        }
        body += 8 + mins.len() * 4;
    }
    if body > 16 * 1024 * 1024 {
        return Err("Waveform cache is too large.".into());
    }
    let mut bytes = vec![0_u8; body];
    bytes[0..4].copy_from_slice(b"ASPK");
    bytes[4..8].copy_from_slice(&1_u32.to_le_bytes());
    bytes[8..12].copy_from_slice(&sample_rate.to_le_bytes());
    bytes[12..14].copy_from_slice(&channels.to_le_bytes());
    bytes[14..16].copy_from_slice(&bits.to_le_bytes());
    bytes[16..24].copy_from_slice(&file_size.to_le_bytes());
    bytes[24..32].copy_from_slice(&frames.to_le_bytes());
    bytes[32..34].copy_from_slice(&(levels.len() as u16).to_le_bytes());
    let mut cursor = 36;
    for (samples_per_peak, mins, maxs) in levels {
        bytes[cursor..cursor + 4].copy_from_slice(&samples_per_peak.to_le_bytes());
        bytes[cursor + 4..cursor + 8].copy_from_slice(&(mins.len() as u32).to_le_bytes());
        cursor += 8;
        for index in 0..mins.len() {
            bytes[cursor..cursor + 2].copy_from_slice(&mins[index].to_le_bytes());
            bytes[cursor + 2..cursor + 4].copy_from_slice(&maxs[index].to_le_bytes());
            cursor += 4;
        }
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write_pcm16(path: &Path, samples: &[i16]) {
        let data_bytes = (samples.len() * 2) as u32;
        let mut body = Vec::new();
        body.extend_from_slice(b"RIFF");
        body.extend_from_slice(&(36 + data_bytes).to_le_bytes());
        body.extend_from_slice(b"WAVE");
        body.extend_from_slice(b"fmt ");
        body.extend_from_slice(&16_u32.to_le_bytes());
        body.extend_from_slice(&1_u16.to_le_bytes());
        body.extend_from_slice(&1_u16.to_le_bytes());
        body.extend_from_slice(&48_000_u32.to_le_bytes());
        body.extend_from_slice(&96_000_u32.to_le_bytes());
        body.extend_from_slice(&2_u16.to_le_bytes());
        body.extend_from_slice(&16_u16.to_le_bytes());
        body.extend_from_slice(b"data");
        body.extend_from_slice(&data_bytes.to_le_bytes());
        for sample in samples {
            body.extend_from_slice(&sample.to_le_bytes());
        }
        fs::write(path, body).unwrap();
    }

    fn first_pair(bytes: &[u8]) -> (i16, i16) {
        let count = u32::from_le_bytes(bytes[40..44].try_into().unwrap()) as usize;
        assert!(count >= 1);
        let min = i16::from_le_bytes(bytes[44..46].try_into().unwrap());
        let max = i16::from_le_bytes(bytes[46..48].try_into().unwrap());
        (min, max)
    }

    #[test]
    fn folds_frames_into_the_same_minmax_buckets_as_the_timeline() {
        let dir = std::env::temp_dir().join(format!("audiosous-peaks-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("tone.wav");
        let mut samples = vec![1_000_i16; 300];
        samples[0] = 0;
        for sample in &mut samples[256..] {
            *sample = -2_000;
        }
        write_pcm16(&path, &samples);
        let size = fs::metadata(&path).unwrap().len();
        let bytes = measure_peaks(&path, size, &|| false, &mut |_| {}).unwrap();
        assert_eq!(&bytes[0..4], b"ASPK");
        assert_eq!(u64::from_le_bytes(bytes[24..32].try_into().unwrap()), 300);
        assert_eq!(first_pair(&bytes), (0, 1_000));
        let second_min = i16::from_le_bytes(bytes[48..50].try_into().unwrap());
        let second_max = i16::from_le_bytes(bytes[50..52].try_into().unwrap());
        assert_eq!((second_min, second_max), (-2_000, -2_000));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn float_full_scale_matches_javascript_rounding() {
        assert_eq!(float_to_i16(1.0), 32_767);
        assert_eq!(float_to_i16(-1.0), -32_767);
        assert_eq!(float_to_i16(f64::NAN), 0);
        let dir =
            std::env::temp_dir().join(format!("audiosous-peaks-float-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("float.wav");
        let mut samples = vec![1.0_f32; 256];
        samples.push(-1.0);
        write_f32(&path, &samples);
        let size = fs::metadata(&path).unwrap().len();
        let bytes = measure_peaks(&path, size, &|| false, &mut |_| {}).unwrap();
        assert_eq!(first_pair(&bytes), (32_767, 32_767));
        let second_min = i16::from_le_bytes(bytes[48..50].try_into().unwrap());
        let second_max = i16::from_le_bytes(bytes[50..52].try_into().unwrap());
        assert_eq!((second_min, second_max), (-32_767, -32_767));
        let cancelled = measure_peaks(&path, size, &|| true, &mut |_| {}).unwrap_err();
        assert_eq!(cancelled, MEASURE_CANCELLED);
        let _ = fs::remove_dir_all(&dir);
    }

    fn write_f32(path: &Path, samples: &[f32]) {
        let data_bytes = (samples.len() * 4) as u32;
        let mut body = Vec::new();
        body.extend_from_slice(b"RIFF");
        body.extend_from_slice(&(36 + data_bytes).to_le_bytes());
        body.extend_from_slice(b"WAVE");
        body.extend_from_slice(b"fmt ");
        body.extend_from_slice(&16_u32.to_le_bytes());
        body.extend_from_slice(&3_u16.to_le_bytes());
        body.extend_from_slice(&1_u16.to_le_bytes());
        body.extend_from_slice(&48_000_u32.to_le_bytes());
        body.extend_from_slice(&192_000_u32.to_le_bytes());
        body.extend_from_slice(&4_u16.to_le_bytes());
        body.extend_from_slice(&32_u16.to_le_bytes());
        body.extend_from_slice(b"data");
        body.extend_from_slice(&data_bytes.to_le_bytes());
        for sample in samples {
            body.extend_from_slice(&sample.to_le_bytes());
        }
        fs::write(path, body).unwrap();
    }
}
