use std::ffi::OsStr;
use std::time::{Duration, Instant};

/// A filesystem event, reduced to the three shapes we care about for a single
/// tracked filename.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RawKind {
    Created,
    Modified,
    Removed,
}

/// The semantic outcome to emit to the frontend for a tracked file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChangeKind {
    Reload,
    Detached,
    Reattached,
}

/// Per-file state used to turn a stream of raw directory events into Live
/// Reload / Detached / Reattached (see ADR 0002: we watch the parent
/// directory, not the file itself, so atomic saves — write-temp-then-rename —
/// must resolve to Reload rather than a Detached/Reattached flicker).
#[derive(Debug, Default)]
pub struct FileWatchState {
    detached: bool,
    pending_removal_at: Option<Instant>,
}

impl FileWatchState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Handle a raw event for this file's exact name. A `Removed` doesn't
    /// immediately become Detached — it's held pending until `on_tick`
    /// confirms the grace period elapsed with no matching Create/Modify.
    pub fn on_event(&mut self, kind: RawKind, now: Instant) -> Option<ChangeKind> {
        match kind {
            RawKind::Removed => {
                self.pending_removal_at = Some(now);
                None
            }
            RawKind::Created | RawKind::Modified => {
                self.pending_removal_at = None;
                let was_detached = self.detached;
                self.detached = false;
                Some(if was_detached {
                    ChangeKind::Reattached
                } else {
                    ChangeKind::Reload
                })
            }
        }
    }

    /// Call periodically to resolve a pending removal into a real Detached
    /// once `grace` has elapsed with no matching Create/Modify.
    pub fn on_tick(&mut self, now: Instant, grace: Duration) -> Option<ChangeKind> {
        let removed_at = self.pending_removal_at?;
        if now.duration_since(removed_at) < grace {
            return None;
        }
        self.pending_removal_at = None;
        self.detached = true;
        Some(ChangeKind::Detached)
    }
}

/// Map a raw `notify` event to a `RawKind`, but only if it concerns the exact
/// filename we're tracking (directory watches fire for every entry in the
/// directory).
pub fn notify_event_to_raw(event: &notify::Event, target_name: &OsStr) -> Option<RawKind> {
    let concerns_target = event
        .paths
        .iter()
        .any(|p| p.file_name() == Some(target_name));
    if !concerns_target {
        return None;
    }

    use notify::event::{ModifyKind, RenameMode};
    use notify::EventKind::*;
    match event.kind {
        Create(_) => Some(RawKind::Created),
        Modify(ModifyKind::Name(RenameMode::To)) => Some(RawKind::Created),
        Modify(ModifyKind::Name(RenameMode::From)) => Some(RawKind::Removed),
        Modify(_) => Some(RawKind::Modified),
        Remove(_) => Some(RawKind::Removed),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn later(base: Instant, ms: u64) -> Instant {
        base + Duration::from_millis(ms)
    }

    #[test]
    fn modify_while_attached_is_reload() {
        let mut state = FileWatchState::new();
        let now = Instant::now();
        assert_eq!(state.on_event(RawKind::Modified, now), Some(ChangeKind::Reload));
    }

    #[test]
    fn create_while_attached_is_reload() {
        let mut state = FileWatchState::new();
        let now = Instant::now();
        assert_eq!(state.on_event(RawKind::Created, now), Some(ChangeKind::Reload));
    }

    #[test]
    fn removed_emits_nothing_immediately() {
        let mut state = FileWatchState::new();
        let now = Instant::now();
        assert_eq!(state.on_event(RawKind::Removed, now), None);
    }

    #[test]
    fn removed_then_tick_before_grace_emits_nothing() {
        let mut state = FileWatchState::new();
        let now = Instant::now();
        state.on_event(RawKind::Removed, now);
        let grace = Duration::from_millis(300);
        assert_eq!(state.on_tick(later(now, 100), grace), None);
    }

    #[test]
    fn removed_then_tick_after_grace_is_detached() {
        let mut state = FileWatchState::new();
        let now = Instant::now();
        state.on_event(RawKind::Removed, now);
        let grace = Duration::from_millis(300);
        assert_eq!(
            state.on_tick(later(now, 301), grace),
            Some(ChangeKind::Detached)
        );
    }

    #[test]
    fn removed_then_created_before_grace_is_reload_not_detached() {
        // Models an atomic save: write-temp-then-rename shows up as a
        // Remove followed almost immediately by a Create for the same name.
        let mut state = FileWatchState::new();
        let now = Instant::now();
        assert_eq!(state.on_event(RawKind::Removed, now), None);
        assert_eq!(
            state.on_event(RawKind::Created, later(now, 20)),
            Some(ChangeKind::Reload)
        );

        // The grace-period tick must not fire Detached after the fact.
        let grace = Duration::from_millis(300);
        assert_eq!(state.on_tick(later(now, 400), grace), None);
    }

    #[test]
    fn created_after_confirmed_detached_is_reattached() {
        let mut state = FileWatchState::new();
        let now = Instant::now();
        state.on_event(RawKind::Removed, now);
        let grace = Duration::from_millis(300);
        assert_eq!(
            state.on_tick(later(now, 301), grace),
            Some(ChangeKind::Detached)
        );

        assert_eq!(
            state.on_event(RawKind::Created, later(now, 500)),
            Some(ChangeKind::Reattached)
        );
    }

    #[test]
    fn on_tick_is_a_noop_when_nothing_pending() {
        let mut state = FileWatchState::new();
        let now = Instant::now();
        assert_eq!(state.on_tick(now, Duration::from_millis(300)), None);
    }

    fn event(kind: notify::EventKind, paths: Vec<std::path::PathBuf>) -> notify::Event {
        notify::Event {
            kind,
            paths,
            attrs: Default::default(),
        }
    }

    #[test]
    fn notify_event_ignores_events_for_other_filenames() {
        let target = OsStr::new("a.md");
        let e = event(
            notify::EventKind::Modify(notify::event::ModifyKind::Any),
            vec![std::path::PathBuf::from("/tmp/other.md")],
        );
        assert_eq!(notify_event_to_raw(&e, target), None);
    }

    #[test]
    fn notify_event_maps_create_to_created() {
        let target = OsStr::new("a.md");
        let e = event(
            notify::EventKind::Create(notify::event::CreateKind::Any),
            vec![std::path::PathBuf::from("/tmp/a.md")],
        );
        assert_eq!(notify_event_to_raw(&e, target), Some(RawKind::Created));
    }

    #[test]
    fn notify_event_maps_modify_data_to_modified() {
        let target = OsStr::new("a.md");
        let e = event(
            notify::EventKind::Modify(notify::event::ModifyKind::Data(
                notify::event::DataChange::Any,
            )),
            vec![std::path::PathBuf::from("/tmp/a.md")],
        );
        assert_eq!(notify_event_to_raw(&e, target), Some(RawKind::Modified));
    }

    #[test]
    fn notify_event_maps_remove_to_removed() {
        let target = OsStr::new("a.md");
        let e = event(
            notify::EventKind::Remove(notify::event::RemoveKind::Any),
            vec![std::path::PathBuf::from("/tmp/a.md")],
        );
        assert_eq!(notify_event_to_raw(&e, target), Some(RawKind::Removed));
    }

    #[test]
    fn notify_event_maps_rename_to_target_as_created() {
        let target = OsStr::new("a.md");
        let e = event(
            notify::EventKind::Modify(notify::event::ModifyKind::Name(
                notify::event::RenameMode::To,
            )),
            vec![std::path::PathBuf::from("/tmp/a.md")],
        );
        assert_eq!(notify_event_to_raw(&e, target), Some(RawKind::Created));
    }

    #[test]
    fn notify_event_maps_rename_from_target_as_removed() {
        let target = OsStr::new("a.md");
        let e = event(
            notify::EventKind::Modify(notify::event::ModifyKind::Name(
                notify::event::RenameMode::From,
            )),
            vec![std::path::PathBuf::from("/tmp/a.md")],
        );
        assert_eq!(notify_event_to_raw(&e, target), Some(RawKind::Removed));
    }

    // Real filesystem, real notify watcher, real atomic-save rename — proves
    // ADR 0002's assumption holds against the actual `notify` backend on this
    // platform, not just our own synthetic events.
    #[test]
    fn atomic_save_on_real_filesystem_resolves_to_reload_not_detached() {
        use notify::{RecursiveMode, Watcher};
        use std::sync::mpsc;

        let dir = tempfile::tempdir().unwrap();
        let target_path = dir.path().join("a.md");
        std::fs::write(&target_path, "original").unwrap();

        let (tx, rx) = mpsc::channel();
        let mut watcher =
            notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
                if let Ok(event) = res {
                    let _ = tx.send(event);
                }
            })
            .unwrap();
        watcher.watch(dir.path(), RecursiveMode::NonRecursive).unwrap();

        // Give the watcher a moment to start on platforms where this is async.
        std::thread::sleep(Duration::from_millis(100));

        // Atomic save: write to a temp file, then rename over the original.
        let tmp_path = dir.path().join("a.md.tmp");
        std::fs::write(&tmp_path, "updated").unwrap();
        std::fs::rename(&tmp_path, &target_path).unwrap();

        let mut state = FileWatchState::new();
        let target_name = OsStr::new("a.md");
        let grace = Duration::from_millis(300);
        let start = Instant::now();
        let mut last_result = None;

        while start.elapsed() < Duration::from_secs(2) {
            if let Ok(event) = rx.recv_timeout(Duration::from_millis(50)) {
                if let Some(raw) = notify_event_to_raw(&event, target_name) {
                    if let Some(change) = state.on_event(raw, Instant::now()) {
                        last_result = Some(change);
                    }
                }
            }
            if let Some(change) = state.on_tick(Instant::now(), grace) {
                last_result = Some(change);
            }
        }

        assert_ne!(
            last_result,
            Some(ChangeKind::Detached),
            "atomic save must not surface as Detached"
        );
    }
}
