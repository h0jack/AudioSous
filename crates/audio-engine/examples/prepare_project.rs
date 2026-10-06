//! Measures project preparation: builds every stem's playback proxy through the engine, as opening a project does,
//! and reports each stem's state from the status poll the desktop's preparation view reads.
//!
//!   cargo run --release -p audiosous-audio --example prepare_project -- PROJECT_DIR
//!
//! Point it at a copy: it deletes and rebuilds PROJECT_DIR/cache/playback.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use audiosous_audio::{Engine, LoadedTrack};

fn main() {
    let dir = PathBuf::from(std::env::args().skip(1).find(|arg| arg != "--").expect("Pass a project folder (a copy)."));
    let doc: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(dir.join("project.amix")).expect("project.amix")).expect("valid project");
    let cache = dir.join("cache/playback");
    let _ = std::fs::remove_dir_all(&cache);
    std::fs::create_dir_all(&cache).unwrap();
    let tracks: Vec<LoadedTrack> = doc["tracks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|track| {
            let id = track["id"].as_str().unwrap().to_string();
            let source = dir.join(track["file"]["relativePath"].as_str().unwrap());
            let meta = std::fs::metadata(&source).unwrap();
            LoadedTrack { id: id.clone(), label: track["file"]["filename"].as_str().unwrap_or(&id).to_string(), source_path: source, proxy_path: cache.join(format!("{id}.proxy")), source_size: meta.len(), source_modified_ns: 1, gain_db: 0.0, pan: 0.0, width: 1.0, muted: false, solo: false }
        })
        .collect();
    let count = tracks.len();
    let engine = Engine::offline();
    let started = Instant::now();
    engine.load(tracks).unwrap();
    let mut last = String::new();
    let mut first_ready: Option<Duration> = None;
    loop {
        let status = engine.status();
        let ready = status.proxy_tracks.iter().filter(|track| track.state == "ready").count();
        if ready > 0 && first_ready.is_none() {
            first_ready = Some(started.elapsed());
        }
        let line = format!("{ready} of {count} stems ready ({:.0}%)", status.proxy_tracks.iter().map(|track| f64::from(track.percent)).sum::<f64>() / count as f64);
        if line != last {
            println!("{:>6.2} s  {line}", started.elapsed().as_secs_f64());
            last = line;
        }
        if status.proxy_tracks.iter().all(|track| track.state == "ready" || track.state == "failed") {
            for track in &status.proxy_tracks {
                println!("  {} {}{}", track.state, track.label, if track.error.is_empty() { String::new() } else { format!(": {}", track.error) });
            }
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    println!("Prepared {count} stems in {:.1} s (first ready after {:.1} s)", started.elapsed().as_secs_f64(), first_ready.unwrap_or_default().as_secs_f64());
    engine.shutdown();
}
