# MD Reader

A lightweight desktop app (Tauri + React) for viewing local Markdown files.

## Language

**Live Reload**:
The behavior where an open tab's content automatically re-reads from disk when the underlying file changes externally (e.g. edited in another app).
_Avoid_: refresh, auto-update, watch mode, real-time update.

**Detached**:
The state of a tab whose file has been deleted or moved away on disk. It keeps showing its last-known content plus a marker, and automatically reattaches (clearing the marker) if a file reappears at the same path.
_Avoid_: missing, orphaned, broken.
