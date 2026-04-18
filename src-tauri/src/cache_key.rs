//! Phase 2 cache-key derivation.
//!
//! Design reference: phases/phase-2 §"Persistence" and the Risks section:
//!
//! > Phase 2 can proceed with a provisional derivation
//! > (`sha256(canonical_source) + '-' + majorMinor`), but Phase 6 must lock
//! > the exact format before the first public release, including how remote
//! > URL signing parameters are stripped.
//!
//! We parse `// @aperture-version X.Y.Z` out of the first 4 KB of the script
//! source and emit a cache key of `sha256(canonical_path)[..16] + "-X.Y"`.
//! Scripts without the version comment return `None`, which the bootstrap
//! treats as "never cached" per design.md §"Cache Invalidation".

use std::io;
use std::path::Path;

use once_cell::sync::Lazy;
use regex::Regex;
use sha2::{Digest, Sha256};

static VERSION_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?m)^\s*//\s*@aperture-version\s+(\d+)\.(\d+)\.(\d+)").unwrap());

/// Read up to the first 4 KB of a file and scan for `// @aperture-version`.
/// Returns the `"major.minor"` pair if found.
pub fn read_version(path: &Path) -> io::Result<Option<String>> {
    use std::io::Read;
    let mut f = std::fs::File::open(path)?;
    let mut buf = [0u8; 4096];
    let mut read = 0;
    loop {
        let n = f.read(&mut buf[read..])?;
        if n == 0 {
            break;
        }
        read += n;
        if read >= buf.len() {
            break;
        }
    }
    let text = String::from_utf8_lossy(&buf[..read]);
    if let Some(caps) = VERSION_RE.captures(&text) {
        let major = caps.get(1).map(|m| m.as_str()).unwrap_or("0");
        let minor = caps.get(2).map(|m| m.as_str()).unwrap_or("0");
        return Ok(Some(format!("{}.{}", major, minor)));
    }
    Ok(None)
}

/// Compute the phase-2 cache key, or `None` if the script declines caching.
pub fn derive(script_path: &Path) -> io::Result<Option<String>> {
    let Some(major_minor) = read_version(script_path)? else {
        return Ok(None);
    };
    let canonical = std::fs::canonicalize(script_path).unwrap_or_else(|_| script_path.to_path_buf());
    let mut hasher = Sha256::new();
    hasher.update(canonical.to_string_lossy().as_bytes());
    let digest = hex::encode(hasher.finalize());
    Ok(Some(format!("{}-{}", &digest[..16], major_minor)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_script(contents: &str, ext: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir();
        let p = dir.join(format!(
            "aperture-cachekey-{}-{}.{}",
            std::process::id(),
            rand_suffix(),
            ext
        ));
        std::fs::write(&p, contents).unwrap();
        p
    }
    fn rand_suffix() -> String {
        use std::time::{SystemTime, UNIX_EPOCH};
        let t = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        format!("{:x}", t)
    }

    #[test]
    fn parses_version() {
        let p = tmp_script("// @aperture-version 1.2.3\nexport const x = 1\n", "mjs");
        let v = read_version(&p).unwrap();
        assert_eq!(v, Some("1.2".to_string()));
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn no_version_returns_none() {
        let p = tmp_script("export const x = 1\n", "mjs");
        assert_eq!(read_version(&p).unwrap(), None);
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn minor_bump_changes_key() {
        let p1 = tmp_script("// @aperture-version 1.0.0\n", "mjs");
        let p2 = tmp_script("// @aperture-version 1.1.0\n", "mjs");
        let k1 = derive(&p1).unwrap();
        let k2 = derive(&p2).unwrap();
        assert!(k1.is_some() && k2.is_some());
        assert_ne!(k1, k2);
        let _ = std::fs::remove_file(&p1);
        let _ = std::fs::remove_file(&p2);
    }

    #[test]
    fn patch_bump_preserves_key() {
        // Patch bumps reuse the cache (design.md §"Cache Invalidation").
        let p1 = tmp_script("// @aperture-version 1.0.0\n", "mjs");
        let p1_path_str = p1.to_string_lossy().into_owned();
        let k1 = derive(&p1).unwrap().unwrap();
        // Same file, different content (patch bump on disk).
        std::fs::write(&p1, "// @aperture-version 1.0.7\n").unwrap();
        let k2 = derive(&p1).unwrap().unwrap();
        assert_eq!(k1, k2, "{}", p1_path_str);
        let _ = std::fs::remove_file(&p1);
    }
}
