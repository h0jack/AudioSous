use std::cell::UnsafeCell;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicU8, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex, RwLock};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, SampleRate, StreamConfig};
use rtrb::{Consumer, Producer, RingBuffer};
use rubato::{
    Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction,
};

use crate::eq::{EqRuntime, EqTable, FilterSpec, PublishedEq, TrackEqInput};
use crate::mix::{
    linear_gain, scheduled_linear_gain, GainRegion, MixSnapshot, PublishedGainSchedule, PublishedMix,
    TrackMix, MAX_GAIN_REGIONS,
};
use crate::proxy::{ensure_proxy, ProxyReader, PLAYBACK_RATE};
use crate::spatial::{spatial_frame, PublishedSpatial, SpatialParams, SpatialRegionInput, SpatialRuntime, SpatialTable};

const MAX_TRACKS: usize = 64;
const WORKERS: usize = 4;
const RING_SECONDS: usize = 5;
const PRIME_FRAMES: u64 = PLAYBACK_RATE as u64;
const TARGET_FRAMES: u64 = PLAYBACK_RATE as u64 * 3;
const READ_FRAMES: usize = 8_192;
const NO_LOOP: u64 = u64::MAX;
const STATE_STOPPED: u8 = 0;
const STATE_PRIMING: u8 = 1;
const STATE_PLAYING: u8 = 3;
const STATE_PAUSED: u8 = 4;

#[derive(Clone)]
pub struct TrackGainRegion {
    pub track_id: String,
    pub start_seconds: f64,
    pub end_seconds: f64,
    pub gain_db: f32,
}

/// Static EQ for one track: track-wide filters, then extra filters inside each section window.
#[derive(Clone, Debug)]
pub struct TrackEq {
    pub track_id: String,
    pub filters: Vec<FilterSpec>,
    pub regions: Vec<TrackEqRegion>,
}

#[derive(Clone, Debug)]
pub struct TrackEqRegion {
    pub start_seconds: f64,
    pub end_seconds: f64,
    pub filters: Vec<FilterSpec>,
}

/// Spatial state for one track: whole-song pan and width, then section windows that replace them.
#[derive(Clone, Debug)]
pub struct TrackSpatial {
    pub track_id: String,
    pub pan: f32,
    pub width: f32,
    pub regions: Vec<TrackSpatialRegion>,
}

#[derive(Clone, Debug)]
pub struct TrackSpatialRegion {
    pub start_seconds: f64,
    pub end_seconds: f64,
    pub pan: f32,
    pub width: f32,
}

#[derive(Clone)]
pub struct LoadedTrack {
    pub id: String,
    pub label: String,
    pub source_path: PathBuf,
    pub proxy_path: PathBuf,
    pub source_size: u64,
    pub source_modified_ns: u64,
    pub gain_db: f32,
    pub pan: f32,
    /// Stereo width, 1.0 = as recorded. Ignored on a mono proxy.
    pub width: f32,
    pub muted: bool,
    pub solo: bool,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatus {
    pub state: String,
    pub position_seconds: f64,
    pub duration_seconds: f64,
    pub output_sample_rate: u32,
    pub callback_frames: u32,
    pub active_tracks: usize,
    pub proxy_ready_tracks: usize,
    pub proxy_total_tracks: usize,
    pub buffered_ahead_min: f64,
    pub buffered_ahead_avg: f64,
    pub underruns: u64,
    pub last_underrun_track: String,
    pub reader_backlog: usize,
    pub seek_prime_ms: u64,
    pub callback_ms: f64,
    pub callback_budget_ms: f64,
    pub device_format: String,
    pub proxy_percent: f32,
    pub message: String,
}

const FORMAT_F32: u8 = 1;
const FORMAT_I16: u8 = 2;

/// Ring consumers shared by the callback, the device-rate mixer, and the control thread.
///
/// Only one of those uses the consumers at a time. The callback and mixer set
/// `in_callback` or `mixer_busy` with `SeqCst` before reading, and they leave
/// if `consume` is false. The control thread clears `consume`, then waits until
/// both flags are false, and only then mutates the rings. That handoff is the
/// exclusion. There is no mutex on this path.
struct SharedRings {
    tracks: UnsafeCell<Vec<Consumer<f32>>>,
    device: UnsafeCell<Option<Consumer<f32>>>,
    /// Filter memory and ramps. Same owner rule as the ring consumers.
    eq: UnsafeCell<EqRuntime>,
    /// Pan and width ramps and section assignment. Same owner rule as the ring consumers.
    spatial: UnsafeCell<SpatialRuntime>,
}

impl SharedRings {
    fn new() -> Self {
        Self {
            tracks: UnsafeCell::new(Vec::new()),
            device: UnsafeCell::new(None),
            eq: UnsafeCell::new(EqRuntime::new()),
            spatial: UnsafeCell::new(SpatialRuntime::new()),
        }
    }

    #[allow(clippy::mut_from_ref)]
    fn spatial(&self) -> &mut SpatialRuntime {
        unsafe { &mut *self.spatial.get() }
    }

    #[allow(clippy::mut_from_ref)]
    fn eq(&self) -> &mut EqRuntime {
        unsafe { &mut *self.eq.get() }
    }

    fn tracks(&self) -> &mut Vec<Consumer<f32>> {
        unsafe { &mut *self.tracks.get() }
    }

    fn device(&self) -> &mut Option<Consumer<f32>> {
        unsafe { &mut *self.device.get() }
    }

    fn device_slots(&self) -> usize {
        unsafe {
            (*self.device.get())
                .as_ref()
                .map(|consumer| consumer.slots())
                .unwrap_or(0)
        }
    }
}

// The rings move between the callback, the mixer thread, and the control thread.
// `Send` is required for that move. `Sync` is sound only because the SeqCst
// consume / in_callback / mixer_busy handoff gives one of those threads the
// consumers at a time.
unsafe impl Send for SharedRings {}
unsafe impl Sync for SharedRings {}

#[allow(dead_code)]
struct TrackState {
    id: String,
    source_path: PathBuf,
    proxy_path: PathBuf,
    source_size: u64,
    source_modified_ns: u64,
    gain_db: f32,
    pan: f32,
    width: f32,
    muted: bool,
    solo: bool,
    channels: u16,
    frames: u64,
    cursor: u64,
    ready: bool,
    error: Option<String>,
    producer: Option<Producer<f32>>,
    reader: Option<ProxyReader>,
    scratch: Vec<f32>,
}

impl TrackState {
    fn from_loaded(track: &LoadedTrack) -> Self {
        Self {
            id: track.id.clone(),
            source_path: track.source_path.clone(),
            proxy_path: track.proxy_path.clone(),
            source_size: track.source_size,
            source_modified_ns: track.source_modified_ns,
            gain_db: track.gain_db,
            pan: track.pan,
            width: track.width,
            muted: track.muted,
            solo: track.solo,
            channels: 0,
            frames: 0,
            cursor: 0,
            ready: false,
            error: None,
            producer: None,
            reader: None,
            scratch: Vec::new(),
        }
    }
}

struct Realtime {
    offline: bool,
    rings: SharedRings,
    published: PublishedMix,
    gain_schedule: PublishedGainSchedule,
    eq: PublishedEq,
    spatial: PublishedSpatial,
    gains: [AtomicU32; MAX_TRACKS],
    produced: [AtomicU64; MAX_TRACKS],
    consumed: [AtomicU64; MAX_TRACKS],
    consume: AtomicBool,
    audible: AtomicBool,
    hold: AtomicBool,
    shutdown: AtomicBool,
    generation: AtomicU64,
    in_callback: AtomicBool,
    mixer_busy: AtomicBool,
    busy: AtomicUsize,
    presented: AtomicU64,
    prime_frame: AtomicU64,
    loop_start: AtomicU64,
    loop_end: AtomicU64,
    underruns: AtomicU64,
    last_underrun: AtomicUsize,
    callback_nanos: AtomicU64,
    callback_frames: AtomicU32,
    output_rate: AtomicU32,
    indirect: AtomicBool,
    state: AtomicU8,
    track_count: AtomicUsize,
    proxy_ready: AtomicUsize,
    proxy_total: AtomicUsize,
    proxy_percent: AtomicU32,
    seek_prime_ms: AtomicU64,
    duration_frames: AtomicU64,
    eof_bits: AtomicU64,
    load_id: AtomicU64,
    device_format: AtomicU8,
    device_fault: AtomicU8,
    ids: Mutex<Vec<String>>,
    message: Mutex<String>,
}

impl Realtime {
    fn new(offline: bool) -> Self {
        Self {
            offline,
            rings: SharedRings::new(),
            published: PublishedMix::silent(),
            gain_schedule: PublishedGainSchedule::empty(),
            eq: PublishedEq::empty(),
            spatial: PublishedSpatial::empty(),
            gains: std::array::from_fn(|_| AtomicU32::new(1.0_f32.to_bits())),
            produced: std::array::from_fn(|_| AtomicU64::new(0)),
            consumed: std::array::from_fn(|_| AtomicU64::new(0)),
            consume: AtomicBool::new(false),
            audible: AtomicBool::new(false),
            hold: AtomicBool::new(false),
            shutdown: AtomicBool::new(false),
            generation: AtomicU64::new(1),
            in_callback: AtomicBool::new(false),
            mixer_busy: AtomicBool::new(false),
            busy: AtomicUsize::new(0),
            presented: AtomicU64::new(0),
            prime_frame: AtomicU64::new(0),
            loop_start: AtomicU64::new(0),
            loop_end: AtomicU64::new(NO_LOOP),
            underruns: AtomicU64::new(0),
            last_underrun: AtomicUsize::new(usize::MAX),
            callback_nanos: AtomicU64::new(0),
            callback_frames: AtomicU32::new(0),
            output_rate: AtomicU32::new(PLAYBACK_RATE),
            indirect: AtomicBool::new(false),
            state: AtomicU8::new(STATE_STOPPED),
            track_count: AtomicUsize::new(0),
            proxy_ready: AtomicUsize::new(0),
            proxy_total: AtomicUsize::new(0),
            proxy_percent: AtomicU32::new(0),
            seek_prime_ms: AtomicU64::new(0),
            duration_frames: AtomicU64::new(0),
            eof_bits: AtomicU64::new(0),
            load_id: AtomicU64::new(0),
            device_format: AtomicU8::new(if offline { FORMAT_F32 } else { 0 }),
            device_fault: AtomicU8::new(0),
            ids: Mutex::new(Vec::new()),
            message: Mutex::new(String::new()),
        }
    }

    fn wait_audio_idle(&self) {
        while self.mixer_busy.load(Ordering::SeqCst) || self.in_callback.load(Ordering::SeqCst) {
            thread::sleep(Duration::from_millis(1));
        }
    }
}

enum Command {
    Load {
        tracks: Vec<LoadedTrack>,
        reply: Sender<Result<(), String>>,
    },
    Play {
        seconds: f64,
        reply: Sender<Result<(), String>>,
    },
    Pause,
    Stop,
    Seek(f64),
    SetTrack {
        id: String,
        gain_db: Option<f32>,
        pan: Option<f32>,
        muted: Option<bool>,
        solo: Option<bool>,
    },
    SetLoop(Option<(f64, f64)>),
    SetGainRegions(Vec<TrackGainRegion>),
    SetEq(Vec<TrackEq>),
    SetSpatial(Vec<TrackSpatial>),
    ProxyReady {
        load_id: u64,
        index: usize,
        result: Result<(u16, u64), String>,
    },
    Shutdown,
}

enum Poll {
    Continue,
    Abort,
    Seek(f64),
    Load(Vec<LoadedTrack>, Sender<Result<(), String>>),
}

struct Output {
    stream: cpal::Stream,
    mixer_stop: Arc<AtomicBool>,
    mixer: Option<JoinHandle<()>>,
}

impl Drop for Output {
    fn drop(&mut self) {
        self.mixer_stop.store(true, Ordering::Release);
        if let Some(mixer) = self.mixer.take() {
            let _ = mixer.join();
        }
    }
}

struct Control {
    rx: Receiver<Command>,
    tx: Sender<Command>,
    rt: Arc<Realtime>,
    tracks: Arc<RwLock<Vec<Mutex<TrackState>>>>,
    workers: Vec<JoinHandle<()>>,
    builder: Option<JoinHandle<()>>,
    builder_cancel: Arc<AtomicBool>,
    stream: Option<Output>,
    loop_region: Option<(u64, u64)>,
    playing: bool,
    /// Section spatial windows as last sent, re-published whenever a track's own pan or width moves.
    spatial_regions: Vec<(String, TrackSpatialRegion)>,
}

pub struct Engine {
    commands: Mutex<Option<Sender<Command>>>,
    rt: Arc<Realtime>,
    join: Mutex<Option<JoinHandle<()>>>,
}

impl Engine {
    pub fn start() -> Self {
        Self::spawn(false)
    }

    pub fn offline() -> Self {
        Self::spawn(true)
    }

    fn spawn(offline: bool) -> Self {
        let rt = Arc::new(Realtime::new(offline));
        let tracks = Arc::new(RwLock::new(Vec::new()));
        let (tx, rx) = mpsc::channel();
        let mut workers = Vec::with_capacity(WORKERS);
        for id in 0..WORKERS {
            let rt = Arc::clone(&rt);
            let tracks = Arc::clone(&tracks);
            workers.push(
                thread::Builder::new()
                    .name(format!("audiosous-read-{id}"))
                    .spawn(move || worker_loop(id, rt, tracks))
                    .expect("reader thread"),
            );
        }
        let rt_control = Arc::clone(&rt);
        let tx_control = tx.clone();
        let join = thread::Builder::new()
            .name("audiosous-audio".into())
            .spawn(move || {
                let mut control = Control {
                    rx,
                    tx: tx_control,
                    rt: rt_control,
                    tracks,
                    workers,
                    builder: None,
                    builder_cancel: Arc::new(AtomicBool::new(false)),
                    stream: None,
                    loop_region: None,
                    playing: false,
                    spatial_regions: Vec::new(),
                };
                control.run();
            })
            .expect("audio control thread");
        Self {
            commands: Mutex::new(Some(tx)),
            rt,
            join: Mutex::new(Some(join)),
        }
    }

    pub fn load(&self, tracks: Vec<LoadedTrack>) -> Result<(), String> {
        let (reply_tx, reply_rx) = mpsc::channel();
        self.send(Command::Load {
            tracks,
            reply: reply_tx,
        })?;
        reply_rx
            .recv()
            .unwrap_or_else(|_| Err("Audio engine stopped.".into()))
    }

    pub fn play(&self, seconds: f64) -> Result<(), String> {
        let (reply_tx, reply_rx) = mpsc::channel();
        self.send(Command::Play {
            seconds,
            reply: reply_tx,
        })?;
        reply_rx
            .recv()
            .unwrap_or_else(|_| Err("Audio engine stopped.".into()))
    }

    pub fn pause(&self) {
        let _ = self.send(Command::Pause);
    }

    pub fn stop(&self) {
        let _ = self.send(Command::Stop);
    }

    pub fn seek(&self, seconds: f64) {
        let _ = self.send(Command::Seek(seconds));
    }

    pub fn set_track(
        &self,
        id: &str,
        gain_db: Option<f32>,
        pan: Option<f32>,
        muted: Option<bool>,
        solo: Option<bool>,
    ) {
        let _ = self.send(Command::SetTrack {
            id: id.to_string(),
            gain_db,
            pan,
            muted,
            solo,
        });
    }

    pub fn set_loop(&self, region: Option<(f64, f64)>) {
        let _ = self.send(Command::SetLoop(region));
    }

    pub fn set_gain_regions(&self, regions: Vec<TrackGainRegion>) {
        let _ = self.send(Command::SetGainRegions(regions));
    }

    /// Replaces every track's EQ. Tracks that are not listed run flat. Changes ramp over about 30 ms.
    pub fn set_eq(&self, tracks: Vec<TrackEq>) {
        let _ = self.send(Command::SetEq(tracks));
    }

    /// Sets pan and width for the listed tracks and replaces every section spatial window.
    /// Tracks that are not listed keep their pan and width. Changes ramp over 30 ms.
    pub fn set_spatial(&self, tracks: Vec<TrackSpatial>) {
        let _ = self.send(Command::SetSpatial(tracks));
    }

    pub fn status(&self) -> EngineStatus {
        status_from(&self.rt)
    }

    pub fn render_block(&self, out: &mut [f32]) {
        process_callback(&self.rt, out);
    }

    pub fn shutdown(&self) {
        let sender = self.commands.lock().ok().and_then(|mut slot| slot.take());
        if let Some(sender) = sender {
            let _ = sender.send(Command::Shutdown);
        }
        if let Some(join) = self.join.lock().ok().and_then(|mut slot| slot.take()) {
            let _ = join.join();
        }
    }

    fn send(&self, command: Command) -> Result<(), String> {
        let guard = self
            .commands
            .lock()
            .map_err(|_| "Audio engine stopped.".to_string())?;
        let sender = guard.as_ref().ok_or("Audio engine stopped.")?;
        sender
            .send(command)
            .map_err(|_| "Audio engine stopped.".to_string())
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        self.shutdown();
    }
}

impl Control {
    fn run(&mut self) {
        while let Ok(command) = self.rx.recv() {
            if self.handle(command) {
                break;
            }
        }
        self.rt.shutdown.store(true, Ordering::Release);
        self.rt.hold.store(true, Ordering::Release);
        self.builder_cancel.store(true, Ordering::Release);
        if let Some(builder) = self.builder.take() {
            let _ = builder.join();
        }
        self.stream.take();
        for worker in self.workers.drain(..) {
            let _ = worker.join();
        }
    }

    fn handle(&mut self, command: Command) -> bool {
        match command {
            Command::Shutdown => true,
            Command::Load { tracks, reply } => {
                let _ = reply.send(self.load(tracks));
                false
            }
            Command::Play { seconds, reply } => {
                let _ = reply.send(self.play(seconds));
                false
            }
            Command::Pause => {
                self.pause();
                false
            }
            Command::Stop => {
                self.stop_transport();
                false
            }
            Command::Seek(seconds) => {
                if self.playing || self.rt.state.load(Ordering::Relaxed) == STATE_PAUSED {
                    let _ = self.reposition(seconds);
                    if self.playing {
                        let _ = self.finish_start();
                    }
                } else {
                    self.rt
                        .prime_frame
                        .store(seconds_to_frame(seconds), Ordering::Relaxed);
                    self.rt.presented.store(0, Ordering::Relaxed);
                }
                false
            }
            Command::SetTrack {
                id,
                gain_db,
                pan,
                muted,
                solo,
            } => {
                self.set_track(&id, gain_db, pan, muted, solo);
                false
            }
            Command::SetLoop(region) => {
                self.loop_region = frame_region(region);
                self.apply_loop_atomics();
                if self.playing {
                    let seconds = position_seconds(&self.rt);
                    let _ = self.reposition(seconds);
                    let _ = self.finish_start();
                }
                false
            }
            Command::SetGainRegions(regions) => {
                self.publish_gain_regions(regions);
                false
            }
            Command::SetEq(tracks) => {
                self.publish_eq(tracks);
                false
            }
            Command::SetSpatial(tracks) => {
                self.set_spatial(tracks);
                false
            }
            Command::ProxyReady {
                load_id,
                index,
                result,
            } => {
                self.note_proxy(load_id, index, result);
                false
            }
        }
    }

    fn load(&mut self, tracks: Vec<LoadedTrack>) -> Result<(), String> {
        if tracks.len() > MAX_TRACKS {
            return Err("Playback supports up to 64 stems.".into());
        }
        self.playing = false;
        self.rt.consume.store(false, Ordering::SeqCst);
        self.rt.audible.store(false, Ordering::SeqCst);
        self.stream.take();
        self.pause_workers();
        let load_id = self.rt.load_id.fetch_add(1, Ordering::AcqRel) + 1;
        {
            let mut slots = self.tracks.write().expect("tracks");
            *slots = tracks
                .iter()
                .map(|track| Mutex::new(TrackState::from_loaded(track)))
                .collect();
            self.rt.wait_audio_idle();
            self.rt.rings.tracks().clear();
            *self.rt.rings.device() = None;
            self.rt.rings.eq().reset();
            self.rt.rings.spatial().reset();
        }
        self.rt.track_count.store(0, Ordering::Release);
        self.rt.proxy_ready.store(0, Ordering::Release);
        self.rt.proxy_total.store(tracks.len(), Ordering::Release);
        self.rt.proxy_percent.store(0, Ordering::Release);
        self.rt.eof_bits.store(0, Ordering::Release);
        self.rt.underruns.store(0, Ordering::Release);
        self.rt.presented.store(0, Ordering::Release);
        self.rt.gain_schedule.publish(&[]);
        self.rt.eq.publish(&EqTable::empty());
        self.spatial_regions.clear();
        for index in 0..MAX_TRACKS {
            self.rt.produced[index].store(0, Ordering::Relaxed);
            self.rt.consumed[index].store(0, Ordering::Relaxed);
        }
        *self.rt.ids.lock().expect("ids") = tracks.iter().map(|track| track.id.clone()).collect();
        self.publish_spatial();
        self.set_state(STATE_STOPPED);
        self.set_message("");
        self.resume_workers();
        self.spawn_builder(load_id, tracks);
        Ok(())
    }

    fn spawn_builder(&mut self, load_id: u64, tracks: Vec<LoadedTrack>) {
        self.builder_cancel.store(true, Ordering::Release);
        if let Some(builder) = self.builder.take() {
            let _ = builder.join();
        }
        let cancel = Arc::new(AtomicBool::new(false));
        self.builder_cancel = Arc::clone(&cancel);
        let tx = self.tx.clone();
        let rt = Arc::clone(&self.rt);
        self.builder = Some(
            thread::Builder::new()
                .name("audiosous-proxy".into())
                .spawn(move || {
                    for (index, track) in tracks.iter().enumerate() {
                        if cancel.load(Ordering::Relaxed) {
                            return;
                        }
                        let label = if track.label.is_empty() {
                            track.id.clone()
                        } else {
                            track.label.clone()
                        };
                        let result = ensure_proxy(
                            &track.source_path,
                            &track.proxy_path,
                            track.source_size,
                            track.source_modified_ns,
                            &cancel,
                            &mut |ratio| {
                                rt.proxy_percent
                                    .store((ratio * 1000.0) as u32, Ordering::Relaxed);
                                *rt.message.lock().expect("message") =
                                    format!("Converting {label} {:.0}%", ratio * 100.0);
                            },
                        )
                        .map(|info| (info.channels, info.frames));
                        let _ = tx.send(Command::ProxyReady {
                            load_id,
                            index,
                            result,
                        });
                    }
                })
                .expect("proxy thread"),
        );
    }

    fn note_proxy(&mut self, load_id: u64, index: usize, result: Result<(u16, u64), String>) {
        if load_id != self.rt.load_id.load(Ordering::Acquire) {
            return;
        }
        let tracks = self.tracks.read().expect("tracks");
        let Some(slot) = tracks.get(index) else {
            return;
        };
        let mut track = slot.lock().expect("track");
        match result {
            Ok((channels, frames)) => {
                track.channels = channels;
                track.frames = frames;
                track.ready = true;
                track.error = None;
                self.rt.proxy_ready.fetch_add(1, Ordering::Release);
                self.rt.duration_frames.fetch_max(frames, Ordering::Relaxed);
            }
            Err(error) => {
                if error != "Playback proxy build was cancelled." {
                    track.error = Some(error);
                }
            }
        }
    }

    fn play(&mut self, mut seconds: f64) -> Result<(), String> {
        if self.track_len() == 0 {
            return Err("Add a stem before playing.".into());
        }
        self.set_state(STATE_PRIMING);
        self.set_message("Preparing playback…");
        loop {
            if let Some(error) = self.proxy_error() {
                self.set_state(STATE_STOPPED);
                return Err(error);
            }
            if self.proxies_ready() {
                break;
            }
            match self.poll(Duration::from_millis(40))? {
                Poll::Continue => {}
                Poll::Abort => {
                    self.pause();
                    return Ok(());
                }
                Poll::Seek(next) => seconds = next,
                Poll::Load(tracks, reply) => {
                    let result = self.load(tracks);
                    let _ = reply.send(result);
                    return Ok(());
                }
            }
        }
        self.playing = true;
        self.reposition(seconds)?;
        self.finish_start()
    }

    fn finish_start(&mut self) -> Result<(), String> {
        self.set_state(STATE_PRIMING);
        self.set_message("Preparing playback…");
        let started = Instant::now();
        loop {
            if self.tracks_primed() {
                break;
            }
            if started.elapsed() > Duration::from_secs(3) {
                break;
            }
            match self.poll(Duration::from_millis(10))? {
                Poll::Continue => {}
                Poll::Abort => {
                    self.pause();
                    return Ok(());
                }
                Poll::Seek(seconds) => {
                    self.reposition(seconds)?;
                    return self.finish_start();
                }
                Poll::Load(tracks, reply) => {
                    let result = self.load(tracks);
                    let _ = reply.send(result);
                    return Ok(());
                }
            }
        }
        self.rt
            .seek_prime_ms
            .store(started.elapsed().as_millis() as u64, Ordering::Relaxed);
        self.rt.consume.store(true, Ordering::SeqCst);
        if self.rt.offline {
            self.rt.audible.store(true, Ordering::Release);
            self.set_state(STATE_PLAYING);
            self.set_message("");
            return Ok(());
        }
        self.ensure_stream()?;
        if self.rt.indirect.load(Ordering::Acquire) {
            let wait = Instant::now();
            while wait.elapsed() < Duration::from_millis(500) {
                if self.rt.rings.device_slots() >= PLAYBACK_RATE as usize {
                    break;
                }
                thread::sleep(Duration::from_millis(5));
            }
        }
        self.rt.audible.store(true, Ordering::Release);
        if let Some(output) = &self.stream {
            output
                .stream
                .play()
                .map_err(|error| format!("Audio output did not start: {error}"))?;
        }
        self.set_state(STATE_PLAYING);
        self.set_message("");
        Ok(())
    }

    fn pause(&mut self) {
        self.playing = false;
        self.rt.audible.store(false, Ordering::SeqCst);
        self.rt.consume.store(false, Ordering::SeqCst);
        if let Some(output) = &self.stream {
            let _ = output.stream.pause();
        }
        self.set_state(STATE_PAUSED);
    }

    fn stop_transport(&mut self) {
        self.pause();
        let _ = self.reposition(0.0);
        self.playing = false;
        self.set_state(STATE_STOPPED);
    }

    fn reposition(&mut self, seconds: f64) -> Result<(), String> {
        self.rt.consume.store(false, Ordering::SeqCst);
        self.rt.audible.store(false, Ordering::SeqCst);
        if let Some(output) = &self.stream {
            let _ = output.stream.pause();
        }
        self.pause_workers();
        self.rt.wait_audio_idle();
        // The output is silent until the rings refill, so pan and width start at their new values.
        self.rt.rings.spatial().snap();
        let frame = seconds_to_frame(seconds);
        self.apply_loop_atomics();
        {
            let tracks = self.tracks.read().expect("tracks");
            let consumers = self.rt.rings.tracks();
            if consumers.len() != tracks.len() {
                consumers.clear();
                for slot in tracks.iter() {
                    let mut track = slot.lock().expect("track");
                    let channels = track.channels.max(1) as usize;
                    let capacity = (RING_SECONDS * PLAYBACK_RATE as usize * channels).max(4096);
                    let (producer, consumer) = RingBuffer::new(capacity);
                    track.producer = Some(producer);
                    consumers.push(consumer);
                }
            }
            self.rt.track_count.store(tracks.len(), Ordering::Release);
            let any_solo = tracks.iter().any(|slot| {
                let track = slot.lock().expect("track");
                track.solo && !track.muted
            });
            for (index, slot) in tracks.iter().enumerate() {
                let mut track = slot.lock().expect("track");
                while consumers[index].pop().is_ok() {}
                let start = frame.min(track.frames);
                open_reader(&mut track, start)?;
                self.rt.produced[index].store(0, Ordering::Relaxed);
                self.rt.consumed[index].store(0, Ordering::Relaxed);
                let ended = track.frames == 0 || start >= track.frames;
                set_eof(&self.rt, index, ended);
                let target = if track.muted || (any_solo && !track.solo) {
                    0.0
                } else {
                    linear_gain(track.gain_db)
                };
                self.rt.gains[index].store(target.to_bits(), Ordering::Relaxed);
            }
            if let Some(device) = self.rt.rings.device().as_mut() {
                while device.pop().is_ok() {}
            }
        }
        self.rt.presented.store(0, Ordering::Relaxed);
        self.rt.prime_frame.store(frame, Ordering::Relaxed);
        self.rt.generation.fetch_add(1, Ordering::AcqRel);
        self.publish_from_tracks();
        self.resume_workers();
        Ok(())
    }

    fn tracks_primed(&self) -> bool {
        let tracks = self.tracks.read().expect("tracks");
        if tracks.is_empty() {
            return false;
        }
        let prime = self.rt.prime_frame.load(Ordering::Relaxed);
        tracks.iter().enumerate().all(|(index, slot)| {
            let track = slot.lock().expect("track");
            let start = prime.min(track.frames);
            let need = PRIME_FRAMES.min(track.frames.saturating_sub(start));
            let fill = self.rt.produced[index]
                .load(Ordering::Relaxed)
                .saturating_sub(self.rt.consumed[index].load(Ordering::Relaxed));
            let eof = self.rt.eof_bits.load(Ordering::Relaxed) & (1 << index) != 0;
            eof || fill >= need
        })
    }

    fn proxies_ready(&self) -> bool {
        let tracks = self.tracks.read().expect("tracks");
        !tracks.is_empty() && tracks.iter().all(|slot| slot.lock().expect("track").ready)
    }

    fn proxy_error(&self) -> Option<String> {
        let tracks = self.tracks.read().expect("tracks");
        tracks
            .iter()
            .find_map(|slot| slot.lock().expect("track").error.clone())
    }

    fn track_len(&self) -> usize {
        self.tracks.read().expect("tracks").len()
    }

    fn set_track(
        &mut self,
        id: &str,
        gain_db: Option<f32>,
        pan: Option<f32>,
        muted: Option<bool>,
        solo: Option<bool>,
    ) {
        let tracks = self.tracks.read().expect("tracks");
        for slot in tracks.iter() {
            let mut track = slot.lock().expect("track");
            if track.id == id {
                if let Some(gain_db) = gain_db {
                    track.gain_db = gain_db;
                }
                if let Some(pan) = pan {
                    track.pan = pan.clamp(-1.0, 1.0);
                }
                if let Some(muted) = muted {
                    track.muted = muted;
                }
                if let Some(solo) = solo {
                    track.solo = solo;
                }
                break;
            }
        }
        drop(tracks);
        self.publish_from_tracks();
        if pan.is_some() {
            self.publish_spatial();
        }
    }

    fn set_spatial(&mut self, updates: Vec<TrackSpatial>) {
        {
            let tracks = self.tracks.read().expect("tracks");
            for update in &updates {
                for slot in tracks.iter() {
                    let mut track = slot.lock().expect("track");
                    if track.id == update.track_id {
                        let params = SpatialParams { pan: update.pan, width: update.width }.sanitized();
                        track.pan = params.pan;
                        track.width = params.width;
                        break;
                    }
                }
            }
        }
        self.spatial_regions = updates
            .into_iter()
            .flat_map(|update| {
                let id = update.track_id;
                update.regions.into_iter().map(move |region| (id.clone(), region))
            })
            .collect();
        self.publish_from_tracks();
        self.publish_spatial();
    }

    /// Whole-song pan and width from the track state, plus the section windows, as one table.
    fn publish_spatial(&self) {
        let ids = self.rt.ids.lock().expect("ids");
        let tracks = self.tracks.read().expect("tracks");
        let base: Vec<(usize, SpatialParams)> = tracks
            .iter()
            .enumerate()
            .take(MAX_TRACKS)
            .map(|(index, slot)| {
                let track = slot.lock().expect("track");
                (index, SpatialParams { pan: track.pan, width: track.width })
            })
            .collect();
        drop(tracks);
        let regions: Vec<SpatialRegionInput> = self
            .spatial_regions
            .iter()
            .filter_map(|(id, region)| {
                let index = ids.iter().position(|item| item == id)?;
                Some(SpatialRegionInput {
                    track_index: index,
                    start_frame: seconds_to_frame(region.start_seconds),
                    end_frame: seconds_to_frame(region.end_seconds),
                    params: SpatialParams { pan: region.pan, width: region.width },
                })
            })
            .collect();
        drop(ids);
        self.rt.spatial.publish(&SpatialTable::build(&base, &regions));
    }

    fn publish_gain_regions(&self, regions: Vec<TrackGainRegion>) {
        let ids = self.rt.ids.lock().expect("ids");
        let mut scheduled = Vec::new();
        for region in regions {
            let Some(index) = ids.iter().position(|id| id == &region.track_id) else {
                continue;
            };
            if index >= MAX_TRACKS || scheduled.len() >= MAX_GAIN_REGIONS {
                continue;
            }
            let start = seconds_to_frame(region.start_seconds);
            let end = seconds_to_frame(region.end_seconds);
            if end <= start {
                continue;
            }
            scheduled.push(GainRegion {
                track_index: index as u8,
                start_frame: start,
                end_frame: end,
                gain: linear_gain(region.gain_db),
            });
        }
        drop(ids);
        self.rt.gain_schedule.publish(&scheduled);
    }

    fn publish_eq(&self, tracks: Vec<TrackEq>) {
        let ids = self.rt.ids.lock().expect("ids");
        let mut owned: Vec<(usize, Vec<FilterSpec>, Vec<(u64, u64, Vec<FilterSpec>)>)> = Vec::new();
        for track in tracks {
            let Some(index) = ids.iter().position(|id| id == &track.track_id) else {
                continue;
            };
            if index >= MAX_TRACKS {
                continue;
            }
            let regions = track
                .regions
                .into_iter()
                .map(|region| {
                    (
                        seconds_to_frame(region.start_seconds),
                        seconds_to_frame(region.end_seconds),
                        region.filters,
                    )
                })
                .filter(|(start, end, _)| end > start)
                .collect();
            owned.push((index, track.filters, regions));
        }
        drop(ids);
        let borrowed: Vec<Vec<(u64, u64, &[FilterSpec])>> = owned
            .iter()
            .map(|(_, _, regions)| {
                regions
                    .iter()
                    .map(|(start, end, filters)| (*start, *end, filters.as_slice()))
                    .collect()
            })
            .collect();
        let inputs: Vec<TrackEqInput<'_>> = owned
            .iter()
            .zip(borrowed.iter())
            .map(|((index, filters, _), regions)| TrackEqInput {
                track_index: *index,
                filters,
                regions,
            })
            .collect();
        self.rt.eq.publish(&EqTable::design(&inputs));
    }

    fn publish_from_tracks(&self) {
        let tracks = self.tracks.read().expect("tracks");
        let mut snap = MixSnapshot::silent();
        snap.count = tracks.len().min(MAX_TRACKS);
        snap.any_solo = tracks.iter().any(|slot| {
            let track = slot.lock().expect("track");
            track.solo && !track.muted
        });
        for (index, slot) in tracks.iter().enumerate().take(MAX_TRACKS) {
            let track = slot.lock().expect("track");
            snap.tracks[index] = TrackMix {
                gain: linear_gain(track.gain_db),
                pan: track.pan,
                mute: track.muted,
                solo: track.solo,
                channels: track.channels.max(1),
                active: track.ready,
            };
        }
        self.rt.published.publish(&snap);
    }

    fn apply_loop_atomics(&self) {
        if let Some((start, end)) = self.loop_region {
            if end > start {
                self.rt.loop_start.store(start, Ordering::Relaxed);
                self.rt.loop_end.store(end, Ordering::Relaxed);
                return;
            }
        }
        self.rt.loop_start.store(0, Ordering::Relaxed);
        self.rt.loop_end.store(NO_LOOP, Ordering::Relaxed);
    }

    fn poll(&mut self, timeout: Duration) -> Result<Poll, String> {
        match self.rx.recv_timeout(timeout) {
            Ok(Command::Seek(seconds)) => Ok(Poll::Seek(seconds)),
            Ok(Command::Pause) | Ok(Command::Stop) => Ok(Poll::Abort),
            Ok(Command::SetTrack {
                id,
                gain_db,
                pan,
                muted,
                solo,
            }) => {
                self.set_track(&id, gain_db, pan, muted, solo);
                Ok(Poll::Continue)
            }
            Ok(Command::SetLoop(region)) => {
                self.loop_region = frame_region(region);
                self.apply_loop_atomics();
                Ok(Poll::Continue)
            }
            Ok(Command::SetGainRegions(regions)) => {
                self.publish_gain_regions(regions);
                Ok(Poll::Continue)
            }
            Ok(Command::SetEq(tracks)) => {
                self.publish_eq(tracks);
                Ok(Poll::Continue)
            }
            Ok(Command::SetSpatial(tracks)) => {
                self.set_spatial(tracks);
                Ok(Poll::Continue)
            }
            Ok(Command::ProxyReady {
                load_id,
                index,
                result,
            }) => {
                self.note_proxy(load_id, index, result);
                Ok(Poll::Continue)
            }
            Ok(Command::Load { tracks, reply }) => Ok(Poll::Load(tracks, reply)),
            Ok(Command::Play { reply, .. }) => {
                let _ = reply.send(Err("Playback is already starting.".into()));
                Ok(Poll::Continue)
            }
            Ok(Command::Shutdown) => Err("Audio engine stopped.".into()),
            Err(mpsc::RecvTimeoutError::Timeout) => Ok(Poll::Continue),
            Err(mpsc::RecvTimeoutError::Disconnected) => Err("Audio engine stopped.".into()),
        }
    }

    fn pause_workers(&self) {
        self.rt.hold.store(true, Ordering::Release);
        while self.rt.busy.load(Ordering::Acquire) > 0 {
            thread::sleep(Duration::from_millis(1));
        }
    }

    fn resume_workers(&self) {
        self.rt.hold.store(false, Ordering::Release);
    }

    fn ensure_stream(&mut self) -> Result<(), String> {
        if self.stream.is_some() || self.rt.offline {
            return Ok(());
        }
        let output = open_output(Arc::clone(&self.rt))?;
        self.stream = Some(output);
        Ok(())
    }

    fn set_state(&self, state: u8) {
        self.rt.state.store(state, Ordering::Release);
    }

    fn set_message(&self, message: &str) {
        *self.rt.message.lock().expect("message") = message.to_string();
    }
}

fn worker_loop(id: usize, rt: Arc<Realtime>, tracks: Arc<RwLock<Vec<Mutex<TrackState>>>>) {
    loop {
        if rt.shutdown.load(Ordering::Acquire) {
            break;
        }
        if rt.hold.load(Ordering::Acquire) {
            thread::sleep(Duration::from_millis(2));
            continue;
        }
        rt.busy.fetch_add(1, Ordering::AcqRel);
        if rt.hold.load(Ordering::Acquire) || rt.shutdown.load(Ordering::Acquire) {
            rt.busy.fetch_sub(1, Ordering::AcqRel);
            continue;
        }
        let mut worked = false;
        {
            let slots = tracks.read().expect("tracks");
            let generation = rt.generation.load(Ordering::Acquire);
            for index in (id..slots.len()).step_by(WORKERS) {
                if rt.hold.load(Ordering::Acquire)
                    || rt.generation.load(Ordering::Acquire) != generation
                {
                    break;
                }
                let mut track = slots[index].lock().expect("track");
                worked |= read_block(&rt, index, generation, &mut track);
            }
        }
        rt.busy.fetch_sub(1, Ordering::AcqRel);
        if !worked {
            thread::sleep(Duration::from_millis(2));
        }
    }
}

fn read_block(rt: &Realtime, index: usize, generation: u64, track: &mut TrackState) -> bool {
    let Some(producer) = track.producer.as_mut() else {
        return false;
    };
    if !track.ready || track.channels == 0 {
        return false;
    }
    let channels = track.channels as usize;
    let fill = rt.produced[index]
        .load(Ordering::Relaxed)
        .saturating_sub(rt.consumed[index].load(Ordering::Relaxed));
    if fill >= TARGET_FRAMES {
        return false;
    }
    if rt.eof_bits.load(Ordering::Relaxed) & (1 << index) != 0 {
        return false;
    }
    let free_frames = producer.slots() / channels;
    if free_frames < 1024 && fill > 0 {
        return false;
    }
    let loop_end = rt.loop_end.load(Ordering::Relaxed);
    let loop_start = rt.loop_start.load(Ordering::Relaxed);
    if loop_end != NO_LOOP && track.cursor >= loop_end {
        let restart = loop_start.min(track.frames);
        if open_reader(track, restart).is_err() {
            return false;
        }
    }
    if track.cursor >= track.frames {
        if loop_end != NO_LOOP && loop_start < track.frames {
            let _ = open_reader(track, loop_start.min(track.frames));
            return true;
        }
        set_eof(rt, index, true);
        return false;
    }
    let mut want = free_frames.min(READ_FRAMES).max(1);
    if loop_end != NO_LOOP && track.cursor < loop_end {
        want = want.min((loop_end - track.cursor) as usize);
    }
    want = want.min((track.frames - track.cursor) as usize);
    if want == 0 {
        set_eof(rt, index, true);
        return false;
    }
    let start_cursor = track.cursor;
    let read = match track.reader.as_mut() {
        Some(reader) => reader.read_interleaved(want, &mut track.scratch),
        None => open_reader(track, track.cursor).and_then(|_| {
            track
                .reader
                .as_mut()
                .unwrap()
                .read_interleaved(want, &mut track.scratch)
        }),
    };
    let Ok(count) = read else {
        return false;
    };
    if count == 0 {
        set_eof(rt, index, loop_end == NO_LOOP);
        return false;
    }
    if rt.hold.load(Ordering::Acquire) || rt.generation.load(Ordering::Acquire) != generation {
        let _ = open_reader(track, start_cursor);
        return false;
    }
    let samples = count * channels;
    let pushed = push_samples(track.producer.as_mut().unwrap(), &track.scratch[..samples]);
    if pushed < samples {
        let frames_pushed = pushed / channels;
        let _ = open_reader(track, start_cursor + frames_pushed as u64);
        rt.produced[index].fetch_add(frames_pushed as u64, Ordering::Relaxed);
        return frames_pushed > 0;
    }
    track.cursor = start_cursor + count as u64;
    rt.produced[index].fetch_add(count as u64, Ordering::Relaxed);
    if loop_end == NO_LOOP && track.cursor >= track.frames {
        set_eof(rt, index, true);
    }
    true
}

fn open_reader(track: &mut TrackState, frame: u64) -> Result<(), String> {
    if track.reader.is_none() {
        let (_header, reader) = ProxyReader::open(&track.proxy_path)?;
        track.reader = Some(reader);
    }
    let frame = frame.min(track.frames);
    track.reader.as_mut().expect("reader").seek_frame(frame)?;
    track.cursor = frame;
    Ok(())
}

fn push_samples(producer: &mut Producer<f32>, data: &[f32]) -> usize {
    let count = data.len().min(producer.slots());
    if count == 0 {
        return 0;
    }
    let Ok(mut chunk) = producer.write_chunk_uninit(count) else {
        return 0;
    };
    let (first, second) = chunk.as_mut_slices();
    let mut cursor = 0;
    for slot in first.iter_mut().chain(second.iter_mut()) {
        if cursor >= count {
            break;
        }
        slot.write(data[cursor]);
        cursor += 1;
    }
    // Every slot in the chunk was initialized above.
    unsafe { chunk.commit_all() };
    count
}

fn pull_frame(consumer: &mut Consumer<f32>, channels: usize, dst: &mut [f32]) -> bool {
    if consumer.slots() < channels {
        return false;
    }
    let Ok(chunk) = consumer.read_chunk(channels) else {
        return false;
    };
    let (first, second) = chunk.as_slices();
    let mut index = 0;
    for sample in first.iter().chain(second.iter()) {
        if index >= channels {
            break;
        }
        dst[index] = *sample;
        index += 1;
    }
    chunk.commit_all();
    true
}

/// Device callback. Reads ring consumers, atomics, and the published mix.
/// It does not allocate, free, lock, read files, resample, log, or call out of process.
/// `Instant::now` records callback duration for the diagnostics panel.
fn process_callback(rt: &Realtime, out: &mut [f32]) {
    rt.in_callback.store(true, Ordering::SeqCst);
    if !rt.audible.load(Ordering::SeqCst) || !rt.consume.load(Ordering::SeqCst) {
        out.fill(0.0);
        rt.in_callback.store(false, Ordering::SeqCst);
        return;
    }
    let started = Instant::now();
    if rt.indirect.load(Ordering::Acquire) {
        copy_device(rt, out);
    } else {
        let frames = out.len() / 2;
        let mix = rt.published.load();
        let (underruns, track) = mix_consumers(rt, rt.rings.tracks(), &mix, out);
        if underruns > 0 {
            rt.underruns.fetch_add(underruns, Ordering::Relaxed);
            if let Some(track) = track {
                rt.last_underrun.store(track, Ordering::Relaxed);
            }
        }
        rt.presented.fetch_add(frames as u64, Ordering::Relaxed);
    }
    rt.callback_nanos
        .store(started.elapsed().as_nanos() as u64, Ordering::Relaxed);
    rt.callback_frames
        .store((out.len() / 2) as u32, Ordering::Relaxed);
    rt.in_callback.store(false, Ordering::SeqCst);
}

fn copy_device(rt: &Realtime, out: &mut [f32]) {
    let Some(consumer) = rt.rings.device().as_mut() else {
        out.fill(0.0);
        return;
    };
    let frames = out.len() / 2;
    let available = consumer.slots() / 2;
    let take = available.min(frames);
    if take < frames {
        rt.underruns.fetch_add(1, Ordering::Relaxed);
    }
    if take > 0 {
        if let Ok(chunk) = consumer.read_chunk(take * 2) {
            let (first, second) = chunk.as_slices();
            let mut index = 0;
            for sample in first.iter().chain(second.iter()) {
                if index < take * 2 {
                    out[index] = *sample;
                    index += 1;
                }
            }
            chunk.commit_all();
        }
    }
    for sample in &mut out[take * 2..] {
        *sample = 0.0;
    }
}

fn mix_consumers(
    rt: &Realtime,
    consumers: &mut [Consumer<f32>],
    mix: &MixSnapshot,
    out: &mut [f32],
) -> (u64, Option<usize>) {
    let mut gains = [0.0_f32; MAX_TRACKS];
    for index in 0..mix.count.min(MAX_TRACKS) {
        gains[index] = f32::from_bits(rt.gains[index].load(Ordering::Relaxed));
    }
    let schedule = rt.gain_schedule.load();
    let eq = rt.rings.eq();
    eq.refresh(&rt.eq);
    let spatial = rt.rings.spatial();
    spatial.refresh(&rt.spatial);
    let origin = rt
        .prime_frame
        .load(Ordering::Relaxed)
        .saturating_add(rt.presented.load(Ordering::Relaxed));
    let loop_start = rt.loop_start.load(Ordering::Relaxed);
    let loop_end = rt.loop_end.load(Ordering::Relaxed);
    let eof_bits = rt.eof_bits.load(Ordering::Relaxed);
    let step = 1.0 / (0.01 * PLAYBACK_RATE as f32);
    let frames = out.len() / 2;
    let mut underruns = 0_u64;
    let mut underrun_track = None;
    let mut counted = [false; MAX_TRACKS];
    let mut pulled = [0_u64; MAX_TRACKS];
    // Tracks whose width and pan hold for the whole block skip per-frame spatial bookkeeping.
    let mut constant = [None; MAX_TRACKS];
    if frames > 0 {
        let first = playback_frame(origin, 0, loop_start, loop_end);
        let last = playback_frame(origin, frames as u64 - 1, loop_start, loop_end);
        if last >= first && last - first == frames as u64 - 1 {
            for (track_index, slot) in constant.iter_mut().enumerate().take(mix.count.min(consumers.len()).min(MAX_TRACKS)) {
                *slot = spatial.block_constant(track_index, first, last);
            }
        }
    }
    for frame in 0..frames {
        let mut left = 0.0;
        let mut right = 0.0;
        for track_index in 0..mix.count.min(consumers.len()).min(MAX_TRACKS) {
            let track = mix.tracks[track_index];
            if !track.active {
                continue;
            }
            let audible = !track.mute && (!mix.any_solo || track.solo);
            let file_frame = playback_frame(origin, frame as u64, loop_start, loop_end);
            let mut target = if audible { track.gain } else { 0.0 };
            if audible {
                if let Some(gain) = scheduled_linear_gain(&schedule, track_index, file_frame) {
                    target = gain;
                }
            }
            let delta = target - gains[track_index];
            gains[track_index] += delta.clamp(-step, step);
            let channels = (track.channels as usize).clamp(1, 2);
            let mut sample = [0.0_f32; 2];
            if pull_frame(&mut consumers[track_index], channels, &mut sample) {
                pulled[track_index] += 1;
                // Per-track process stage: static EQ, then width and pan/balance, then the fader.
                if eq.track_live(track_index) {
                    eq.process(track_index, file_frame, channels, &mut sample);
                }
                let (placed_left, placed_right) = match constant[track_index] {
                    Some((width, coefs)) => spatial_frame(channels, sample, width, coefs),
                    None => spatial.process(track_index, file_frame, channels, sample),
                };
                let gain = gains[track_index];
                left += placed_left * gain;
                right += placed_right * gain;
            } else if eof_bits & (1 << track_index) == 0 && !counted[track_index] {
                counted[track_index] = true;
                underruns += 1;
                if underrun_track.is_none() {
                    underrun_track = Some(track_index);
                }
            }
        }
        out[frame * 2] = left;
        out[frame * 2 + 1] = right;
    }
    for track_index in 0..mix.count.min(MAX_TRACKS) {
        if pulled[track_index] > 0 {
            rt.consumed[track_index].fetch_add(pulled[track_index], Ordering::Relaxed);
        }
        rt.gains[track_index].store(gains[track_index].to_bits(), Ordering::Relaxed);
    }
    (underruns, underrun_track)
}

fn copy_device_space(producer: &mut Producer<f32>, samples: &[f32]) {
    let mut offset = 0;
    while offset < samples.len() {
        let count = (samples.len() - offset).min(producer.slots());
        if count == 0 {
            break;
        }
        let Ok(mut chunk) = producer.write_chunk_uninit(count) else {
            break;
        };
        let (first, second) = chunk.as_mut_slices();
        let mut cursor = offset;
        for slot in first.iter_mut().chain(second.iter_mut()) {
            if cursor >= offset + count {
                break;
            }
            slot.write(samples[cursor]);
            cursor += 1;
        }
        // Every slot in the chunk was initialized above.
        unsafe { chunk.commit_all() };
        offset += count;
    }
}

fn open_output(rt: Arc<Realtime>) -> Result<Output, String> {
    let host = cpal::default_host();
    let device = host
        .default_output_device()
        .ok_or("No audio output device is available.")?;
    let configs: Vec<_> = device
        .supported_output_configs()
        .map_err(|error| error.to_string())?
        .collect();
    let float_48 = configs.iter().find(|range| {
        range.channels() >= 2
            && range.sample_format() == SampleFormat::F32
            && range.min_sample_rate().0 <= PLAYBACK_RATE
            && range.max_sample_rate().0 >= PLAYBACK_RATE
    });
    if let Some(range) = float_48 {
        let config = range.with_sample_rate(SampleRate(PLAYBACK_RATE)).config();
        return build_f32_stream(device, config, rt, false);
    }
    if let Some(range) = configs
        .iter()
        .find(|range| range.channels() >= 2 && range.sample_format() == SampleFormat::F32)
    {
        let rate = range
            .max_sample_rate()
            .min(range.min_sample_rate().max(SampleRate(PLAYBACK_RATE)));
        let preferred =
            if range.min_sample_rate().0 <= 48_000 && range.max_sample_rate().0 >= 48_000 {
                SampleRate(48_000)
            } else {
                range.max_sample_rate()
            };
        let _ = rate;
        let config = range.with_sample_rate(preferred).config();
        let resample = config.sample_rate.0 != PLAYBACK_RATE;
        return build_f32_stream(device, config, rt, resample);
    }
    if let Some(range) = configs
        .iter()
        .find(|range| range.channels() >= 2 && range.sample_format() == SampleFormat::I16)
    {
        let preferred = if range.min_sample_rate().0 <= PLAYBACK_RATE
            && range.max_sample_rate().0 >= PLAYBACK_RATE
        {
            SampleRate(PLAYBACK_RATE)
        } else {
            range.max_sample_rate()
        };
        let config = range.with_sample_rate(preferred).config();
        let resample = config.sample_rate.0 != PLAYBACK_RATE;
        return build_i16_stream(device, config, rt, resample);
    }
    Err("The audio device has no stereo float or 16-bit output.".into())
}

fn build_f32_stream(
    device: cpal::Device,
    mut config: StreamConfig,
    rt: Arc<Realtime>,
    resample: bool,
) -> Result<Output, String> {
    config.channels = 2;
    rt.output_rate
        .store(config.sample_rate.0, Ordering::Relaxed);
    rt.device_format.store(FORMAT_F32, Ordering::Relaxed);
    rt.indirect.store(resample, Ordering::Release);
    let (mixer_stop, mixer) = start_mixer_if_needed(&rt, resample, config.sample_rate.0);
    let callback_rt = Arc::clone(&rt);
    let stream = device
        .build_output_stream(
            &config,
            move |data: &mut [f32], _| process_callback(&callback_rt, data),
            move |error| {
                let _ = error;
                rt.device_fault.store(1, Ordering::Relaxed);
            },
            None,
        )
        .map_err(|error| format!("Could not open the audio device: {error}"))?;
    let _ = stream.pause();
    Ok(Output {
        stream,
        mixer_stop,
        mixer,
    })
}

fn build_i16_stream(
    device: cpal::Device,
    mut config: StreamConfig,
    rt: Arc<Realtime>,
    _resample: bool,
) -> Result<Output, String> {
    config.channels = 2;
    rt.output_rate
        .store(config.sample_rate.0, Ordering::Relaxed);
    rt.device_format.store(FORMAT_I16, Ordering::Relaxed);
    rt.indirect.store(true, Ordering::Release);
    let (mixer_stop, mixer) = start_mixer_if_needed(&rt, true, config.sample_rate.0);
    let callback_rt = Arc::clone(&rt);
    let mut scratch = vec![0.0_f32; 8_192];
    let stream = device
        .build_output_stream(
            &config,
            move |data: &mut [i16], _| {
                callback_rt.in_callback.store(true, Ordering::SeqCst);
                let started = Instant::now();
                if !callback_rt.audible.load(Ordering::SeqCst)
                    || !callback_rt.consume.load(Ordering::SeqCst)
                {
                    data.fill(0);
                    callback_rt.in_callback.store(false, Ordering::SeqCst);
                    return;
                }
                let mut offset = 0;
                while offset < data.len() {
                    let count = (data.len() - offset).min(scratch.len()) & !1;
                    if count == 0 {
                        break;
                    }
                    copy_device(&callback_rt, &mut scratch[..count]);
                    for (dst, sample) in data[offset..offset + count].iter_mut().zip(scratch.iter())
                    {
                        *dst = (sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
                    }
                    offset += count;
                }
                callback_rt
                    .callback_nanos
                    .store(started.elapsed().as_nanos() as u64, Ordering::Relaxed);
                callback_rt
                    .callback_frames
                    .store((data.len() / 2) as u32, Ordering::Relaxed);
                callback_rt.in_callback.store(false, Ordering::SeqCst);
            },
            move |error| {
                let _ = error;
                rt.device_fault.store(1, Ordering::Relaxed);
            },
            None,
        )
        .map_err(|error| format!("Could not open the audio device: {error}"))?;
    let _ = stream.pause();
    Ok(Output {
        stream,
        mixer_stop,
        mixer,
    })
}

fn start_mixer_if_needed(
    rt: &Arc<Realtime>,
    enabled: bool,
    device_rate: u32,
) -> (Arc<AtomicBool>, Option<JoinHandle<()>>) {
    let stop = Arc::new(AtomicBool::new(false));
    if !enabled {
        return (stop, None);
    }
    let capacity = (device_rate as usize * 2 * 2).max(4096);
    let (mut producer, consumer) = RingBuffer::<f32>::new(capacity);
    *rt.rings.device() = Some(consumer);
    let rt = Arc::clone(rt);
    let stop_flag = Arc::clone(&stop);
    let mixer = thread::Builder::new()
        .name("audiosous-mix".into())
        .spawn(move || mixer_loop(&rt, &stop_flag, &mut producer, device_rate))
        .expect("mix thread");
    (stop, Some(mixer))
}

fn mixer_loop(rt: &Realtime, stop: &AtomicBool, producer: &mut Producer<f32>, device_rate: u32) {
    let mut mixed = vec![0.0_f32; 2048];
    let mut resampler = if device_rate == PLAYBACK_RATE {
        None
    } else {
        SincFixedIn::<f32>::new(
            f64::from(device_rate) / f64::from(PLAYBACK_RATE),
            2.0,
            SincInterpolationParameters {
                sinc_len: 32,
                f_cutoff: 0.95,
                interpolation: SincInterpolationType::Linear,
                oversampling_factor: 32,
                window: WindowFunction::BlackmanHarris2,
            },
            1024,
            2,
        )
        .ok()
    };
    let mut planar = [Vec::with_capacity(1024), Vec::with_capacity(1024)];
    let mut output = resampler
        .as_ref()
        .map(|resampler| resampler.output_buffer_allocate(true));
    let max_out = output
        .as_ref()
        .map(|channels| {
            channels
                .iter()
                .map(|channel| channel.capacity())
                .max()
                .unwrap_or(1024)
        })
        .unwrap_or(1024);
    let mut interleaved = Vec::with_capacity(max_out.saturating_mul(2).max(mixed.len()));
    while !stop.load(Ordering::Acquire) && !rt.shutdown.load(Ordering::Acquire) {
        rt.mixer_busy.store(true, Ordering::SeqCst);
        if rt.hold.load(Ordering::Acquire) || !rt.consume.load(Ordering::SeqCst) {
            rt.mixer_busy.store(false, Ordering::SeqCst);
            thread::sleep(Duration::from_millis(2));
            continue;
        }
        let mix = rt.published.load();
        let (underruns, track) = mix_consumers(rt, rt.rings.tracks(), &mix, &mut mixed);
        if underruns > 0 {
            rt.underruns.fetch_add(underruns, Ordering::Relaxed);
            if let Some(track) = track {
                rt.last_underrun.store(track, Ordering::Relaxed);
            }
        }
        rt.presented
            .fetch_add((mixed.len() / 2) as u64, Ordering::Relaxed);
        if let Some(resampler) = resampler.as_mut() {
            let frames = mixed.len() / 2;
            planar[0].clear();
            planar[1].clear();
            planar[0].resize(frames, 0.0);
            planar[1].resize(frames, 0.0);
            for frame in 0..frames {
                planar[0][frame] = mixed[frame * 2];
                planar[1][frame] = mixed[frame * 2 + 1];
            }
            if let Some(output) = output.as_mut() {
                if let Ok((_used, produced)) = resampler.process_into_buffer(&planar, output, None)
                {
                    interleaved.clear();
                    interleaved.resize(produced * 2, 0.0);
                    for frame in 0..produced {
                        interleaved[frame * 2] = output[0].get(frame).copied().unwrap_or(0.0);
                        interleaved[frame * 2 + 1] = output[1].get(frame).copied().unwrap_or(0.0);
                    }
                    copy_device_space(producer, &interleaved);
                }
            }
        } else {
            copy_device_space(producer, &mixed);
        }
        rt.mixer_busy.store(false, Ordering::SeqCst);
    }
}

fn set_eof(rt: &Realtime, index: usize, eof: bool) {
    if index >= 63 {
        return;
    }
    if eof {
        rt.eof_bits.fetch_or(1 << index, Ordering::Relaxed);
    } else {
        rt.eof_bits.fetch_and(!(1 << index), Ordering::Relaxed);
    }
}

fn frame_region(region: Option<(f64, f64)>) -> Option<(u64, u64)> {
    region.and_then(|(start, end)| {
        let start = seconds_to_frame(start);
        let end = seconds_to_frame(end);
        (end > start).then_some((start, end))
    })
}

fn seconds_to_frame(seconds: f64) -> u64 {
    if !seconds.is_finite() || seconds <= 0.0 {
        0
    } else {
        (seconds * f64::from(PLAYBACK_RATE)).round() as u64
    }
}

fn playback_frame(origin: u64, offset: u64, loop_start: u64, loop_end: u64) -> u64 {
    let mut frame = origin.saturating_add(offset);
    if loop_end != NO_LOOP && loop_end > loop_start && frame >= loop_end {
        let length = loop_end - loop_start;
        if length > 0 {
            frame = loop_start + (frame - loop_start) % length;
        }
    }
    frame
}

fn position_seconds(rt: &Realtime) -> f64 {
    let mut frame = rt
        .prime_frame
        .load(Ordering::Relaxed)
        .saturating_add(rt.presented.load(Ordering::Relaxed));
    let end = rt.loop_end.load(Ordering::Relaxed);
    let start = rt.loop_start.load(Ordering::Relaxed);
    if end != NO_LOOP && end > start && frame >= end {
        let length = end - start;
        frame = start + (frame - start) % length;
    }
    frame as f64 / f64::from(PLAYBACK_RATE)
}

fn status_from(rt: &Realtime) -> EngineStatus {
    let count = rt.track_count.load(Ordering::Relaxed);
    let mut min_fill = f64::MAX;
    let mut total_fill = 0.0;
    let mut backlog = 0;
    let measured = count.min(MAX_TRACKS);
    for index in 0..measured {
        let fill = rt.produced[index]
            .load(Ordering::Relaxed)
            .saturating_sub(rt.consumed[index].load(Ordering::Relaxed));
        let seconds = fill as f64 / f64::from(PLAYBACK_RATE);
        min_fill = min_fill.min(seconds);
        total_fill += seconds;
        let eof = rt.eof_bits.load(Ordering::Relaxed) & (1 << index) != 0;
        if !eof && fill < PRIME_FRAMES {
            backlog += 1;
        }
    }
    if measured == 0 {
        min_fill = 0.0;
    }
    let callback_frames = rt.callback_frames.load(Ordering::Relaxed);
    let rate = rt.output_rate.load(Ordering::Relaxed).max(1);
    let underrun_index = rt.last_underrun.load(Ordering::Relaxed);
    let last_underrun_track = rt
        .ids
        .lock()
        .ok()
        .and_then(|ids| ids.get(underrun_index).cloned())
        .unwrap_or_default();
    let mut message = rt
        .message
        .lock()
        .ok()
        .map(|message| message.clone())
        .unwrap_or_default();
    if message.is_empty() && rt.device_fault.load(Ordering::Relaxed) != 0 {
        message = "The audio device stopped.".into();
    }
    let device_format = match rt.device_format.load(Ordering::Relaxed) {
        FORMAT_I16 => "i16",
        FORMAT_F32 => "f32",
        _ => "",
    };
    EngineStatus {
        state: match rt.state.load(Ordering::Relaxed) {
            STATE_PRIMING => "priming",
            STATE_PLAYING => "playing",
            STATE_PAUSED => "paused",
            _ => "stopped",
        }
        .into(),
        position_seconds: position_seconds(rt),
        duration_seconds: rt.duration_frames.load(Ordering::Relaxed) as f64
            / f64::from(PLAYBACK_RATE),
        output_sample_rate: rate,
        callback_frames,
        active_tracks: count,
        proxy_ready_tracks: rt.proxy_ready.load(Ordering::Relaxed),
        proxy_total_tracks: rt.proxy_total.load(Ordering::Relaxed),
        buffered_ahead_min: if min_fill.is_finite() { min_fill } else { 0.0 },
        buffered_ahead_avg: if measured == 0 {
            0.0
        } else {
            total_fill / measured as f64
        },
        underruns: rt.underruns.load(Ordering::Relaxed),
        last_underrun_track,
        reader_backlog: backlog,
        seek_prime_ms: rt.seek_prime_ms.load(Ordering::Relaxed),
        callback_ms: rt.callback_nanos.load(Ordering::Relaxed) as f64 / 1_000_000.0,
        callback_budget_ms: if callback_frames == 0 {
            0.0
        } else {
            f64::from(callback_frames) / f64::from(rate) * 1000.0
        },
        device_format: device_format.into(),
        proxy_percent: rt.proxy_percent.load(Ordering::Relaxed) as f32 / 10.0,
        message,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proxy::ensure_proxy;
    use std::env;
    use std::fs;

    fn write_wav(path: &std::path::Path, frames: usize, sample: impl Fn(usize) -> f32) {
        let mut body = Vec::with_capacity(44 + frames * 4);
        let data_bytes = (frames * 4) as u32;
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
        for frame in 0..frames {
            body.extend_from_slice(&sample(frame).to_le_bytes());
        }
        fs::write(path, body).unwrap();
    }

    fn track(
        dir: &std::path::Path,
        name: &str,
        frames: usize,
        sample: impl Fn(usize) -> f32,
    ) -> LoadedTrack {
        let source = dir.join(format!("{name}.wav"));
        let proxy = dir.join(format!("{name}.proxy"));
        write_wav(&source, frames, sample);
        let size = fs::metadata(&source).unwrap().len();
        ensure_proxy(
            &source,
            &proxy,
            size,
            1,
            &AtomicBool::new(false),
            &mut |_| {},
        )
        .unwrap();
        LoadedTrack {
            id: name.into(),
            label: name.into(),
            source_path: source,
            proxy_path: proxy,
            source_size: size,
            source_modified_ns: 1,
            gain_db: 0.0,
            pan: 0.0,
            width: 1.0,
            muted: false,
            solo: false,
        }
    }

    #[test]
    fn playback_stays_aligned_seeks_and_loops_without_the_control_thread() {
        let dir = env::temp_dir().join(format!("audiosous-engine-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let frames = 48_000;
        let left = track(
            &dir,
            "left",
            frames,
            |frame| if frame < 4_800 { 1.0 } else { 0.2 },
        );
        let right = track(&dir, "right", frames, |_| 0.2);
        let engine = Engine::offline();
        engine.load(vec![left, right]).unwrap();
        engine.set_track("left", Some(0.0), Some(-1.0), Some(false), Some(false));
        engine.set_track("right", Some(0.0), Some(1.0), Some(false), Some(false));
        engine.play(0.0).unwrap();
        let mut block = vec![0.0_f32; 960];
        engine.render_block(&mut block);
        let left_peak = block
            .iter()
            .step_by(2)
            .map(|sample| sample.abs())
            .fold(0.0_f32, f32::max);
        let right_level = block[1].abs();
        assert!(left_peak > 0.5, "left stem missing, peak {left_peak}");
        assert!(right_level > 0.05, "right stem missing");
        let before = engine.status().underruns;
        engine.render_block(&mut block);
        assert_eq!(engine.status().underruns, before);

        engine.seek(0.2);
        thread::sleep(Duration::from_millis(80));
        let mut later = vec![0.0_f32; 960];
        engine.render_block(&mut later);
        let late_peak = later
            .iter()
            .step_by(2)
            .map(|sample| sample.abs())
            .fold(0.0_f32, f32::max);
        assert!(
            late_peak < 0.5,
            "seek played the file opening, peak {late_peak}"
        );
        let position = engine.status().position_seconds;
        assert!(position > 0.15 && position < 0.35, "position {position}");

        engine.set_loop(Some((0.0, 0.5)));
        thread::sleep(Duration::from_millis(50));
        let mut long = vec![0.0_f32; 48_000];
        engine.render_block(&mut long);
        let wrapped = engine.status().position_seconds;
        assert!(wrapped < 0.55, "loop did not wrap, position {wrapped}");
        let _ = fs::remove_dir_all(&dir);
    }

    mod counting {
        use std::alloc::{GlobalAlloc, Layout, System};
        use std::cell::Cell;

        thread_local! {
            static WATCHING: Cell<bool> = const { Cell::new(false) };
            static COUNT: Cell<usize> = const { Cell::new(0) };
        }

        /// Counts allocations made by the watching thread only. Other threads are untouched.
        pub struct Counting;

        unsafe impl GlobalAlloc for Counting {
            unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
                note();
                System.alloc(layout)
            }
            unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
                note();
                System.dealloc(ptr, layout)
            }
            unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, size: usize) -> *mut u8 {
                note();
                System.realloc(ptr, layout, size)
            }
        }

        fn note() {
            let _ = WATCHING.try_with(|watching| {
                if watching.get() {
                    let _ = COUNT.try_with(|count| count.set(count.get() + 1));
                }
            });
        }

        pub fn watch<T>(run: impl FnOnce() -> T) -> (T, usize) {
            COUNT.with(|count| count.set(0));
            WATCHING.with(|watching| watching.set(true));
            let value = run();
            WATCHING.with(|watching| watching.set(false));
            (value, COUNT.with(Cell::get))
        }
    }

    #[global_allocator]
    static ALLOCATOR: counting::Counting = counting::Counting;

    /// The callback path with EQ on: no allocation or free, including a new EQ table and section boundaries.
    #[test]
    fn callback_with_eq_does_not_allocate() {
        use crate::eq::{FilterKind, FilterSpec};
        let dir = env::temp_dir().join(format!("audiosous-eq-alloc-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let tracks: Vec<LoadedTrack> = (0..8)
            .map(|index| track(&dir, &format!("t{index}"), 48_000 * 3, |frame| ((frame % 97) as f32 / 97.0) - 0.5))
            .collect();
        let engine = Engine::offline();
        engine.load(tracks).unwrap();
        let bell = |gain_db: f32| FilterSpec {
            kind: FilterKind::Bell,
            frequency_hz: 2_400.0,
            gain_db,
            q: 1.0,
        };
        let table = |gain_db: f32| -> Vec<TrackEq> {
            (0..8)
                .map(|index| TrackEq {
                    track_id: format!("t{index}"),
                    filters: vec![
                        bell(gain_db),
                        FilterSpec {
                            kind: FilterKind::HighPass,
                            frequency_hz: 60.0,
                            gain_db: 0.0,
                            q: 0.707,
                        },
                    ],
                    regions: vec![TrackEqRegion {
                        start_seconds: 0.3,
                        end_seconds: 0.6,
                        filters: vec![bell(-2.0)],
                    }],
                })
                .collect()
        };
        engine.set_eq(table(-1.5));
        engine.play(0.0).unwrap();
        let mut block = vec![0.0_f32; 1_024];
        engine.render_block(&mut block);
        let ((), first) = counting::watch(|| {
            for _ in 0..40 {
                engine.render_block(&mut block);
            }
        });
        engine.set_eq(table(-3.0));
        thread::sleep(Duration::from_millis(30));
        let ((), second) = counting::watch(|| {
            for _ in 0..20 {
                engine.render_block(&mut block);
            }
        });
        let ((), probe) = counting::watch(|| drop(std::hint::black_box(vec![0_u8; 16])));
        assert!(probe >= 1, "the allocation counter is not counting");
        assert_eq!(first, 0, "callback allocated {first} times");
        assert_eq!(second, 0, "callback allocated {second} times after an EQ update");
        assert!(block.iter().all(|sample| sample.is_finite()));
        engine.shutdown();
        let _ = fs::remove_dir_all(&dir);
    }

    /// EQ sits between the ring and the fader: a bell on one stem changes that stem only, a section band
    /// applies inside its window only, and the gain still scales the filtered signal.
    #[test]
    fn track_and_section_eq_play_through_the_mix() {
        use crate::eq::{FilterKind, FilterSpec};
        let dir = env::temp_dir().join(format!("audiosous-eq-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let tone = |frame: usize| (2.0 * std::f32::consts::PI * 1_000.0 * frame as f32 / 48_000.0).sin() * 0.5;
        let frames = 48_000 * 4;
        let cut = track(&dir, "cut", frames, tone);
        let flat = track(&dir, "flat", frames, tone);
        let engine = Engine::offline();
        engine.load(vec![cut, flat]).unwrap();
        engine.set_track("cut", Some(0.0), Some(-1.0), Some(false), Some(false));
        engine.set_track("flat", Some(-6.0), Some(1.0), Some(false), Some(false));
        let bell = FilterSpec {
            kind: FilterKind::Bell,
            frequency_hz: 1_000.0,
            gain_db: -6.0,
            q: 1.0,
        };
        engine.set_eq(vec![
            TrackEq {
                track_id: "cut".into(),
                filters: vec![bell],
                regions: vec![],
            },
            TrackEq {
                track_id: "flat".into(),
                filters: vec![],
                regions: vec![TrackEqRegion {
                    start_seconds: 2.0,
                    end_seconds: 3.0,
                    filters: vec![bell],
                }],
            },
            TrackEq {
                track_id: "unknown".into(),
                filters: vec![bell],
                regions: vec![],
            },
        ]);
        engine.play(0.0).unwrap();
        let level = |block: &[f32], channel: usize| {
            let samples: Vec<f32> = block.iter().skip(channel).step_by(2).copied().collect();
            let rms = (samples.iter().map(|value| value * value).sum::<f32>() / samples.len() as f32).sqrt();
            20.0 * (rms / (0.5 / 2_f32.sqrt())).log10()
        };
        let mut block = vec![0.0_f32; 2 * 4_800];
        let mut early = Vec::new();
        for _ in 0..10 {
            engine.render_block(&mut block);
            early.extend_from_slice(&block);
        }
        // Hard-left stem: -6 dB bell, unity gain. Hard-right stem: flat, -6 dB fader.
        assert!((level(&early[9_600..], 0) + 6.0).abs() < 0.15, "track EQ {}", level(&early[9_600..], 0));
        assert!((level(&early[9_600..], 1) + 6.0).abs() < 0.15, "fader only {}", level(&early[9_600..], 1));
        let mut inside = Vec::new();
        while inside.len() < 2 * 48_000 * 2 {
            engine.render_block(&mut block);
            inside.extend_from_slice(&block);
        }
        // 2.0 s to 3.0 s: the section band stacks on the fader.
        let section = &inside[2 * (48_000 + 4_800)..2 * (48_000 + 43_000)];
        assert!((level(section, 1) + 12.0).abs() < 0.2, "section EQ {}", level(section, 1));
        assert_eq!(engine.status().underruns, 0);
        engine.set_eq(vec![]);
        thread::sleep(Duration::from_millis(50));
        let mut released = Vec::new();
        for _ in 0..4 {
            engine.render_block(&mut block);
            released.extend_from_slice(&block);
        }
        assert!(level(&released[2 * 4_800..], 0).abs() < 0.15, "bypass {}", level(&released[2 * 4_800..], 0));
        engine.shutdown();
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_empty_ring_underruns_without_blocking() {
        let dir = env::temp_dir().join(format!("audiosous-underrun-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let stem = track(&dir, "stem", 48_000, |_| 0.0);
        let engine = Engine::offline();
        engine.load(vec![stem]).unwrap();
        engine.play(0.0).unwrap();
        engine.rt.hold.store(true, Ordering::Release);
        while engine.rt.busy.load(Ordering::Acquire) > 0 {
            thread::sleep(Duration::from_millis(1));
        }
        {
            let consumers = engine.rt.rings.tracks();
            if let Some(consumer) = consumers.get_mut(0) {
                while consumer.pop().is_ok() {}
            }
        }
        engine.rt.produced[0].store(0, Ordering::Relaxed);
        engine.rt.consumed[0].store(0, Ordering::Relaxed);
        engine.rt.eof_bits.store(0, Ordering::Relaxed);
        engine.rt.underruns.store(0, Ordering::Relaxed);
        let mut block = vec![0.0_f32; 256];
        let started = Instant::now();
        engine.render_block(&mut block);
        assert!(started.elapsed() < Duration::from_millis(50));
        assert!(engine.status().underruns >= 1);
        assert!(block.iter().all(|sample| *sample == 0.0));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn stems_stay_on_one_frame_and_a_shorter_stem_ends_quietly() {
        let dir = env::temp_dir().join(format!("audiosous-align-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let mut short = track(&dir, "short", 4_800, |_| 1.0);
        short.pan = -1.0;
        let mut long = track(&dir, "long", 48_000, |_| 0.4);
        long.pan = 1.0;
        let engine = Engine::offline();
        engine.load(vec![short, long]).unwrap();
        engine.play(0.0).unwrap();
        let mut early = vec![0.0_f32; 2_400];
        engine.render_block(&mut early);
        assert!(early[0].abs() > 0.5, "short stem missing");
        assert!(early[1].abs() > 0.2, "long stem missing");
        assert_eq!(
            engine.rt.consumed[0].load(Ordering::Relaxed),
            engine.rt.consumed[1].load(Ordering::Relaxed)
        );
        let mut later = vec![0.0_f32; 9_600];
        engine.render_block(&mut later);
        let tail = &later[later.len() - 400..];
        let left = tail
            .iter()
            .step_by(2)
            .map(|sample| sample.abs())
            .fold(0.0_f32, f32::max);
        let right = tail
            .iter()
            .skip(1)
            .step_by(2)
            .map(|sample| sample.abs())
            .fold(0.0_f32, f32::max);
        assert!(left < 0.05, "short stem kept playing, peak {left}");
        assert!(right > 0.2, "long stem stopped, peak {right}");
        assert_eq!(engine.status().underruns, 0);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_starved_reader_silences_only_that_stem_then_recovers() {
        let dir = env::temp_dir().join(format!("audiosous-starve-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let mut left = track(&dir, "left", 48_000 * 8, |_| 0.8);
        left.pan = -1.0;
        let mut right = track(&dir, "right", 48_000 * 8, |_| 0.8);
        right.pan = 1.0;
        let engine = Engine::offline();
        engine.load(vec![left, right]).unwrap();
        engine.play(0.0).unwrap();
        engine.rt.hold.store(true, Ordering::Release);
        while engine.rt.busy.load(Ordering::Acquire) > 0 {
            thread::sleep(Duration::from_millis(1));
        }
        {
            let consumers = engine.rt.rings.tracks();
            while consumers[0].pop().is_ok() {}
        }
        engine.rt.produced[0].store(0, Ordering::Relaxed);
        engine.rt.consumed[0].store(0, Ordering::Relaxed);
        engine.rt.eof_bits.store(
            engine.rt.eof_bits.load(Ordering::Relaxed) & !1,
            Ordering::Relaxed,
        );
        engine.rt.underruns.store(0, Ordering::Relaxed);
        engine.rt.last_underrun.store(usize::MAX, Ordering::Relaxed);
        let mut block = vec![0.0_f32; 512];
        let started = Instant::now();
        engine.render_block(&mut block);
        assert!(started.elapsed() < Duration::from_millis(50));
        assert!(engine.status().underruns >= 1);
        assert_eq!(engine.status().last_underrun_track, "left");
        let right = block
            .iter()
            .skip(1)
            .step_by(2)
            .map(|sample| sample.abs())
            .fold(0.0_f32, f32::max);
        assert!(right > 0.4, "the other stem was silenced, peak {right}");
        assert!(block.iter().step_by(2).all(|sample| sample.abs() < 0.05));
        engine.rt.hold.store(false, Ordering::Release);
        let recovered = Instant::now();
        let mut heard = false;
        while recovered.elapsed() < Duration::from_secs(2) {
            thread::sleep(Duration::from_millis(20));
            engine.render_block(&mut block);
            if block.iter().step_by(2).any(|sample| sample.abs() > 0.2) {
                heard = true;
                break;
            }
        }
        assert!(heard, "starved stem did not recover");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn callback_keeps_rendering_while_status_locks_are_held() {
        let dir = env::temp_dir().join(format!("audiosous-ui-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let stem = track(&dir, "tone", 48_000, |_| 0.5);
        let engine = Engine::offline();
        engine.load(vec![stem]).unwrap();
        engine.play(0.0).unwrap();
        let mut block = vec![0.0_f32; 960];
        engine.render_block(&mut block);
        let before = engine.status().underruns;
        let (ready_tx, ready_rx) = mpsc::channel();
        thread::scope(|scope| {
            scope.spawn(|| {
                let _commands = engine.commands.lock().expect("commands");
                let _ids = engine.rt.ids.lock().expect("ids");
                let _message = engine.rt.message.lock().expect("message");
                let _ = ready_tx.send(());
                thread::sleep(Duration::from_millis(800));
            });
            ready_rx.recv().expect("lock thread");
            let started = Instant::now();
            engine.render_block(&mut block);
            assert!(
                started.elapsed() < Duration::from_millis(100),
                "callback waited on a lock"
            );
        });
        let peak = block
            .iter()
            .map(|sample| sample.abs())
            .fold(0.0_f32, f32::max);
        assert!(peak > 0.2, "audio stopped while other threads held locks");
        assert_eq!(engine.status().underruns, before);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rapid_seeks_discard_the_previous_buffer() {
        let dir = env::temp_dir().join(format!("audiosous-seek-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let stem = track(
            &dir,
            "tone",
            48_000,
            |frame| if frame < 4_800 { 1.0 } else { 0.05 },
        );
        let engine = Engine::offline();
        engine.load(vec![stem]).unwrap();
        engine.play(0.0).unwrap();
        for seconds in [0.0, 0.8, 0.05, 0.6, 0.02, 0.3] {
            engine.seek(seconds);
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let status = engine.status();
            if status.state == "playing"
                && status.position_seconds > 0.25
                && status.position_seconds < 0.45
            {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "seek did not settle, position {}",
                status.position_seconds
            );
            thread::sleep(Duration::from_millis(20));
        }
        let mut block = vec![0.0_f32; 960];
        engine.render_block(&mut block);
        let peak = block
            .iter()
            .map(|sample| sample.abs())
            .fold(0.0_f32, f32::max);
        assert!(
            peak > 0.01 && peak < 0.4,
            "stale opening survived the seek, peak {peak}"
        );
        let position = engine.status().position_seconds;
        assert!(position > 0.2 && position < 0.55, "position {position}");
        engine.set_loop(Some((0.25, 0.4)));
        thread::sleep(Duration::from_millis(80));
        let mut lap = vec![0.0_f32; 24_000];
        engine.render_block(&mut lap);
        let wrapped = engine.status().position_seconds;
        assert!(wrapped < 0.45, "loop drifted, position {wrapped}");
        let skew = engine.rt.consumed[0].load(Ordering::Relaxed) as i64
            - engine.rt.presented.load(Ordering::Relaxed) as i64;
        assert!(
            skew.abs() < 4_096,
            "reader and transport diverged by {skew} frames"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    #[ignore = "synthetic playback stress"]
    fn stress_mix_throughput() {
        let dir = env::temp_dir().join(format!("audiosous-stress-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let cases = [
            (32, 48_000 * 2, 48_000_u32),
            (32, 96_000 * 2, 96_000),
            (11, 192_000 * 2, 192_000),
            (64, 48_000 * 2, 48_000),
        ];
        for (tracks, frames, rate) in cases {
            let loaded: Vec<_> = (0..tracks)
                .map(|index| {
                    let name = format!("t{index}");
                    let source = dir.join(format!("{name}-{rate}.wav"));
                    write_wav_rate(&source, rate, frames, |_| 0.1);
                    let proxy = dir.join(format!("{name}-{rate}.proxy"));
                    let size = fs::metadata(&source).unwrap().len();
                    ensure_proxy(
                        &source,
                        &proxy,
                        size,
                        1,
                        &AtomicBool::new(false),
                        &mut |_| {},
                    )
                    .unwrap();
                    LoadedTrack {
                        id: name.clone(),
                        label: name,
                        source_path: source,
                        proxy_path: proxy,
                        source_size: size,
                        source_modified_ns: 1,
                        gain_db: 0.0,
                        pan: 0.0,
                        width: 1.0,
                        muted: false,
                        solo: false,
                    }
                })
                .collect();
            let engine = Engine::offline();
            let started = Instant::now();
            engine.load(loaded).unwrap();
            engine.play(0.0).unwrap();
            let mut block = vec![0.0_f32; 512];
            let callbacks = 48_000 / 512 / 4;
            let mut callback_ns = 0_u128;
            for _ in 0..callbacks {
                let tick = Instant::now();
                engine.render_block(&mut block);
                callback_ns += tick.elapsed().as_nanos();
            }
            let status = engine.status();
            let ring_bytes = tracks * RING_SECONDS * PLAYBACK_RATE as usize * 4;
            eprintln!(
                "stress tracks={tracks} source={rate} build+play={:?} underruns={} min_buffer={:.3}s callback={:.3}ms budget={:.3}ms ring≈{}MB",
                started.elapsed(),
                status.underruns,
                status.buffered_ahead_min,
                callback_ns as f64 / callbacks as f64 / 1_000_000.0,
                status.callback_budget_ms,
                ring_bytes / (1024 * 1024)
            );
            assert_eq!(status.underruns, 0, "{tracks} tracks at {rate} underran");
            assert!(
                status.buffered_ahead_min > 0.2,
                "{tracks} tracks at {rate} were not primed, buffer {}",
                status.buffered_ahead_min
            );
            assert!(status.buffered_ahead_min < RING_SECONDS as f64 + 0.5);
            engine.shutdown();
        }
        let _ = fs::remove_dir_all(&dir);
    }

    /// Callback cost with EQ: 11, 32, and 64 stereo stems at 0, 1, and 3 filters per track,
    /// the 3-filter case also crossing a section band. Paced in real time so readers are not starved.
    #[test]
    #[ignore = "EQ callback cost"]
    fn stress_eq_callback_cost() {
        use crate::eq::{FilterKind, FilterSpec};
        let dir = env::temp_dir().join(format!("audiosous-eq-stress-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let bell = |frequency_hz: f32, gain_db: f32| FilterSpec {
            kind: FilterKind::Bell,
            frequency_hz,
            gain_db,
            q: 1.0,
        };
        let hpf = FilterSpec {
            kind: FilterKind::HighPass,
            frequency_hz: 70.0,
            gain_db: 0.0,
            q: 0.707,
        };
        for tracks in [11_usize, 32, 64] {
            let loaded: Vec<LoadedTrack> = (0..tracks)
                .map(|index| {
                    let name = format!("s{tracks}-{index}");
                    let source = dir.join(format!("{name}.wav"));
                    let seed = 0x9e37_79b9_u32.wrapping_mul(index as u32 + 1);
                    write_wav_rate(&source, 48_000, 48_000 * 6, move |frame| {
                        let mut x = (frame as u32).wrapping_mul(0x85eb_ca6b) ^ seed;
                        x ^= x << 13;
                        x ^= x >> 17;
                        x ^= x << 5;
                        (x as f32 / u32::MAX as f32 - 0.5) * 0.1
                    });
                    let proxy = dir.join(format!("{name}.proxy"));
                    let size = fs::metadata(&source).unwrap().len();
                    ensure_proxy(&source, &proxy, size, 1, &AtomicBool::new(false), &mut |_| {}).unwrap();
                    LoadedTrack {
                        id: name.clone(),
                        label: name,
                        source_path: source,
                        proxy_path: proxy,
                        source_size: size,
                        source_modified_ns: 1,
                        gain_db: 0.0,
                        pan: 0.0,
                        width: 1.0,
                        muted: false,
                        solo: false,
                    }
                })
                .collect();
            for filters in [0_usize, 1, 3] {
                let engine = Engine::offline();
                engine.load(loaded.clone()).unwrap();
                let table: Vec<TrackEq> = loaded
                    .iter()
                    .map(|track| TrackEq {
                        track_id: track.id.clone(),
                        filters: match filters {
                            0 => vec![],
                            1 => vec![bell(2_400.0, -1.5)],
                            _ => vec![hpf, bell(250.0, -1.0), bell(2_400.0, -1.5)],
                        },
                        regions: if filters == 3 {
                            vec![TrackEqRegion {
                                start_seconds: 1.0,
                                end_seconds: 2.0,
                                filters: vec![bell(1_800.0, -1.0)],
                            }]
                        } else {
                            vec![]
                        },
                    })
                    .collect();
                engine.set_eq(table);
                engine.play(0.0).unwrap();
                let mut block = vec![0.0_f32; 1_024];
                let block_duration = Duration::from_secs_f64(512.0 / f64::from(PLAYBACK_RATE));
                let callbacks = 280_u32;
                let mut total = 0_u128;
                let mut worst = 0_u128;
                let started = Instant::now();
                for index in 0..callbacks {
                    let tick = Instant::now();
                    engine.render_block(&mut block);
                    let spent = tick.elapsed().as_nanos();
                    total += spent;
                    worst = worst.max(spent);
                    let due = started + block_duration.saturating_mul(index + 1);
                    if let Some(wait) = due.checked_duration_since(Instant::now()) {
                        thread::sleep(wait);
                    }
                }
                let status = engine.status();
                let average = total as f64 / f64::from(callbacks) / 1_000_000.0;
                let budget = 512.0 / f64::from(PLAYBACK_RATE) * 1_000.0;
                eprintln!(
                    "eq-stress tracks={tracks} filters/track={filters}{} callback avg={average:.3}ms max={:.3}ms budget={budget:.2}ms ({:.1}% avg) underruns={}",
                    if filters == 3 { "+section" } else { "" },
                    worst as f64 / 1_000_000.0,
                    average / budget * 100.0,
                    status.underruns
                );
                assert!(block.iter().all(|sample| sample.is_finite()));
                assert_eq!(status.underruns, 0, "{tracks} tracks with {filters} filters underran");
                assert!(average < budget * 0.5, "{tracks} tracks with {filters} filters used {average:.3} ms of {budget:.2} ms");
                engine.shutdown();
            }
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    #[ignore = "project playback soak"]
    fn sustained_generated_projects() {
        let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
        for name in ["Generated 5", "Generated2"] {
            let project = root.join("test-assets").join(name).join("project.amix");
            if !project.is_file() {
                eprintln!("skip {name}: project file is not on disk");
                continue;
            }
            let doc: serde_json::Value =
                serde_json::from_str(&fs::read_to_string(&project).unwrap()).unwrap();
            let duration_frames = (doc["project"]["durationSeconds"].as_f64().unwrap_or(0.0)
                * f64::from(PLAYBACK_RATE)) as usize;
            let tracks = doc["tracks"].as_array().cloned().unwrap_or_default();
            let bundle = project.parent().unwrap();
            let loaded: Vec<LoadedTrack> = tracks
                .iter()
                .map(|track| {
                    let id = track["id"].as_str().unwrap().to_string();
                    let relative = track["file"]["relativePath"].as_str().unwrap();
                    let source = bundle.join(relative);
                    let meta = fs::metadata(&source).unwrap();
                    let modified_ns = meta
                        .modified()
                        .ok()
                        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|duration| u64::try_from(duration.as_nanos()).unwrap_or(u64::MAX))
                        .unwrap_or(0);
                    LoadedTrack {
                        id: id.clone(),
                        label: track["file"]["filename"]
                            .as_str()
                            .unwrap_or(&id)
                            .to_string(),
                        source_path: source,
                        proxy_path: bundle.join("cache/playback").join(format!("{id}.proxy")),
                        source_size: meta.len(),
                        source_modified_ns: modified_ns,
                        gain_db: track["gainDb"].as_f64().unwrap_or(0.0) as f32,
                        pan: track["pan"].as_f64().unwrap_or(0.0) as f32,
                        width: track["width"].as_f64().unwrap_or(1.0) as f32,
                        muted: track["muted"].as_bool().unwrap_or(false),
                        solo: track["solo"].as_bool().unwrap_or(false),
                    }
                })
                .collect();
            let engine = Engine::offline();
            let prepared = Instant::now();
            engine.load(loaded).unwrap();
            engine.play(0.0).unwrap();
            let mut block = vec![0.0_f32; 4_096];
            let target = duration_frames.min(5 * 60 * PLAYBACK_RATE as usize).max(1);
            let block_frames = block.len() / 2;
            let block_duration =
                Duration::from_secs_f64(block_frames as f64 / f64::from(PLAYBACK_RATE));
            let mut heard = 0_usize;
            let mut callback_ns = 0_u128;
            let mut callbacks = 0_u64;
            let mut min_buffer = f64::MAX;
            let mut buffer_sum = 0.0;
            let mut buffer_samples = 0_u64;
            let playback = Instant::now();
            let prepare_time = playback.saturating_duration_since(prepared);
            while heard < target {
                let tick = Instant::now();
                engine.render_block(&mut block);
                callback_ns += tick.elapsed().as_nanos();
                callbacks += 1;
                heard += block_frames;
                if callbacks % 100 == 0 && heard < duration_frames {
                    let status = engine.status();
                    min_buffer = min_buffer.min(status.buffered_ahead_min);
                    buffer_sum += status.buffered_ahead_min;
                    buffer_samples += 1;
                    if status.underruns != 0 {
                        panic!(
                            "{name} underran at {:.1}s: {}",
                            heard as f64 / f64::from(PLAYBACK_RATE),
                            status.underruns
                        );
                    }
                }
                let due = playback + block_duration.saturating_mul((heard / block_frames) as u32);
                if let Some(wait) = due.checked_duration_since(Instant::now()) {
                    thread::sleep(wait);
                }
            }
            let mut status = engine.status();
            eprintln!(
                "soak {name} prepare={:?} play={:?} underruns={} min_buffer={:.3}s avg_buffer={:.3}s callback={:.3}ms max_seen_budget={:.3}ms backlog={} seek_prime={}ms",
                prepare_time,
                playback.elapsed(),
                status.underruns,
                if min_buffer.is_finite() { min_buffer } else { status.buffered_ahead_min },
                if buffer_samples == 0 { status.buffered_ahead_avg } else { buffer_sum / buffer_samples as f64 },
                callback_ns as f64 / callbacks as f64 / 1_000_000.0,
                status.callback_budget_ms,
                status.reader_backlog,
                status.seek_prime_ms
            );
            assert_eq!(status.underruns, 0, "{name} underruns");
            for seconds in [70.0, 90.0, 20.0, 180.0, 5.0] {
                engine.seek(seconds);
            }
            let settle = Instant::now() + Duration::from_secs(30);
            loop {
                status = engine.status();
                if status.state == "playing"
                    && status.position_seconds > 4.0
                    && status.position_seconds < 8.0
                {
                    break;
                }
                assert!(
                    Instant::now() < settle,
                    "{name} seek did not settle at {}",
                    status.position_seconds
                );
                thread::sleep(Duration::from_millis(20));
            }
            engine.render_block(&mut block);
            engine.set_loop(Some((5.0, 12.0)));
            thread::sleep(Duration::from_millis(200));
            engine.render_block(&mut block);
            if let Some(first) = doc["tracks"].as_array().and_then(|tracks| tracks.first()) {
                let id = first["id"].as_str().unwrap();
                engine.set_track(id, Some(-6.0), Some(-0.5), Some(true), Some(false));
                engine.set_track(id, Some(-6.0), Some(-0.5), Some(false), Some(true));
            }
            thread::sleep(Duration::from_millis(100));
            engine.render_block(&mut block);
            status = engine.status();
            eprintln!(
                "soak {name} after seek/loop/gain underruns={} position={:.3}",
                status.underruns, status.position_seconds
            );
            assert_eq!(status.underruns, 0, "{name} underruns after seek");
            engine.shutdown();
        }
    }

    /// 48 kHz float stereo WAV.
    fn write_wav_stereo(path: &std::path::Path, frames: usize, sample: impl Fn(usize) -> (f32, f32)) {
        let mut body = Vec::with_capacity(44 + frames * 8);
        let data_bytes = (frames * 8) as u32;
        body.extend_from_slice(b"RIFF");
        body.extend_from_slice(&(36 + data_bytes).to_le_bytes());
        body.extend_from_slice(b"WAVE");
        body.extend_from_slice(b"fmt ");
        body.extend_from_slice(&16_u32.to_le_bytes());
        body.extend_from_slice(&3_u16.to_le_bytes());
        body.extend_from_slice(&2_u16.to_le_bytes());
        body.extend_from_slice(&48_000_u32.to_le_bytes());
        body.extend_from_slice(&(48_000_u32 * 8).to_le_bytes());
        body.extend_from_slice(&8_u16.to_le_bytes());
        body.extend_from_slice(&32_u16.to_le_bytes());
        body.extend_from_slice(b"data");
        body.extend_from_slice(&data_bytes.to_le_bytes());
        for frame in 0..frames {
            let (left, right) = sample(frame);
            body.extend_from_slice(&left.to_le_bytes());
            body.extend_from_slice(&right.to_le_bytes());
        }
        fs::write(path, body).unwrap();
    }

    fn stereo_track(dir: &std::path::Path, name: &str, frames: usize, sample: impl Fn(usize) -> (f32, f32)) -> LoadedTrack {
        let source = dir.join(format!("{name}.wav"));
        let proxy = dir.join(format!("{name}.proxy"));
        write_wav_stereo(&source, frames, sample);
        let size = fs::metadata(&source).unwrap().len();
        ensure_proxy(&source, &proxy, size, 1, &AtomicBool::new(false), &mut |_| {}).unwrap();
        LoadedTrack {
            id: name.into(),
            label: name.into(),
            source_path: source,
            proxy_path: proxy,
            source_size: size,
            source_modified_ns: 1,
            gain_db: 0.0,
            pan: 0.0,
            width: 1.0,
            muted: false,
            solo: false,
        }
    }

    /// Two independent noise channels, deterministic per seed.
    fn noise_pair(seed: u32) -> impl Fn(usize) -> (f32, f32) {
        move |frame| {
            let hash = |value: u32| {
                let mut x = value.wrapping_mul(0x85eb_ca6b) ^ seed;
                x ^= x << 13;
                x ^= x >> 17;
                x ^= x << 5;
                (x as f32 / u32::MAX as f32 - 0.5) * 0.4
            };
            (hash(frame as u32 * 2), hash(frame as u32 * 2 + 1))
        }
    }

    fn correlation_of(block: &[f32]) -> (f64, f64, f64) {
        let (mut ll, mut rr, mut lr) = (0.0_f64, 0.0_f64, 0.0_f64);
        for frame in block.chunks(2) {
            let (left, right) = (f64::from(frame[0]), f64::from(frame[1]));
            ll += left * left;
            rr += right * right;
            lr += left * right;
        }
        (lr / (ll * rr).sqrt().max(1e-30), ll, rr)
    }

    fn render(engine: &Engine, seconds: f64) -> Vec<f32> {
        let mut block = vec![0.0_f32; 2 * 480];
        let mut out = Vec::new();
        while (out.len() as f64) < seconds * 2.0 * 48_000.0 {
            engine.render_block(&mut block);
            out.extend_from_slice(&block);
        }
        out
    }

    /// Width sits after EQ and before pan and the fader. Width 0 folds a decorrelated stem to mono,
    /// width 2 pushes its correlation to (1 − 4) / (1 + 4), and a section window applies only inside it.
    #[test]
    fn spatial_plays_through_the_mix_and_section_windows_replace_it() {
        let dir = env::temp_dir().join(format!("audiosous-spatial-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let wide = stereo_track(&dir, "wide", 48_000 * 6, noise_pair(17));
        let engine = Engine::offline();
        engine.load(vec![wide]).unwrap();
        engine.set_spatial(vec![TrackSpatial {
            track_id: "wide".into(),
            pan: 0.0,
            width: 0.0,
            regions: vec![TrackSpatialRegion { start_seconds: 3.0, end_seconds: 6.0, pan: 0.0, width: 2.0 }],
        }]);
        engine.play(0.0).unwrap();
        let early = render(&engine, 2.0);
        let (corr, ll, rr) = correlation_of(&early[2 * 4_800..]);
        assert!(corr > 0.999, "width 0 should be mono, correlation {corr}");
        assert!((ll / rr - 1.0).abs() < 1e-3);
        let _ = render(&engine, 1.2);
        let late = render(&engine, 1.5);
        let (corr, _, _) = correlation_of(&late);
        assert!((corr + 0.6).abs() < 0.05, "width 2 in the section, correlation {corr}");
        assert_eq!(engine.status().underruns, 0);
        engine.shutdown();
        let _ = fs::remove_dir_all(&dir);
    }

    /// A stereo stem moved with balance scales each channel only; a mono stem pans; a seek into a section
    /// starts at the section's values instead of ramping from the old ones.
    #[test]
    fn balance_pan_and_a_seek_into_a_spatial_section() {
        let dir = env::temp_dir().join(format!("audiosous-balance-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let stereo = stereo_track(&dir, "stereo", 48_000 * 6, |frame| ((frame as f32 * 0.05).sin() * 0.5, 0.0));
        let mono = track(&dir, "mono", 48_000 * 6, |frame| (frame as f32 * 0.03).sin() * 0.5);
        let engine = Engine::offline();
        engine.load(vec![stereo, mono]).unwrap();
        engine.set_track("mono", Some(-96.0), None, None, None);
        engine.set_spatial(vec![
            TrackSpatial { track_id: "stereo".into(), pan: 1.0, width: 1.0, regions: vec![] },
            TrackSpatial {
                track_id: "mono".into(),
                pan: 0.0,
                width: 1.0,
                regions: vec![TrackSpatialRegion { start_seconds: 4.0, end_seconds: 6.0, pan: -1.0, width: 1.0 }],
            },
        ]);
        engine.play(0.0).unwrap();
        let block = render(&engine, 1.0);
        let (_, ll, rr) = correlation_of(&block[2 * 4_800..]);
        // All the content is on the left channel and balance is hard right: nothing crosses over.
        assert!(ll < 1e-9, "left leaked {ll}");
        assert!(rr < 1e-9, "the source right channel is silent, so balance has nothing to pass {rr}");
        engine.set_track("stereo", Some(-96.0), None, None, None);
        engine.set_track("mono", Some(0.0), None, None, None);
        engine.seek(4.5);
        thread::sleep(Duration::from_millis(50));
        engine.play(4.5).unwrap();
        let mut first = vec![0.0_f32; 2 * 256];
        engine.render_block(&mut first);
        let (_, ll, rr) = correlation_of(&first[2 * 64..]);
        assert!(rr < ll * 1e-6, "the seek landed hard left, right {rr} left {ll}");
        engine.shutdown();
        let _ = fs::remove_dir_all(&dir);
    }

    /// The callback with EQ and spatial processing on, through a spatial table change and section edges:
    /// no allocation or free.
    #[test]
    fn callback_with_eq_and_spatial_does_not_allocate() {
        use crate::eq::{FilterKind, FilterSpec};
        let dir = env::temp_dir().join(format!("audiosous-spatial-alloc-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let tracks: Vec<LoadedTrack> = (0..8).map(|index| stereo_track(&dir, &format!("t{index}"), 48_000 * 3, noise_pair(index + 1))).collect();
        let engine = Engine::offline();
        engine.load(tracks).unwrap();
        engine.set_eq(
            (0..8)
                .map(|index| TrackEq {
                    track_id: format!("t{index}"),
                    filters: vec![FilterSpec { kind: FilterKind::Bell, frequency_hz: 2_400.0, gain_db: -1.5, q: 1.0 }],
                    regions: vec![],
                })
                .collect(),
        );
        let spatial = |width: f32| -> Vec<TrackSpatial> {
            (0..8)
                .map(|index| TrackSpatial {
                    track_id: format!("t{index}"),
                    pan: index as f32 / 8.0 - 0.5,
                    width,
                    regions: vec![TrackSpatialRegion { start_seconds: 0.3, end_seconds: 0.6, pan: 0.2, width: 1.4 }],
                })
                .collect()
        };
        engine.set_spatial(spatial(1.2));
        engine.play(0.0).unwrap();
        let mut block = vec![0.0_f32; 1_024];
        engine.render_block(&mut block);
        let ((), first) = counting::watch(|| {
            for _ in 0..40 {
                engine.render_block(&mut block);
            }
        });
        engine.set_spatial(spatial(0.8));
        thread::sleep(Duration::from_millis(30));
        let ((), second) = counting::watch(|| {
            for _ in 0..20 {
                engine.render_block(&mut block);
            }
        });
        let ((), probe) = counting::watch(|| drop(std::hint::black_box(vec![0_u8; 16])));
        assert!(probe >= 1, "the allocation counter is not counting");
        assert_eq!(first, 0, "callback allocated {first} times");
        assert_eq!(second, 0, "callback allocated {second} times after a spatial update");
        assert!(block.iter().all(|sample| sample.is_finite()));
        engine.shutdown();
        let _ = fs::remove_dir_all(&dir);
    }

    /// Callback cost with the processing Milestones 4 and 5 add together: 32 and 64 stereo stems,
    /// none, EQ only (high-pass + 2 bells + a section bell), and EQ plus pan, width, and a section
    /// pan/width window on every stem. Paced in real time so readers are not starved.
    #[test]
    #[ignore = "EQ + spatial callback cost"]
    fn stress_spatial_callback_cost() {
        use crate::eq::{FilterKind, FilterSpec};
        let dir = env::temp_dir().join(format!("audiosous-spatial-stress-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let bell = |frequency_hz: f32, gain_db: f32| FilterSpec { kind: FilterKind::Bell, frequency_hz, gain_db, q: 1.0 };
        let hpf = FilterSpec { kind: FilterKind::HighPass, frequency_hz: 70.0, gain_db: 0.0, q: 0.707 };
        for tracks in [32_usize, 64] {
            let loaded: Vec<LoadedTrack> = (0..tracks)
                .map(|index| stereo_track(&dir, &format!("s{tracks}-{index}"), 48_000 * 6, noise_pair(0x9e37_79b9_u32.wrapping_mul(index as u32 + 1))))
                .map(|mut track| {
                    track.gain_db = -12.0;
                    track
                })
                .collect();
            for load in ["none", "eq", "eq+spatial"] {
                let engine = Engine::offline();
                engine.load(loaded.clone()).unwrap();
                if load != "none" {
                    engine.set_eq(
                        loaded
                            .iter()
                            .map(|track| TrackEq {
                                track_id: track.id.clone(),
                                filters: vec![hpf, bell(250.0, -1.0), bell(2_400.0, -1.5)],
                                regions: vec![TrackEqRegion { start_seconds: 1.0, end_seconds: 2.0, filters: vec![bell(1_800.0, -1.0)] }],
                            })
                            .collect(),
                    );
                }
                if load == "eq+spatial" {
                    engine.set_spatial(
                        loaded
                            .iter()
                            .enumerate()
                            .map(|(index, track)| TrackSpatial {
                                track_id: track.id.clone(),
                                pan: (index as f32 / tracks as f32) - 0.5,
                                width: 0.8 + (index % 5) as f32 * 0.1,
                                regions: vec![
                                    TrackSpatialRegion { start_seconds: 1.0, end_seconds: 2.0, pan: 0.25, width: 1.35 },
                                    TrackSpatialRegion { start_seconds: 3.0, end_seconds: 4.0, pan: -0.25, width: 0.9 },
                                ],
                            })
                            .collect(),
                    );
                }
                engine.play(0.0).unwrap();
                let mut block = vec![0.0_f32; 1_024];
                let block_duration = Duration::from_secs_f64(512.0 / f64::from(PLAYBACK_RATE));
                let callbacks = 420_u32;
                let mut total = 0_u128;
                let mut worst = 0_u128;
                let started = Instant::now();
                for index in 0..callbacks {
                    let tick = Instant::now();
                    engine.render_block(&mut block);
                    let spent = tick.elapsed().as_nanos();
                    total += spent;
                    worst = worst.max(spent);
                    let due = started + block_duration.saturating_mul(index + 1);
                    if let Some(wait) = due.checked_duration_since(Instant::now()) {
                        thread::sleep(wait);
                    }
                }
                let status = engine.status();
                let average = total as f64 / f64::from(callbacks) / 1_000_000.0;
                let budget = 512.0 / f64::from(PLAYBACK_RATE) * 1_000.0;
                eprintln!(
                    "spatial-stress stereo tracks={tracks} load={load} callback avg={average:.3}ms max={:.3}ms budget={budget:.2}ms ({:.1}% avg) underruns={}",
                    worst as f64 / 1_000_000.0,
                    average / budget * 100.0,
                    status.underruns
                );
                assert!(block.iter().all(|sample| sample.is_finite()));
                assert_eq!(status.underruns, 0, "{tracks} tracks with {load} underran");
                assert!(average < budget * 0.5, "{tracks} tracks with {load} used {average:.3} ms of {budget:.2} ms");
                engine.shutdown();
            }
        }
        let _ = fs::remove_dir_all(&dir);
    }

    fn write_wav_rate(
        path: &std::path::Path,
        rate: u32,
        frames: usize,
        sample: impl Fn(usize) -> f32,
    ) {
        let mut body = Vec::with_capacity(44 + frames * 4);
        let data_bytes = (frames * 4) as u32;
        body.extend_from_slice(b"RIFF");
        body.extend_from_slice(&(36 + data_bytes).to_le_bytes());
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
}
