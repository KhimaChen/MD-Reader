import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App.jsx'

const { invokeMock, listenMock, onDragDropEventMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn(),
  onDragDropEventMock: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }))
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ onDragDropEvent: onDragDropEventMock }),
}))

const OPENED_FILE = { path: '/docs/a.md', name: 'a.md', content: 'Original content' }

async function openFileViaDialog(user) {
  invokeMock.mockImplementation((cmd) => {
    if (cmd === 'open_markdown_dialog') return Promise.resolve([OPENED_FILE])
    return Promise.resolve()
  })
  await user.click(screen.getAllByRole('button', { name: /open file/i })[0])
  await waitFor(() => screen.getByText('Original content'))
}

async function getRegisteredFileChangeListener() {
  await waitFor(() => expect(listenMock).toHaveBeenCalledWith('file-change', expect.any(Function)))
  return listenMock.mock.calls.find(([name]) => name === 'file-change')[1]
}

describe('App live reload', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    listenMock.mockReset()
    listenMock.mockResolvedValue(() => {})
    onDragDropEventMock.mockReset()
    onDragDropEventMock.mockReturnValue(Promise.resolve(() => {}))
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('reloads the active tab content on a reload event', async () => {
    const user = userEvent.setup()
    render(<App />)
    await openFileViaDialog(user)
    const onFileChange = await getRegisteredFileChangeListener()

    onFileChange({ payload: { path: '/docs/a.md', kind: 'reload', content: 'Updated content' } })

    await waitFor(() => screen.getByText('Updated content'))
    expect(screen.queryByText('Original content')).not.toBeInTheDocument()
  })

  it('reloads a background tab immediately, before it is ever viewed', async () => {
    const user = userEvent.setup()
    render(<App />)
    const fileB = { path: '/docs/b.md', name: 'b.md', content: 'B original' }
    invokeMock.mockImplementation((cmd) => {
      if (cmd === 'open_markdown_dialog') return Promise.resolve([OPENED_FILE, fileB])
      return Promise.resolve()
    })
    await user.click(screen.getAllByRole('button', { name: /open file/i })[0])
    // b.md was opened last, so it's active; a.md is the background tab.
    await waitFor(() => screen.getByText('B original'))
    const onFileChange = await getRegisteredFileChangeListener()

    onFileChange({ payload: { path: '/docs/a.md', kind: 'reload', content: 'A updated in background' } })

    // Switch to the background tab; it should already show the new content.
    await user.click(screen.getByTitle('a.md'))
    await waitFor(() => screen.getByText('A updated in background'))
  })

  it('shows a marker when the file goes detached, and clears it on reattach', async () => {
    const user = userEvent.setup()
    render(<App />)
    await openFileViaDialog(user)
    const onFileChange = await getRegisteredFileChangeListener()

    onFileChange({ payload: { path: '/docs/a.md', kind: 'detached' } })
    await waitFor(() => expect(screen.getByTitle(/no longer found on disk/i)).toBeInTheDocument())
    // Detached keeps showing last-known content.
    expect(screen.getByText('Original content')).toBeInTheDocument()

    onFileChange({
      payload: { path: '/docs/a.md', kind: 'reattached', content: 'Reattached content' },
    })
    await waitFor(() => screen.getByText('Reattached content'))
    expect(screen.queryByTitle(/no longer found on disk/i)).not.toBeInTheDocument()
  })

  it('preserves scroll position (as a ratio) across an active-tab reload', async () => {
    const user = userEvent.setup()
    render(<App />)
    await openFileViaDialog(user)
    const onFileChange = await getRegisteredFileChangeListener()

    const contentEl = document.querySelector('.content')
    // scrollHeight tracks live text length, standing in for real reflow.
    Object.defineProperty(contentEl, 'scrollHeight', {
      get: () => contentEl.textContent.length * 100,
      configurable: true,
    })
    let scrollTopValue = 0
    Object.defineProperty(contentEl, 'scrollTop', {
      get: () => scrollTopValue,
      set: (v) => {
        scrollTopValue = v
      },
      configurable: true,
    })

    const oldHeight = contentEl.scrollHeight
    scrollTopValue = oldHeight * 0.4 // scrolled 40% down

    onFileChange({
      payload: {
        path: '/docs/a.md',
        kind: 'reload',
        content: 'Updated content, now considerably longer than before',
      },
    })
    await waitFor(() => screen.getByText('Updated content, now considerably longer than before'))

    const newHeight = contentEl.scrollHeight
    await waitFor(() => expect(scrollTopValue).toBeCloseTo(newHeight * 0.4, 0))
  })
})
