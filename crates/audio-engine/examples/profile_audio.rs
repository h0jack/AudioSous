//! Song profiles for the reference acceptance run, measured exactly as the desktop measures them.
//!
//!   cargo run --release -p audiosous-audio --example profile_audio -- file SONG.(wav|flac|mp3|aiff) OUT.json
//!   cargo run --release -p audiosous-audio --example profile_audio -- mix VARIANTS.json VARIANT OUT.json
//!
//! `mix` renders a variant from `mix-variants.ts` or `reference-project.ts` (original stems, export graph, 48 kHz).

use std::path::PathBuf;
use std::sync::atomic::AtomicBool;

use audiosous_audio::{decode_to_48k, render_mix, song_profile, FrameSource, GraphTrack, MixGraph, MixVariantSpec, SourceStream, PROFILE_RATE};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    duration_seconds: f64,
    sources: Vec<Source>,
    variants: std::collections::HashMap<String, MixVariantSpec>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Source {
    track_id: String,
    path: PathBuf,
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).filter(|arg| arg != "--").collect();
    let (audio, out) = match args[0].as_str() {
        "file" => (decode_to_48k(&PathBuf::from(&args[1])).expect("decode"), PathBuf::from(&args[2])),
        "mix" => {
            let request: Request = serde_json::from_str(&std::fs::read_to_string(&args[1]).unwrap()).unwrap();
            let mix = &request.variants[&args[2]];
            let (tracks, settings) = mix.bounce_inputs(|id| request.sources.iter().find(|source| source.track_id == id).map(|source| source.path.clone()).ok_or_else(|| format!("no source for {id}"))).unwrap();
            let mut sources: Vec<Box<dyn FrameSource>> = tracks.iter().map(|track| Box::new(SourceStream::open(&track.proxy, PROFILE_RATE).unwrap()) as Box<dyn FrameSource>).collect();
            let graph_tracks: Vec<GraphTrack> = tracks.iter().map(|track| GraphTrack { id: track.id.clone(), gain_db: track.gain_db, muted: track.muted }).collect();
            let mut graph = MixGraph::new(&graph_tracks, settings, PROFILE_RATE);
            let mut audio = Vec::new();
            render_mix(&mut sources, &mut graph, PROFILE_RATE, request.duration_seconds, &AtomicBool::new(false), &mut |chunk| {
                audio.extend_from_slice(chunk);
                Ok(())
            }, &mut |_| {})
            .unwrap();
            (audio, PathBuf::from(&args[3]))
        }
        other => panic!("unknown mode {other}"),
    };
    let profile = song_profile(&audio);
    std::fs::write(&out, serde_json::to_string_pretty(&profile).unwrap()).unwrap();
    println!("{}: {:.2} LUFS, true peak {:.2} dBTP, LRA {:.1} LU, body {:.0}%, low correlation {:.2}", out.display(), profile.loudness.integrated_lufs, profile.loudness.true_peak_dbtp, profile.loudness.loudness_range_lu, profile.body_share * 100.0, profile.low_correlation);
}
