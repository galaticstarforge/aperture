//! Phase 4 OS-primitive Tauri commands invoked from the frontend when the
//! script calls `runtime.invoke(name, args)`.
//!
//! The frontend receives an `{ type:'invoke', fn, args, callId }` script event,
//! calls the appropriate command here, then forwards the result back to the
//! child's stdin as `{ type:'invoke:result', callId, result }`.

use rfd::AsyncFileDialog;
use serde::Serialize;

// --- filePicker --------------------------------------------------------------

#[derive(Serialize)]
pub struct FilePickerResult {
    pub paths: Vec<String>,
    pub cancelled: bool,
}

#[tauri::command]
pub async fn aperture_file_picker(mode: String, filter: Option<String>) -> Result<FilePickerResult, String> {
    let mut dialog = AsyncFileDialog::new();
    if let Some(f) = &filter {
        if !f.is_empty() {
            dialog = dialog.add_filter("filter", &[f.as_str()]);
        }
    }

    if mode == "directory" {
        let picked = dialog.pick_folder().await;
        match picked {
            None => Ok(FilePickerResult { paths: vec![], cancelled: true }),
            Some(handle) => Ok(FilePickerResult {
                paths: vec![handle.path().to_string_lossy().into_owned()],
                cancelled: false,
            }),
        }
    } else {
        let picked = dialog.pick_files().await;
        match picked {
            None => Ok(FilePickerResult { paths: vec![], cancelled: true }),
            Some(handles) => Ok(FilePickerResult {
                paths: handles
                    .iter()
                    .map(|h| h.path().to_string_lossy().into_owned())
                    .collect(),
                cancelled: false,
            }),
        }
    }
}

// --- notification ------------------------------------------------------------

#[tauri::command]
pub async fn aperture_notification(title: String, body: String, _level: String) -> Result<(), String> {
    // Use a desktop notification via the OS. We spawn a blocking task since
    // `notify-rust` is synchronous — avoid blocking the async executor.
    tokio::task::spawn_blocking(move || {
        // Best-effort: if the platform doesn't support notifications, log and
        // move on rather than erroring the script.
        #[cfg(target_os = "linux")]
        {
            let _ = std::process::Command::new("notify-send")
                .arg(&title)
                .arg(&body)
                .spawn();
        }
        #[cfg(target_os = "macos")]
        {
            let script = format!(
                "display notification {} with title {}",
                shell_quote(&body),
                shell_quote(&title),
            );
            let _ = std::process::Command::new("osascript")
                .arg("-e")
                .arg(&script)
                .spawn();
        }
        #[cfg(target_os = "windows")]
        {
            // Windows toast notifications via PowerShell.
            let ps = format!(
                r#"[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null; $xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02); $xml.GetElementsByTagName('text')[0].AppendChild($xml.CreateTextNode('{title}')) | Out-Null; $xml.GetElementsByTagName('text')[1].AppendChild($xml.CreateTextNode('{body}')) | Out-Null; [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Aperture').Show([Windows.UI.Notifications.ToastNotification]::new($xml))"#,
                title = title.replace('\'', "''"),
                body = body.replace('\'', "''"),
            );
            let _ = std::process::Command::new("powershell")
                .arg("-Command")
                .arg(&ps)
                .spawn();
        }
    })
    .await
    .map_err(|e| e.to_string())
}

// --- openExternal ------------------------------------------------------------

#[tauri::command]
pub async fn aperture_open_external(url: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        open::that(&url).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

// --- clipboard ---------------------------------------------------------------

#[tauri::command]
pub async fn aperture_clipboard_read() -> Result<String, String> {
    tokio::task::spawn_blocking(|| {
        let mut ctx = arboard::Clipboard::new().map_err(|e| e.to_string())?;
        ctx.get_text().map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn aperture_clipboard_write(text: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let mut ctx = arboard::Clipboard::new().map_err(|e| e.to_string())?;
        ctx.set_text(text).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

// --- helpers -----------------------------------------------------------------

#[allow(dead_code)]
fn shell_quote(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\\\""))
}
