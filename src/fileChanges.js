// Applies a semantic `file-change` event ({ path, kind, content }) emitted
// by the Rust watcher (see src-tauri/src/watch/mod.rs) to the current tab
// list. `kind` is one of Live Reload's three outcomes: reload | detached |
// reattached (see CONTEXT.md).
export const FILE_CHANGE_KIND = {
  RELOAD: 'reload',
  DETACHED: 'detached',
  REATTACHED: 'reattached',
}

export function applyFileChange(files, event) {
  if (!files.some((f) => f.path === event.path)) return files

  return files.map((f) => {
    if (f.path !== event.path) return f
    switch (event.kind) {
      case FILE_CHANGE_KIND.RELOAD:
      case FILE_CHANGE_KIND.REATTACHED:
        return { ...f, content: event.content, detached: false }
      case FILE_CHANGE_KIND.DETACHED:
        return { ...f, detached: true }
      default:
        return f
    }
  })
}
