//! Multi-instance guard backed by `~/.aperture/locks/<hash>.lock`.
//!
//! Tauri's `single-instance` plugin handles the OS-level focus-existing-window
//! case across all three target platforms. We layer a file lock on top so:
//!
//! 1. We can cheaply detect a duplicate launch before initializing Tauri (and
//!    exit with a clear error message to stderr as required by acceptance
//!    criterion #4).
//! 2. If the Tauri plugin misbehaves on a given platform (a documented Linux
//!    quirk), we still refuse the second launch instead of silently double-
//!    running the child.
//!
//! The lock is an advisory exclusive flock. When the first process exits the
//! OS releases it automatically, so we don't need to clean the file up.

use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use fs2::FileExt;
use sha2::{Digest, Sha256};

pub struct InstanceLock {
    #[allow(dead_code)] // held for its Drop side-effect (releases the lock)
    file: File,
    pub path: PathBuf,
}

pub enum LockOutcome {
    Acquired(InstanceLock),
    AlreadyHeld { path: PathBuf },
}

pub fn try_acquire(locks_dir: &Path, canonical_id: &str) -> io::Result<LockOutcome> {
    std::fs::create_dir_all(locks_dir)?;
    let mut hasher = Sha256::new();
    hasher.update(canonical_id.as_bytes());
    let digest = hex::encode(hasher.finalize());
    let path = locks_dir.join(format!("{}.lock", &digest[..16]));

    let mut file = OpenOptions::new()
        .create(true)
        .write(true)
        .read(true)
        .truncate(false)
        .open(&path)?;

    match file.try_lock_exclusive() {
        Ok(()) => {
            // Write our pid for debugging; failure is non-fatal.
            let _ = file.set_len(0);
            let _ = writeln!(file, "{}", std::process::id());
            Ok(LockOutcome::Acquired(InstanceLock { file, path }))
        }
        Err(err) if is_would_block(&err) => Ok(LockOutcome::AlreadyHeld { path }),
        Err(err) => Err(err),
    }
}

fn is_would_block(err: &io::Error) -> bool {
    matches!(err.kind(), io::ErrorKind::WouldBlock)
        || err.raw_os_error().map_or(false, |c| c == 11 || c == 35)
}
