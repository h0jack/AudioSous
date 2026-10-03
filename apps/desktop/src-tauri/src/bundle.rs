use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

const AUDIO_EXTENSIONS: &[&str] = &[
    "wav", "wave", "aif", "aiff", "mp3", "flac", "ogg", "m4a", "aac", "wma",
];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserFile {
    pub path: String,
    pub filename: String,
    pub file_size_bytes: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyItem {
    pub source_path: String,
    pub relative_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyProgress {
    pub completed_files: usize,
    pub total_files: usize,
    pub filename: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaStatus {
    pub relative_path: String,
    pub exists: bool,
    pub file_size_bytes: u64,
}

pub fn validate_relative_cache_path(relative: &str) -> Result<(), String> {
    let Some(name) = relative.strip_prefix("cache/waveforms/") else {
        return Err("Waveform cache must stay inside cache/waveforms.".into());
    };
    if name.is_empty()
        || relative.len() > 180
        || relative.contains('\0')
        || relative.contains('\\')
        || name.contains('/')
        || !name.ends_with(".peaks")
    {
        return Err("Waveform cache must stay inside cache/waveforms.".into());
    }
    let id = name.trim_end_matches(".peaks");
    if id.is_empty()
        || !id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
    {
        return Err("Waveform cache must stay inside cache/waveforms.".into());
    }
    Ok(())
}

const MAX_CACHE_BYTES: usize = 16 * 1024 * 1024;

pub fn write_project_cache(
    project_file: &Path,
    relative: &str,
    bytes: &[u8],
) -> Result<(), String> {
    if bytes.len() > MAX_CACHE_BYTES {
        return Err("Waveform cache is too large.".into());
    }
    let path = resolve_cache_path(project_file, relative, true)?
        .ok_or("Waveform cache folder does not exist.")?;
    if path
        .symlink_metadata()
        .map(|meta| meta.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err("Refusing to follow a cache symlink.".into());
    }
    let temporary = path.with_extension("tmp");
    {
        let mut file = File::create(&temporary).map_err(|error| error.to_string())?;
        file.write_all(bytes).map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
    }
    fs::rename(&temporary, &path).map_err(|error| error.to_string())?;
    Ok(())
}

pub fn read_project_cache(project_file: &Path, relative: &str) -> Result<Option<Vec<u8>>, String> {
    let Some(path) = resolve_cache_path(project_file, relative, false)? else {
        return Ok(None);
    };
    if !path.is_file() {
        return Ok(None);
    }
    let meta = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
    if meta.file_type().is_symlink() {
        return Err("Refusing to follow a cache symlink.".into());
    }
    if meta.len() > MAX_CACHE_BYTES as u64 {
        return Err("Waveform cache is too large.".into());
    }
    fs::read(&path).map(Some).map_err(|error| error.to_string())
}

fn resolve_cache_path(
    project_file: &Path,
    relative: &str,
    create: bool,
) -> Result<Option<PathBuf>, String> {
    validate_relative_cache_path(relative)?;
    let bundle = bundle_dir_for(project_file)?
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let cache_root = bundle.join("cache").join("waveforms");
    if create {
        fs::create_dir_all(&cache_root).map_err(|error| error.to_string())?;
    } else if !cache_root.exists() {
        return Ok(None);
    }
    let cache_canonical = cache_root
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if !cache_canonical.starts_with(&bundle) {
        return Err("Waveform cache must stay inside the project.".into());
    }
    let file_name = Path::new(relative)
        .file_name()
        .ok_or("Waveform cache must stay inside cache/waveforms.")?;
    Ok(Some(cache_canonical.join(file_name)))
}

pub fn encode_base64(bytes: &[u8]) -> String {
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    let mut index = 0;
    while index + 3 <= bytes.len() {
        let value = ((bytes[index] as u32) << 16)
            | ((bytes[index + 1] as u32) << 8)
            | bytes[index + 2] as u32;
        out.push(TABLE[((value >> 18) & 63) as usize] as char);
        out.push(TABLE[((value >> 12) & 63) as usize] as char);
        out.push(TABLE[((value >> 6) & 63) as usize] as char);
        out.push(TABLE[(value & 63) as usize] as char);
        index += 3;
    }
    let rest = bytes.len() - index;
    if rest == 1 {
        let value = (bytes[index] as u32) << 16;
        out.push(TABLE[((value >> 18) & 63) as usize] as char);
        out.push(TABLE[((value >> 12) & 63) as usize] as char);
        out.push('=');
        out.push('=');
    } else if rest == 2 {
        let value = ((bytes[index] as u32) << 16) | ((bytes[index + 1] as u32) << 8);
        out.push(TABLE[((value >> 18) & 63) as usize] as char);
        out.push(TABLE[((value >> 12) & 63) as usize] as char);
        out.push(TABLE[((value >> 6) & 63) as usize] as char);
        out.push('=');
    }
    out
}

pub fn decode_base64(text: &str) -> Result<Vec<u8>, String> {
    if text.len() > MAX_CACHE_BYTES.div_ceil(3) * 4 {
        return Err("Waveform cache is too large.".into());
    }
    if text.len() % 4 != 0 {
        return Err("Waveform cache could not be read.".into());
    }
    fn value(byte: u8) -> Result<u8, String> {
        match byte {
            b'A'..=b'Z' => Ok(byte - b'A'),
            b'a'..=b'z' => Ok(byte - b'a' + 26),
            b'0'..=b'9' => Ok(byte - b'0' + 52),
            b'+' => Ok(62),
            b'/' => Ok(63),
            _ => Err("Waveform cache could not be read.".into()),
        }
    }
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    for chunk in bytes.chunks(4) {
        let padding = chunk.iter().rev().take_while(|byte| **byte == b'=').count();
        if padding > 2 {
            return Err("Waveform cache could not be read.".into());
        }
        let mut parts = [0_u8; 4];
        for (index, byte) in chunk.iter().enumerate() {
            parts[index] = if *byte == b'=' { 0 } else { value(*byte)? };
        }
        let combined = ((parts[0] as u32) << 18)
            | ((parts[1] as u32) << 12)
            | ((parts[2] as u32) << 6)
            | parts[3] as u32;
        out.push((combined >> 16) as u8);
        if padding < 2 {
            out.push((combined >> 8) as u8);
        }
        if padding < 1 {
            out.push(combined as u8);
        }
    }
    if out.len() > MAX_CACHE_BYTES {
        return Err("Waveform cache is too large.".into());
    }
    Ok(out)
}

pub fn validate_relative_media_path(relative: &str) -> Result<(), String> {
    if relative.is_empty()
        || relative.len() > 512
        || relative.contains('\0')
        || !relative.starts_with("media/")
        || relative.starts_with('/')
        || relative.starts_with('\\')
    {
        return Err("Media path must stay inside the project media folder.".into());
    }
    if relative
        .split(['/', '\\'])
        .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err("Media path must stay inside the project media folder.".into());
    }
    Ok(())
}

pub fn sanitize_bundle_name(name: &str) -> Result<String, String> {
    let cleaned = name
        .trim()
        .chars()
        .filter(|ch| !matches!(ch, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
        .collect::<String>();
    let cleaned = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    if cleaned.is_empty() || cleaned == "." || cleaned == ".." || cleaned.len() > 120 {
        return Err("Enter a project name.".into());
    }
    Ok(cleaned)
}

pub fn list_audio_files(paths: &[String]) -> Result<Vec<UserFile>, String> {
    let mut files = Vec::new();
    for path in paths {
        collect(Path::new(path), false, 0, &mut files)?;
        if files.len() > 128 {
            return Err("Too many audio files. Import up to 128 stems at a time.".into());
        }
    }
    if files.is_empty() {
        return Err("No WAV or AIFF files were found.".into());
    }
    Ok(files)
}

fn collect(
    path: &Path,
    from_directory: bool,
    depth: usize,
    out: &mut Vec<UserFile>,
) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("Could not read {}: {error}", path.display()))?;
    if metadata.file_type().is_symlink() {
        return Ok(());
    }
    if metadata.is_file() {
        if from_directory && !is_audio_candidate(path) {
            return Ok(());
        }
        let filename = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("stem")
            .to_string();
        if filename.starts_with('.') {
            return Ok(());
        }
        out.push(UserFile {
            path: path.to_string_lossy().into_owned(),
            filename,
            file_size_bytes: metadata.len(),
        });
        return Ok(());
    }
    if metadata.is_dir() {
        if depth > 5 {
            return Ok(());
        }
        for entry in fs::read_dir(path).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            collect(&entry.path(), true, depth + 1, out)?;
        }
    }
    Ok(())
}

fn is_audio_candidate(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| AUDIO_EXTENSIONS.contains(&extension.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

pub fn read_range(path: &Path, offset: u64, length: u32) -> Result<Vec<u8>, String> {
    if length > 1_048_576 {
        return Err("Requested read is too large.".into());
    }
    let mut file =
        File::open(path).map_err(|error| format!("Could not read {}: {error}", path.display()))?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|error| error.to_string())?;
    let mut buffer = vec![0_u8; length as usize];
    let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
    buffer.truncate(read);
    Ok(buffer)
}

pub fn bundle_dir_for(project_file: &Path) -> Result<PathBuf, String> {
    let parent = project_file.parent().ok_or("Project file has no folder.")?;
    if parent.file_name().and_then(|name| name.to_str()) == Some("recovery") {
        let bundle = parent
            .parent()
            .ok_or("Recovery file is not inside a project.")?
            .to_path_buf();
        return Ok(bundle);
    }
    Ok(parent.to_path_buf())
}

pub fn canonical_project_file(project_file: &Path) -> Result<PathBuf, String> {
    if project_file
        .extension()
        .and_then(|extension| extension.to_str())
        != Some("amix")
    {
        return Err("Choose an .amix project file.".into());
    }
    if !project_file.is_file() {
        return Err("That project file does not exist.".into());
    }
    if project_file.file_name().and_then(|name| name.to_str()) == Some("project.amix") {
        if let Some(parent) = project_file.parent() {
            if parent.file_name().and_then(|name| name.to_str()) == Some("recovery") {
                if let Some(bundle) = parent.parent() {
                    let primary = bundle.join("project.amix");
                    if primary.is_file() {
                        return Ok(primary);
                    }
                }
            }
        }
    }
    Ok(project_file.to_path_buf())
}

fn resolve_media(bundle: &Path, relative: &str) -> Result<PathBuf, String> {
    validate_relative_media_path(relative)?;
    let joined = bundle.join(relative);
    if joined
        .symlink_metadata()
        .map(|meta| meta.file_type().is_symlink())
        .unwrap_or(false)
    {
        let canonical = joined.canonicalize().map_err(|error| error.to_string())?;
        let bundle_canonical = bundle.canonicalize().map_err(|error| error.to_string())?;
        if !canonical.starts_with(&bundle_canonical) {
            return Err("Media path escapes the project folder.".into());
        }
        return Ok(canonical);
    }
    Ok(joined)
}

pub fn project_media_status(
    project_file: &Path,
    relative_paths: &[String],
) -> Result<Vec<MediaStatus>, String> {
    let bundle = bundle_dir_for(project_file)?;
    let mut statuses = Vec::new();
    for relative_path in relative_paths {
        let status = match resolve_media(&bundle, relative_path) {
            Ok(path) if path.is_file() => MediaStatus {
                relative_path: relative_path.clone(),
                exists: true,
                file_size_bytes: fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0),
            },
            _ => MediaStatus {
                relative_path: relative_path.clone(),
                exists: false,
                file_size_bytes: 0,
            },
        };
        statuses.push(status);
    }
    Ok(statuses)
}

pub fn read_project_media(
    project_file: &Path,
    relative: &str,
    offset: u64,
    length: u32,
) -> Result<Vec<u8>, String> {
    let bundle = bundle_dir_for(project_file)?;
    let path = resolve_media(&bundle, relative)?;
    read_range(&path, offset, length)
}

pub fn create_bundle(
    parent_dir: &Path,
    bundle_name: &str,
    project_json: &str,
    copies: &[CopyItem],
    mut progress: impl FnMut(CopyProgress),
) -> Result<(PathBuf, PathBuf), String> {
    let name = sanitize_bundle_name(bundle_name)?;
    if !parent_dir.is_dir() {
        return Err("Choose a folder for the project.".into());
    }
    if copies.is_empty() {
        return Err("Add at least one readable stem.".into());
    }
    validate_project_json(project_json)?;
    let bundle = parent_dir.join(&name);
    if bundle.exists() {
        return Err(format!("A folder named \"{name}\" already exists there."));
    }

    fs::create_dir_all(bundle.join("media")).map_err(|error| error.to_string())?;
    fs::create_dir_all(bundle.join("cache")).map_err(|error| error.to_string())?;
    fs::create_dir_all(bundle.join("recovery")).map_err(|error| error.to_string())?;
    let cleanup_dir = bundle.clone();

    let result = (|| -> Result<(PathBuf, PathBuf), String> {
        for (index, item) in copies.iter().enumerate() {
            validate_relative_media_path(&item.relative_path)?;
            let source = PathBuf::from(&item.source_path);
            let dest = bundle.join(&item.relative_path);
            if !dest.starts_with(&bundle) {
                return Err("Media path escapes the project folder.".into());
            }
            let filename = source
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("stem")
                .to_string();
            progress(CopyProgress {
                completed_files: index,
                total_files: copies.len(),
                filename: filename.clone(),
            });
            if let Some(parent) = dest.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            copy_readonly(&source, &dest)
                .map_err(|error| format!("Could not copy {filename}: {error}"))?;
            progress(CopyProgress {
                completed_files: index + 1,
                total_files: copies.len(),
                filename,
            });
        }
        let project_file = bundle.join("project.amix");
        write_atomic(&project_file, project_json)?;
        write_atomic(&bundle.join("recovery").join("project.amix"), project_json)?;
        Ok((bundle, project_file))
    })();

    if result.is_err() {
        let _ = fs::remove_dir_all(&cleanup_dir);
    }
    result
}

pub fn write_project_file(project_file: &Path, project_json: &str) -> Result<(), String> {
    if project_file.file_name().and_then(|name| name.to_str()) != Some("project.amix") {
        return Err("Audiosous saves to project.amix inside the project folder.".into());
    }
    if !project_file.is_file() {
        return Err("The project file is missing.".into());
    }
    validate_project_json(project_json)?;
    write_atomic(project_file, project_json)?;
    let recovery_dir = bundle_dir_for(project_file)?.join("recovery");
    fs::create_dir_all(&recovery_dir).map_err(|error| error.to_string())?;
    write_atomic(&recovery_dir.join("project.amix"), project_json)?;
    Ok(())
}

pub fn read_project_text(project_file: &Path) -> Result<(PathBuf, String), String> {
    let canonical = canonical_project_file(project_file)?;
    let json = fs::read_to_string(&canonical)
        .map_err(|error| format!("Could not read the project file: {error}"))?;
    if json.len() > 20_000_000 {
        return Err("Project file is too large.".into());
    }
    Ok((canonical, json))
}

fn validate_project_json(project_json: &str) -> Result<(), String> {
    if project_json.len() > 20_000_000 {
        return Err("Project file is too large.".into());
    }
    let value: serde_json::Value = serde_json::from_str(project_json)
        .map_err(|_| "Project file is not valid JSON.".to_string())?;
    if !value
        .get("schemaVersion")
        .and_then(|version| version.as_u64())
        .is_some()
    {
        return Err("Project file is missing schemaVersion.".into());
    }
    Ok(())
}

fn write_atomic(path: &Path, contents: &str) -> Result<(), String> {
    let temporary = path.with_extension("tmp");
    {
        let mut file = File::create(&temporary).map_err(|error| error.to_string())?;
        file.write_all(contents.as_bytes())
            .map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
    }
    fs::rename(&temporary, path).map_err(|error| error.to_string())?;
    Ok(())
}

fn copy_readonly(source: &Path, dest: &Path) -> Result<(), String> {
    let mut input = File::open(source).map_err(|error| error.to_string())?;
    let mut output = File::create(dest).map_err(|error| error.to_string())?;
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let read = input.read(&mut buffer).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        output
            .write_all(&buffer[..read])
            .map_err(|error| error.to_string())?;
    }
    output.sync_all().map_err(|error| error.to_string())?;
    Ok(())
}

pub fn append_log_line(directory: &Path, line: &str) -> Result<(), String> {
    if line.len() > 16_000 || line.contains('\n') || line.contains('\r') {
        return Err("Log line must be a single short line.".into());
    }
    fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(directory.join("audiosous.jsonl"))
        .map_err(|error| error.to_string())?;
    writeln!(file, "{line}").map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("audiosous-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn rejects_paths_that_escape_the_bundle() {
        assert!(validate_relative_media_path("media/kick.wav").is_ok());
        assert!(validate_relative_media_path("media/../secret.wav").is_err());
        assert!(validate_relative_media_path("/etc/passwd").is_err());
        assert!(validate_relative_media_path("notes.txt").is_err());
        assert!(validate_relative_cache_path("cache/waveforms/track-kick.peaks").is_ok());
        assert!(validate_relative_cache_path("cache/../secret.peaks").is_err());
        assert!(validate_relative_cache_path("cache/waveforms/../secret.peaks").is_err());
        assert!(validate_relative_cache_path("media/kick.peaks").is_err());
    }

    #[test]
    fn waveform_cache_round_trip_stays_in_the_project() {
        let root = temp_root("peaks");
        let bundle = root.join("Song");
        fs::create_dir_all(bundle.join("media")).unwrap();
        let project = bundle.join("project.amix");
        fs::write(&project, b"{}").unwrap();
        let payload = b"ASPK-demo-peaks";
        write_project_cache(&project, "cache/waveforms/track-kick.peaks", payload).unwrap();
        let read = read_project_cache(&project, "cache/waveforms/track-kick.peaks")
            .unwrap()
            .unwrap();
        assert_eq!(read, payload);
        assert!(write_project_cache(&project, "media/track-kick.peaks", payload).is_err());
        assert!(
            read_project_cache(&project, "cache/waveforms/missing.peaks")
                .unwrap()
                .is_none()
        );
        for length in 0..8 {
            let bytes: Vec<u8> = (0..length).map(|index| index * 17).collect();
            assert_eq!(decode_base64(&encode_base64(&bytes)).unwrap(), bytes);
        }
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn copies_stems_without_changing_the_source_and_cleans_up_on_failure() {
        let root = temp_root("bundle");
        let source = root.join("kick.wav");
        fs::write(&source, b"RIFF-demo").unwrap();
        let parent = root.join("projects");
        fs::create_dir_all(&parent).unwrap();
        let json = r#"{"schemaVersion":1}"#;

        let (bundle, project_file) = create_bundle(
            &parent,
            "Night Drive",
            json,
            &[CopyItem {
                source_path: source.to_string_lossy().into_owned(),
                relative_path: "media/track-kick__kick.wav".into(),
            }],
            |_| {},
        )
        .unwrap();

        assert_eq!(fs::read(&source).unwrap(), b"RIFF-demo");
        assert_eq!(
            fs::read(bundle.join("media/track-kick__kick.wav")).unwrap(),
            b"RIFF-demo"
        );
        assert_eq!(fs::read(&project_file).unwrap(), json.as_bytes());
        assert!(bundle.join("recovery/project.amix").is_file());
        assert!(bundle.join("cache").is_dir());

        let missing = CopyItem {
            source_path: root.join("missing.wav").to_string_lossy().into_owned(),
            relative_path: "media/track-missing__missing.wav".into(),
        };
        let error = create_bundle(&parent, "Other", json, &[missing], |_| {}).unwrap_err();
        assert!(error.contains("missing.wav"));
        assert!(!parent.join("Other").exists());

        let escape = CopyItem {
            source_path: source.to_string_lossy().into_owned(),
            relative_path: "media/../secret.wav".into(),
        };
        assert!(create_bundle(&parent, "Escape", json, &[escape], |_| {}).is_err());
        assert!(!parent.join("Escape").exists());

        let _ = fs::remove_dir_all(&root);
    }
}
