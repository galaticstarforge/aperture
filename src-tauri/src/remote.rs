//! Remote URL downloading, version peeking, and script caching.
//!
//! Cache key = `sha256(canonical_url)[..16] + "-" + major.minor`
//! Scripts without `// @aperture-version` are never cached (re-downloaded every launch).

use std::path::{Path, PathBuf};
use std::io;

use sha2::{Digest, Sha256};

use crate::cache_key::VERSION_RE;

/// Result of a cache/download resolution.
pub enum FetchOutcome {
    /// Cache hit — script already at this path with matching major.minor.
    CacheHit { script_path: PathBuf, cache_key: String },
    /// Downloaded fresh — script saved to this path.
    Downloaded { script_path: PathBuf, cache_key: String },
    /// Script has no `@aperture-version` — downloaded but not cached (temp path).
    Uncached { script_path: PathBuf },
}

/// Derive a cache key from a canonical URL + major.minor pair.
pub fn cache_key_for_url(canonical_url: &str, major_minor: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(canonical_url.as_bytes());
    let digest = hex::encode(hasher.finalize());
    format!("{}-{}", &digest[..16], major_minor)
}

/// Peek the `// @aperture-version` comment from the first N bytes of text.
pub fn peek_version(text: &str) -> Option<String> {
    if let Some(caps) = VERSION_RE.captures(text) {
        let major = caps.get(1).map(|m| m.as_str()).unwrap_or("0");
        let minor = caps.get(2).map(|m| m.as_str()).unwrap_or("0");
        return Some(format!("{}.{}", major, minor));
    }
    None
}

/// Resolve a remote URL to a local script path, downloading if needed.
///
/// `scripts_dir` — `~/.aperture/scripts/`
/// `offline`     — if true, never attempt network; fail if not cached
pub async fn resolve_remote(
    raw_url: &str,
    canonical_url: &str,
    scripts_dir: &Path,
    offline: bool,
) -> anyhow::Result<FetchOutcome> {
    use tokio::fs;

    // ── offline: only allow cache hits ────────────────────────────────────────
    if offline {
        // Scan scripts_dir for any file whose name starts with the URL hash prefix.
        let prefix = {
            let mut h = Sha256::new();
            h.update(canonical_url.as_bytes());
            hex::encode(h.finalize())[..16].to_string()
        };
        let mut rd = fs::read_dir(scripts_dir).await?;
        while let Some(entry) = rd.next_entry().await? {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with(&prefix) && name.ends_with(".mjs") {
                let key = name.trim_end_matches(".mjs").to_string();
                return Ok(FetchOutcome::CacheHit { script_path: entry.path(), cache_key: key });
            }
        }
        anyhow::bail!(
            "--offline: script not in cache (canonical URL: {})\n\
             Run without --offline to download and cache it.",
            canonical_url
        );
    }

    // ── peek: try to read just the first 4 KB for the version comment ─────────
    let head_text = peek_remote_head(raw_url).await.unwrap_or_default();
    let major_minor_peek = peek_version(&head_text);

    if let Some(ref mm) = major_minor_peek {
        let key = cache_key_for_url(canonical_url, mm);
        let cached = scripts_dir.join(format!("{}.mjs", key));
        if cached.is_file() {
            return Ok(FetchOutcome::CacheHit { script_path: cached, cache_key: key });
        }
    }

    // ── full download ─────────────────────────────────────────────────────────
    let body = download_url(raw_url).await?;
    let body_str = std::str::from_utf8(&body).unwrap_or("");

    let major_minor = peek_version(body_str).or(major_minor_peek);

    match major_minor {
        Some(mm) => {
            let key = cache_key_for_url(canonical_url, &mm);
            let dest = scripts_dir.join(format!("{}.mjs", key));
            fs::write(&dest, &body).await?;
            Ok(FetchOutcome::Downloaded { script_path: dest, cache_key: key })
        }
        None => {
            // No version → write to a temp file, never cached.
            let tmp = scripts_dir.join(format!("uncached-{}.mjs", temp_suffix()));
            fs::write(&tmp, &body).await?;
            Ok(FetchOutcome::Uncached { script_path: tmp })
        }
    }
}

/// Attempt a HEAD request or small range GET to get the first 4 KB.
async fn peek_remote_head(url: &str) -> anyhow::Result<String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()?;

    // Try range GET first (most S3-compatible hosts support it).
    let range_resp = client
        .get(url)
        .header("Range", "bytes=0-4095")
        .send()
        .await;

    match range_resp {
        Ok(resp) if resp.status().is_success() || resp.status().as_u16() == 206 => {
            let bytes = resp.bytes().await?;
            Ok(String::from_utf8_lossy(&bytes).into_owned())
        }
        _ => anyhow::bail!("range GET not supported"),
    }
}

async fn download_url(url: &str) -> anyhow::Result<bytes::Bytes> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()?;
    let resp = client.get(url).send().await?.error_for_status()?;
    Ok(resp.bytes().await?)
}

fn temp_suffix() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let t = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{:x}", t)
}

/// Check whether the cache entry for a remote URL is still valid by reading
/// the cached file's embedded `@aperture-version`. Returns `None` if the file
/// doesn't exist or has no version comment.
pub fn cached_major_minor(script_path: &Path) -> io::Result<Option<String>> {
    use std::io::Read;
    let mut f = std::fs::File::open(script_path)?;
    let mut buf = [0u8; 4096];
    let mut read = 0;
    loop {
        let n = f.read(&mut buf[read..])?;
        if n == 0 { break; }
        read += n;
        if read >= buf.len() { break; }
    }
    let text = String::from_utf8_lossy(&buf[..read]);
    Ok(peek_version(&text))
}
