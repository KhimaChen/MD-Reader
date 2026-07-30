import { describe, expect, it } from 'vitest'
import { applyFileChange } from './fileChanges.js'

function file(overrides) {
  return { id: 'f1', path: '/docs/a.md', name: 'a.md', content: 'old', detached: false, ...overrides }
}

describe('applyFileChange', () => {
  it('reload swaps content for a matching tab', () => {
    const files = [file()]
    const next = applyFileChange(files, { path: '/docs/a.md', kind: 'reload', content: 'new' })
    expect(next[0].content).toBe('new')
  })

  it('reload updates every tab sharing the same path, active or not', () => {
    const files = [file({ id: 'f1' }), file({ id: 'f2' })]
    const next = applyFileChange(files, { path: '/docs/a.md', kind: 'reload', content: 'new' })
    expect(next.map((f) => f.content)).toEqual(['new', 'new'])
  })

  it('leaves tabs with a different path untouched', () => {
    const files = [file(), file({ id: 'f2', path: '/docs/b.md', content: 'b-content' })]
    const next = applyFileChange(files, { path: '/docs/a.md', kind: 'reload', content: 'new' })
    expect(next.find((f) => f.id === 'f2').content).toBe('b-content')
  })

  it('detached sets the flag without touching content', () => {
    const files = [file({ content: 'last-known' })]
    const next = applyFileChange(files, { path: '/docs/a.md', kind: 'detached' })
    expect(next[0].detached).toBe(true)
    expect(next[0].content).toBe('last-known')
  })

  it('reattached clears the flag and applies fresh content', () => {
    const files = [file({ detached: true, content: 'stale' })]
    const next = applyFileChange(files, { path: '/docs/a.md', kind: 'reattached', content: 'fresh' })
    expect(next[0].detached).toBe(false)
    expect(next[0].content).toBe('fresh')
  })

  it('returns the same array reference when nothing matches', () => {
    const files = [file()]
    const next = applyFileChange(files, { path: '/docs/nope.md', kind: 'reload', content: 'x' })
    expect(next).toBe(files)
  })
})
