use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use rubato::{FftFixedIn, Resampler};

use crate::source::SourceReader;

pub const PLAYBACK_RATE: u32 = 48_000;
pub const PROXY_VERSION: u16 = 1;
/// rubato `FftFixedIn`, 8192-frame chunks, 2 sub-chunks. Offline quality, fast enough for 192 kHz stems.
pub const RESAMPLER_ID: u32 = 1;
pub const HEADER_LEN: u64 = 64;

const FLAG_F32_LE: u16 = 1;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProxyHeader {
    pub version: u16,
    pub sample_rate: u32,
    pub channels: u16,
    pub frames: u64,
    pub source_size: u64,
    pub source_modified_ns: u64,
    pub resampler_id: u32,
    pub data_offset: u32,
}

#[allow(dead_code)]
pub struct ProxyInfo {
    pub channels: u16,
    pub frames: u64,
    pub sample_rate: u32,
}

pub fn proxy_file_name(track_id: &str) -> Result<String, String> {
    if track_id.is_empty()
        || track_id.len() > 80
        || !track_id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
    {
        return Err("Track id is not valid for a playback proxy.".into());
    }
    Ok(format!("{track_id}.proxy"))
}

pub fn read_header(file: &mut File) -> Result<ProxyHeader, String> {
    let mut bytes = [0_u8; HEADER_LEN as usize];
    file.read_exact(&mut bytes)
        .map_err(|_| "Playback proxy header is unreadable.".to_string())?;
    parse_header(&bytes)
}

pub fn header_is_current(
    header: &ProxyHeader,
    channels: u16,
    source_size: u64,
    source_modified_ns: u64,
    file_len: u64,
) -> bool {
    header.version == PROXY_VERSION
        && header.sample_rate == PLAYBACK_RATE
        && header.channels == channels
        && header.resampler_id == RESAMPLER_ID
        && header.data_offset as u64 == HEADER_LEN
        && header.source_size == source_size
        && header.source_modified_ns == source_modified_ns
        && file_len == HEADER_LEN + header.frames * header.channels as u64 * 4
}

/// Builds `path` when the existing proxy does not match this source.
/// `progress` receives 0..1 while samples are converted.
pub fn ensure_proxy(
    source: &Path,
    proxy: &Path,
    source_size: u64,
    source_modified_ns: u64,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(f32),
) -> Result<ProxyInfo, String> {
    if cancel.load(Ordering::Relaxed) {
        return Err("Playback proxy build was cancelled.".into());
    }
    if let Some(info) = existing_proxy(source, proxy, source_size, source_modified_ns)? {
        progress(1.0);
        return Ok(info);
    }
    if let Some(parent) = proxy.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let reader = SourceReader::open(source)?;
    let format = reader.format().clone();
    let channels = format.playback_channels;
    write_proxy(
        reader,
        proxy,
        channels,
        source_size,
        source_modified_ns,
        cancel,
        progress,
    )?;
    existing_proxy(source, proxy, source_size, source_modified_ns)?
        .ok_or_else(|| "Playback proxy was written but could not be read back.".to_string())
}

fn existing_proxy(
    source: &Path,
    proxy: &Path,
    source_size: u64,
    source_modified_ns: u64,
) -> Result<Option<ProxyInfo>, String> {
    if !proxy.is_file() {
        return Ok(None);
    }
    let mut file = File::open(proxy).map_err(|error| error.to_string())?;
    let header = match read_header(&mut file) {
        Ok(header) => header,
        Err(_) => return Ok(None),
    };
    let file_len = file.metadata().map(|meta| meta.len()).unwrap_or(0);
    let source_channels = SourceReader::open(source)?.format().playback_channels;
    if !header_is_current(
        &header,
        source_channels,
        source_size,
        source_modified_ns,
        file_len,
    ) {
        return Ok(None);
    }
    Ok(Some(ProxyInfo {
        channels: header.channels,
        frames: header.frames,
        sample_rate: header.sample_rate,
    }))
}

fn write_proxy(
    mut reader: SourceReader,
    proxy: &Path,
    channels: u16,
    source_size: u64,
    source_modified_ns: u64,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(f32),
) -> Result<(), String> {
    let temporary = proxy.with_extension("partial");
    let mut file = File::create(&temporary).map_err(|error| error.to_string())?;
    file.write_all(&header_bytes(&ProxyHeader {
        version: PROXY_VERSION,
        sample_rate: PLAYBACK_RATE,
        channels,
        frames: 0,
        source_size,
        source_modified_ns,
        resampler_id: RESAMPLER_ID,
        data_offset: HEADER_LEN as u32,
    }))
    .map_err(|error| error.to_string())?;

    let input_rate = reader.format().sample_rate;
    let input_frames = reader.format().frames.max(1);
    let mut written = 0_u64;
    if input_rate == PLAYBACK_RATE {
        let mut planar = vec![Vec::new(); channels as usize];
        loop {
            let count = reader.read_planar(4096, &mut planar)?;
            if count == 0 {
                break;
            }
            if cancel.load(Ordering::Relaxed) {
                drop(file);
                let _ = fs::remove_file(&temporary);
                return Err("Playback proxy build was cancelled.".into());
            }
            write_interleaved(&mut file, &planar, count)?;
            written += count as u64;
            progress((written as f32 / input_frames as f32).clamp(0.0, 1.0));
        }
    } else {
        written = match resample_into(
            &mut reader,
            &mut file,
            channels,
            input_rate,
            cancel,
            progress,
        ) {
            Ok(frames) => frames,
            Err(error) => {
                drop(file);
                let _ = fs::remove_file(&temporary);
                return Err(error);
            }
        };
    }

    let header = header_bytes(&ProxyHeader {
        version: PROXY_VERSION,
        sample_rate: PLAYBACK_RATE,
        channels,
        frames: written,
        source_size,
        source_modified_ns,
        resampler_id: RESAMPLER_ID,
        data_offset: HEADER_LEN as u32,
    });
    file.seek(SeekFrom::Start(0))
        .map_err(|error| error.to_string())?;
    file.write_all(&header).map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    drop(file);
    fs::rename(&temporary, proxy).map_err(|error| error.to_string())?;
    progress(1.0);
    Ok(())
}

fn resample_into(
    reader: &mut SourceReader,
    file: &mut File,
    channels: u16,
    input_rate: u32,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(f32),
) -> Result<u64, String> {
    let channel_count = channels as usize;
    let mut resampler = FftFixedIn::<f32>::new(
        input_rate as usize,
        PLAYBACK_RATE as usize,
        8192,
        2,
        channel_count,
    )
    .map_err(|error| format!("Could not start the playback resampler: {error}"))?;
    let chunk = resampler.input_frames_next();
    let mut planar = vec![Vec::new(); channel_count];
    let mut output = resampler.output_buffer_allocate(true);
    let mut written = 0_u64;
    let total = reader.format().frames.max(1);
    let mut consumed = 0_u64;
    loop {
        let count = reader.read_planar(chunk, &mut planar)?;
        if count == 0 {
            break;
        }
        if cancel.load(Ordering::Relaxed) {
            return Err("Playback proxy build was cancelled.".into());
        }
        consumed += count as u64;
        let produced = if count < chunk {
            for channel in &mut planar {
                channel.truncate(count);
            }
            let (_used, produced) = resampler
                .process_partial_into_buffer(Some(&planar), &mut output, None)
                .map_err(|error| format!("Playback resample failed: {error}"))?;
            produced
        } else {
            let (_used, produced) = resampler
                .process_into_buffer(&planar, &mut output, None)
                .map_err(|error| format!("Playback resample failed: {error}"))?;
            produced
        };
        if produced > 0 {
            write_interleaved(file, &output, produced)?;
            written += produced as u64;
        }
        progress((consumed as f32 / total as f32).clamp(0.0, 0.99));
    }
    let mut delay = resampler.output_delay();
    while delay > 0 {
        let (_used, produced) = resampler
            .process_partial_into_buffer(None::<&[Vec<f32>]>, &mut output, None)
            .map_err(|error| format!("Playback resample failed: {error}"))?;
        if produced == 0 {
            break;
        }
        let keep = produced.min(delay);
        write_interleaved(file, &output, keep)?;
        written += keep as u64;
        delay = delay.saturating_sub(keep);
    }
    Ok(written)
}

fn write_interleaved(file: &mut File, channels: &[Vec<f32>], frames: usize) -> Result<(), String> {
    let width = channels.len();
    let mut bytes = vec![0_u8; frames * width * 4];
    for frame in 0..frames {
        for channel in 0..width {
            let sample = channels[channel].get(frame).copied().unwrap_or(0.0);
            let sample = if sample.is_finite() { sample } else { 0.0 };
            let encoded = sample.to_le_bytes();
            let offset = (frame * width + channel) * 4;
            bytes[offset..offset + 4].copy_from_slice(&encoded);
        }
    }
    file.write_all(&bytes).map_err(|error| error.to_string())
}

fn header_bytes(header: &ProxyHeader) -> [u8; HEADER_LEN as usize] {
    let mut bytes = [0_u8; HEADER_LEN as usize];
    bytes[0..4].copy_from_slice(b"ASPX");
    bytes[4..6].copy_from_slice(&header.version.to_le_bytes());
    bytes[6..8].copy_from_slice(&FLAG_F32_LE.to_le_bytes());
    bytes[8..12].copy_from_slice(&header.sample_rate.to_le_bytes());
    bytes[12..14].copy_from_slice(&header.channels.to_le_bytes());
    bytes[16..24].copy_from_slice(&header.frames.to_le_bytes());
    bytes[24..32].copy_from_slice(&header.source_size.to_le_bytes());
    bytes[32..40].copy_from_slice(&header.source_modified_ns.to_le_bytes());
    bytes[40..44].copy_from_slice(&header.resampler_id.to_le_bytes());
    bytes[44..48].copy_from_slice(&header.data_offset.to_le_bytes());
    bytes
}

fn parse_header(bytes: &[u8]) -> Result<ProxyHeader, String> {
    if bytes.len() < HEADER_LEN as usize || &bytes[0..4] != b"ASPX" {
        return Err("Playback proxy header is not an Audiosous proxy.".into());
    }
    let flags = u16::from_le_bytes(bytes[6..8].try_into().unwrap());
    if flags & FLAG_F32_LE == 0 {
        return Err("Playback proxy is not little-endian float.".into());
    }
    Ok(ProxyHeader {
        version: u16::from_le_bytes(bytes[4..6].try_into().unwrap()),
        sample_rate: u32::from_le_bytes(bytes[8..12].try_into().unwrap()),
        channels: u16::from_le_bytes(bytes[12..14].try_into().unwrap()),
        frames: u64::from_le_bytes(bytes[16..24].try_into().unwrap()),
        source_size: u64::from_le_bytes(bytes[24..32].try_into().unwrap()),
        source_modified_ns: u64::from_le_bytes(bytes[32..40].try_into().unwrap()),
        resampler_id: u32::from_le_bytes(bytes[40..44].try_into().unwrap()),
        data_offset: u32::from_le_bytes(bytes[44..48].try_into().unwrap()),
    })
}

pub struct ProxyReader {
    file: File,
    channels: usize,
    frames: u64,
    cursor: u64,
    scratch: Vec<u8>,
}

impl ProxyReader {
    pub fn open(path: &Path) -> Result<(ProxyHeader, Self), String> {
        let mut file = File::open(path).map_err(|error| error.to_string())?;
        let header = read_header(&mut file)?;
        if header.version != PROXY_VERSION
            || header.sample_rate != PLAYBACK_RATE
            || header.data_offset as u64 != HEADER_LEN
        {
            return Err("Playback proxy is stale and must be rebuilt.".into());
        }
        if header.channels == 0 || header.channels > 2 {
            return Err("Playback proxy channel count is not playable.".into());
        }
        Ok((
            header.clone(),
            Self {
                file,
                channels: header.channels as usize,
                frames: header.frames,
                cursor: 0,
                scratch: Vec::new(),
            },
        ))
    }

    pub fn seek_frame(&mut self, frame: u64) -> Result<(), String> {
        let frame = frame.min(self.frames);
        let pos = HEADER_LEN + frame * self.channels as u64 * 4;
        self.file
            .seek(SeekFrom::Start(pos))
            .map_err(|error| error.to_string())?;
        self.cursor = frame;
        Ok(())
    }

    pub fn read_interleaved(&mut self, frames: usize, out: &mut Vec<f32>) -> Result<usize, String> {
        let available = self.frames.saturating_sub(self.cursor) as usize;
        let count = frames.min(available);
        out.clear();
        if count == 0 {
            return Ok(0);
        }
        let bytes = count * self.channels * 4;
        self.scratch.resize(bytes, 0);
        self.file
            .read_exact(&mut self.scratch)
            .map_err(|error| error.to_string())?;
        out.reserve(count * self.channels);
        for chunk in self.scratch.chunks_exact(4) {
            out.push(f32::from_le_bytes(chunk.try_into().unwrap()));
        }
        self.cursor += count as u64;
        Ok(count)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = env::temp_dir().join(format!("audiosous-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_wav(path: &Path, rate: u32, frames: usize, sample: impl Fn(usize) -> f32) {
        let mut body = Vec::with_capacity(44 + frames * 4);
        let data_bytes = (frames * 4) as u32;
        let riff_size = 36 + data_bytes;
        body.extend_from_slice(b"RIFF");
        body.extend_from_slice(&riff_size.to_le_bytes());
        body.extend_from_slice(b"WAVE");
        body.extend_from_slice(b"fmt ");
        body.extend_from_slice(&16_u32.to_le_bytes());
        body.extend_from_slice(&3_u16.to_le_bytes());
        body.extend_from_slice(&1_u16.to_le_bytes());
        body.extend_from_slice(&rate.to_le_bytes());
        body.extend_from_slice(&(rate * 4).to_le_bytes());
        body.extend_from_slice(&4_u16.to_le_bytes());
        body.extend_from_slice(&32_u16.to_le_bytes());
        body.extend_from_slice(b"data");
        body.extend_from_slice(&data_bytes.to_le_bytes());
        for frame in 0..frames {
            body.extend_from_slice(&sample(frame).to_le_bytes());
        }
        fs::write(path, body).unwrap();
    }

    #[test]
    fn stale_proxy_is_rebuilt_and_identity_must_match() {
        let dir = temp_dir("proxy-identity");
        let source = dir.join("tone.wav");
        write_wav(&source, 48_000, 480, |_| 0.25);
        let proxy = dir.join("tone.proxy");
        let info = ensure_proxy(
            &source,
            &proxy,
            100,
            5,
            &AtomicBool::new(false),
            &mut |_| {},
        )
        .unwrap();
        assert_eq!(info.sample_rate, 48_000);
        assert_eq!(info.channels, 1);
        let again = ensure_proxy(
            &source,
            &proxy,
            100,
            5,
            &AtomicBool::new(false),
            &mut |_| {},
        )
        .unwrap();
        assert_eq!(again.frames, info.frames);
        let changed = ensure_proxy(
            &source,
            &proxy,
            100,
            9,
            &AtomicBool::new(false),
            &mut |_| {},
        )
        .unwrap();
        assert!(changed.frames > 0);
        let mut file = File::open(&proxy).unwrap();
        let header = read_header(&mut file).unwrap();
        assert_eq!(header.source_modified_ns, 9);
        assert!(!header_is_current(
            &header,
            1,
            100,
            5,
            file.metadata().unwrap().len()
        ));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn downsampling_keeps_a_1khz_tone_and_rejects_nyquist() {
        let dir = temp_dir("proxy-resample");
        let source = dir.join("sine.wav");
        let rate = 192_000_u32;
        let frames = rate as usize / 4;
        write_wav(&source, rate, frames, |frame| {
            let time = frame as f32 / rate as f32;
            (2.0 * std::f32::consts::PI * 1_000.0 * time).sin()
        });
        let proxy = dir.join("sine.proxy");
        let info =
            ensure_proxy(&source, &proxy, 1, 1, &AtomicBool::new(false), &mut |_| {}).unwrap();
        let (_header, mut reader) = ProxyReader::open(&proxy).unwrap();
        let mut samples = Vec::new();
        reader.seek_frame(info.frames / 4).unwrap();
        reader
            .read_interleaved((info.frames / 2) as usize, &mut samples)
            .unwrap();
        let crossings = samples
            .windows(2)
            .filter(|pair| pair[0] <= 0.0 && pair[1] > 0.0)
            .count();
        let duration = samples.len() as f32 / PLAYBACK_RATE as f32;
        let hz = crossings as f32 / duration;
        assert!((hz - 1_000.0).abs() < 15.0, "expected 1 kHz, got {hz}");
        let mean_square =
            samples.iter().map(|sample| sample * sample).sum::<f32>() / samples.len() as f32;
        assert!(
            mean_square > 0.2 && mean_square < 0.7,
            "rms energy {mean_square}"
        );

        write_wav(&source, rate, frames, |frame| {
            let time = frame as f32 / rate as f32;
            (2.0 * std::f32::consts::PI * 96_000.0 * time).sin()
        });
        let alias = dir.join("alias.proxy");
        ensure_proxy(&source, &alias, 2, 2, &AtomicBool::new(false), &mut |_| {}).unwrap();
        let (_header, mut alias_reader) = ProxyReader::open(&alias).unwrap();
        let mut rejected = Vec::new();
        alias_reader.seek_frame(2_000).unwrap();
        alias_reader.read_interleaved(8_000, &mut rejected).unwrap();
        let peak = rejected
            .iter()
            .map(|sample| sample.abs())
            .fold(0.0_f32, f32::max);
        assert!(peak < 0.05, "96 kHz tone survived at peak {peak}");
        let _ = fs::remove_dir_all(&dir);
    }
}
