// tests/index-lifecycle.test.ts
// Three read-index lifecycle races, each driven deterministically (the
// interleaving is injected, never slept for; (c)'s second test alone holds a
// lock for a bounded moment, see there):
//  (a) rebuildIndex() used to bypass the two-level vault write lock, so a
//      rebuild could interleave with a mutation's file writes.
//  (b) A file written WHILE a staleness scan is in flight was stamped by the
//      scan's END time, so every later sync saw mtime < watermark and skipped
//      it — permanently stale.
//  (c) Two write-capable processes syncing one changed note each deleted the
//      row, then each inserted it: the second insert failed UNIQUE (#293).
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, utimesSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Worker } from 'worker_threads'
import { serializeFile } from '../src/vault.js'
import { createHafez, removeTemp } from './helpers/hafez.js'
import { createIndex, __setAfterScanHook, __setReplaceHook, type HafezIndex } from '../src/db.js'
import { createMemoryJournal } from './helpers/memory-journal.js'
import { localDay } from '../src/dates.js'

const TMP = join(tmpdir(), 'hafez-test-idxlife-' + Date.now())
const today = localDay()

function makeVault(name: string): string {
  const vault = join(TMP, name)
  mkdirSync(join(vault, 'entities'), { recursive: true })
  mkdirSync(join(vault, 'knowledge'), { recursive: true })
  return vault
}

/** Let pending microtasks and I/O callbacks drain without sleeping. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r))
}

beforeAll(() => { mkdirSync(TMP, { recursive: true }) })
afterAll(() => { removeTemp(TMP) })

describe('rebuildIndex takes the vault write lock', () => {
  it('serializes behind an in-flight mutation instead of interleaving with its write', async () => {
    const vault = makeVault('vault-lock')
    writeFileSync(
      join(vault, 'entities', 'lock-target.md'),
      serializeFile(
        { name: 'Lock Target', type: 'project', status: 'active', created: today, 'last-touched': today },
        '## Purpose\n\nLock target\n\n## Session Log\n',
      ),
    )

    // Gate the Journal: the mutation parks inside commit() — i.e. holding the
    // lock, past its file write — until the test releases it.
    const journal = createMemoryJournal()
    const inner = journal.commit.bind(journal)
    let releaseCommit!: () => void
    const commitGate = new Promise<void>(r => { releaseCommit = r })
    let commitEntered!: () => void
    const entered = new Promise<void>(r => { commitEntered = r })
    journal.commit = async (written, deleted, message) => {
      commitEntered()
      await commitGate
      return inner(written, deleted, message)
    }

    const os = createHafez({ vaultPath: vault, persistence: journal })

    const mutation = os.update('lock-target', {
      session_log: { summary: 'held mid-commit', type: 'progress', agent: 'test' },
    })
    await entered

    let rebuildSettled = false
    const rebuild = os.rebuildIndex().then(() => { rebuildSettled = true })
    await flush()

    // The mutation still holds the lock: the rebuild must not have run.
    expect(rebuildSettled).toBe(false)

    releaseCommit()
    await mutation
    await rebuild
    expect(rebuildSettled).toBe(true)

    // …and both landed: the rebuild indexed the committed write.
    const found = await os.query({ filter: 'all' })
    expect(found.items.map(i => i.slug)).toContain('lock-target')
  })
})

describe('staleness watermark survives a mid-scan write', () => {
  it('picks up on the next sync a file written between the scan read and the record', () => {
    const vault = makeVault('vault-scan')
    const file = join(vault, 'entities', 'mid-scan.md')
    const write = (marker: string) => writeFileSync(
      file,
      serializeFile(
        { name: 'Mid Scan', type: 'project', status: 'active', created: today, 'last-touched': today },
        `## Brief\n\n${marker}\n\n## Session Log\n`,
      ),
    )

    write('version-one')
    const idx = createIndex(vault)          // auto-rebuild seeds the watermark
    const indexed = () => idx.queryItems({}).items.find(i => i.slug === 'mid-scan')!.brief
    expect(indexed()).toContain('version-one')

    // A change the scan WILL see, so the watermark actually advances.
    write('version-two')
    utimesSync(file, new Date(), new Date())

    // …and a change that lands after the scan read the file but before it
    // records the watermark. The clock is jumped forward at the same moment so
    // an end-of-scan watermark is unambiguously later than the write's mtime.
    const realNow = Date.now
    __setAfterScanHook(() => {
      write('version-three')
      // Pin the mtime a hair ahead of the scan-start watermark: the FS clock
      // and Date.now() round differently at the boundary, and this test is
      // about the watermark policy, not sub-millisecond clock agreement.
      const ahead = new Date(realNow() + 5)
      utimesSync(file, ahead, ahead)
      vi.spyOn(Date, 'now').mockReturnValue(realNow() + 60_000)
    })
    try {
      idx.syncIfStale()
    } finally {
      __setAfterScanHook(null)
      vi.restoreAllMocks()
    }
    expect(indexed()).toContain('version-two')

    // The mid-scan write must not be lost to the watermark.
    idx.syncIfStale()
    expect(indexed()).toContain('version-three')

    idx.close()
  })
})

describe('two processes syncing one changed note (#293)', () => {
  /** A note indexed at version-one, then changed outside hafez (a pull) with
   * its mtime past the watermark. Returns the vault and the first index. */
  function pulledVault(name: string): { vault: string, idx: HafezIndex } {
    const vault = makeVault(name)
    const file = join(vault, 'entities', 'pulled.md')
    const write = (marker: string) => writeFileSync(
      file,
      serializeFile(
        { name: 'Pulled', type: 'project', status: 'active', created: today, 'last-touched': today },
        `## Brief\n\n${marker}\n\n## Session Log\n`,
      ),
    )
    write('version-one')
    const idx = createIndex(vault)
    write('version-two')
    const ahead = new Date(Date.now() + 1000)
    utimesSync(file, ahead, ahead)
    return { vault, idx }
  }

  function expectOneNewRow(idx: HafezIndex): void {
    const rows = idx.queryItems({}).items.filter(i => i.slug === 'pulled')
    expect(rows).toHaveLength(1)
    expect(rows[0].brief).toContain('version-two')
  }

  it('both complete when both saw the changed hash before either replaced it', () => {
    const { vault, idx: a } = pulledVault('vault-two-syncs')
    const b = createIndex(vault)

    // A has seen the changed hash; B runs its whole sync there.
    let bSynced = false
    __setReplaceHook(step => {
      if (step !== 'changed' || bSynced) return
      bSynced = true
      b.syncIfStale()
    })
    try {
      expect(() => a.syncIfStale()).not.toThrow()
    } finally {
      __setReplaceHook(null)
    }
    expect(bSynced).toBe(true)
    expectOneNewRow(a)
    a.close()
    b.close()
  })

  it('a sync during another process\'s replacement waits it out, never UNIQUE', async () => {
    const { vault, idx: b } = pulledVault('vault-mid-replace')

    // A is another process: its own thread, connection and module instance.
    // It parks between its delete and its insert until B's sync returns, or
    // for a bounded moment (well inside busy_timeout) while B waits on its
    // write lock — one thread cannot see the other blocked, so that wait is
    // the one bounded hold in this file. Without the per-note transaction B
    // saw no row, inserted, and A's insert then failed UNIQUE.
    const state = new Int32Array(new SharedArrayBuffer(4))   // 1: A parked, 2: B done
    const a = new Worker(`
      const { workerData: { tsx, db, vault, state }, parentPort } = require('worker_threads')
      import(tsx).then(api => { api.register(); return import(db) }).then(({ createIndex, __setReplaceHook }) => {
        const idx = createIndex(vault)
        __setReplaceHook(step => {
          if (step !== 'deleted') return
          Atomics.store(state, 0, 1)
          Atomics.notify(state, 0)
          Atomics.wait(state, 0, 1, 500)
        })
        try { idx.syncIfStale(); parentPort.postMessage(null) }
        catch (err) { parentPort.postMessage(String(err)) }
        finally { idx.close() }
      })
    `, {
      eval: true,
      workerData: {
        tsx: import.meta.resolve('tsx/esm/api'),
        db: new URL('../src/db.ts', import.meta.url).href,
        vault,
        state,
      },
    })
    const aError = new Promise((resolve, reject) => { a.once('message', resolve); a.once('error', reject) })
    expect(Atomics.wait(state, 0, 0, 10_000)).not.toBe('timed-out')

    expect(() => b.syncIfStale()).not.toThrow()
    Atomics.store(state, 0, 2)
    Atomics.notify(state, 0)
    expect(await aError).toBeNull()
    await a.terminate()
    expectOneNewRow(b)
    b.close()
  })
})

describe('close() releases the index handle (#184)', () => {
  it('lets the index file be deleted, and the next call reopens it', async () => {
    const vault = makeVault('vault-close')
    const os = createHafez({ vaultPath: vault, persistence: createMemoryJournal() })
    await os.create('entity', 'Kept', { type: 'project' })

    os.close()
    os.close()
    // Windows refuses to delete an open file; POSIX would allow it either way.
    // The -wal/-shm siblings go too: a leftover WAL beside a fresh db would
    // read as corruption, not as the open-handle regression this guards.
    for (const suffix of ['', '-wal', '-shm']) rmSync(join(vault, `.hafez.db${suffix}`), { force: true })

    expect((await os.query({ filter: 'all' })).items.map(i => i.slug)).toEqual(['kept'])
  })
})
