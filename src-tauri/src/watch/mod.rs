pub mod classify;

use classify::{notify_event_to_raw, ChangeKind, FileWatchState};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const GRACE: Duration = Duration::from_millis(300);
const TICK_INTERVAL: Duration = Duration::from_millis(100);

#[derive(Clone, serde::Serialize)]
pub struct ChangeEvent {
    pub path: String,
    pub kind: &'static str,
    pub content: Option<String>,
}

struct DirWatch {
    // Held only to keep the OS-level watch alive for as long as this
    // directory has tracked files; never read after construction.
    _watcher: RecommendedWatcher,
    files: HashMap<OsString, FileWatchState>,
}

type Dirs = Arc<Mutex<HashMap<PathBuf, DirWatch>>>;

/// Tracks a `notify` watch per directory (see ADR 0002 for why directories,
/// not files) shared across every open tab whose file lives there, and
/// periodically resolves pending removals into Detached via a ticker thread.
#[derive(Clone)]
pub struct WatchManager {
    dirs: Dirs,
    app: AppHandle,
}

impl WatchManager {
    pub fn new(app: AppHandle) -> Self {
        let manager = Self {
            dirs: Arc::new(Mutex::new(HashMap::new())),
            app,
        };
        manager.spawn_ticker();
        manager
    }

    fn spawn_ticker(&self) {
        let dirs = self.dirs.clone();
        let app = self.app.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(TICK_INTERVAL);
            emit_all(&app, collect_tick_changes(&dirs, Instant::now()));
        });
    }

    /// Start tracking `path` for Live Reload, creating a directory watch if
    /// this is the first tracked file in that directory.
    pub fn watch(&self, path: &Path) {
        let Some((dir, name)) = split_dir_name(path) else {
            return;
        };

        let mut guard = self.dirs.lock().unwrap();
        if let Some(watch) = guard.get_mut(&dir) {
            watch.files.entry(name).or_insert_with(FileWatchState::new);
            return;
        }

        let dirs = self.dirs.clone();
        let app = self.app.clone();
        let watch_dir = dir.clone();
        let mut watcher = match notify::recommended_watcher(
            move |res: notify::Result<notify::Event>| {
                let Ok(event) = res else { return };
                emit_all(&app, collect_event_changes(&dirs, &watch_dir, &event));
            },
        ) {
            Ok(w) => w,
            Err(e) => {
                log::error!("failed to create watcher for {dir:?}: {e}");
                return;
            }
        };

        if let Err(e) = watcher.watch(&dir, RecursiveMode::NonRecursive) {
            log::error!("failed to watch {dir:?}: {e}");
            return;
        }

        let mut files = HashMap::new();
        files.insert(name, FileWatchState::new());
        guard.insert(
            dir,
            DirWatch {
                _watcher: watcher,
                files,
            },
        );
    }

    /// Stop tracking `path`. Drops the directory watch entirely once no
    /// tracked file remains in it.
    pub fn unwatch(&self, path: &Path) {
        let Some((dir, name)) = split_dir_name(path) else {
            return;
        };

        let mut guard = self.dirs.lock().unwrap();
        if let Some(watch) = guard.get_mut(&dir) {
            watch.files.remove(&name);
            if watch.files.is_empty() {
                guard.remove(&dir);
            }
        }
    }
}

fn split_dir_name(path: &Path) -> Option<(PathBuf, OsString)> {
    Some((path.parent()?.to_path_buf(), path.file_name()?.to_os_string()))
}

/// Resolve every tracked file's pending removal against `now`, for the
/// ticker thread.
fn collect_tick_changes(dirs: &Dirs, now: Instant) -> Vec<(PathBuf, ChangeKind)> {
    let mut guard = dirs.lock().unwrap();
    let mut changes = Vec::new();
    for (dir, watch) in guard.iter_mut() {
        for (name, state) in watch.files.iter_mut() {
            if let Some(change) = state.on_tick(now, GRACE) {
                changes.push((dir.join(name), change));
            }
        }
    }
    changes
}

/// Feed a raw `notify` event to every file tracked under `dir`, for the
/// watcher callback.
fn collect_event_changes(dirs: &Dirs, dir: &Path, event: &notify::Event) -> Vec<(PathBuf, ChangeKind)> {
    let mut guard = dirs.lock().unwrap();
    let mut changes = Vec::new();
    let Some(watch) = guard.get_mut(dir) else {
        return changes;
    };
    for (name, state) in watch.files.iter_mut() {
        if let Some(raw) = notify_event_to_raw(event, name.as_os_str()) {
            if let Some(change) = state.on_event(raw, Instant::now()) {
                changes.push((dir.join(name), change));
            }
        }
    }
    changes
}

fn emit_all(app: &AppHandle, changes: Vec<(PathBuf, ChangeKind)>) {
    for (path, change) in changes {
        emit_change(app, &path, change);
    }
}

fn emit_change(app: &AppHandle, path: &Path, change: ChangeKind) {
    let (kind, content) = match change {
        ChangeKind::Reload | ChangeKind::Reattached => match std::fs::read_to_string(path) {
            Ok(content) => (change_kind_str(change), Some(content)),
            // The file vanished between the raw event and this read (e.g. a
            // fast delete right after a modify). Don't surface a reload with
            // no content — a follow-up Remove event will resolve this into
            // Detached once the grace period elapses.
            Err(_) => return,
        },
        ChangeKind::Detached => ("detached", None),
    };
    let event = ChangeEvent {
        path: path.to_string_lossy().to_string(),
        kind,
        content,
    };
    let _ = app.emit("file-change", event);
}

fn change_kind_str(change: ChangeKind) -> &'static str {
    match change {
        ChangeKind::Reload => "reload",
        ChangeKind::Reattached => "reattached",
        ChangeKind::Detached => "detached",
    }
}
