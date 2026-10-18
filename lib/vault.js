/**
 * The vault: a durable, inspectable collection of every operation script the
 * plugin kept out of a workspace.
 *
 * Layout under `<vaultDir>`:
 *   index.jsonl              append-only ledger, one entry per line
 *   entries/<id>/script      the collected bytes
 *   entries/<id>/meta.json   the same record as the ledger line
 *
 * A JSONL ledger is chosen over a single JSON document on purpose: an aborted
 * append can only ever damage its own final line, which the reader skips, while
 * a crash during a whole-file rewrite would lose the entire history.
 *
 * @module dsh-scratch-vault/vault
 */

import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { vaultEntriesDir, vaultIndexPath } from './paths.js'

/** Sortable, collision-resistant entry id. */
function newEntryId(now = Date.now()) {
  const iso = new Date(now).toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
  const rand = Math.random().toString(36).slice(2, 8)
  return `${iso}-${rand}`
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export class ScratchVault {
  /**
   * @param {{ dir: string, maxEntries: number, maxEntryBytes: number, retainDays: number }} options
   */
  constructor(options) {
    this.dir = options.dir
    this.maxEntries = options.maxEntries
    this.maxEntryBytes = options.maxEntryBytes
    this.retainDays = options.retainDays
  }

  get entriesDir() {
    return vaultEntriesDir(this.dir)
  }

  get indexPath() {
    return vaultIndexPath(this.dir)
  }

  /** Create the directory skeleton. Safe to call repeatedly. */
  ensure() {
    mkdirSync(this.entriesDir, { recursive: true })
    if (!existsSync(this.indexPath)) {
      try {
        writeFileSync(this.indexPath, '', 'utf8')
      } catch {
        /* a read-only vault must not break a tool call */
      }
    }
    return this
  }

  /**
   * Persist one collected script.
   * @param {{ sessionId: string, originalPath: string, scratchPath?: string, content: string,
   *           reason?: string, rule?: string, source?: string, callId?: string,
   *           workspaceRoot?: string }} record
   * @returns {object} the stored entry (with `stored: boolean`)
   */
  record(record) {
    this.ensure()
    const id = newEntryId()
    const content = typeof record.content === 'string' ? record.content : ''
    const bytes = Buffer.byteLength(content, 'utf8')
    const tooLarge = bytes > this.maxEntryBytes

    const entry = {
      id,
      ts: new Date().toISOString(),
      sessionId: record.sessionId ?? 'unknown',
      workspaceRoot: record.workspaceRoot ?? null,
      originalPath: record.originalPath,
      scratchPath: record.scratchPath ?? null,
      reason: record.reason ?? null,
      rule: record.rule ?? null,
      source: record.source ?? 'write',
      callId: record.callId ?? null,
      bytes,
      sha256: sha256(content),
      stored: !tooLarge,
    }

    try {
      if (!tooLarge) {
        const entryDir = join(this.entriesDir, id)
        mkdirSync(entryDir, { recursive: true })
        writeFileSync(join(entryDir, 'script'), content, 'utf8')
        writeFileSync(join(entryDir, 'meta.json'), `${JSON.stringify(entry, null, 2)}\n`, 'utf8')
      }
      appendFileSync(this.indexPath, `${JSON.stringify(entry)}\n`, 'utf8')
    } catch (error) {
      // Collection is best effort: failing to archive must never fail the write
      // it was observing.
      entry.stored = false
      entry.storeError = error instanceof Error ? error.message : String(error)
    }

    this.pruneToLimit()
    return entry
  }

  /** Read every ledger line, skipping a torn final line. */
  all() {
    if (!existsSync(this.indexPath)) return []
    let raw
    try {
      raw = readFileSync(this.indexPath, 'utf8')
    } catch {
      return []
    }
    const out = []
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      try {
        out.push(JSON.parse(trimmed))
      } catch {
        /* torn or corrupt line: skip it, keep the rest */
      }
    }
    return out
  }

  /** Newest-first listing, optionally scoped to one session. */
  list({ sessionId, limit = 50 } = {}) {
    const entries = this.all()
      .filter((e) => sessionId === undefined || e.sessionId === sessionId)
      .sort((a, b) => String(b.ts).localeCompare(String(a.ts)))
    return entries.slice(0, Math.max(1, limit))
  }

  /** One entry plus its script text. */
  read(id) {
    const entry = this.all().find((e) => e.id === id)
    if (entry === undefined) return undefined
    let content
    try {
      content = readFileSync(join(this.entriesDir, id, 'script'), 'utf8')
    } catch {
      content = undefined
    }
    return { entry, content }
  }

  /**
   * Copy a vaulted script back into a real path, promoting it to a deliverable.
   * @param {string} id
   * @param {string} targetPath - absolute destination
   */
  promote(id, targetPath) {
    const found = this.read(id)
    if (found === undefined) throw new Error(`no vault entry "${id}"`)
    if (found.content === undefined) {
      throw new Error(`vault entry "${id}" has no stored script (it may have exceeded maxEntryBytes)`)
    }
    mkdirSync(join(targetPath, '..'), { recursive: true })
    writeFileSync(targetPath, found.content, 'utf8')
    return { id, targetPath, bytes: Buffer.byteLength(found.content, 'utf8') }
  }

  /** Drop entries older than the retention window. Never throws. */
  purge({ olderThanDays, dryRun = false } = {}) {
    const days = Number.isFinite(olderThanDays) ? olderThanDays : this.retainDays
    if (!(days > 0)) return { removed: [], dryRun, kept: this.all().length }
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
    const entries = this.all()
    const keep = []
    const removed = []
    for (const entry of entries) {
      const ts = Date.parse(entry.ts)
      if (Number.isFinite(ts) && ts < cutoff) removed.push(entry)
      else keep.push(entry)
    }
    if (dryRun) return { removed, dryRun, kept: keep.length }
    for (const entry of removed) {
      try {
        rmSync(join(this.entriesDir, entry.id), { recursive: true, force: true })
      } catch {
        keep.push(entry) // could not delete: keep the ledger honest
      }
    }
    try {
      writeFileSync(this.indexPath, keep.map((e) => JSON.stringify(e)).join('\n') + (keep.length ? '\n' : ''), 'utf8')
    } catch {
      /* leave the ledger as-is rather than losing records */
    }
    return { removed, dryRun, kept: keep.length }
  }

  /** Keep the ledger within `maxEntries` by dropping the oldest. */
  pruneToLimit() {
    const entries = this.all()
    if (entries.length <= this.maxEntries) return 0
    const sorted = [...entries].sort((a, b) => String(a.ts).localeCompare(String(b.ts)))
    const excess = sorted.slice(0, entries.length - this.maxEntries)
    for (const entry of excess) {
      try {
        rmSync(join(this.entriesDir, entry.id), { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
    const keep = sorted.slice(entries.length - this.maxEntries)
    try {
      writeFileSync(this.indexPath, keep.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8')
    } catch {
      /* ignore */
    }
    return excess.length
  }

  /** Aggregate counts for the status tool. */
  stats() {
    const entries = this.all()
    let bytes = 0
    for (const entry of entries) bytes += Number(entry.bytes) || 0
    const sessions = new Set(entries.map((e) => e.sessionId))
    return { count: entries.length, bytes, sessions: sessions.size }
  }

  /** Total size of the entries directory, best effort. */
  diskUsage() {
    let total = 0
    try {
      for (const name of readdirSync(this.entriesDir)) {
        try {
          total += statSync(join(this.entriesDir, name, 'script')).size
        } catch {
          /* entry without a script (oversized) */
        }
      }
    } catch {
      /* vault not created yet */
    }
    return total
  }
}

export { newEntryId }
