import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import MarkdownView from './MarkdownView.jsx'
import { extractHeadings } from './slug.js'
import { applyFileChange, FILE_CHANGE_KIND } from './fileChanges.js'

const MD_EXTENSIONS = /\.(md|markdown|mdown|mkd|mkdn|mdtxt|text|txt)$/i

let idSeq = 0
const nextId = () => `f${++idSeq}`

function toTab(opened) {
  return {
    id: nextId(),
    path: opened.path,
    name: opened.name,
    content: opened.content,
    detached: false,
  }
}

export default function App() {
  const [files, setFiles] = useState([]) // { id, path, name, content, detached }
  const [activeId, setActiveId] = useState(null)
  const [theme, setTheme] = useState(
    () => localStorage.getItem('md-reader-theme') || 'light'
  )
  const [dragging, setDragging] = useState(false)
  const contentRef = useRef(null)
  const activePathRef = useRef(null)
  const pendingScrollRatio = useRef(null)

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('md-reader-theme', theme)
  }, [theme])

  const active = files.find((f) => f.id === activeId) || null

  useEffect(() => {
    activePathRef.current = active?.path ?? null
  }, [active?.path])

  const headings = useMemo(
    () => (active ? extractHeadings(active.content) : []),
    [active]
  )

  const addOpenedFiles = useCallback((openedFiles) => {
    if (!openedFiles || openedFiles.length === 0) return
    const tabs = openedFiles.map(toTab)
    setFiles((prev) => [...prev, ...tabs])
    setActiveId(tabs[tabs.length - 1].id)
  }, [])

  const openDialog = useCallback(async () => {
    const opened = await invoke('open_markdown_dialog')
    addOpenedFiles(opened)
  }, [addOpenedFiles])

  const openPaths = useCallback(
    async (paths) => {
      const mdPaths = paths.filter((p) => MD_EXTENSIONS.test(p))
      if (mdPaths.length === 0) return
      const opened = await Promise.all(
        mdPaths.map((path) => invoke('open_path', { path }))
      )
      addOpenedFiles(opened)
    },
    [addOpenedFiles]
  )

  const closeFile = (id, e) => {
    e.stopPropagation()
    setFiles((prev) => {
      const closed = prev.find((f) => f.id === id)
      const next = prev.filter((f) => f.id !== id)
      if (closed && !next.some((f) => f.path === closed.path)) {
        invoke('close_path', { path: closed.path })
      }
      if (id === activeId) {
        setActiveId(next.length ? next[next.length - 1].id : null)
      }
      return next
    })
  }

  // Native drag-and-drop, so dropped files carry real filesystem paths (ADR 0001).
  useEffect(() => {
    let unlisten
    let cancelled = false
    getCurrentWindow()
      .onDragDropEvent((event) => {
        const { type } = event.payload
        if (type === 'enter' || type === 'over') setDragging(true)
        else if (type === 'leave') setDragging(false)
        else if (type === 'drop') {
          setDragging(false)
          openPaths(event.payload.paths)
        }
      })
      .then((fn) => {
        if (cancelled) fn()
        else unlisten = fn
      })
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [openPaths])

  // Live Reload: apply semantic events from the Rust watcher (see
  // src-tauri/src/watch/mod.rs and CONTEXT.md for Live Reload / Detached).
  useEffect(() => {
    let unlisten
    let cancelled = false
    listen('file-change', (event) => {
      const change = event.payload
      const reloadsContent =
        change.kind === FILE_CHANGE_KIND.RELOAD || change.kind === FILE_CHANGE_KIND.REATTACHED
      if (reloadsContent && change.path === activePathRef.current && contentRef.current) {
        const el = contentRef.current
        pendingScrollRatio.current =
          el.scrollHeight > 0 ? el.scrollTop / el.scrollHeight : null
      }
      setFiles((prev) => applyFileChange(prev, change))
    }).then((fn) => {
      if (cancelled) fn()
      else unlisten = fn
    })
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])

  // Restore scroll position (as a ratio) after a Live Reload of the active tab.
  useLayoutEffect(() => {
    if (pendingScrollRatio.current == null) return
    const el = contentRef.current
    if (el) el.scrollTop = pendingScrollRatio.current * el.scrollHeight
    pendingScrollRatio.current = null
  }, [active?.content])

  // Scroll content to top when switching files. A Live Reload of the active
  // tab doesn't change activeId, so it's unaffected by this effect.
  useEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0
  }, [activeId])

  const onTocClick = (e, id) => {
    e.preventDefault()
    const el = document.getElementById(id)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <div className="app">
      <header className="toolbar">
        <div className="brand">
          <Logo />
          <span>MD Reader</span>
        </div>
        <div className="toolbar-spacer" />
        <button className="btn btn-primary" onClick={openDialog}>
          <FolderIcon />
          Open file
        </button>
        <button
          className="btn btn-icon"
          title={theme === 'dark' ? 'Switch to light' : 'Switch to dark'}
          onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
        >
          {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
        </button>
      </header>

      <div className="body">
        {files.length > 0 && (
          <aside className="sidebar">
            <div className="sidebar-section-title">Open files</div>
            {files.map((f) => (
              <button
                key={f.id}
                className={`file-item ${f.id === activeId ? 'active' : ''}`}
                onClick={() => setActiveId(f.id)}
                title={f.name}
              >
                <FileIcon />
                <span className="name">{f.name}</span>
                {f.detached && (
                  <span
                    className="detached-marker"
                    title="File no longer found on disk"
                  >
                    <DetachedIcon />
                  </span>
                )}
                <span
                  className="close"
                  role="button"
                  aria-label={`Close ${f.name}`}
                  onClick={(e) => closeFile(f.id, e)}
                >
                  <CloseIcon />
                </span>
              </button>
            ))}
          </aside>
        )}

        <main className="content" ref={contentRef}>
          {active ? (
            <div className="reader">
              <MarkdownView content={active.content} />
            </div>
          ) : (
            <div className="welcome">
              <FolderOpenIcon className="icon" />
              <h1>Read your Markdown</h1>
              <p>
                Open a <code>.md</code> file to view it here. This is a viewer
                only — your files are never modified.
              </p>
              <div style={{ display: 'flex', gap: 12 }}>
                <button className="btn btn-primary" onClick={openDialog}>
                  <FolderIcon />
                  Open file
                </button>
              </div>
              <div className="hint">Drag a file into the window to open it</div>
            </div>
          )}
        </main>

        {active && headings.length > 1 && (
          <nav className="toc">
            <div className="toc-title">On this page</div>
            {headings.map((h, i) => (
              <a
                key={i}
                href={`#${h.id}`}
                className={`lvl-${h.level}`}
                onClick={(e) => onTocClick(e, h.id)}
              >
                {h.text}
              </a>
            ))}
          </nav>
        )}
      </div>

      {dragging && <div className="drop-overlay">Drop Markdown files to open</div>}
    </div>
  )
}

/* ---------- Icons (inline SVG, no dependencies) ---------- */
function Logo() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="2" y="4" width="20" height="16" rx="2.5" fill="var(--accent)" />
      <path
        d="M5 15V9h1.8l1.7 2.1L10.2 9H12v6h-1.7v-3.4l-1.8 2.1-1.8-2.1V15H5z"
        fill="#fff"
      />
      <path d="M15.6 9h1.7v3.2h1.6L16.4 15 13.7 12.2h1.6V9z" fill="#fff" />
    </svg>
  )
}
function FolderIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
    </svg>
  )
}
function FolderOpenIcon({ className }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1H3V7z" />
      <path d="M3 10h18l-2 8a2 2 0 0 1-2 1.5H5A2 2 0 0 1 3 18V10z" />
    </svg>
  )
}
function FileIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M6 2h8l4 4v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z" />
      <path d="M14 2v4h4" />
    </svg>
  )
}
function DetachedIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 9v4M12 17h.01" />
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
    </svg>
  )
}
function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  )
}
function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </svg>
  )
}
function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.4 1.4M17.6 17.6L19 19M19 5l-1.4 1.4M6.4 17.6L5 19" />
    </svg>
  )
}
