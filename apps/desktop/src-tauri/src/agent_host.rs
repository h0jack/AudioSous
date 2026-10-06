//! The conversational agent's provider settings and its one network path.
//!
//! The webview never holds the API key. Provider settings live in the application config directory, not in any
//! project; the key comes from `ANTHROPIC_API_KEY` or a key file there (owner-only permissions). The only request
//! the shell makes for the agent is a POST to the Anthropic Messages endpoint, with the key added here. Nothing in
//! this module reads project files or audio.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

pub const PROVIDERS: [&str; 2] = ["none", "anthropic"];
pub const DEFAULT_MODEL: &str = "claude-opus-5-5";
const MESSAGES_URL: &str = "https://api.anthropic.com/v1/messages";
const MAX_BODY_BYTES: usize = 2 * 1024 * 1024;
const KEY_ENV: &str = "ANTHROPIC_API_KEY";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfig {
    pub provider: String,
    pub model: String,
    pub effort: String,
}

impl Default for AgentConfig {
    fn default() -> Self {
        Self { provider: "none".into(), model: DEFAULT_MODEL.into(), effort: "medium".into() }
    }
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentSettingsInfo {
    pub provider: String,
    pub model: String,
    pub effort: String,
    /// "environment", "settings", or null. Never the key itself.
    pub key_source: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveAgentSettings {
    pub provider: String,
    pub model: String,
    pub effort: String,
    /// A new key to store, or null to keep the stored one.
    pub api_key: Option<String>,
    #[serde(default)]
    pub clear_key: bool,
}

#[derive(Debug, Deserialize)]
pub struct AgentHttpRequest {
    pub url: String,
    pub method: String,
    pub headers: Vec<(String, String)>,
    pub body: String,
}

#[derive(Debug, Serialize)]
pub struct AgentHttpResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: String,
}

fn config_file(dir: &Path) -> PathBuf {
    dir.join("agent.json")
}

fn key_file(dir: &Path) -> PathBuf {
    dir.join("anthropic.key")
}

pub fn read_config(dir: &Path) -> AgentConfig {
    fs::read_to_string(config_file(dir))
        .ok()
        .and_then(|text| serde_json::from_str::<AgentConfig>(&text).ok())
        .filter(|config| PROVIDERS.contains(&config.provider.as_str()))
        .unwrap_or_default()
}

fn stored_key(dir: &Path) -> Option<String> {
    fs::read_to_string(key_file(dir)).ok().map(|text| text.trim().to_string()).filter(|key| !key.is_empty())
}

fn environment_key() -> Option<String> {
    std::env::var(KEY_ENV).ok().map(|key| key.trim().to_string()).filter(|key| !key.is_empty())
}

/// The key to use and where it came from. The environment wins, so a developer key never has to be stored.
fn api_key(dir: &Path) -> Option<(String, &'static str)> {
    environment_key().map(|key| (key, "environment")).or_else(|| stored_key(dir).map(|key| (key, "settings")))
}

pub fn settings_info(dir: &Path) -> AgentSettingsInfo {
    let config = read_config(dir);
    AgentSettingsInfo {
        provider: config.provider,
        model: config.model,
        effort: config.effort,
        key_source: api_key(dir).map(|(_, source)| source.to_string()),
    }
}

fn valid_model(model: &str) -> bool {
    !model.is_empty() && model.len() <= 64 && model.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.' || c == '_')
}

pub fn save_settings(dir: &Path, input: SaveAgentSettings) -> Result<AgentSettingsInfo, String> {
    if !PROVIDERS.contains(&input.provider.as_str()) {
        return Err("Unknown provider.".into());
    }
    if !valid_model(&input.model) {
        return Err("The model name has characters a model id never has.".into());
    }
    if !["low", "medium", "high"].contains(&input.effort.as_str()) {
        return Err("Effort is low, medium, or high.".into());
    }
    fs::create_dir_all(dir).map_err(|error| format!("Could not create the settings folder: {error}"))?;
    let config = AgentConfig { provider: input.provider, model: input.model, effort: input.effort };
    let text = serde_json::to_string_pretty(&config).map_err(|error| error.to_string())?;
    fs::write(config_file(dir), text).map_err(|error| format!("Could not save the settings: {error}"))?;
    if input.clear_key {
        let _ = fs::remove_file(key_file(dir));
    } else if let Some(key) = input.api_key.map(|key| key.trim().to_string()).filter(|key| !key.is_empty()) {
        if key.len() > 512 || key.chars().any(|c| c.is_whitespace() || c.is_control()) {
            return Err("That does not look like an API key.".into());
        }
        write_private(&key_file(dir), &key)?;
    }
    Ok(settings_info(dir))
}

/// Writes a file only the current user can read.
fn write_private(path: &Path, text: &str) -> Result<(), String> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(|error| format!("Could not store the key: {error}"))?;
    file.write_all(text.as_bytes()).map_err(|error| format!("Could not store the key: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// Request headers the agent's SDK may send. Credentials are never taken from the webview.
fn header_allowed(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    name == "content-type" || name == "accept" || name == "anthropic-version" || name == "anthropic-beta" || name.starts_with("x-stainless-")
}

/// Checks the request is the one the agent is allowed to make.
pub fn validate(request: &AgentHttpRequest) -> Result<(), String> {
    if request.method.to_ascii_uppercase() != "POST" {
        return Err("Only POST to the Messages endpoint is allowed.".into());
    }
    let allowed = request.url == MESSAGES_URL || request.url == format!("{MESSAGES_URL}?beta=true");
    if !allowed {
        return Err("The assistant may only call the Anthropic Messages endpoint.".into());
    }
    if request.body.len() > MAX_BODY_BYTES {
        return Err("The request is larger than the assistant ever sends.".into());
    }
    Ok(())
}

pub fn send(dir: &Path, request: AgentHttpRequest) -> Result<AgentHttpResponse, String> {
    validate(&request)?;
    let config = read_config(dir);
    if config.provider != "anthropic" {
        return Err("not-configured: No AI provider is configured.".into());
    }
    let Some((key, _)) = api_key(dir) else {
        return Err("not-configured: No API key is configured.".into());
    };
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(180)))
        .http_status_as_error(false)
        .build()
        .into();
    let mut builder = agent.post(&request.url);
    for (name, value) in request.headers.iter().filter(|(name, _)| header_allowed(name)) {
        builder = builder.header(name.as_str(), value.as_str());
    }
    builder = builder.header("x-api-key", key.as_str());
    let mut response = builder.send(request.body.as_bytes()).map_err(|error| format!("unavailable: {error}"))?;
    let status = response.status().as_u16();
    let headers = response
        .headers()
        .iter()
        .filter(|(name, _)| {
            let name = name.as_str();
            name != "content-encoding" && name != "content-length" && name != "transfer-encoding"
        })
        .filter_map(|(name, value)| value.to_str().ok().map(|value| (name.as_str().to_string(), value.to_string())))
        .collect();
    let body = response.body_mut().read_to_string().map_err(|error| format!("unavailable: {error}"))?;
    Ok(AgentHttpResponse { status, headers, body })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("audiosous-agent-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    fn request(url: &str, method: &str) -> AgentHttpRequest {
        AgentHttpRequest { url: url.into(), method: method.into(), headers: vec![], body: "{}".into() }
    }

    #[test]
    fn only_the_messages_endpoint_is_allowed() {
        assert!(validate(&request("https://api.anthropic.com/v1/messages", "POST")).is_ok());
        assert!(validate(&request("https://api.anthropic.com/v1/messages?beta=true", "POST")).is_ok());
        assert!(validate(&request("https://api.anthropic.com/v1/files", "POST")).is_err());
        assert!(validate(&request("https://example.com/v1/messages", "POST")).is_err());
        assert!(validate(&request("https://api.anthropic.com/v1/messages", "GET")).is_err());
        assert!(validate(&request("http://api.anthropic.com/v1/messages", "POST")).is_err());
        let mut large = request("https://api.anthropic.com/v1/messages", "POST");
        large.body = "x".repeat(MAX_BODY_BYTES + 1);
        assert!(validate(&large).is_err());
    }

    #[test]
    fn credentials_from_the_webview_are_dropped() {
        assert!(!header_allowed("x-api-key"));
        assert!(!header_allowed("Authorization"));
        assert!(!header_allowed("cookie"));
        assert!(header_allowed("anthropic-version"));
        assert!(header_allowed("Content-Type"));
    }

    #[test]
    fn settings_round_trip_without_exposing_the_key() {
        let dir = temp_dir("settings");
        assert_eq!(read_config(&dir), AgentConfig::default());
        let info = save_settings(&dir, SaveAgentSettings { provider: "anthropic".into(), model: "claude-opus-5-5".into(), effort: "medium".into(), api_key: Some("sk-test-123".into()), clear_key: false }).unwrap();
        assert_eq!(info.provider, "anthropic");
        if environment_key().is_none() {
            assert_eq!(info.key_source.as_deref(), Some("settings"));
        }
        let serialized = serde_json::to_string(&info).unwrap();
        assert!(!serialized.contains("sk-test-123"));
        assert!(!fs::read_to_string(config_file(&dir)).unwrap().contains("sk-test-123"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(key_file(&dir)).unwrap().permissions().mode() & 0o777, 0o600);
        }
        save_settings(&dir, SaveAgentSettings { provider: "anthropic".into(), model: "claude-opus-5-5".into(), effort: "low".into(), api_key: None, clear_key: true }).unwrap();
        assert!(stored_key(&dir).is_none());
        assert!(save_settings(&dir, SaveAgentSettings { provider: "shell".into(), model: "x".into(), effort: "low".into(), api_key: None, clear_key: false }).is_err());
        assert!(save_settings(&dir, SaveAgentSettings { provider: "anthropic".into(), model: "../../etc".into(), effort: "low".into(), api_key: None, clear_key: false }).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn nothing_is_sent_without_a_configured_provider() {
        let dir = temp_dir("unconfigured");
        let error = send(&dir, request("https://api.anthropic.com/v1/messages", "POST")).unwrap_err();
        assert!(error.starts_with("not-configured"));
        let _ = fs::remove_dir_all(&dir);
    }
}
