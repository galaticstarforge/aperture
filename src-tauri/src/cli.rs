//! Argv parsing for the binary entry point.
//!
//! Shape: `aperture <script-source> <working-dir> [--offline] [--flag value ...]`
//!
//! Flag values are kept raw (strings). Phase 2 will hand them to zod for
//! validation. Complex JSON payloads pass through unchanged.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use thiserror::Error;

#[derive(Debug, Clone)]
pub struct ParsedArgs {
    pub source: ScriptSource,
    pub cwd: PathBuf,
    pub offline: bool,
    pub raw_flags: BTreeMap<String, String>,
}

#[derive(Debug, Clone)]
pub enum ScriptSource {
    LocalPath(PathBuf),
    RemoteUrl(String),
}

#[derive(Debug, Error)]
pub enum CliError {
    #[error("usage: aperture <script-source> <working-dir> [--offline] [--flag value ...]")]
    Usage,
    #[error("working directory does not exist or is not a directory: {0}")]
    BadCwd(PathBuf),
    #[error("script file not found: {0}")]
    MissingScript(PathBuf),
    #[error("only .mjs scripts are supported in v1 (got: {0})")]
    NotMjs(String),
    #[error("flag `--{0}` is missing a value")]
    FlagMissingValue(String),
    #[error("bare positional `{0}` is not allowed after the script/cwd pair")]
    UnexpectedPositional(String),
}

pub fn parse<I, S>(args: I) -> Result<ParsedArgs, CliError>
where
    I: IntoIterator<Item = S>,
    S: Into<String>,
{
    let mut it = args.into_iter().map(Into::into);
    // argv[0] is the binary itself.
    let _bin = it.next().ok_or(CliError::Usage)?;

    let mut positionals: Vec<String> = Vec::new();
    let mut offline = false;
    let mut raw_flags: BTreeMap<String, String> = BTreeMap::new();

    let mut remaining: Vec<String> = it.collect();
    let mut i = 0;
    while i < remaining.len() {
        let arg = std::mem::take(&mut remaining[i]);
        i += 1;
        if arg == "--offline" {
            offline = true;
        } else if let Some(rest) = arg.strip_prefix("--") {
            // --key=value or --key value
            if let Some((k, v)) = rest.split_once('=') {
                raw_flags.insert(k.to_string(), v.to_string());
            } else {
                let val = remaining.get_mut(i).map(std::mem::take).ok_or_else(|| {
                    CliError::FlagMissingValue(rest.to_string())
                })?;
                i += 1;
                raw_flags.insert(rest.to_string(), val);
            }
        } else {
            positionals.push(arg);
        }
    }

    let mut pos = positionals.into_iter();
    let source_raw = pos.next().ok_or(CliError::Usage)?;
    let cwd_raw = pos.next().ok_or(CliError::Usage)?;
    if let Some(extra) = pos.next() {
        return Err(CliError::UnexpectedPositional(extra));
    }

    let source = classify_source(&source_raw)?;
    let cwd = std::fs::canonicalize(&cwd_raw)
        .map_err(|_| CliError::BadCwd(PathBuf::from(&cwd_raw)))?;
    if !cwd.is_dir() {
        return Err(CliError::BadCwd(cwd));
    }

    Ok(ParsedArgs {
        source,
        cwd,
        offline,
        raw_flags,
    })
}

fn classify_source(raw: &str) -> Result<ScriptSource, CliError> {
    if raw.starts_with("http://") || raw.starts_with("https://") {
        return Ok(ScriptSource::RemoteUrl(raw.to_string()));
    }
    let path = PathBuf::from(raw);
    let abs = if path.is_absolute() {
        path
    } else {
        std::env::current_dir().unwrap_or_default().join(path)
    };
    if !abs.exists() {
        return Err(CliError::MissingScript(abs));
    }
    if abs.extension().and_then(|s| s.to_str()) != Some("mjs") {
        return Err(CliError::NotMjs(abs.display().to_string()));
    }
    // Resolve symlinks for canonical identity — used by the multi-instance lock.
    let canonical = std::fs::canonicalize(&abs).unwrap_or(abs);
    Ok(ScriptSource::LocalPath(canonical))
}

impl ScriptSource {
    /// The canonical identity used for the multi-instance lock file name.
    /// For remote URLs, signing parameters (`X-Amz-*`, etc) are stripped per
    /// design.md §"Cache Invalidation". For local paths we canonicalize.
    pub fn canonical_identity(&self) -> String {
        match self {
            ScriptSource::LocalPath(p) => p.to_string_lossy().into_owned(),
            ScriptSource::RemoteUrl(u) => strip_signed_query(u),
        }
    }

    pub fn as_display(&self) -> String {
        match self {
            ScriptSource::LocalPath(p) => p.display().to_string(),
            ScriptSource::RemoteUrl(u) => u.clone(),
        }
    }

    pub fn local_path(&self) -> Option<&Path> {
        match self {
            ScriptSource::LocalPath(p) => Some(p),
            ScriptSource::RemoteUrl(_) => None,
        }
    }

    pub fn is_remote(&self) -> bool {
        matches!(self, ScriptSource::RemoteUrl(_))
    }
}

fn strip_signed_query(raw: &str) -> String {
    match url::Url::parse(raw) {
        Ok(mut u) => {
            let filtered: Vec<(String, String)> = u
                .query_pairs()
                .filter(|(k, _)| !k.starts_with("X-Amz-") && !k.eq_ignore_ascii_case("signature"))
                .map(|(k, v)| (k.into_owned(), v.into_owned()))
                .collect();
            u.set_query(None);
            if !filtered.is_empty() {
                let mut qp = u.query_pairs_mut();
                for (k, v) in filtered {
                    qp.append_pair(&k, &v);
                }
            }
            u.to_string()
        }
        Err(_) => raw.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flag_parsing_split_and_eq() {
        let tmp = std::env::temp_dir();
        let script = tmp.join("aperture-cli-test.mjs");
        std::fs::write(&script, "").unwrap();
        let args = vec![
            "aperture".into(),
            script.display().to_string(),
            tmp.display().to_string(),
            "--foo".into(),
            "bar".into(),
            "--baz=qux".into(),
            "--offline".into(),
        ];
        let parsed = parse::<_, String>(args).unwrap();
        assert!(parsed.offline);
        assert_eq!(parsed.raw_flags.get("foo").map(String::as_str), Some("bar"));
        assert_eq!(parsed.raw_flags.get("baz").map(String::as_str), Some("qux"));
        let _ = std::fs::remove_file(&script);
    }

    #[test]
    fn strips_amz_query() {
        let raw = "https://s3.example.com/foo.mjs?X-Amz-Signature=abc&v=1";
        let stripped = strip_signed_query(raw);
        assert!(stripped.contains("v=1"));
        assert!(!stripped.to_lowercase().contains("x-amz-signature"));
    }
}
