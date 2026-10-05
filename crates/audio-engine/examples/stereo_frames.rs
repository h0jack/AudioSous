//! Fills `cache/analysis/<trackId>__stereo.json` for every track of a project folder, the same cache
//! the desktop app writes before spatial planning. Used by the acceptance harness.
//!
//!   cargo run --release -p audiosous-audio --example stereo_frames -- "test-assets/Generated 5"

use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::time::Instant;

fn main() {
    let bundle = PathBuf::from(std::env::args().nth(1).expect("project folder"));
    let text = std::fs::read_to_string(bundle.join("project.amix")).expect("project.amix");
    let doc: serde_json::Value = serde_json::from_str(&text).expect("project JSON");
    let started = Instant::now();
    for track in doc["tracks"].as_array().expect("tracks") {
        let id = track["id"].as_str().expect("id");
        let source = bundle.join(track["file"]["relativePath"].as_str().expect("path"));
        let tick = Instant::now();
        match audiosous_audio::cached_stereo_frames(&bundle, id, &source, &AtomicBool::new(false)) {
            Ok(_) => println!("{id} {:?}", tick.elapsed()),
            Err(error) => println!("{id} failed: {error}"),
        }
    }
    println!("all {:?}", started.elapsed());
}
