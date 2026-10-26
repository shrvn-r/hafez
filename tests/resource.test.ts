// tests/resource.test.ts
//
// The Resource module's pure part (#303): the URL normalisation the Folder
// match compares remotes by, which Apply will share for the duplicate rule
// (#302). It must work without git or a working directory, since Apply never
// runs git; the git-backed helpers are covered through the hook in
// tests/onboard-block.test.ts.

import { describe, it, expect, vi } from 'vitest'

const execFileSync = vi.hoisted(() => vi.fn())
vi.mock('child_process', () => ({ execFileSync }))

import { normaliseUrl } from '../src/resource.js'

describe('normaliseUrl', () => {
  it('spells an ssh, an ssh:// and an https remote of one repo the same, user and case aside', () => {
    expect(normaliseUrl('git@github.com:Org/Repo.git')).toBe('github.com/org/repo')
    expect(normaliseUrl('ssh://git@github.com/org/repo')).toBe('github.com/org/repo')
    expect(normaliseUrl('https://github.com/org/repo/')).toBe('github.com/org/repo')
    expect(normaliseUrl('https://user@example.com/Org/Repo.git')).toBe('example.com/org/repo')
  })

  it('keeps a port after the host', () => {
    expect(normaliseUrl('ssh://git@host:2222/org/repo.git')).toBe('host:2222/org/repo')
  })

  it('runs no git', () => {
    normaliseUrl('git@github.com:org/repo.git')
    expect(execFileSync).not.toHaveBeenCalled()
  })
})
