//! Bun-backed dependency installer.
//!
//! `~/.aperture/deps/` is a shared bun-managed workspace. For each launch
//! with a cache miss, this module:
//!   1. Merges the script's `deps[]` into a shared `package.json`
//!   2. Runs `bun install` with a file lock for concurrent-safety
//!   3. Returns the `node_modules` path to be added to `NODE_PATH`

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use fs2::FileExt;
use serde_json::Value;
use tokio::fs;

/// Parse `export const deps = [...]` from the first 8 KB of a script.
/// Returns an empty vec if no deps are declared.
pub fn parse_deps_from_script(script: &Path) -> Vec<String> {
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
    extract_deps_from_text(&text)
}

/// Very simple static extractor. Handles the common single-line pattern:
/// `export const deps = ['a', 'b@1.0']`
fn extract_deps_from_text(text: &str) -> Vec<String> {
    use once_cell::sync::Lazy;
    use regex::Regex;
    // Match `export const deps = [...]` — single-line, string literals only.
    static DEPS_RE: Lazy<Regex> = Lazy::new(|| {
        Regex::new(r#"export\s+const\s+deps\s*=\s*\[([^\]]*)\]"#).unwrap()
    });
    static ENTRY_RE: Lazy<Regex> = Lazy::new(|| {
        Regex::new(r#"['"]([^'"]+)['"]"#).unwrap()
    });
    let Some(caps) = DEPS_RE.captures(text) else { return vec![] };
    let inner = &caps[1];
    ENTRY_RE.captures_iter(inner)
        .map(|c| c[1].to_string())
        .collect()
}

/// Install result — paths to pass as NODE_PATH to the child process.
pub struct DepInstallResult {
    pub node_modules: PathBuf,
    /// Tail of bun install stderr for error reporting.
    pub install_log: String,
}

/// Ensure `deps` are installed in `~/.aperture/deps/`.
/// Acquires a file lock for concurrent-safety.
/// Returns `Ok(None)` when deps is empty.
pub async fn ensure_deps(
    deps_dir: &Path,
    deps: &[String],
) -> anyhow::Result<Option<DepInstallResult>> {
    if deps.is_empty() {
        return Ok(None);
    }

    fs::create_dir_all(deps_dir).await?;

    // ── file lock ─────────────────────────────────────────────────────────────
    let lock_path = deps_dir.join(".install.lock");
    let lock_file = tokio::task::spawn_blocking({
        let lock_path = lock_path.clone();
        move || -> anyhow::Result<std::fs::File> {
            let f = std::fs::OpenOptions::new()
                .create(true)
                .write(true)
                .read(true)
                .open(&lock_path)?;
            // Blocking wait up to 60 s for any concurrent install to finish.
            let deadline = std::time::Instant::now() + Duration::from_secs(60);
            loop {
                match f.try_lock_exclusive() {
                    Ok(()) => return Ok(f),
                    Err(_) if std::time::Instant::now() < deadline => {
                        std::thread::sleep(Duration::from_millis(200));
                    }
                    Err(e) => anyhow::bail!("dep install lock timeout: {e}"),
                }
            }
        }
    })
    .await??;

    // ── merge deps into package.json ──────────────────────────────────────────
    let pkg_path = deps_dir.join("package.json");
    let mut pkg = load_package_json(&pkg_path).await;

    // Extract current deps map (cloned so we don't hold a mutable borrow).
    let existing_deps: serde_json::Map<String, Value> = pkg
        .get("dependencies")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();

    let mut changed = false;
    let mut merged = existing_deps;
    for dep in deps {
        let (name, version) = split_dep(dep);
        if !merged.contains_key(name) {
            merged.insert(name.to_string(), Value::String(version.to_string()));
            changed = true;
        }
    }

    if changed {
        if let Some(obj) = pkg.as_object_mut() {
            obj.insert("dependencies".to_string(), Value::Object(merged));
        }
        fs::write(&pkg_path, serde_json::to_string_pretty(&pkg)? + "\n").await?;
    }

    // ── bun install ───────────────────────────────────────────────────────────
    let node_modules = deps_dir.join("node_modules");
    let needs_install = changed || !node_modules.is_dir();
    let install_log = if needs_install {
        run_bun_install(deps_dir).await?
    } else {
        String::new()
    };

    // Release lock (drop).
    drop(lock_file);

    Ok(Some(DepInstallResult { node_modules, install_log }))
}

async fn load_package_json(path: &Path) -> Value {
    if let Ok(raw) = fs::read_to_string(path).await {
        if let Ok(v) = serde_json::from_str(&raw) {
            return v;
        }
    }
    serde_json::json!({ "name": "aperture-deps", "version": "0.0.1", "dependencies": {} })
}

async fn run_bun_install(deps_dir: &Path) -> anyhow::Result<String> {
    let bun_bin = find_bun()?;
    let output = tokio::process::Command::new(&bun_bin)
        .arg("install")
        .arg("--no-save")
        .current_dir(deps_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await?;

    let stderr_tail = String::from_utf8_lossy(&output.stderr)
        .lines()
        .rev()
        .take(20)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join("\n");

    if !output.status.success() {
        anyhow::bail!(
            "bun install failed (exit {}):\n{}",
            output.status.code().unwrap_or(-1),
            stderr_tail
        );
    }

    Ok(stderr_tail)
}

fn find_bun() -> anyhow::Result<PathBuf> {
    if let Ok(p) = std::env::var("APERTURE_BUN") {
        return Ok(PathBuf::from(p));
    }
    let exe = if cfg!(windows) { "bun.exe" } else { "bun" };
    let path_var = std::env::var_os("PATH")
        .ok_or_else(|| anyhow::anyhow!("PATH not set"))?;
    for dir in std::env::split_paths(&path_var) {
        let c = dir.join(exe);
        if c.is_file() {
            return Ok(c);
        }
    }
    anyhow::bail!(
        "`bun` not found on PATH. Install Bun: https://bun.sh\n\
         Or set APERTURE_BUN=/path/to/bun"
    )
}

fn split_dep(dep: &str) -> (&str, &str) {
    // Handle scoped packages like @org/pkg@1.0.0
    if dep.starts_with('@') {
        let rest = &dep[1..];
        if let Some(at_pos) = rest.find('@') {
            let name_end = at_pos + 1; // position in original dep
            return (&dep[..name_end], &dep[name_end + 1..]);
        }
        return (dep, "latest");
    }
    if let Some(pos) = dep.find('@') {
        return (&dep[..pos], &dep[pos + 1..]);
    }
    (dep, "latest")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_deps() {
        let text = r#"export const deps = ['lodash', 'axios@1.6.0']"#;
        let deps = extract_deps_from_text(text);
        assert_eq!(deps, vec!["lodash", "axios@1.6.0"]);
    }

    #[test]
    fn empty_deps() {
        let text = "export const ui = {}";
        assert!(extract_deps_from_text(text).is_empty());
    }

    #[test]
    fn split_dep_bare() {
        assert_eq!(split_dep("lodash"), ("lodash", "latest"));
    }

    #[test]
    fn split_dep_versioned() {
        assert_eq!(split_dep("axios@1.6.0"), ("axios", "1.6.0"));
    }

    #[test]
    fn split_dep_scoped() {
        assert_eq!(split_dep("@org/pkg@2.0.0"), ("@org/pkg", "2.0.0"));
    }
}
