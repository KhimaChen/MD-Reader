# Live Reload

Status: ready-for-agent

## Problem Statement

MD-Reader displays the content of a Markdown file at the moment it's opened, and never again. If a file is being edited elsewhere — in a code editor, by a build tool, by another process — while it's also open as a tab in MD-Reader, the reader keeps showing stale content until the user manually closes and reopens the file. For a tool whose whole purpose is to show what a Markdown file currently says, this is a broken promise: the user can't trust that what's on screen matches what's on disk.

## Solution

Every tab MD-Reader has open watches its underlying file on disk. The moment that file changes — edited, deleted, moved, or recreated — the tab updates to reflect it, automatically and without any confirmation step, whether or not that tab is the one currently in view. This is **Live Reload**. If the file disappears from disk entirely, its tab doesn't close or lose its content — it goes **Detached**: it keeps showing the last content it had, with a small marker that the file is no longer there, and clears that marker the moment a file reappears at the same path.

To make this possible, MD-Reader stops opening files through the browser's `FileReader` API (which never exposes a real filesystem path) and instead opens them through Tauri's native dialog, fs, and drag-drop APIs, so every open tab is anchored to a real path a watcher can attach to.

## User Stories

1. As a user, I want a Markdown file I have open to automatically update when I save changes to it in another editor, so that I'm never looking at stale content.
2. As a user, I want the file I opened via the "Open file" dialog to live-reload, so that dialog-opened files behave the same as any other open file.
3. As a user, I want a file I opened by dragging it into the window to live-reload, so that drag-and-drop isn't a second-class way of opening files.
4. As a user, I want a background tab (one I'm not currently looking at) to already be showing the latest content when I switch to it, so that I don't see stale content for even a moment after switching tabs.
5. As a user, I want my scroll position preserved when the active tab's content reloads, so that I'm not thrown back to the top of a long document I was in the middle of reading.
6. As a user, I want live reload to happen silently, with no popup or confirmation prompt, so that reading isn't interrupted — there's nothing to lose by reloading since MD-Reader is read-only.
7. As a user, I want to be told, subtly, when a file I have open has been deleted or moved, so that I understand why its content has stopped updating.
8. As a user, I want a Detached tab's content to stay visible rather than disappearing, so that I don't lose my only view of that content just because the source file went away.
9. As a user, I want a Detached tab to automatically come back to life if a file reappears at the same path, so that I don't have to manually reopen it after, e.g., an editor's save-by-delete-and-recreate cycle.
10. As a user, I want live reload to work the same way regardless of which editor or tool is modifying the file (including editors that save by writing a temp file and renaming it over the original), so that the feature isn't unreliable with common tools like VS Code or Vim.
11. As a user, I want live reload to be always on, so that I don't have to find and enable a setting before it works.
12. As a developer maintaining MD-Reader, I want the terms "Live Reload" and "Detached" used consistently in code, comments, and docs, so that the feature's behavior is unambiguous to read about later.

## Implementation Decisions

- **File opening moves from the browser File API to Tauri-native APIs.** The "Open file" button and drag-and-drop both switch to Tauri's dialog/fs plugins and native `onDragDropEvent`, respectively, so every tab carries a real filesystem path instead of an in-memory blob with no path. This reverses part of commit `83cdcb4` (which disabled native drag-drop to route drops through the webview's HTML5 `onDrop` instead) — native drag-drop needs to be reimplemented correctly this time, not just re-enabled, since the webview `onDrop` path is what's used today. See ADR 0001.
- **Rust-side file watching via the `notify` crate.** Each open path gets a watch registered against its **parent directory**, filtered by filename, rather than watching the file path directly — this survives atomic-save patterns (write-temp-then-rename) used by editors like VS Code and Vim, which can otherwise break a direct file watch once the original inode is replaced. See ADR 0002.
- **Semantic event translation happens in Rust, before crossing the IPC boundary.** Raw `notify` events for a watched directory are translated into one of three semantic outcomes per affected filename — reload, detached, or reattached — and only that semantic outcome is emitted to the frontend via `app.emit()`, not the raw filesystem event. This is also the seam used for Rust-side testing (see Testing Decisions).
- **Frontend tab state gains a path field.** The existing `{ id, name, content }` shape for each open file gains a real filesystem `path`, used both to display and as the key the frontend uses to match incoming `file-changed`-style events back to the right tab(s) (more than one tab could theoretically point at the same path).
- **Frontend reacts to semantic events, not raw ones.** The frontend's event listener receives `{ path, kind: reload | detached | reattached }` and applies it directly to tab state: `reload` re-reads and swaps the tab's content (for every tab matching that path, active or not); `detached` sets a per-tab flag without touching content; `reattached` clears that flag and reloads content.
- **No confirmation, no toast, fully silent reload.** The frontend does not surface any notification when a reload happens — content simply updates in place.
- **Scroll position is preserved across a reload of the active tab**, using a reasonable heuristic (e.g. scroll-ratio-based) rather than exact pixel/offset matching, since reflowed content after an edit won't map 1:1 to the old layout.
- **Detached is a per-tab boolean-ish flag with a persistent, non-blocking visual marker** (exact visual treatment — icon vs. label vs. dimming — left to implementation, consistent with the app's existing minimal-chrome style) shown on the tab, cleared automatically on reattach.
- **No settings/toggle for Live Reload.** It's always on; not configurable in this iteration.
- **Capabilities/permissions**: `src-tauri/Cargo.toml` and `capabilities/default.json` need the dialog and fs plugins added (currently only `core:default` is granted, with no fs/dialog/watch permissions and no such plugins even registered).

## Testing Decisions

Tests should verify observable behavior at each of the two seams below, not internal implementation details (e.g. don't assert on `notify`'s internal event types beyond what's needed to construct a test input; don't assert on React internals).

- **Rust seam — raw disk events → semantic decision.** New `#[cfg(test)]` unit tests (no prior art in this codebase — this is a new testing surface) around the function that maps a raw `notify` event + target filename to `reload | detached | reattached`. Cover: a plain in-place write → `reload`; a delete → `detached`; a recreate after delete → `reattached`; an atomic save (temp file write + rename-over-original, the VS Code/Vim pattern) → `reload`, not `detached` (this is the behavior ADR 0002 exists to guarantee). At least the atomic-save case should run against a real temp directory (using `tempfile` as a new dev-dependency) with a real rename, not just a synthetic `notify::Event`, since this is exactly the assumption that's easy to get subtly wrong with a mocked event.
- **Frontend seam — semantic event → UI state.** New Vitest + React Testing Library tests (no prior art — this is a new testing surface for this codebase) that render the app's tab/content components, fire a fake `{ path, kind }` event through the same listener the real Tauri event would arrive on, and assert on rendered output: content swaps for `reload` on both the active and a background tab; a Detached marker appears on `detached` and disappears on `reattached`; scroll position is retained (or the retention logic is invoked) across a `reload` of the active tab.
- Out of scope for automated testing in this iteration: full end-to-end tests that launch the real compiled Tauri app against a real OS filesystem (e.g. via `tauri-driver`/WebDriver). The two seams above were chosen specifically so this heavier infrastructure isn't required to get solid coverage.

## Out of Scope

- A settings toggle to disable Live Reload.
- Any confirmation/prompt UI before reloading.
- Conflict handling between multiple external writers to the same file (last write simply wins, whatever `notify` reports last).
- End-to-end/UI-automation tests of the real compiled app.
- Any change to how content is rendered once loaded (Markdown parsing/rendering pipeline is untouched).
- Editing support of any kind — MD-Reader remains read-only.

## Further Notes

- This feature depends on two ADRs already recorded: `docs/adr/0001-tauri-native-file-access-for-live-reload.md` and `docs/adr/0002-watch-parent-directory-not-file.md`.
- Domain vocabulary for this feature ("Live Reload", "Detached") is recorded in `CONTEXT.md` — use these terms in code, comments, commit messages, and future tickets rather than synonyms like "refresh" or "missing".
- The Detached-reattach behavior falls out naturally from watching the parent directory rather than the file itself (ADR 0002) — no separate reattach-detection logic beyond the same directory watch already in place for reload.

## Comments
