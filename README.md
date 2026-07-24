# MD Reader

A **read-only** Markdown reader built with React + Vite. It renders Markdown
beautifully — there is no editor and files are never modified.

## Features

- Open one or more files via a button or drag-and-drop
- GitHub-Flavored Markdown: tables, task lists, strikethrough, autolinks
- Syntax-highlighted code blocks (highlight.js)
- Auto table-of-contents generated from headings
- Light / dark theme (remembered across sessions)
- Zero backend — everything runs in the browser

## Getting started

```bash
npm install
npm run dev      # start the dev server
```

Then open the printed local URL (usually http://localhost:5173).

## Build

```bash
npm run build    # production build into dist/
npm run preview  # preview the production build
```

## Desktop app (Tauri)

MD Reader can also run as a native desktop app via [Tauri](https://tauri.app/).
This requires the [Rust toolchain](https://www.rust-lang.org/tools/install)
installed alongside Node.

```bash
npm run tauri:dev    # run the app in a native window (hot reload)
npm run tauri:build  # build installers/binaries into src-tauri/target/release
```

Installers are written to `src-tauri/target/release/bundle/` (e.g. `.msi` /
`.exe` on Windows, `.dmg` / `.app` on macOS, `.deb` / `.AppImage` on Linux).

## Tech

- [React 18](https://react.dev/) + [Vite](https://vitejs.dev/)
- [react-markdown](https://github.com/remarkjs/react-markdown) with
  `remark-gfm`, `rehype-raw`, `rehype-slug`, and `rehype-highlight`
