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

use crate::mix::{equal_power_pan, linear_gain, MixSnapshot, TrackMix};
use crate::proxy::{ensure_proxy, ProxyReader, PLAYBACK_RATE};

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
pub struct LoadedTrack {
    pub id: String,
    pub label: String,
    pub source_path: PathBuf,
    pub proxy_path: PathBuf,
    pub source_size: u64,
    pub source_modified_ns: u64,
    pub gain_db: f32,
    pub pan: f32,
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
    pub message: String,
}

#[allow(dead_code)]
struct TrackState {
    id: String,
    source_path: PathBuf,
    proxy_path: PathBuf,
    source_size: u64,
    source_modified_ns: u64,
    gain_db: f32,
    pan: f32,
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
    consumers: Mutex<Vec<Consumer<f32>>>,
    device: Mutex<Option<Consumer<f32>>>,
    mix_slots: [Mutex<MixSnapshot>; 2],
    mix_index: AtomicUsize,
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
    ids: Mutex<Vec<String>>,
    message: Mutex<String>,
    device_error: Mutex<String>,
}

impl Realtime {
    fn new(offline: bool) -> Self {
        Self {
            offline,
            consumers: Mutex::new(Vec::new()),
            device: Mutex::new(None),
            mix_slots: [
                Mutex::new(MixSnapshot::silent()),
                Mutex::new(MixSnapshot::silent()),
            ],
            mix_index: AtomicUsize::new(0),
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
            ids: Mutex::new(Vec::new()),
            message: Mutex::new(String::new()),
            device_error: Mutex::new(String::new()),
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
}

pub struct Engine {
    commands: Mutex<Option<Sender<Command>>>,
    rt: Arc<Realtime>,
    join: Mutex<Option<JoinHandle<()>>>,
    cached: Mutex<MixSnapshot>,
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
                };
                control.run();
            })
            .expect("audio control thread");
        Self {
            commands: Mutex::new(Some(tx)),
            rt,
            join: Mutex::new(Some(join)),
            cached: Mutex::new(MixSnapshot::silent()),
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

    pub fn status(&self) -> EngineStatus {
        status_from(&self.rt)
    }

    pub fn render_block(&self, out: &mut [f32]) {
        let mut cached = self.cached.lock().expect("mix cache");
        process_callback(&self.rt, out, &mut cached);
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
        self.rt.consume.store(false, Ordering::Release);
        self.rt.audible.store(false, Ordering::Release);
        self.stream.take();
        self.pause_workers();
        let load_id = self.rt.load_id.fetch_add(1, Ordering::AcqRel) + 1;
        {
            let mut slots = self.tracks.write().expect("tracks");
            *slots = tracks
                .iter()
                .map(|track| Mutex::new(TrackState::from_loaded(track)))
                .collect();
            self.rt.consumers.lock().expect("consumers").clear();
            *self.rt.device.lock().expect("device ring") = None;
        }
        self.rt.track_count.store(0, Ordering::Release);
        self.rt.proxy_ready.store(0, Ordering::Release);
        self.rt.proxy_total.store(tracks.len(), Ordering::Release);
        self.rt.proxy_percent.store(0, Ordering::Release);
        self.rt.eof_bits.store(0, Ordering::Release);
        self.rt.underruns.store(0, Ordering::Release);
        self.rt.presented.store(0, Ordering::Release);
        for index in 0..MAX_TRACKS {
            self.rt.produced[index].store(0, Ordering::Relaxed);
            self.rt.consumed[index].store(0, Ordering::Relaxed);
        }
        *self.rt.ids.lock().expect("ids") = tracks.iter().map(|track| track.id.clone()).collect();
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
        self.rt.consume.store(true, Ordering::Release);
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
                let filled = self
                    .rt
                    .device
                    .lock()
                    .expect("device")
                    .as_ref()
                    .map(|consumer| consumer.slots())
                    .unwrap_or(0);
                if filled >= PLAYBACK_RATE as usize {
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
        self.rt.audible.store(false, Ordering::Release);
        self.rt.consume.store(false, Ordering::Release);
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
        self.rt.consume.store(false, Ordering::Release);
        self.rt.audible.store(false, Ordering::Release);
        if let Some(output) = &self.stream {
            let _ = output.stream.pause();
        }
        self.pause_workers();
        while self.rt.mixer_busy.load(Ordering::Acquire)
            || self.rt.in_callback.load(Ordering::Acquire)
        {
            thread::sleep(Duration::from_millis(1));
        }
        let frame = seconds_to_frame(seconds);
        self.apply_loop_atomics();
        {
            let tracks = self.tracks.read().expect("tracks");
            let mut consumers = self.rt.consumers.lock().expect("consumers");
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
            if let Some(device) = self.rt.device.lock().expect("device").as_mut() {
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
        let next = 1 - self.rt.mix_index.load(Ordering::Acquire);
        *self.rt.mix_slots[next].lock().expect("mix") = snap;
        self.rt.mix_index.store(next, Ordering::Release);
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

fn process_callback(rt: &Realtime, out: &mut [f32], cached: &mut MixSnapshot) {
    rt.in_callback.store(true, Ordering::Release);
    if !rt.audible.load(Ordering::Acquire) || !rt.consume.load(Ordering::Acquire) {
        out.fill(0.0);
        rt.in_callback.store(false, Ordering::Release);
        return;
    }
    let started = Instant::now();
    if rt.indirect.load(Ordering::Acquire) {
        copy_device(rt, out);
    } else if let Ok(mut consumers) = rt.consumers.try_lock() {
        let frames = out.len() / 2;
        let (underruns, track) = mix_consumers(rt, &mut consumers, cached, out);
        if underruns > 0 {
            rt.underruns.fetch_add(underruns, Ordering::Relaxed);
            if let Some(track) = track {
                rt.last_underrun.store(track, Ordering::Relaxed);
            }
        }
        rt.presented.fetch_add(frames as u64, Ordering::Relaxed);
    } else {
        out.fill(0.0);
    }
    rt.callback_nanos
        .store(started.elapsed().as_nanos() as u64, Ordering::Relaxed);
    rt.callback_frames
        .store((out.len() / 2) as u32, Ordering::Relaxed);
    rt.in_callback.store(false, Ordering::Release);
}

fn copy_device(rt: &Realtime, out: &mut [f32]) {
    let Ok(mut guard) = rt.device.try_lock() else {
        out.fill(0.0);
        return;
    };
    let Some(consumer) = guard.as_mut() else {
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
    cached: &mut MixSnapshot,
    out: &mut [f32],
) -> (u64, Option<usize>) {
    let index = rt.mix_index.load(Ordering::Acquire);
    if let Ok(slot) = rt.mix_slots[index].try_lock() {
        *cached = *slot;
    }
    let mix = *cached;
    let mut gains = [0.0_f32; MAX_TRACKS];
    for index in 0..mix.count.min(MAX_TRACKS) {
        gains[index] = f32::from_bits(rt.gains[index].load(Ordering::Relaxed));
    }
    let eof_bits = rt.eof_bits.load(Ordering::Relaxed);
    let step = 1.0 / (0.01 * PLAYBACK_RATE as f32);
    let frames = out.len() / 2;
    let mut underruns = 0_u64;
    let mut underrun_track = None;
    let mut counted = [false; MAX_TRACKS];
    let mut pulled = [0_u64; MAX_TRACKS];
    for frame in 0..frames {
        let mut left = 0.0;
        let mut right = 0.0;
        for track_index in 0..mix.count.min(consumers.len()).min(MAX_TRACKS) {
            let track = mix.tracks[track_index];
            if !track.active {
                continue;
            }
            let audible = !track.mute && (!mix.any_solo || track.solo);
            let target = if audible { track.gain } else { 0.0 };
            let delta = target - gains[track_index];
            gains[track_index] += delta.clamp(-step, step);
            let channels = (track.channels as usize).clamp(1, 2);
            let mut sample = [0.0_f32; 2];
            if pull_frame(&mut consumers[track_index], channels, &mut sample) {
                pulled[track_index] += 1;
                let (pan_left, pan_right) = equal_power_pan(track.pan);
                let gain = gains[track_index];
                if channels == 1 {
                    left += sample[0] * gain * pan_left;
                    right += sample[0] * gain * pan_right;
                } else {
                    left += sample[0] * gain * pan_left;
                    right += sample[1] * gain * pan_right;
                }
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
    rt.indirect.store(resample, Ordering::Release);
    let (mixer_stop, mixer) = start_mixer_if_needed(&rt, resample, config.sample_rate.0);
    let mut cached = MixSnapshot::silent();
    let callback_rt = Arc::clone(&rt);
    let stream = device
        .build_output_stream(
            &config,
            move |data: &mut [f32], _| process_callback(&callback_rt, data, &mut cached),
            move |error| {
                *rt.device_error.lock().expect("device error") = error.to_string();
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
    rt.indirect.store(true, Ordering::Release);
    let (mixer_stop, mixer) = start_mixer_if_needed(&rt, true, config.sample_rate.0);
    let callback_rt = Arc::clone(&rt);
    let mut scratch = vec![0.0_f32; 8_192];
    let stream = device
        .build_output_stream(
            &config,
            move |data: &mut [i16], _| {
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
            },
            move |error| {
                *rt.device_error.lock().expect("device error") = error.to_string();
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
    *rt.device.lock().expect("device ring") = Some(consumer);
    let rt = Arc::clone(rt);
    let stop_flag = Arc::clone(&stop);
    let mixer = thread::Builder::new()
        .name("audiosous-mix".into())
        .spawn(move || mixer_loop(&rt, &stop_flag, &mut producer, device_rate))
        .expect("mix thread");
    (stop, Some(mixer))
}

fn mixer_loop(rt: &Realtime, stop: &AtomicBool, producer: &mut Producer<f32>, device_rate: u32) {
    let mut cached = MixSnapshot::silent();
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
    let mut planar = [Vec::new(), Vec::new()];
    let mut output = resampler
        .as_ref()
        .map(|resampler| resampler.output_buffer_allocate(true));
    while !stop.load(Ordering::Acquire) && !rt.shutdown.load(Ordering::Acquire) {
        if rt.hold.load(Ordering::Acquire) || !rt.consume.load(Ordering::Acquire) {
            thread::sleep(Duration::from_millis(2));
            continue;
        }
        rt.mixer_busy.store(true, Ordering::Release);
        if rt.hold.load(Ordering::Acquire) || !rt.consume.load(Ordering::Acquire) {
            rt.mixer_busy.store(false, Ordering::Release);
            continue;
        }
        {
            let Ok(mut consumers) = rt.consumers.lock() else {
                rt.mixer_busy.store(false, Ordering::Release);
                continue;
            };
            let (underruns, track) = mix_consumers(rt, &mut consumers, &mut cached, &mut mixed);
            if underruns > 0 {
                rt.underruns.fetch_add(underruns, Ordering::Relaxed);
                if let Some(track) = track {
                    rt.last_underrun.store(track, Ordering::Relaxed);
                }
            }
            rt.presented
                .fetch_add((mixed.len() / 2) as u64, Ordering::Relaxed);
        }
        if let Some(resampler) = resampler.as_mut() {
            let frames = mixed.len() / 2;
            planar[0].clear();
            planar[1].clear();
            for frame in 0..frames {
                planar[0].push(mixed[frame * 2]);
                planar[1].push(mixed[frame * 2 + 1]);
            }
            if let Some(output) = output.as_mut() {
                if let Ok((_used, produced)) = resampler.process_into_buffer(&planar, output, None)
                {
                    let mut interleaved = Vec::with_capacity(produced * 2);
                    for frame in 0..produced {
                        interleaved.push(output[0].get(frame).copied().unwrap_or(0.0));
                        interleaved.push(output[1].get(frame).copied().unwrap_or(0.0));
                    }
                    copy_device_space(producer, &interleaved);
                }
            }
        } else {
            copy_device_space(producer, &mixed);
        }
        rt.mixer_busy.store(false, Ordering::Release);
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
    let device_error = rt
        .device_error
        .lock()
        .ok()
        .map(|error| error.clone())
        .unwrap_or_default();
    let mut message = rt
        .message
        .lock()
        .ok()
        .map(|message| message.clone())
        .unwrap_or_default();
    if message.is_empty() && !device_error.is_empty() {
        message = device_error;
    }
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
            let mut consumers = engine.rt.consumers.lock().expect("consumers");
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
}
