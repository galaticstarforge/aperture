//! Argv parsing for the binary entry point.
//!
//! Top-level shapes:
//!
//!   aperture new <name>
//!   aperture validate <script.mjs> [--headless-lint]
//!   aperture run <script-source> <cwd> [--flag value ...]
//!   aperture docs [--section elements|runtime|contract]
//!   aperture dev <script-source> <cwd> [--offline] [--flag value ...]
//!   aperture <script-source> <cwd> [--offline] [--flag value ...]   (GUI launch)
//!
//! Flag values are kept raw (strings). State/zod validation happens in the
//! Node bootstrap. Complex JSON payloads pass through unchanged.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use thiserror::Error;

// ──────────────────────────────── public types ────────────────────────────────

#[derive(Debug, Clone)]
pub struct ParsedArgs {
    pub source: ScriptSource,
    pub cwd: PathBuf,
    pub offline: bool,
    pub dev_mode: bool,
    pub raw_flags: BTreeMap<String, String>,
}

#[derive(Debug, Clone)]
pub enum ScriptSource {
    LocalPath(PathBuf),
    RemoteUrl(String),
}

#[derive(Debug, Clone)]
pub enum DocSection {
    Elements,
    Runtime,
    Contract,
}

/// Top-level command variant.
#[derive(Debug, Clone)]
pub enum ApertureCommand {
    /// Original GUI launch: `aperture <source> <cwd> [flags]`
    GuiLaunch(ParsedArgs),
    /// `aperture dev <source> <cwd> [flags]` — GUI with dev extras
    DevLaunch(ParsedArgs),
    /// `aperture new <name>`
    New { name: String },
    /// `aperture validate <script.mjs> [--headless-lint]`
    Validate { script: PathBuf, headless_lint: bool },
    /// `aperture run <source> <cwd> [flags]` — headless
    HeadlessRun(ParsedArgs),
    /// `aperture docs [--section elements|runtime|contract]`
    Docs { section: Option<DocSection> },
}

#[derive(Debug, Error)]
pub enum CliError {
    #[error(
        "usage:\n  aperture <script> <cwd> [--offline] [--key value ...]\n  aperture new <name>\n  aperture validate <script.mjs> [--headless-lint]\n  aperture run <script> <cwd> [--key value ...]\n  aperture dev <script> <cwd> [--offline] [--key value ...]\n  aperture docs [--section elements|runtime|contract]"
    )]
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
    #[error("unknown --section `{0}`; expected elements, runtime, or contract")]
    UnknownSection(String),
}

// ──────────────────────────────── public API ──────────────────────────────────

pub fn parse_command<I, S>(args: I) -> Result<ApertureCommand, CliError>
where
    I: IntoIterator<Item = S>,
    S: Into<String>,
{
    let mut it = args.into_iter().map(Into::into);
    let _bin = it.next().ok_or(CliError::Usage)?;
    let rest: Vec<String> = it.collect();

    match rest.first().map(String::as_str) {
        Some("new") => parse_new(&rest[1..]),
        Some("validate") => parse_validate(&rest[1..]),
        Some("run") => parse_run(&rest[1..]),
        Some("docs") => parse_docs(&rest[1..]),
        Some("dev") => parse_dev(&rest[1..]),
        _ => parse_gui_launch(&rest, false),
    }
}

// ──────────────────────────────── subcommand parsers ──────────────────────────

fn parse_new(args: &[String]) -> Result<ApertureCommand, CliError> {
    let name = args.first().ok_or(CliError::Usage)?.clone();
    Ok(ApertureCommand::New { name })
}

fn parse_validate(args: &[String]) -> Result<ApertureCommand, CliError> {
    let mut headless_lint = false;
    let mut script_raw: Option<String> = None;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--headless-lint" => {
                headless_lint = true;
                i += 1;
            }
            other if other.starts_with("--") => {
                // Unknown flags silently skipped
                i += 1;
            }
            other => {
                if script_raw.is_none() {
                    script_raw = Some(other.to_string());
                }
                i += 1;
            }
        }
    }
    let raw = script_raw.ok_or(CliError::Usage)?;
    let script = resolve_script_path(&raw)?;
    Ok(ApertureCommand::Validate { script, headless_lint })
}

fn parse_run(args: &[String]) -> Result<ApertureCommand, CliError> {
    let parsed = parse_launch_args(args, false)?;
    Ok(ApertureCommand::HeadlessRun(parsed))
}

fn parse_dev(args: &[String]) -> Result<ApertureCommand, CliError> {
    let mut parsed = parse_launch_args(args, false)?;
    parsed.dev_mode = true;
    Ok(ApertureCommand::DevLaunch(parsed))
}

fn parse_gui_launch(args: &[String], _dev_mode: bool) -> Result<ApertureCommand, CliError> {
    let parsed = parse_launch_args(args, false)?;
    Ok(ApertureCommand::GuiLaunch(parsed))
}

fn parse_docs(args: &[String]) -> Result<ApertureCommand, CliError> {
    let mut section: Option<DocSection> = None;
    let mut i = 0;
    while i < args.len() {
        if args[i] == "--section" {
            i += 1;
            let val = args.get(i).ok_or_else(|| CliError::FlagMissingValue("section".to_string()))?;
            section = Some(match val.as_str() {
                "elements" => DocSection::Elements,
                "runtime" => DocSection::Runtime,
                "contract" => DocSection::Contract,
                other => return Err(CliError::UnknownSection(other.to_string())),
            });
            i += 1;
        } else {
            i += 1;
        }
    }
    Ok(ApertureCommand::Docs { section })
}

// ──────────────────────────────── shared launch parser ────────────────────────

fn parse_launch_args(args: &[String], _is_dev: bool) -> Result<ParsedArgs, CliError> {
    let mut positionals: Vec<String> = Vec::new();
    let mut offline = false;
    let mut raw_flags: BTreeMap<String, String> = BTreeMap::new();

    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        i += 1;
        if arg == "--offline" {
            offline = true;
        } else if let Some(rest) = arg.strip_prefix("--") {
            if let Some((k, v)) = rest.split_once('=') {
                raw_flags.insert(k.to_string(), v.to_string());
            } else {
                let val = args.get(i).cloned().ok_or_else(|| CliError::FlagMissingValue(rest.to_string()))?;
                i += 1;
                raw_flags.insert(rest.to_string(), val);
            }
        } else {
            positionals.push(arg.clone());
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

    Ok(ParsedArgs { source, cwd, offline, dev_mode: false, raw_flags })
}

fn resolve_script_path(raw: &str) -> Result<PathBuf, CliError> {
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
    Ok(std::fs::canonicalize(&abs).unwrap_or(abs))
}

fn classify_source(raw: &str) -> Result<ScriptSource, CliError> {
    if raw.starts_with("http://") || raw.starts_with("https://") {
        return Ok(ScriptSource::RemoteUrl(raw.to_string()));
    }
    let path = resolve_script_path(raw)?;
    Ok(ScriptSource::LocalPath(path))
}

// ──────────────────────────────── ScriptSource helpers ────────────────────────

impl ScriptSource {
    /// Canonical identity used for multi-instance lock and cache keys.
    /// Strips signing parameters from remote URLs per design.md §"Cache Invalidation".
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

    pub fn canonical_url(&self) -> Option<String> {
        match self {
            ScriptSource::RemoteUrl(u) => Some(strip_signed_query(u)),
            ScriptSource::LocalPath(_) => None,
        }
    }
}

pub fn strip_signed_query(raw: &str) -> String {
    match url::Url::parse(raw) {
        Ok(mut u) => {
            let filtered: Vec<(String, String)> = u
                .query_pairs()
                .filter(|(k, _)| {
                    !k.starts_with("X-Amz-")
                        && !k.eq_ignore_ascii_case("signature")
                        && !k.eq_ignore_ascii_case("x-signature")
                        && !k.eq_ignore_ascii_case("token")
                })
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

// ──────────────────────────────── tests ───────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn make_tmp_script() -> PathBuf {
        let p = std::env::temp_dir().join(format!("aperture-cli-test-{}.mjs", std::process::id()));
        std::fs::write(&p, "").unwrap();
        p
    }

    #[test]
    fn flag_parsing_split_and_eq() {
        let tmp = std::env::temp_dir();
        let script = make_tmp_script();
        let args = vec![
            "aperture".to_string(),
            script.display().to_string(),
            tmp.display().to_string(),
            "--foo".to_string(),
            "bar".to_string(),
            "--baz=qux".to_string(),
            "--offline".to_string(),
        ];
        let cmd = parse_command::<_, String>(args).unwrap();
        if let ApertureCommand::GuiLaunch(parsed) = cmd {
            assert!(parsed.offline);
            assert_eq!(parsed.raw_flags.get("foo").map(String::as_str), Some("bar"));
            assert_eq!(parsed.raw_flags.get("baz").map(String::as_str), Some("qux"));
        } else {
            panic!("expected GuiLaunch");
        }
        let _ = std::fs::remove_file(&script);
    }

    #[test]
    fn strips_amz_query() {
        let raw = "https://s3.example.com/foo.mjs?X-Amz-Signature=abc&v=1";
        let stripped = strip_signed_query(raw);
        assert!(stripped.contains("v=1"));
        assert!(!stripped.to_lowercase().contains("x-amz-signature"));
    }

    #[test]
    fn strips_token_and_xsig() {
        let raw = "https://host/x.mjs?token=abc&x-signature=def&keep=1";
        let stripped = strip_signed_query(raw);
        assert!(stripped.contains("keep=1"));
        assert!(!stripped.contains("token="));
        assert!(!stripped.contains("x-signature="));
    }

    #[test]
    fn new_subcommand() {
        let args = vec!["aperture".to_string(), "new".to_string(), "myscript".to_string()];
        match parse_command::<_, String>(args).unwrap() {
            ApertureCommand::New { name } => assert_eq!(name, "myscript"),
            _ => panic!("expected New"),
        }
    }

    #[test]
    fn docs_section_filter() {
        let args = vec!["aperture".to_string(), "docs".to_string(), "--section".to_string(), "elements".to_string()];
        match parse_command::<_, String>(args).unwrap() {
            ApertureCommand::Docs { section: Some(DocSection::Elements) } => {}
            _ => panic!("expected Docs with Elements section"),
        }
    }

    #[test]
    fn docs_unknown_section_errors() {
        let args = vec!["aperture".to_string(), "docs".to_string(), "--section".to_string(), "foobar".to_string()];
        assert!(parse_command::<_, String>(args).is_err());
    }
}
