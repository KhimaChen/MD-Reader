use crate::watch::WatchManager;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri_plugin_dialog::DialogExt;

const EXTENSIONS: &[&str] = &["md", "markdown", "mdown", "mkd", "mkdn", "mdtxt", "text", "txt"];

#[derive(Serialize, Clone)]
pub struct OpenedFile {
    pub path: String,
    pub name: String,
    pub content: String,
}

fn read_opened_file(path: &Path) -> Result<OpenedFile, String> {
    let content = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    Ok(OpenedFile {
        path: path.to_string_lossy().to_string(),
        name,
        content,
    })
}

/// Show the native "Open file" dialog, read every selected file, and start
/// watching each one for Live Reload.
#[tauri::command]
pub fn open_markdown_dialog(
    app: tauri::AppHandle,
    manager: tauri::State<WatchManager>,
) -> Result<Vec<OpenedFile>, String> {
    let picked = app
        .dialog()
        .file()
        .add_filter("Markdown", EXTENSIONS)
        .blocking_pick_files();

    let Some(picked) = picked else {
        return Ok(Vec::new());
    };

    let mut opened = Vec::new();
    for file_path in picked {
        let path: PathBuf = match file_path.into_path() {
            Ok(p) => p,
            Err(e) => {
                log::error!("dropped non-filesystem path from open dialog: {e}");
                continue;
            }
        };
        match read_opened_file(&path) {
            Ok(opened_file) => {
                manager.watch(&path);
                opened.push(opened_file);
            }
            Err(e) => log::error!("failed to read {path:?}: {e}"),
        }
    }
    Ok(opened)
}

/// Read a single file by path (used for drag-and-drop, which supplies real
/// paths via Tauri's native drag-drop event) and start watching it.
#[tauri::command]
pub fn open_path(path: String, manager: tauri::State<WatchManager>) -> Result<OpenedFile, String> {
    let path_buf = PathBuf::from(&path);
    let opened_file = read_opened_file(&path_buf)?;
    manager.watch(&path_buf);
    Ok(opened_file)
}

/// Stop watching a path, called when its tab closes.
#[tauri::command]
pub fn close_path(path: String, manager: tauri::State<WatchManager>) {
    manager.unwatch(Path::new(&path));
}
