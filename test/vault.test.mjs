import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
