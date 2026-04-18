//! Persistent configuration at `~/.aperture/config.json`.
//!
//! Manages:
//!   - `envApprovals` — per-cache-key set of approved env var names
//!   - Window geometry persistence (`~/.aperture/windows/<cache-key>.json`)

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

// ─────────────────────────────── Config file ──────────────────────────────────

#[derive(Debug, Default, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ApertureConfig {
    /// Map of cache-key → set of approved env var names.
    #[serde(default)]
    pub env_approvals: HashMap<String, HashSet<String>>,
}

impl ApertureConfig {
    pub fn load(config_path: &Path) -> Self {
        let raw = match std::fs::read_to_string(config_path) {
            Ok(s) => s,
            Err(_) => return Self::default(),
        };
        serde_json::from_str(&raw).unwrap_or_default()
    }

    pub fn save(&self, config_path: &Path) -> std::io::Result<()> {
        let json = serde_json::to_string_pretty(self)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
        std::fs::write(config_path, json + "\n")
    }

    /// Returns true if all vars in `requested` are already approved for `cache_key`.
    pub fn is_approved(&self, cache_key: &str, requested: &[String]) -> bool {
        if requested.is_empty() {
            return true;
        }
        let Some(approved) = self.env_approvals.get(cache_key) else { return false };
        requested.iter().all(|v| approved.contains(v))
    }

    /// Persist approval for `cache_key` → `vars`.
    pub fn approve(&mut self, cache_key: &str, vars: Vec<String>) {
        self.env_approvals
            .entry(cache_key.to_string())
            .or_default()
            .extend(vars);
    }
}

// ─────────────────────────────── Window geometry ──────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WindowGeometry {
    pub width: f64,
    pub height: f64,
    pub x: f64,
    pub y: f64,
}

impl WindowGeometry {
    pub fn load(windows_dir: &Path, cache_key: &str) -> Option<Self> {
        if cache_key.is_empty() {
            return None;
        }
        let path = windows_dir.join(format!("{}.json", cache_key));
        let raw = std::fs::read_to_string(&path).ok()?;
        serde_json::from_str(&raw).ok()
    }

    pub fn save(&self, windows_dir: &Path, cache_key: &str) -> std::io::Result<()> {
        if cache_key.is_empty() {
            return Ok(());
        }
        std::fs::create_dir_all(windows_dir)?;
        let path = windows_dir.join(format!("{}.json", cache_key));
        let json = serde_json::to_string(self)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
        std::fs::write(path, json)
    }
}

// ─────────────────────────────── Env-var extraction ───────────────────────────

/// Parse `export const env = [...]` from the first 8 KB of a script.
pub fn parse_env_from_script(script: &Path) -> Vec<String> {
    use std::io::Read;
    let Ok(mut f) = std::fs::File::open(script) else { return vec![] };
    let mut buf = [0u8; 8192];
    let mut read = 0;
    loop {
        let Ok(n) = f.read(&mut buf[read..]) else { break };
        if n == 0 { break; }
        read += n;
        if read >= buf.len() { break; }
    }
    let text = String::from_utf8_lossy(&buf[..read]);
    extract_env_from_text(&text)
}

fn extract_env_from_text(text: &str) -> Vec<String> {
    use once_cell::sync::Lazy;
    use regex::Regex;
    static ENV_RE: Lazy<Regex> = Lazy::new(|| {
        Regex::new(r#"export\s+const\s+env\s*=\s*\[([^\]]*)\]"#).unwrap()
    });
    static ENTRY_RE: Lazy<Regex> = Lazy::new(|| {
        Regex::new(r#"['"]([^'"]+)['"]"#).unwrap()
    });
    let Some(caps) = ENV_RE.captures(text) else { return vec![] };
    ENTRY_RE.captures_iter(&caps[1])
        .map(|c| c[1].to_string())
        .collect()
}

/// Build the filtered env map: only vars in `approved` from `requested`, taken from the actual
/// process environment.
pub fn build_approved_env(requested: &[String]) -> HashMap<String, String> {
    requested.iter()
        .filter_map(|k| std::env::var(k).ok().map(|v| (k.clone(), v)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_extraction() {
        let text = r#"export const env = ['MY_TOKEN', "DATABASE_URL"]"#;
        let vars = extract_env_from_text(text);
        assert_eq!(vars, vec!["MY_TOKEN", "DATABASE_URL"]);
    }

    #[test]
    fn is_approved_empty_always_true() {
        let cfg = ApertureConfig::default();
        assert!(cfg.is_approved("any-key", &[]));
    }

    #[test]
    fn approve_and_check() {
        let mut cfg = ApertureConfig::default();
        cfg.approve("k1", vec!["A".to_string(), "B".to_string()]);
        assert!(cfg.is_approved("k1", &["A".to_string()]));
        assert!(cfg.is_approved("k1", &["A".to_string(), "B".to_string()]));
        assert!(!cfg.is_approved("k1", &["A".to_string(), "C".to_string()]));
    }
}
