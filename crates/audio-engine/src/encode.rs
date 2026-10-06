//! Finished-file writers for export: WAV (16/24-bit PCM, 32-bit float), FLAC (16/24-bit), and MP3 (320 kbps CBR
//! or V0), and a decoder that reads any of them back for verification.
//!
//! WAV is written here. FLAC uses `flacenc` (Apache-2.0/MIT). MP3 uses the LAME library (LGPL), loaded at run time
//! from the system or the app bundle and never linked statically, so the application can be distributed with it as
//! a replaceable library. Decoding for verification uses `symphonia` (MPL-2.0). PCM is dithered with seeded TPDF
//! noise, so the same mix and settings always give the same bytes.

use std::ffi::{c_char, c_int, c_void, CString};
use std::fs::{self, File};
use std::io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::loudness::{LoudnessMeter, LoudnessReport};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WavDepth {
    Pcm16,
    Pcm24,
    Float32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Mp3Quality {
    Cbr320,
    V0,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ExportFormat {
    Wav { depth: WavDepth },
    Flac { bits: u8 },
    Mp3 { quality: Mp3Quality },
}

impl ExportFormat {
    pub fn extension(&self) -> &'static str {
        match self {
            Self::Wav { .. } => "wav",
            Self::Flac { .. } => "flac",
            Self::Mp3 { .. } => "mp3",
        }
    }

    /// Integer PCM bits, or None for float and MP3.
    pub fn pcm_bits(&self) -> Option<u32> {
        match self {
            Self::Wav { depth: WavDepth::Pcm16 } => Some(16),
            Self::Wav { depth: WavDepth::Pcm24 } => Some(24),
            Self::Wav { depth: WavDepth::Float32 } => None,
            Self::Flac { bits } => Some(u32::from(*bits)),
            Self::Mp3 { .. } => None,
        }
    }

    pub fn is_lossy(&self) -> bool {
        matches!(self, Self::Mp3 { .. })
    }

    pub fn describe(&self) -> String {
        match self {
            Self::Wav { depth: WavDepth::Pcm16 } => "WAV 16-bit PCM".into(),
            Self::Wav { depth: WavDepth::Pcm24 } => "WAV 24-bit PCM".into(),
            Self::Wav { depth: WavDepth::Float32 } => "WAV 32-bit float".into(),
            Self::Flac { bits } => format!("FLAC {bits}-bit"),
            Self::Mp3 { quality: Mp3Quality::Cbr320 } => "MP3 320 kbps CBR".into(),
            Self::Mp3 { quality: Mp3Quality::V0 } => "MP3 V0 (VBR)".into(),
        }
    }
}

/// Basic tags. Written into MP3 (ID3v2); WAV and FLAC are written without tags.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportMetadata {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub track_number: Option<u32>,
    pub year: Option<u32>,
}

pub trait AudioWriter {
    /// Writes interleaved samples in −1…1.
    fn write(&mut self, interleaved: &[f32]) -> Result<(), String>;
    /// Completes the file.
    fn finish(self: Box<Self>) -> Result<(), String>;
}

/// Opens a writer for `format` at `path` (which should be a temporary name; the caller renames it when verified).
pub fn open_writer(format: ExportFormat, path: &Path, rate: u32, channels: usize, metadata: &ExportMetadata) -> Result<Box<dyn AudioWriter>, String> {
    match format {
        ExportFormat::Wav { depth } => Ok(Box::new(WavWriter::create(path, rate, channels, depth)?)),
        ExportFormat::Flac { bits } => Ok(Box::new(FlacWriter::create(path, rate, channels, bits, metadata)?)),
        ExportFormat::Mp3 { quality } => Ok(Box::new(Mp3Writer::create(path, rate, channels, quality, metadata)?)),
    }
}

/* ------------------------------------------------------------------ dither */

/// Seeded TPDF dither and rounding to `bits`: deterministic, one LSB of triangular noise.
pub struct Quantizer {
    scale: f32,
    max: i32,
    min: i32,
    state: u64,
}

impl Quantizer {
    pub fn new(bits: u32) -> Self {
        let full = 1_i64 << (bits - 1);
        Self { scale: full as f32, max: (full - 1) as i32, min: (-full) as i32, state: 0x9E37_79B9_7F4A_7C15 }
    }

    #[inline(always)]
    fn uniform(&mut self) -> f32 {
        // xorshift64*
        self.state ^= self.state >> 12;
        self.state ^= self.state << 25;
        self.state ^= self.state >> 27;
        let value = self.state.wrapping_mul(0x2545_F491_4F6C_DD1D);
        (value >> 40) as f32 / (1_u64 << 24) as f32 - 0.5
    }

    #[inline]
    pub fn quantize(&mut self, sample: f32) -> i32 {
        let dither = self.uniform() + self.uniform();
        let value = (sample * self.scale + dither).round();
        (value as i64).clamp(i64::from(self.min), i64::from(self.max)) as i32
    }
}

/* ------------------------------------------------------------------ WAV */

pub struct WavWriter {
    file: BufWriter<File>,
    depth: WavDepth,
    quantizer: Option<Quantizer>,
    data_bytes: u64,
    data_size_at: u64,
    riff_size_at: u64,
    fact_at: Option<u64>,
    channels: usize,
}

impl WavWriter {
    pub fn create(path: &Path, rate: u32, channels: usize, depth: WavDepth) -> Result<Self, String> {
        let mut file = BufWriter::with_capacity(1 << 20, File::create(path).map_err(|error| format!("Could not create {}: {error}", path.display()))?);
        let (tag, bits): (u16, u16) = match depth {
            WavDepth::Pcm16 => (1, 16),
            WavDepth::Pcm24 => (1, 24),
            WavDepth::Float32 => (3, 32),
        };
        let block = channels as u16 * bits / 8;
        let mut header = Vec::with_capacity(58);
        header.extend_from_slice(b"RIFF");
        header.extend_from_slice(&0_u32.to_le_bytes());
        header.extend_from_slice(b"WAVEfmt ");
        header.extend_from_slice(&16_u32.to_le_bytes());
        header.extend_from_slice(&tag.to_le_bytes());
        header.extend_from_slice(&(channels as u16).to_le_bytes());
        header.extend_from_slice(&rate.to_le_bytes());
        header.extend_from_slice(&(rate * u32::from(block)).to_le_bytes());
        header.extend_from_slice(&block.to_le_bytes());
        header.extend_from_slice(&bits.to_le_bytes());
        let mut fact_at = None;
        if depth == WavDepth::Float32 {
            header.extend_from_slice(b"fact");
            header.extend_from_slice(&4_u32.to_le_bytes());
            fact_at = Some(header.len() as u64);
            header.extend_from_slice(&0_u32.to_le_bytes());
        }
        header.extend_from_slice(b"data");
        let data_size_at = header.len() as u64;
        header.extend_from_slice(&0_u32.to_le_bytes());
        file.write_all(&header).map_err(|error| error.to_string())?;
        let quantizer = match depth {
            WavDepth::Pcm16 => Some(Quantizer::new(16)),
            WavDepth::Pcm24 => Some(Quantizer::new(24)),
            WavDepth::Float32 => None,
        };
        Ok(Self { file, depth, quantizer, data_bytes: 0, data_size_at, riff_size_at: 4, fact_at, channels })
    }
}

impl AudioWriter for WavWriter {
    fn write(&mut self, interleaved: &[f32]) -> Result<(), String> {
        let mut bytes = Vec::with_capacity(interleaved.len() * 4);
        match (self.depth, self.quantizer.as_mut()) {
            (WavDepth::Float32, _) => {
                for sample in interleaved {
                    bytes.extend_from_slice(&(if sample.is_finite() { *sample } else { 0.0 }).to_le_bytes());
                }
            }
            (WavDepth::Pcm16, Some(quantizer)) => {
                for sample in interleaved {
                    bytes.extend_from_slice(&(quantizer.quantize(*sample) as i16).to_le_bytes());
                }
            }
            (WavDepth::Pcm24, Some(quantizer)) => {
                for sample in interleaved {
                    bytes.extend_from_slice(&quantizer.quantize(*sample).to_le_bytes()[..3]);
                }
            }
            _ => return Err("WAV writer is misconfigured.".into()),
        }
        self.data_bytes += bytes.len() as u64;
        if self.data_bytes > u64::from(u32::MAX) - 64 {
            return Err("The export is larger than a WAV file can hold (4 GB). Choose FLAC or a lower sample rate.".into());
        }
        self.file.write_all(&bytes).map_err(|error| error.to_string())
    }

    fn finish(mut self: Box<Self>) -> Result<(), String> {
        self.file.flush().map_err(|error| error.to_string())?;
        let mut file = self.file.into_inner().map_err(|error| error.to_string())?;
        let data = self.data_bytes as u32;
        let header_len = self.data_size_at + 4;
        let patch = |file: &mut File, at: u64, value: u32| -> Result<(), String> {
            file.seek(SeekFrom::Start(at)).map_err(|error| error.to_string())?;
            file.write_all(&value.to_le_bytes()).map_err(|error| error.to_string())
        };
        patch(&mut file, self.riff_size_at, (header_len - 8) as u32 + data)?;
        patch(&mut file, self.data_size_at, data)?;
        if let Some(at) = self.fact_at {
            let bytes_per_frame = (self.channels * 4) as u32;
            patch(&mut file, at, data / bytes_per_frame)?;
        }
        file.sync_all().map_err(|error| error.to_string())
    }
}

/* ------------------------------------------------------------------ FLAC */

/// Writes dithered PCM to a side file (and its MD5) while the mix streams in, then encodes it block by block with
/// flacenc, the last block as short as it really is, so the decoded length is exactly the rendered length.
pub struct FlacWriter {
    path: PathBuf,
    pcm_path: PathBuf,
    pcm: BufWriter<File>,
    quantizer: Quantizer,
    md5: md5::Md5,
    rate: u32,
    channels: usize,
    bits: u8,
    tags: Vec<(String, String)>,
}

impl FlacWriter {
    pub fn create(path: &Path, rate: u32, channels: usize, bits: u8, metadata: &ExportMetadata) -> Result<Self, String> {
        use md5::Digest;
        if bits != 16 && bits != 24 {
            return Err("FLAC export supports 16 or 24 bits.".into());
        }
        let pcm_path = path.with_extension("pcm.partial");
        let pcm = BufWriter::with_capacity(1 << 20, File::create(&pcm_path).map_err(|error| error.to_string())?);
        let mut tags = Vec::new();
        let mut tag = |key: &str, value: Option<String>| {
            if let Some(value) = value.filter(|value| !value.trim().is_empty()) {
                tags.push((key.to_string(), value.trim().to_string()));
            }
        };
        tag("TITLE", metadata.title.clone());
        tag("ARTIST", metadata.artist.clone());
        tag("ALBUM", metadata.album.clone());
        tag("TRACKNUMBER", metadata.track_number.map(|value| value.to_string()));
        tag("DATE", metadata.year.map(|value| value.to_string()));
        Ok(Self { path: path.to_path_buf(), pcm_path, pcm, quantizer: Quantizer::new(u32::from(bits)), md5: md5::Md5::new(), rate, channels, bits, tags })
    }

    /// A VORBIS_COMMENT block: vendor, then KEY=value fields, little-endian lengths.
    fn vorbis_comment(&self) -> Vec<u8> {
        let vendor = b"Audiosous";
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&(vendor.len() as u32).to_le_bytes());
        bytes.extend_from_slice(vendor);
        bytes.extend_from_slice(&(self.tags.len() as u32).to_le_bytes());
        for (key, value) in &self.tags {
            let field = format!("{key}={value}");
            bytes.extend_from_slice(&(field.len() as u32).to_le_bytes());
            bytes.extend_from_slice(field.as_bytes());
        }
        bytes
    }
}

impl AudioWriter for FlacWriter {
    fn write(&mut self, interleaved: &[f32]) -> Result<(), String> {
        use md5::Digest;
        let width = usize::from(self.bits / 8);
        let mut bytes = Vec::with_capacity(interleaved.len() * 4);
        let mut digest = Vec::with_capacity(interleaved.len() * width);
        for sample in interleaved {
            let value = self.quantizer.quantize(*sample);
            bytes.extend_from_slice(&value.to_le_bytes());
            digest.extend_from_slice(&value.to_le_bytes()[..width]);
        }
        self.md5.update(&digest);
        self.pcm.write_all(&bytes).map_err(|error| error.to_string())
    }

    fn finish(self: Box<Self>) -> Result<(), String> {
        use flacenc::component::{BitRepr, MetadataBlockData, Stream, StreamInfo};
        use flacenc::error::Verify;
        use flacenc::source::{Fill, FrameBuf};
        use md5::Digest;
        let comment = (!self.tags.is_empty()).then(|| self.vorbis_comment());
        let FlacWriter { path, pcm_path, pcm, md5, rate, channels, bits, .. } = *self;
        let result = (|| -> Result<(), String> {
            let mut pcm = pcm;
            pcm.flush().map_err(|error| error.to_string())?;
            drop(pcm);
            let config = flacenc::config::Encoder::default().into_verified().map_err(|(_, error)| format!("FLAC encoder setup failed: {error:?}"))?;
            let block = config.block_size;
            let mut info = StreamInfo::new(rate as usize, channels, usize::from(bits)).map_err(|error| format!("FLAC setup failed: {error:?}"))?;
            let digest: [u8; 16] = md5.finalize().into();
            info.set_md5_digest(&digest);
            let mut stream = Stream::with_stream_info(info);
            if let Some(comment) = comment {
                stream.add_metadata_block(MetadataBlockData::new_unknown(4, &comment).map_err(|error| format!("FLAC tags failed: {error:?}"))?);
            }
            let mut reader = BufReader::with_capacity(1 << 20, File::open(&pcm_path).map_err(|error| error.to_string())?);
            let mut bytes = vec![0_u8; block * channels * 4];
            let mut samples: Vec<i32> = Vec::with_capacity(block * channels);
            let mut frame_number = 0;
            loop {
                let mut filled = 0;
                while filled < bytes.len() {
                    let read = reader.read(&mut bytes[filled..]).map_err(|error| error.to_string())?;
                    if read == 0 {
                        break;
                    }
                    filled += read;
                }
                let frames = filled / (channels * 4);
                if frames == 0 {
                    break;
                }
                samples.clear();
                for chunk in bytes[..frames * channels * 4].chunks_exact(4) {
                    samples.push(i32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]));
                }
                let mut framebuf = FrameBuf::with_size(channels, frames).map_err(|error| format!("FLAC encoding failed: {error:?}"))?;
                framebuf.fill_interleaved(&samples).map_err(|error| format!("FLAC encoding failed: {error:?}"))?;
                let frame = flacenc::encode_fixed_size_frame(&config, &framebuf, frame_number, stream.stream_info()).map_err(|error| format!("FLAC encoding failed: {error:?}"))?;
                stream.add_frame(frame);
                frame_number += 1;
                if frames < block {
                    break;
                }
            }
            let mut sink = flacenc::bitsink::ByteSink::new();
            stream.write(&mut sink).map_err(|error| format!("FLAC encoding failed: {error:?}"))?;
            let mut bytes = sink.as_slice().to_vec();
            // STREAMINFO (after "fLaC" and its 4-byte block header): a fixed-blocksize stream states its block size as
            // both minimum and maximum; only the last frame may be shorter. flacenc counts the last frame in the
            // minimum, which makes decoders read the stream as variable-blocksize, so state it as the format expects.
            if frame_number > 1 && bytes.len() > 12 && &bytes[..4] == b"fLaC" {
                let (max_hi, max_lo) = (bytes[10], bytes[11]);
                bytes[8] = max_hi;
                bytes[9] = max_lo;
            }
            let mut file = File::create(&path).map_err(|error| error.to_string())?;
            file.write_all(&bytes).map_err(|error| error.to_string())?;
            file.sync_all().map_err(|error| error.to_string())
        })();
        let _ = fs::remove_file(&pcm_path);
        result
    }
}

/* ------------------------------------------------------------------ MP3 (LAME, loaded at run time) */

type LameInit = unsafe extern "C" fn() -> *mut c_void;
type LameSetInt = unsafe extern "C" fn(*mut c_void, c_int) -> c_int;
type LameVoid = unsafe extern "C" fn(*mut c_void);
type LameVoidInt = unsafe extern "C" fn(*mut c_void, c_int);
type LameSetText = unsafe extern "C" fn(*mut c_void, *const c_char);
type LameSetTextInt = unsafe extern "C" fn(*mut c_void, *const c_char) -> c_int;
type LameCall = unsafe extern "C" fn(*mut c_void) -> c_int;
type LameGetBuffer = unsafe extern "C" fn(*mut c_void, *mut u8, usize) -> usize;
type LameEncodeFloat = unsafe extern "C" fn(*mut c_void, *const f32, *const f32, c_int, *mut u8, c_int) -> c_int;
type LameFlush = unsafe extern "C" fn(*mut c_void, *mut u8, c_int) -> c_int;
type LameVersion = unsafe extern "C" fn() -> *const c_char;

/// Where the LAME library is looked for: `AUDIOSOUS_LAME_PATH`, then the platform's usual names.
fn lame_candidates() -> Vec<String> {
    let mut out = Vec::new();
    if let Ok(path) = std::env::var("AUDIOSOUS_LAME_PATH") {
        out.push(path);
    }
    if cfg!(target_os = "macos") {
        out.extend(["libmp3lame.0.dylib", "libmp3lame.dylib", "/opt/homebrew/lib/libmp3lame.dylib", "/usr/local/lib/libmp3lame.dylib"].map(String::from));
    } else if cfg!(target_os = "windows") {
        out.extend(["libmp3lame.dll", "lame_enc.dll", "mp3lame.dll"].map(String::from));
    } else {
        out.extend(["libmp3lame.so.0", "libmp3lame.so"].map(String::from));
    }
    out
}

/// The loaded LAME library, or why it could not be loaded.
pub fn lame_available() -> Result<String, String> {
    let library = load_lame()?;
    unsafe {
        let version: libloading::Symbol<LameVersion> = library.get(b"get_lame_version\0").map_err(|error| error.to_string())?;
        let text = std::ffi::CStr::from_ptr(version()).to_string_lossy().into_owned();
        Ok(format!("LAME {text}"))
    }
}

fn load_lame() -> Result<libloading::Library, String> {
    let mut last = String::new();
    for candidate in lame_candidates() {
        match unsafe { libloading::Library::new(&candidate) } {
            Ok(library) => return Ok(library),
            Err(error) => last = error.to_string(),
        }
    }
    Err(format!("MP3 export needs the LAME encoder library (libmp3lame), which was not found ({last}). Install LAME, or set AUDIOSOUS_LAME_PATH to the library."))
}

struct Lame {
    library: libloading::Library,
    flags: *mut c_void,
}

impl Lame {
    unsafe fn get<T>(&self, name: &[u8]) -> Result<libloading::Symbol<'_, T>, String> {
        self.library.get(name).map_err(|error| format!("The LAME library is missing {}: {error}", String::from_utf8_lossy(&name[..name.len() - 1])))
    }
}

impl Drop for Lame {
    fn drop(&mut self) {
        unsafe {
            if let Ok(close) = self.library.get::<LameCall>(b"lame_close\0") {
                close(self.flags);
            }
        }
    }
}

pub struct Mp3Writer {
    lame: Lame,
    file: File,
    /// Where the first audio frame starts (after the ID3v2 tag), for the LAME/Xing info frame.
    audio_at: u64,
    channels: usize,
    left: Vec<f32>,
    right: Vec<f32>,
    out: Vec<u8>,
}

impl Mp3Writer {
    pub fn create(path: &Path, rate: u32, channels: usize, quality: Mp3Quality, metadata: &ExportMetadata) -> Result<Self, String> {
        if rate != 44_100 && rate != 48_000 && rate != 32_000 {
            return Err("MP3 export needs 44.1 or 48 kHz.".into());
        }
        let library = load_lame()?;
        unsafe {
            let init: libloading::Symbol<LameInit> = library.get(b"lame_init\0").map_err(|error| error.to_string())?;
            let flags = init();
            if flags.is_null() {
                return Err("The LAME encoder could not start.".into());
            }
            let lame = Lame { library, flags };
            let set = |name: &[u8], value: c_int| -> Result<(), String> {
                let function: libloading::Symbol<LameSetInt> = lame.get(name)?;
                function(lame.flags, value);
                Ok(())
            };
            set(b"lame_set_num_channels\0", channels as c_int)?;
            set(b"lame_set_in_samplerate\0", rate as c_int)?;
            set(b"lame_set_out_samplerate\0", rate as c_int)?;
            set(b"lame_set_mode\0", if channels == 1 { 3 } else { 1 })?;
            set(b"lame_set_quality\0", 2)?;
            set(b"lame_set_bWriteVbrTag\0", 1)?;
            match quality {
                Mp3Quality::Cbr320 => {
                    set(b"lame_set_VBR\0", 0)?;
                    set(b"lame_set_brate\0", 320)?;
                }
                Mp3Quality::V0 => {
                    set(b"lame_set_VBR\0", 4)?;
                    set(b"lame_set_VBR_q\0", 0)?;
                }
            }
            let automatic: libloading::Symbol<LameVoidInt> = lame.get(b"lame_set_write_id3tag_automatic\0")?;
            automatic(lame.flags, 0);
            let tagged = metadata.title.is_some() || metadata.artist.is_some() || metadata.album.is_some() || metadata.track_number.is_some() || metadata.year.is_some();
            if tagged {
                let init_tag: libloading::Symbol<LameVoid> = lame.get(b"id3tag_init\0")?;
                init_tag(lame.flags);
                let v2: libloading::Symbol<LameVoid> = lame.get(b"id3tag_add_v2\0")?;
                v2(lame.flags);
                let v2_only: libloading::Symbol<LameVoid> = lame.get(b"id3tag_v2_only\0")?;
                v2_only(lame.flags);
                let text = |name: &[u8], value: &Option<String>| -> Result<(), String> {
                    if let Some(value) = value.as_ref().filter(|value| !value.trim().is_empty()) {
                        let value = CString::new(value.trim().replace('\0', "")).map_err(|error| error.to_string())?;
                        let function: libloading::Symbol<LameSetText> = lame.get(name)?;
                        function(lame.flags, value.as_ptr());
                    }
                    Ok(())
                };
                text(b"id3tag_set_title\0", &metadata.title)?;
                text(b"id3tag_set_artist\0", &metadata.artist)?;
                text(b"id3tag_set_album\0", &metadata.album)?;
                text(b"id3tag_set_year\0", &metadata.year.map(|year| year.to_string()))?;
                if let Some(track) = metadata.track_number {
                    let value = CString::new(track.to_string()).map_err(|error| error.to_string())?;
                    let function: libloading::Symbol<LameSetTextInt> = lame.get(b"id3tag_set_track\0")?;
                    function(lame.flags, value.as_ptr());
                }
            }
            let params: libloading::Symbol<LameCall> = lame.get(b"lame_init_params\0")?;
            if params(lame.flags) < 0 {
                return Err("The LAME encoder rejected these settings.".into());
            }
            let mut file = File::create(path).map_err(|error| format!("Could not create {}: {error}", path.display()))?;
            let mut audio_at = 0;
            if tagged {
                let get_tag: libloading::Symbol<LameGetBuffer> = lame.get(b"lame_get_id3v2_tag\0")?;
                let size = get_tag(lame.flags, std::ptr::null_mut(), 0);
                if size > 0 {
                    let mut tag = vec![0_u8; size];
                    let written = get_tag(lame.flags, tag.as_mut_ptr(), size);
                    file.write_all(&tag[..written.min(size)]).map_err(|error| error.to_string())?;
                    audio_at = written.min(size) as u64;
                }
            }
            Ok(Self { lame, file, audio_at, channels, left: Vec::new(), right: Vec::new(), out: Vec::new() })
        }
    }
}

impl AudioWriter for Mp3Writer {
    fn write(&mut self, interleaved: &[f32]) -> Result<(), String> {
        let frames = interleaved.len() / self.channels;
        if frames == 0 {
            return Ok(());
        }
        self.left.clear();
        self.right.clear();
        for frame in interleaved.chunks_exact(self.channels) {
            self.left.push(frame[0]);
            self.right.push(if self.channels > 1 { frame[1] } else { frame[0] });
        }
        let capacity = frames * 5 / 4 + 7_200;
        self.out.resize(capacity, 0);
        let written = unsafe {
            let encode: libloading::Symbol<LameEncodeFloat> = self.lame.get(b"lame_encode_buffer_ieee_float\0")?;
            encode(self.lame.flags, self.left.as_ptr(), self.right.as_ptr(), frames as c_int, self.out.as_mut_ptr(), capacity as c_int)
        };
        if written < 0 {
            return Err(format!("MP3 encoding failed (LAME error {written})."));
        }
        self.file.write_all(&self.out[..written as usize]).map_err(|error| error.to_string())
    }

    fn finish(mut self: Box<Self>) -> Result<(), String> {
        self.out.resize(16_384, 0);
        unsafe {
            let flush: libloading::Symbol<LameFlush> = self.lame.get(b"lame_encode_flush\0")?;
            let written = flush(self.lame.flags, self.out.as_mut_ptr(), self.out.len() as c_int);
            if written < 0 {
                return Err(format!("MP3 encoding failed at the end (LAME error {written})."));
            }
            self.file.write_all(&self.out[..written as usize]).map_err(|error| error.to_string())?;
            // The LAME/Xing info frame: length, seek table, and the encoder delay and padding for gapless decoding.
            let tag: libloading::Symbol<LameGetBuffer> = self.lame.get(b"lame_get_lametag_frame\0")?;
            let size = tag(self.lame.flags, std::ptr::null_mut(), 0);
            if size > 0 {
                let mut frame = vec![0_u8; size];
                let written = tag(self.lame.flags, frame.as_mut_ptr(), size);
                self.file.seek(SeekFrom::Start(self.audio_at)).map_err(|error| error.to_string())?;
                self.file.write_all(&frame[..written.min(size)]).map_err(|error| error.to_string())?;
            }
        }
        self.file.sync_all().map_err(|error| error.to_string())
    }
}

/* ------------------------------------------------------------------ decode for verification */

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DecodedFile {
    pub sample_rate: u32,
    pub channels: usize,
    pub frames: u64,
    pub loudness: LoudnessReport,
    /// Frame offset where the decoded audio best lines up with the reference, when one was given.
    pub codec: String,
}

/// Decodes a finished file completely and measures it: proof that it opens, how long it is, and how loud.
pub fn decode_and_measure(path: &Path, cancel: &std::sync::atomic::AtomicBool) -> Result<DecodedFile, String> {
    use symphonia::core::audio::SampleBuffer;
    use symphonia::core::codecs::DecoderOptions;
    use symphonia::core::formats::FormatOptions;
    use symphonia::core::io::MediaSourceStream;
    use symphonia::core::meta::MetadataOptions;
    use symphonia::core::probe::Hint;

    let file = File::open(path).map_err(|error| format!("The exported file could not be opened: {error}"))?;
    let stream = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(extension) = path.extension().and_then(|value| value.to_str()) {
        hint.with_extension(extension.trim_end_matches(".partial"));
    }
    let probed = symphonia::default::get_probe()
        .format(&hint, stream, &FormatOptions { enable_gapless: true, ..Default::default() }, &MetadataOptions::default())
        .map_err(|error| format!("The exported file could not be read back: {error}"))?;
    let mut format = probed.format;
    let track = format.default_track().ok_or("The exported file has no audio track.")?.clone();
    let codec = format!("{:?}", track.codec_params.codec);
    let mut decoder = symphonia::default::get_codecs().make(&track.codec_params, &DecoderOptions::default()).map_err(|error| format!("The exported file could not be decoded: {error}"))?;
    let rate = track.codec_params.sample_rate.ok_or("The exported file has no sample rate.")?;
    let channels = track.codec_params.channels.map(|value| value.count()).unwrap_or(2);
    let mut meter = LoudnessMeter::new(rate, channels);
    let mut frames = 0_u64;
    let mut buffer: Option<SampleBuffer<f32>> = None;
    loop {
        if cancel.load(std::sync::atomic::Ordering::Relaxed) {
            return Err(crate::render::CANCELLED.into());
        }
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(symphonia::core::errors::Error::IoError(error)) if error.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(symphonia::core::errors::Error::ResetRequired) => break,
            Err(error) => return Err(format!("The exported file is damaged: {error}")),
        };
        if packet.track_id() != track.id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(decoded) => decoded,
            Err(symphonia::core::errors::Error::DecodeError(error)) => return Err(format!("The exported file did not decode: {error}")),
            Err(error) => return Err(format!("The exported file did not decode: {error}")),
        };
        let spec = *decoded.spec();
        let samples = buffer.get_or_insert_with(|| SampleBuffer::new(decoded.capacity() as u64, spec));
        if samples.capacity() < decoded.capacity() * spec.channels.count() {
            *samples = SampleBuffer::new(decoded.capacity() as u64, spec);
        }
        samples.copy_interleaved_ref(decoded);
        let data = samples.samples();
        frames += (data.len() / channels) as u64;
        meter.push(data);
    }
    Ok(DecodedFile { sample_rate: rate, channels, frames, loudness: meter.report(), codec })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    fn tone(rate: u32, seconds: f64) -> Vec<f32> {
        let frames = (seconds * f64::from(rate)) as usize;
        (0..frames).flat_map(|frame| {
            let t = frame as f64 / f64::from(rate);
            let value = (0.5 * (2.0 * std::f64::consts::PI * 440.0 * t).sin()) as f32;
            [value, value * 0.5]
        }).collect()
    }

    fn roundtrip(format: ExportFormat, rate: u32) -> (DecodedFile, Vec<u8>) {
        let dir = std::env::temp_dir().join(format!("audiosous-encode-{}-{}-{rate}", std::process::id(), format.describe().replace(' ', "_")));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("out.{}", format.extension()));
        let audio = tone(rate, 2.0);
        let mut writer = open_writer(format, &path, rate, 2, &ExportMetadata { title: Some("Night Drive".into()), artist: Some("Audiosous".into()), track_number: Some(3), year: Some(2026), album: None }).unwrap();
        for chunk in audio.chunks(4_096) {
            writer.write(chunk).unwrap();
        }
        writer.finish().unwrap();
        let decoded = decode_and_measure(&path, &AtomicBool::new(false)).unwrap();
        let bytes = fs::read(&path).unwrap();
        let _ = fs::remove_dir_all(&dir);
        (decoded, bytes)
    }

    #[test]
    fn wav_round_trips_at_every_depth() {
        for depth in [WavDepth::Pcm16, WavDepth::Pcm24, WavDepth::Float32] {
            let (decoded, _) = roundtrip(ExportFormat::Wav { depth }, 48_000);
            assert_eq!((decoded.sample_rate, decoded.channels, decoded.frames), (48_000, 2, 96_000), "{depth:?}");
            assert!((decoded.loudness.sample_peak_dbfs - -6.02).abs() < 0.05, "{depth:?} {}", decoded.loudness.sample_peak_dbfs);
        }
    }

    #[test]
    fn flac_round_trips_and_is_reproducible() {
        let (decoded, first) = roundtrip(ExportFormat::Flac { bits: 24 }, 44_100);
        assert_eq!((decoded.sample_rate, decoded.channels, decoded.frames), (44_100, 2, 88_200));
        assert!((decoded.loudness.sample_peak_dbfs - -6.02).abs() < 0.05);
        let (_, second) = roundtrip(ExportFormat::Flac { bits: 24 }, 44_100);
        assert_eq!(first, second, "FLAC export is not deterministic");
        let (sixteen, _) = roundtrip(ExportFormat::Flac { bits: 16 }, 48_000);
        assert_eq!(sixteen.frames, 96_000);
    }

    #[test]
    fn mp3_round_trips_with_its_length_when_lame_is_present() {
        if lame_available().is_err() {
            eprintln!("LAME is not installed; skipping the MP3 round trip.");
            return;
        }
        for quality in [Mp3Quality::Cbr320, Mp3Quality::V0] {
            let (decoded, bytes) = roundtrip(ExportFormat::Mp3 { quality }, 48_000);
            assert_eq!((decoded.sample_rate, decoded.channels), (48_000, 2));
            // Gapless decoding trims LAME's delay and padding: the length is the input's.
            assert!((decoded.frames as i64 - 96_000).abs() <= 1_152, "{quality:?}: {} frames", decoded.frames);
            assert!((decoded.loudness.sample_peak_dbfs - -6.02).abs() < 0.6, "{}", decoded.loudness.sample_peak_dbfs);
            assert_eq!(&bytes[..3], b"ID3", "no ID3v2 tag");
        }
    }

    /// The desktop sends these names; keep them stable.
    #[test]
    fn format_names_match_the_desktop() {
        let wav: ExportFormat = serde_json::from_str(r#"{"kind":"wav","depth":"pcm24"}"#).unwrap();
        assert_eq!(wav, ExportFormat::Wav { depth: WavDepth::Pcm24 });
        let float: ExportFormat = serde_json::from_str(r#"{"kind":"wav","depth":"float32"}"#).unwrap();
        assert_eq!(float, ExportFormat::Wav { depth: WavDepth::Float32 });
        let mp3: ExportFormat = serde_json::from_str(r#"{"kind":"mp3","quality":"v0"}"#).unwrap();
        assert_eq!(mp3, ExportFormat::Mp3 { quality: Mp3Quality::V0 });
        let flac: ExportFormat = serde_json::from_str(r#"{"kind":"flac","bits":16}"#).unwrap();
        assert_eq!(flac, ExportFormat::Flac { bits: 16 });
        assert!(serde_json::from_str::<ExportFormat>(r#"{"kind":"mp3","quality":"cbr320"}"#).is_ok());
    }

    #[test]
    fn dither_is_seeded() {
        let mut first = Quantizer::new(16);
        let mut second = Quantizer::new(16);
        let values: Vec<i32> = (0..1_000).map(|index| first.quantize((index as f32 * 0.001).sin() * 0.3)).collect();
        let again: Vec<i32> = (0..1_000).map(|index| second.quantize((index as f32 * 0.001).sin() * 0.3)).collect();
        assert_eq!(values, again);
        assert_eq!(Quantizer::new(16).quantize(2.0), i32::from(i16::MAX));
    }
}
