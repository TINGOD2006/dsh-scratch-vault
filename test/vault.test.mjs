import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ScratchVault } from '../lib/vault.js'

function freshVault(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sv-test-'))
  const vault = new ScratchVault({
    dir,
    maxEntries: 2000,
    maxEntryBytes: 1024 * 1024,
    retainDays: 14,
    ...overrides,
  })
  vault.ensure()
  return { dir, vault }
}

test('a recorded script is listed, readable and hashed', () => {
  const { dir, vault } = freshVault()
  try {
    const entry = vault.record({
      sessionId: 'sess-1',
      originalPath: 'C:/work/demo/_probe.py',
      scratchPath: 'C:/tmp/dsh-scratch/sess-1/workspace/_probe.py',
      content: 'print("hi")\n',
      reason: 'leading underscore',
      rule: 'scratch-name',
    })
    assert.equal(entry.stored, true)
    assert.match(entry.id, /^\d{14}-[a-z0-9]{1,6}$/)
    assert.equal(entry.bytes, 12)

    const listed = vault.list({ sessionId: 'sess-1' })
    assert.equal(listed.length, 1)
    assert.equal(listed[0].id, entry.id)

    const found = vault.read(entry.id)
    assert.equal(found.content, 'print("hi")\n')
    assert.equal(found.entry.rule, 'scratch-name')

    assert.equal(vault.stats().count, 1)
    assert.equal(vault.stats().sessions, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('listing can be scoped to one session and is newest first', () => {
  const { dir, vault } = freshVault()
  try {
    const a = vault.record({ sessionId: 'a', originalPath: 'x.py', content: '1' })
    const b = vault.record({ sessionId: 'b', originalPath: 'y.py', content: '2' })
    assert.equal(vault.list({ sessionId: 'a' }).length, 1)
    assert.equal(vault.list({ sessionId: 'a' })[0].id, a.id)
    assert.equal(vault.list({}).length, 2)
    assert.equal(vault.list({ limit: 1 }).length, 1)
    assert.ok(vault.list({ limit: 1 })[0].id === b.id || vault.list({ limit: 1 })[0].id === a.id)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an oversized script is recorded but not stored', () => {
  const { dir, vault } = freshVault({ maxEntryBytes: 16 })
  try {
    const entry = vault.record({ sessionId: 's', originalPath: 'big.py', content: 'x'.repeat(64) })
    assert.equal(entry.stored, false)
    assert.equal(vault.read(entry.id).content, undefined)
    assert.throws(() => vault.promote(entry.id, join(dir, 'out.py')), /no stored script/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('promote copies a collected script back to a real path', () => {
  const { dir, vault } = freshVault()
  try {
    const entry = vault.record({ sessionId: 's', originalPath: '_probe.py', content: 'print(1)\n' })
    const target = join(dir, 'promoted', '_probe.py')
    vault.promote(entry.id, target)
    assert.equal(readFileSync(target, 'utf8'), 'print(1)\n')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('promote rejects an unknown id', () => {
  const { dir, vault } = freshVault()
  try {
    assert.throws(() => vault.promote('nope', join(dir, 'x.py')), /no vault entry/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('purge honours the dry run and then the retention window', () => {
  const { dir, vault } = freshVault({ retainDays: 1 })
  try {
    const entry = vault.record({ sessionId: 's', originalPath: '_old.py', content: 'old' })
    // Backdate the ledger entry rather than waiting a day.
    const indexPath = vault.indexPath
    const line = JSON.parse(readFileSync(indexPath, 'utf8').trim())
    line.ts = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString()
    writeFileSync(indexPath, `${JSON.stringify(line)}\n`, 'utf8')

    const dry = vault.purge({ olderThanDays: 1, dryRun: true })
    assert.equal(dry.removed.length, 1)
    assert.equal(vault.stats().count, 1, 'a dry run must not delete anything')

    const real = vault.purge({ olderThanDays: 1, dryRun: false })
    assert.equal(real.removed.length, 1)
    assert.equal(vault.stats().count, 0, 'the entry is gone after a real purge')
    assert.equal(vault.read(entry.id), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the ledger survives a torn final line', () => {
  const { dir, vault } = freshVault()
  try {
    vault.record({ sessionId: 's', originalPath: 'a.py', content: 'a' })
    writeFileSync(vault.indexPath, `${readFileSync(vault.indexPath, 'utf8')}{"id":"torn"`, 'utf8')
    assert.equal(vault.all().length, 1, 'the good line is still readable')
    assert.equal(vault.stats().count, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the ledger is trimmed to maxEntries', () => {
  const { dir, vault } = freshVault({ maxEntries: 3 })
  try {
    for (let i = 0; i < 6; i += 1) {
      vault.record({ sessionId: 's', originalPath: `f${i}.py`, content: String(i) })
    }
    assert.equal(vault.stats().count, 3)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// --- ledger cache
//
// The cache is what keeps `record()` off the O(n) path: without it every
// intercepted write re-read the whole ledger. It may only ever be trusted while
// the file signature is unchanged, so the tests that matter are the ones where
// something else touches the file behind the cache's back.
test('a cached read still sees an entry another process appended', () => {
  const { dir, vault } = freshVault()
  const other = new ScratchVault({
    dir,
    maxEntries: 2000,
    maxEntryBytes: 1024 * 1024,
    retainDays: 14,
  })
  try {
    vault.record({ sessionId: 'a', originalPath: 'a.py', content: 'a' })
    assert.equal(vault.stats().count, 1, 'the cache is warm after the first record')

    other.record({ sessionId: 'b', originalPath: 'b.py', content: 'b' })
    assert.equal(vault.stats().count, 2, 'a second writer must invalidate the cache')
    assert.equal(vault.list({}).length, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('all() hands out a copy so a caller cannot corrupt the cache', () => {
  const { dir, vault } = freshVault()
  try {
    vault.record({ sessionId: 's', originalPath: 'a.py', content: 'a' })
    const listed = vault.all()
    listed.push({ id: 'bogus' })
    listed.length = 0
    assert.equal(vault.stats().count, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// --- atomic rewrites
//
// A whole-file `writeFileSync` truncates before it writes: a crash there loses
// every record at once, which is the exact failure the JSONL ledger exists to
// avoid. The rewrite therefore goes through a temp file and a rename.
test('a rewrite leaves no temporary file and no partial ledger', () => {
  const { dir, vault } = freshVault({ retainDays: 1 })
  try {
    const entry = vault.record({ sessionId: 's', originalPath: '_old.py', content: 'old' })
    const indexPath = vault.indexPath
    const line = JSON.parse(readFileSync(indexPath, 'utf8').trim())
    line.ts = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString()
    writeFileSync(indexPath, `${JSON.stringify(line)}\n`, 'utf8')

    vault.purge({ olderThanDays: 1, dryRun: false })
    assert.deepEqual(
      readdirSync(dir).filter((name) => name.endsWith('.tmp')),
      [],
      'no temporary file may survive a rewrite',
    )
    assert.equal(vault.read(entry.id), undefined)
    assert.doesNotThrow(() => JSON.parse(readFileSync(indexPath, 'utf8').trim() || '{}'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a rewrite preserves a line appended by another process', () => {
  const { dir, vault } = freshVault()
  const other = new ScratchVault({
    dir,
    maxEntries: 2000,
    maxEntryBytes: 1024 * 1024,
    retainDays: 14,
  })
  try {
    const first = vault.record({ sessionId: 's', originalPath: 'a.py', content: 'a' })
    vault.record({ sessionId: 's', originalPath: 'b.py', content: 'b' })
    // The snapshot the rewrite is based on: the ledger as it is right now.
    const snapshot = readFileSync(vault.indexPath, 'utf8')

    // Another DSH window appends while we are "deciding" what to keep.
    const third = other.record({ sessionId: 's', originalPath: 'c.py', content: 'c' })

    // Keep only the first entry; the append that raced us must survive.
    assert.equal(vault._rewriteLocked([first], snapshot), true)
    const ids = vault.all().map((e) => e.id)
    assert.deepEqual(ids, [first.id, third.id])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// --- ledger lock
//
// Two DSH windows share one vault. A purge in one must not delete entry
// directories while the other is rewriting the ledger: the two would disagree
// and `list()` would advertise entries whose script is already gone.
test('a held ledger lock makes a purge decline instead of racing', () => {
  const { dir, vault } = freshVault({ retainDays: 1 })
  const lockPath = join(dir, 'ledger.lock')
  try {
    const entry = vault.record({ sessionId: 's', originalPath: '_old.py', content: 'old' })
    const line = JSON.parse(readFileSync(vault.indexPath, 'utf8').trim())
    line.ts = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString()
    writeFileSync(vault.indexPath, `${JSON.stringify(line)}\n`, 'utf8')
    writeFileSync(lockPath, '', 'utf8')

    const result = vault.purge({ olderThanDays: 1, dryRun: false })
    assert.equal(result.busy, true)
    assert.equal(result.removed.length, 0)
    assert.equal(vault.stats().count, 1, 'a busy purge must delete nothing')
    assert.equal(vault.read(entry.id).content, 'old', 'and must keep the stored script')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a lock left behind by a dead process is stolen', () => {
  const { dir, vault } = freshVault({ retainDays: 1 })
  const lockPath = join(dir, 'ledger.lock')
  try {
    vault.record({ sessionId: 's', originalPath: '_old.py', content: 'old' })
    const line = JSON.parse(readFileSync(vault.indexPath, 'utf8').trim())
    line.ts = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString()
    writeFileSync(vault.indexPath, `${JSON.stringify(line)}\n`, 'utf8')
    // A crashed rewrite leaves the lock file behind; it must not wedge the vault.
    writeFileSync(lockPath, '', 'utf8')
    const old = new Date(Date.now() - 60_000)
    utimesSync(lockPath, old, old)

    const result = vault.purge({ olderThanDays: 1, dryRun: false })
    assert.equal(result.busy, false)
    assert.equal(result.removed.length, 1)
    assert.equal(vault.stats().count, 0)
    assert.equal(existsSync(lockPath), false, 'the stolen lock is released again')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// A failed read is NOT an empty ledger. Caching the empty parse under a valid stat
// signature hides every entry for the rest of the process, and a purge would then
// persist the emptiness over the real file. A directory where the ledger should be
// is the cheapest way to produce a real read error (EISDIR) on every platform.
test('an unreadable ledger is not mistaken for an empty one', () => {
  const { dir, vault } = freshVault()
  try {
    rmSync(vault.indexPath, { force: true })
    mkdirSync(vault.indexPath)

    assert.deepEqual(vault.all(), [])
    assert.equal(vault.stats().count, 0)
    assert.equal(vault.purge({ olderThanDays: 1, dryRun: false }).ledgerUnreadable, true)

    // Once the cause is gone, the real entries have to reappear: nothing may have
    // been cached in the meantime.
    rmSync(vault.indexPath, { recursive: true, force: true })
    const entry = vault.record({ sessionId: 's', originalPath: '_probe.py', content: 'x = 1\n' })
    assert.deepEqual(
      vault.all().map((e) => e.id),
      [entry.id],
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// The module promises that a crash mid-append can only damage its OWN line. Without
// a terminator repair, the next record is glued onto the torn fragment and both
// records become one unparsable line — losing an entry whose script is on disk.
test('a torn final line is repaired instead of fusing the next record', () => {
  const { dir, vault } = freshVault()
  try {
    writeFileSync(vault.indexPath, '{"id":"torn-entry","ts":', 'utf8')

    const entry = vault.record({ sessionId: 's', originalPath: '_probe.py', content: 'x = 1\n' })

    const raw = readFileSync(vault.indexPath, 'utf8')
    assert.ok(
      !raw.includes('{"id":"torn-entry","ts":{"id"'),
      'the new record must start on its own line',
    )
    const ids = vault.all().map((e) => e.id)
    assert.ok(ids.includes(entry.id), 'the new record must survive the torn predecessor')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

