use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::Path;

#[derive(Debug, Clone)]
pub struct DecodedFormat {
    pub sample_rate: u32,
    pub channels: u16,
    pub playback_channels: u16,
    pub frames: u64,
    pub data_offset: u64,
    pub bits_per_sample: u16,
    pub float: bool,
    pub little_endian: bool,
}

pub struct SourceReader {
    file: BufReader<File>,
    format: DecodedFormat,
    block_align: usize,
}

impl SourceReader {
    pub fn open(path: &Path) -> Result<Self, String> {
        let file = File::open(path)
            .map_err(|error| format!("Could not open {}: {error}", path.display()))?;
        let mut reader = BufReader::with_capacity(1024 * 1024, file);
        let format = read_format(&mut reader, path)?;
        let block_align = format.channels as usize * (format.bits_per_sample as usize / 8);
        if block_align == 0 || format.playback_channels == 0 || format.playback_channels > 2 {
            return Err(format!("{} has no playable channels.", path.display()));
        }
        reader
            .seek(SeekFrom::Start(format.data_offset))
            .map_err(|error| error.to_string())?;
        Ok(Self {
            file: reader,
            format,
            block_align,
        })
    }

    pub fn format(&self) -> &DecodedFormat {
        &self.format
    }

    pub fn read(&mut self, buf: &mut [u8]) -> Result<usize, String> {
        self.file.read(buf).map_err(|error| error.to_string())
    }

    /// Fills planar playback channels. Returns frames actually read.
    pub fn read_planar(&mut self, frames: usize, out: &mut [Vec<f32>]) -> Result<usize, String> {
        if frames == 0 {
            return Ok(0);
        }
        let channels = self.format.playback_channels as usize;
        if out.len() < channels {
            return Err("Playback channel buffer is too small.".into());
        }
        let bytes = frames * self.block_align;
        let mut raw = vec![0_u8; bytes];
        let mut filled = 0;
        while filled < bytes {
            let read = self
                .file
                .read(&mut raw[filled..])
                .map_err(|error| error.to_string())?;
            if read == 0 {
                break;
            }
            filled += read;
        }
        let whole = filled / self.block_align;
        if whole == 0 {
            return Ok(0);
        }
        decode_block(
            &raw[..whole * self.block_align],
            self.format.channels as usize,
            channels,
            self.format.bits_per_sample,
            self.format.float,
            self.format.little_endian,
            out,
        )?;
        Ok(whole)
    }
}

fn read_format(reader: &mut BufReader<File>, path: &Path) -> Result<DecodedFormat, String> {
    let mut head = [0_u8; 12];
    reader
        .read_exact(&mut head)
        .map_err(|_| format!("{} is too small to be audio.", path.display()))?;
    let kind = &head[0..4];
    let form = &head[8..12];
    if kind == b"RIFF" && form == b"WAVE" {
        read_wav(reader, false, path)
    } else if kind == b"RF64" && form == b"WAVE" {
        read_wav(reader, true, path)
    } else if kind == b"FORM" && (form == b"AIFF" || form == b"AIFC") {
        read_aiff(reader, form == b"AIFC", path)
    } else {
        Err(format!("{} is not a WAV or AIFF stem.", path.display()))
    }
}

fn read_wav(
    reader: &mut BufReader<File>,
    rf64: bool,
    path: &Path,
) -> Result<DecodedFormat, String> {
    let mut sample_rate = None;
    let mut channels = None;
    let mut bits = None;
    let mut float_pcm = None;
    let mut data_offset = None;
    let mut data_bytes = None;
    let mut rf64_data = None;
    let file_len = reader
        .get_ref()
        .metadata()
        .map(|meta| meta.len())
        .unwrap_or(0);

    loop {
        let mut chunk = [0_u8; 8];
        if reader.read_exact(&mut chunk).is_err() {
            break;
        }
        let id = &chunk[0..4];
        let size = u32::from_le_bytes(chunk[4..8].try_into().unwrap()) as u64;
        let payload_at = reader
            .stream_position()
            .map_err(|error| error.to_string())?;
        if id == b"fmt " {
            let body_len = size.min(64) as usize;
            let mut body = vec![0_u8; body_len];
            reader
                .read_exact(&mut body)
                .map_err(|_| format!("{} has a broken WAV format chunk.", path.display()))?;
            let parsed = parse_fmt(&body).ok_or_else(|| {
                format!("{} is not uncompressed PCM or float WAV.", path.display())
            })?;
            sample_rate = Some(parsed.0);
            channels = Some(parsed.1);
            bits = Some(parsed.2);
            float_pcm = Some(parsed.3);
            skip_unread(reader, size, body_len as u64)?;
        } else if id == b"ds64" && rf64 {
            let mut body = [0_u8; 28];
            reader
                .read_exact(&mut body)
                .map_err(|_| format!("{} has a broken RF64 header.", path.display()))?;
            rf64_data = Some(u64::from_le_bytes(body[8..16].try_into().unwrap()));
            skip_unread(reader, size, 28)?;
        } else if id == b"data" {
            data_offset = Some(payload_at);
            if size == 0xffff_ffff && rf64_data.is_some() {
                data_bytes = rf64_data;
            } else {
                data_bytes = Some(size);
            }
            break;
        } else {
            skip_unread(reader, size, 0)?;
        }
    }

    let sample_rate =
        sample_rate.ok_or_else(|| format!("{} is missing a WAV format chunk.", path.display()))?;
    let channels =
        channels.ok_or_else(|| format!("{} is missing a WAV format chunk.", path.display()))?;
    let bits = bits.ok_or_else(|| format!("{} is missing a WAV format chunk.", path.display()))?;
    let float_pcm = float_pcm.unwrap_or(false);
    let data_offset =
        data_offset.ok_or_else(|| format!("{} is missing audio data.", path.display()))?;
    let declared = data_bytes.unwrap_or(0);
    let available = file_len.saturating_sub(data_offset);
    let bytes = declared.min(available);
    let block = channels as u64 * (bits as u64 / 8);
    if sample_rate == 0 || channels == 0 || block == 0 {
        return Err(format!("{} has an invalid WAV format.", path.display()));
    }
    finish_format(
        sample_rate,
        channels,
        bits,
        float_pcm,
        true,
        data_offset,
        bytes / block,
    )
}

fn parse_fmt(body: &[u8]) -> Option<(u32, u16, u16, bool)> {
    if body.len() < 16 {
        return None;
    }
    let tag = u16::from_le_bytes(body[0..2].try_into().ok()?);
    let channels = u16::from_le_bytes(body[2..4].try_into().ok()?);
    let sample_rate = u32::from_le_bytes(body[4..8].try_into().ok()?);
    let bits = u16::from_le_bytes(body[14..16].try_into().ok()?);
    let (format_tag, bit_depth) = if tag == 0xfffe {
        if body.len() < 40 {
            return None;
        }
        let valid = u16::from_le_bytes(body[18..20].try_into().ok()?);
        let sub = u16::from_le_bytes(body[24..26].try_into().ok()?);
        (sub, if valid > 0 { valid } else { bits })
    } else {
        (tag, bits)
    };
    if format_tag != 1 && format_tag != 3 {
        return None;
    }
    Some((sample_rate, channels, bit_depth, format_tag == 3))
}

fn read_aiff(
    reader: &mut BufReader<File>,
    compressed: bool,
    path: &Path,
) -> Result<DecodedFormat, String> {
    let mut channels = None;
    let mut sample_rate = None;
    let mut bits = None;
    let mut frames = None;
    let mut little_endian = false;
    let mut float_pcm = false;
    let mut data_offset = None;
    let file_len = reader
        .get_ref()
        .metadata()
        .map(|meta| meta.len())
        .unwrap_or(0);

    loop {
        let mut chunk = [0_u8; 8];
        if reader.read_exact(&mut chunk).is_err() {
            break;
        }
        let id = &chunk[0..4];
        let size = u32::from_be_bytes(chunk[4..8].try_into().unwrap()) as u64;
        if id == b"COMM" {
            let body_len = size.min(64) as usize;
            if body_len < 18 {
                return Err(format!(
                    "{} has a broken AIFF common chunk.",
                    path.display()
                ));
            }
            let mut body = vec![0_u8; body_len];
            reader
                .read_exact(&mut body)
                .map_err(|_| format!("{} has a broken AIFF common chunk.", path.display()))?;
            channels = Some(i16::from_be_bytes(body[0..2].try_into().unwrap()) as u16);
            frames = Some(u32::from_be_bytes(body[2..6].try_into().unwrap()) as u64);
            bits = Some(i16::from_be_bytes(body[6..8].try_into().unwrap()) as u16);
            sample_rate = Some(decode_extended80(&body[8..18]).round() as u32);
            if compressed && body.len() >= 22 {
                let compression = std::str::from_utf8(&body[18..22])
                    .unwrap_or("")
                    .to_ascii_lowercase();
                little_endian = compression == "sowt";
                float_pcm = compression == "fl32" || compression == "fl64";
                let allowed = [
                    "none", "sowt", "twos", "raw ", "in24", "in32", "fl32", "fl64",
                ];
                if !allowed.contains(&compression.as_str()) {
                    return Err(format!(
                        "{} uses {compression} AIFF, which is not supported.",
                        path.display()
                    ));
                }
            }
            skip_unread(reader, size, body_len as u64)?;
        } else if id == b"SSND" {
            let mut sound = [0_u8; 8];
            reader
                .read_exact(&mut sound)
                .map_err(|_| format!("{} has a broken AIFF sound chunk.", path.display()))?;
            let sound_offset = u32::from_be_bytes(sound[0..4].try_into().unwrap()) as u64;
            let payload = reader
                .stream_position()
                .map_err(|error| error.to_string())?;
            data_offset = Some(payload + sound_offset);
            break;
        } else {
            skip_unread(reader, size, 0)?;
        }
    }

    let channels =
        channels.ok_or_else(|| format!("{} is missing an AIFF common chunk.", path.display()))?;
    let sample_rate = sample_rate
        .ok_or_else(|| format!("{} is missing an AIFF common chunk.", path.display()))?;
    let bits = bits.filter(|value| *value > 0).unwrap_or(16);
    let frames = frames.unwrap_or(0);
    let data_offset =
        data_offset.ok_or_else(|| format!("{} is missing audio data.", path.display()))?;
    let bytes_per = ((bits + 7) / 8) as u64;
    let declared = frames
        .saturating_mul(channels as u64)
        .saturating_mul(bytes_per);
    let available = file_len.saturating_sub(data_offset);
    let bytes = declared.min(available);
    let block = channels as u64 * bytes_per;
    if sample_rate == 0 || block == 0 {
        return Err(format!("{} has an invalid AIFF format.", path.display()));
    }
    finish_format(
        sample_rate,
        channels,
        bytes_per as u16 * 8,
        float_pcm,
        little_endian,
        data_offset,
        bytes / block,
    )
}

fn finish_format(
    sample_rate: u32,
    channels: u16,
    bits: u16,
    float_pcm: bool,
    little_endian: bool,
    data_offset: u64,
    frames: u64,
) -> Result<DecodedFormat, String> {
    if !matches!(bits, 8 | 16 | 24 | 32 | 64) {
        return Err(format!(
            "{bits}-bit audio is not supported for playback proxies."
        ));
    }
    if float_pcm && bits != 32 && bits != 64 {
        return Err("Floating-point stems must be 32-bit or 64-bit.".into());
    }
    let playback_channels = channels.min(2);
    Ok(DecodedFormat {
        sample_rate,
        channels,
        playback_channels,
        frames,
        data_offset,
        bits_per_sample: bits,
        float: float_pcm,
        little_endian,
    })
}

fn skip_unread(reader: &mut BufReader<File>, size: u64, already: u64) -> Result<(), String> {
    let padded = size + (size % 2);
    let rest = padded.saturating_sub(already);
    if rest > 0 {
        reader
            .seek(SeekFrom::Current(rest as i64))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn decode_extended80(bytes: &[u8]) -> f64 {
    let exponent = (((bytes[0] & 0x7f) as u16) << 8) | bytes[1] as u16;
    let mut mantissa = 0_u64;
    for byte in &bytes[2..10] {
        mantissa = (mantissa << 8) | *byte as u64;
    }
    if exponent == 0 && mantissa == 0 {
        return 0.0;
    }
    let value = mantissa as f64 * 2_f64.powi(exponent as i32 - 16383 - 63);
    if bytes[0] & 0x80 != 0 {
        -value
    } else {
        value
    }
}

fn decode_block(
    raw: &[u8],
    source_channels: usize,
    playback_channels: usize,
    bits: u16,
    float_pcm: bool,
    little_endian: bool,
    out: &mut [Vec<f32>],
) -> Result<(), String> {
    let width = (bits / 8) as usize;
    let frames = raw.len() / (source_channels * width);
    for channel in 0..playback_channels {
        out[channel].clear();
        out[channel].reserve(frames);
    }
    for frame in 0..frames {
        for channel in 0..playback_channels {
            let offset = (frame * source_channels + channel) * width;
            out[channel].push(read_sample(
                &raw[offset..offset + width],
                bits,
                float_pcm,
                little_endian,
            ));
        }
    }
    Ok(())
}

fn read_sample(bytes: &[u8], bits: u16, float_pcm: bool, little_endian: bool) -> f32 {
    if float_pcm {
        let value = if bits == 64 {
            let bits = if little_endian {
                u64::from_le_bytes(bytes.try_into().unwrap_or([0; 8]))
            } else {
                u64::from_be_bytes(bytes.try_into().unwrap_or([0; 8]))
            };
            f64::from_bits(bits) as f32
        } else {
            let bits = if little_endian {
                u32::from_le_bytes(bytes.try_into().unwrap_or([0; 4]))
            } else {
                u32::from_be_bytes(bytes.try_into().unwrap_or([0; 4]))
            };
            f32::from_bits(bits)
        };
        return if value.is_finite() {
            value.clamp(-1.0, 1.0)
        } else {
            0.0
        };
    }
    if bits == 8 {
        return (bytes[0] as f32 - 128.0) / 128.0;
    }
    if bits == 16 {
        let sample = if little_endian {
            i16::from_le_bytes(bytes.try_into().unwrap_or([0; 2]))
        } else {
            i16::from_be_bytes(bytes.try_into().unwrap_or([0; 2]))
        };
        return sample as f32 / 32768.0;
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
        return signed as f32 / 8_388_608.0;
    }
    let sample = if little_endian {
        i32::from_le_bytes(bytes.try_into().unwrap_or([0; 4]))
    } else {
        i32::from_be_bytes(bytes.try_into().unwrap_or([0; 4]))
    };
    sample as f32 / 2_147_483_648.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    #[test]
    fn reads_a_192khz_float_wav_header() {
        let media =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../test-assets/Generated2/media");
        let Ok(entries) = fs::read_dir(&media) else {
            return;
        };
        let Some(path) = entries
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.path())
            .find(|path| path.extension().is_some())
        else {
            return;
        };
        let mut reader = SourceReader::open(&path).unwrap();
        let format = reader.format().clone();
        assert_eq!(format.sample_rate, 192_000);
        assert_eq!(format.channels, 2);
        assert!(format.float);
        let mut planar = vec![Vec::new(), Vec::new()];
        let frames = reader.read_planar(64, &mut planar).unwrap();
        assert_eq!(frames, 64);
        assert_eq!(planar[0].len(), 64);
    }
}
