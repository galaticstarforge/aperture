//! Startup diagnostic log — writes to ~/.aperture/logs/startup-<unix_secs>.log.
//!
//! Call `init()` once after the logs directory exists, then use the `diag!` macro
//! anywhere to append a timestamped line. Flushes after every write.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

static FILE: OnceLock<Mutex<std::fs::File>> = OnceLock::new();

pub fn init(logs_dir: &Path) {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let path = logs_dir.join(format!("startup-{}.log", secs));
    match OpenOptions::new().create(true).append(true).open(&path) {
        Ok(f) => {
            let _ = FILE.set(Mutex::new(f));
            write_line(&format!("=== aperture startup (pid={}) path={} ===", std::process::id(), path.display()));
            write_line(&format!("PATH={}", std::env::var("PATH").unwrap_or_else(|_| "(not set)".into())));
            write_line(&format!("args={:?}", std::env::args().collect::<Vec<_>>()));
            write_line(&format!("cwd={}", std::env::current_dir().map(|p| p.display().to_string()).unwrap_or_else(|_| "(err)".into())));
        }
        Err(e) => {
            eprintln!("[diag] could not open log at {}: {}", path.display(), e);
        }
    }
}

pub fn write_line(msg: &str) {
    let Some(mtx) = FILE.get() else { return };
    let Ok(mut f) = mtx.lock() else { return };
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let _ = writeln!(f, "[{ms}] {msg}");
    let _ = f.flush();
}

macro_rules! diag {
    ($($arg:tt)*) => { $crate::diag::write_line(&format!($($arg)*)) };
}
pub(crate) use diag;
