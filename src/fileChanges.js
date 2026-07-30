// Applies a semantic `file-change` event ({ path, kind, content }) emitted
// by the Rust watcher (see src-tauri/src/watch/mod.rs) to the current tab
// list. `kind` is one of Live Reload's three outcomes: reload | detached |
// reattached (see CONTEXT.md).
export const FILE_CHANGE_KIND = {
  RELOAD: 'reload',
  DETACHED: 'detached',
  REATTACHED: 'reattached',
}

// Reload and Reattached both carry fresh content; Detached doesn't.
export function changeCarriesContent(kind) {
  return kind === FILE_CHANGE_KIND.RELOAD || kind === FILE_CHANGE_KIND.REATTACHED
}

export function applyFileChange(files, event) {
  if (!files.some((f) => f.path === event.path)) return files

  return files.map((f) => {
    if (f.path !== event.path) return f
    if (changeCarriesContent(event.kind)) {
      return { ...f, content: event.content, detached: false }
    }
    if (event.kind === FILE_CHANGE_KIND.DETACHED) {
      return { ...f, detached: true }
    }
    return f
  })
}
