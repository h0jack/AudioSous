//! Reference songs in a project: `references/<name>.wav` (decoded once to 48 kHz stereo float, so the engine plays it
//! like a stem and nothing else needs a decoder), its profile in `cache/reference/<name>.json`, and the profile of the
//! mix as the engine plays it, measured the same way. The reference file the person chose is never modified, and the
//! project file does not name references: a project folder carries its own.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use audiosous_audio::{bounce, import_reference, song_profile, MixVariantSpec, SongProfile, PROFILE_RATE};
use serde::{Deserialize, Serialize};

use crate::{bundle, dynamics_check};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceInfo {
    pub name: String,
    pub duration_seconds: f64,
    pub profile: SongProfile,
}

fn references_dir(project_file: &str) -> Result<PathBuf, String> {
    let bundle = bundle::bundle_dir_for(Path::new(project_file))?.canonicalize().map_err(|error| error.to_string())?;
    Ok(bundle.join("references"))
}

fn profile_path(project_file: &str, name: &str) -> Result<PathBuf, String> {
    let bundle = bundle::bundle_dir_for(Path::new(project_file))?.canonicalize().map_err(|error| error.to_string())?;
    Ok(bundle.join("cache").join("reference").join(format!("{name}.json")))
}

/// A reference's name: a plain file stem (letters, digits, spaces, `-`, `_`, `.`), never a path.
pub fn checked_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    let ok = !trimmed.is_empty() && trimmed.len() <= 100 && trimmed != "." && trimmed != ".." && trimmed.chars().all(|ch| ch.is_alphanumeric() || matches!(ch, ' ' | '-' | '_' | '.' | '(' | ')' | '\'' | '&' | ','));
    if ok { Ok(trimmed.to_string()) } else { Err("That reference name is not allowed.".into()) }
}

/// The WAV the engine plays for a reference, inside the project folder.
pub fn reference_file(project_file: &str, name: &str) -> Result<PathBuf, String> {
    let name = checked_name(name)?;
    let path = references_dir(project_file)?.join(format!("{name}.wav"));
    if !path.is_file() {
        return Err(format!("The reference {name} is not in this project."));
    }
    Ok(path)
}

fn stem_name(source: &Path) -> String {
    let stem = source.file_stem().map(|value| value.to_string_lossy().into_owned()).unwrap_or_else(|| "Reference".into());
    let cleaned: String = stem.chars().map(|ch| if ch.is_alphanumeric() || matches!(ch, ' ' | '-' | '_' | '(' | ')' | '\'' | '&' | ',') { ch } else { ' ' }).collect();
    let cleaned = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let cleaned: String = cleaned.chars().take(80).collect();
    if cleaned.is_empty() { "Reference".into() } else { cleaned }
}

pub fn import(project_file: &str, source: &str) -> Result<ReferenceInfo, String> {
    let source = PathBuf::from(source);
    if !source.is_file() {
        return Err("Choose an audio file.".into());
    }
    let dir = references_dir(project_file)?;
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let base = stem_name(&source);
    let mut name = base.clone();
    let mut counter = 2;
    while dir.join(format!("{name}.wav")).exists() {
        name = format!("{base} ({counter})");
        counter += 1;
    }
    let dest = dir.join(format!("{name}.wav"));
    let profile = import_reference(&source, &dest)?;
    save_profile(project_file, &name, &profile)?;
    Ok(ReferenceInfo { name, duration_seconds: profile.duration_seconds, profile })
}

fn save_profile(project_file: &str, name: &str, profile: &SongProfile) -> Result<(), String> {
    let path = profile_path(project_file, name)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(&path, serde_json::to_vec_pretty(profile).map_err(|error| error.to_string())?).map_err(|error| error.to_string())
}

fn load_profile(project_file: &str, name: &str) -> Result<SongProfile, String> {
    let cached = profile_path(project_file, name).ok().and_then(|path| fs::read(path).ok()).and_then(|bytes| serde_json::from_slice::<SongProfile>(&bytes).ok());
    if let Some(profile) = cached.filter(|profile| profile.version == audiosous_audio::PROFILE_VERSION) {
        return Ok(profile);
    }
    let audio = audiosous_audio::decode_to_48k(&reference_file(project_file, name)?)?;
    let profile = song_profile(&audio);
    save_profile(project_file, name, &profile)?;
    Ok(profile)
}

pub fn list(project_file: &str) -> Result<Vec<ReferenceInfo>, String> {
    let dir = references_dir(project_file)?;
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut names: Vec<String> = fs::read_dir(&dir)
        .map_err(|error| error.to_string())?
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let path = entry.path();
            (path.extension().and_then(|value| value.to_str()) == Some("wav")).then(|| path.file_stem().map(|value| value.to_string_lossy().into_owned())).flatten()
        })
        .filter(|name| checked_name(name).is_ok())
        .collect();
    names.sort();
    names
        .into_iter()
        .map(|name| {
            let profile = load_profile(project_file, &name)?;
            Ok(ReferenceInfo { name, duration_seconds: profile.duration_seconds, profile })
        })
        .collect()
}

pub fn delete(project_file: &str, name: &str) -> Result<(), String> {
    let path = reference_file(project_file, name)?;
    fs::remove_file(path).map_err(|error| error.to_string())?;
    if let Ok(profile) = profile_path(project_file, name) {
        let _ = fs::remove_file(profile);
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MixProfileRequest {
    pub tracks: Vec<crate::mix_check::MixCheckTrack>,
    pub variant: MixVariantSpec,
    pub duration_seconds: f64,
}

/// The whole song as the engine plays `variant`, rendered from the playback proxies through the playback DSP, then
/// profiled exactly like a reference.
pub fn mix_profile(project_file: &str, request: MixProfileRequest) -> Result<SongProfile, String> {
    let project = PathBuf::from(project_file);
    let bundle = bundle::bundle_dir_for(&project)?.canonicalize().map_err(|error| error.to_string())?;
    let cache = bundle.join("cache").join("playback");
    fs::create_dir_all(&cache).map_err(|error| error.to_string())?;
    let mut proxies: HashMap<String, PathBuf> = HashMap::new();
    for track in &request.tracks {
        proxies.insert(track.track_id.clone(), dynamics_check::proxy_for(&project, &cache, &track.track_id, &track.relative_path)?);
    }
    let (tracks, settings) = request.variant.bounce_inputs(|id| proxies.get(id).cloned().ok_or_else(|| format!("No playback proxy for track {id}.")))?;
    let seconds = request.duration_seconds.clamp(0.0, 60.0 * 60.0);
    let audio = bounce(&tracks, settings, seconds)?;
    debug_assert_eq!(PROFILE_RATE, audiosous_audio::PLAYBACK_RATE);
    Ok(song_profile(&audio))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reference_names_are_plain() {
        assert!(checked_name("Daft Punk - Around the World (Live)").is_ok());
        assert!(checked_name("../media/x").is_err());
        assert!(checked_name("a/b").is_err());
        assert!(checked_name("").is_err());
        assert_eq!(stem_name(Path::new("/tmp/My: Song?.mp3")), "My Song");
    }
}
