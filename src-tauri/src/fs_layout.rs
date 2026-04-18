//! Creates `~/.aperture/` and its subdirectories on first run. Idempotent.
//!
//! The `locks/` subdir is a Phase 1 addition for the multi-instance guard;
//! everything else mirrors design.md §"Filesystem Layout".

use std::io;
use std::path::{Path, PathBuf};

pub struct Layout {
    pub root: PathBuf,
    pub config_json: PathBuf,
    pub deps: PathBuf,
    pub scripts: PathBuf,
    pub state: PathBuf,
    pub windows: PathBuf,
    pub logs: PathBuf,
    pub locks: PathBuf,
}

impl Layout {
    pub fn resolve() -> io::Result<Self> {
        let home = dirs::home_dir().ok_or_else(|| {
            io::Error::new(io::ErrorKind::NotFound, "could not locate home directory")
        })?;
        Ok(Self::under(home.join(".aperture")))
    }

    pub fn under(root: PathBuf) -> Self {
        Self {
            config_json: root.join("config.json"),
            deps: root.join("deps"),
            scripts: root.join("scripts"),
            state: root.join("state"),
            windows: root.join("windows"),
            logs: root.join("logs"),
            locks: root.join("locks"),
            root,
        }
    }

    pub fn ensure(&self) -> io::Result<()> {
        ensure_dir(&self.root)?;
        for dir in [
            &self.deps,
            &self.scripts,
            &self.state,
            &self.windows,
            &self.logs,
            &self.locks,
        ] {
            ensure_dir(dir)?;
        }
        if !self.config_json.exists() {
            std::fs::write(&self.config_json, "{}\n")?;
        }
        Ok(())
    }
}

fn ensure_dir(p: &Path) -> io::Result<()> {
    match std::fs::create_dir_all(p) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => Ok(()),
        Err(e) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ensure_is_idempotent() {
        let tmp = std::env::temp_dir().join(format!("aperture-test-{}", std::process::id()));
        let layout = Layout::under(tmp.clone());
        layout.ensure().unwrap();
        layout.ensure().unwrap();
        assert!(layout.deps.is_dir());
        assert!(layout.locks.is_dir());
        assert!(layout.config_json.is_file());
        std::fs::remove_dir_all(&tmp).ok();
    }
}
