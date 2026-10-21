/**
 * The vault: a durable, inspectable collection of every operation script the
 * plugin kept out of a workspace.
 *
 * Layout under `<vaultDir>`:
 *   index.jsonl              append-only ledger, one entry per line
 *   entries/<id>/script      the collected bytes
 *   entries/<id>/meta.json   the same record as the ledger line
 *   ledger.lock              advisory lock held only while the ledger is rewritten
 *
 * A JSONL ledger is chosen over a single JSON document on purpose: an aborted
 * append can only ever damage its own final line, which the reader skips, while
 * a crash during a whole-file rewrite would lose the entire history. The two
 * operations that must rewrite the file anyway — retention purge and the
 * `maxVaultEntries` trim — therefore go through `_rewriteLocked`, which writes a
 * temporary file and renames it into place, so the ledger swaps atoms and is
 * never observed half-written.
 *
 * Reading is on the hot path: every intercepted write records one entry, and a
 * naive implementation parsed the whole ledger each time (at the default 2000
 * entry cap that is tens of thousands of JSON.parse calls per collected script).
 * Reads are therefore served from an in-memory cache keyed by the ledger's
 * `stat` — size, mtime and inode. Any writer, including a second DSH window
 * sharing the same vault, changes that signature and the next read reloads. A
 * local append extends the cache in place instead of invalidating it, and if the
 * file grew by anything other than exactly the bytes just appended (i.e. another
 * process interleaved) the cache is dropped rather than guessed at.
 *
 * @module dsh-scratch-vault/vault
 */

import { createHash } from 'node:crypto'
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { vaultEntriesDir, vaultIndexPath } from './paths.js'

/** A lock older than this is assumed to belong to a dead process. */
const LOCK_STALE_MS = 30_000

/** Sortable, collision-resistant entry id. */
function newEntryId(now = Date.now()) {
  const iso = new Date(now).toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
  const rand = Math.random().toString(36).slice(2, 8)
  return `${iso}-${rand}`
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Whether a pid still exists. `EPERM` means "exists but not ours", which is
 * still alive-and-must-not-be-stolen.
 */
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error !== null && typeof error === 'object' && error.code === 'EPERM'
  }
}

/** Cache key for a ledger file: any external write changes at least one field. */
function ledgerKey(stat) {
  if (stat === undefined) return undefined
  return `${stat.size}:${stat.mtimeMs}:${stat.ino}`
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
    /** @type {{ key: string, entries: object[] } | undefined} */
    this._cache = undefined
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
        this._cache = undefined
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
    // `ensure()` is part of collection, so it must fail like the rest of it: a
    // mkdir that throws here would otherwise escape `record()` and abort a
    // caller's loop after it already deleted earlier originals.
    try {
      this.ensure()
    } catch {
      /* the write below reports the same failure through `stored: false` */
    }
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

    // A crashed append can leave a line without its terminator; appending on top
    // of that fuses two records into one unparsable line and loses BOTH. Repair
    // the terminator first, and do it before the signature below is taken so the
    // append-size check still balances.
    this._ensureLedgerTerminated()

    // Only a loaded cache can be extended; note the pre-append signature so a
    // concurrent writer cannot slip a line past it unnoticed.
    const previous = this._cache
    const before = previous === undefined ? undefined : this._stat()

    try {
      if (!tooLarge) {
        const entryDir = join(this.entriesDir, id)
        mkdirSync(entryDir, { recursive: true })
        writeFileSync(join(entryDir, 'script'), content, 'utf8')
        writeFileSync(join(entryDir, 'meta.json'), `${JSON.stringify(entry, null, 2)}\n`, 'utf8')
      }
      const line = `${JSON.stringify(entry)}\n`
      appendFileSync(this.indexPath, line, 'utf8')
      this._rememberAppend(previous, before, line, entry)
    } catch (error) {
      // Collection is best effort: failing to archive must never fail the write
      // it was observing.
      entry.stored = false
      entry.storeError = error instanceof Error ? error.message : String(error)
      this._cache = undefined
    }

    this.pruneToLimit()
    return entry
  }

  /** Read every ledger line, skipping a torn final line. */
  all() {
    return [...this._entries()]
  }

  /** Newest-first listing, optionally scoped to one session. */
  list({ sessionId, limit = 50 } = {}) {
    const entries = this._entries()
      .filter((e) => sessionId === undefined || e.sessionId === sessionId)
      .sort((a, b) => String(b.ts).localeCompare(String(a.ts)))
    return entries.slice(0, Math.max(1, limit))
  }

  /** One entry plus its script text. */
  read(id) {
    const entry = this._entries().find((e) => e.id === id)
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
    const parent = join(targetPath, '..')
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true })
    writeFileSync(targetPath, found.content, 'utf8')
    return { id, targetPath, bytes: Buffer.byteLength(found.content, 'utf8') }
  }

  /**
   * Drop entries older than the retention window. Never throws.
   *
   * Returns `busy: true` without touching anything when another process holds
   * the ledger lock: deleting entry directories while that process rewrites the
   * ledger would leave the two disagreeing, so the safe answer is "try later".
   */
  purge({ olderThanDays, dryRun = false } = {}) {
    const days = Number.isFinite(olderThanDays) ? olderThanDays : this.retainDays
    if (!(days > 0)) return { removed: [], dryRun, kept: this._entries().length, busy: false }
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000

    const release = this._acquireLock()
    if (release === undefined) {
      return { removed: [], dryRun, kept: this._entries().length, busy: true }
    }
    try {
      const { readable, raw, entries } = this._freshLedger()
      if (!readable) {
        // An unreadable ledger is not an empty one. Rewriting from `''` would
        // replace every record with nothing while the entry directories survive.
        return { removed: [], dryRun, kept: this._entries().length, busy: false, ledgerUnreadable: true }
      }
      const keep = []
      const expired = []
      for (const entry of entries) {
        const ts = Date.parse(entry.ts)
        if (Number.isFinite(ts) && ts < cutoff) expired.push(entry)
        else keep.push(entry)
      }
      if (dryRun) return { removed: expired, dryRun, kept: keep.length, busy: false }
      const deleted = []
      const undeletable = []
      for (const entry of expired) {
        try {
          rmSync(join(this.entriesDir, entry.id), { recursive: true, force: true })
          deleted.push(entry)
        } catch {
          undeletable.push(entry) // a locked directory stays, and stays recorded
        }
      }
      const ledgerRewritten = this._rewriteLocked([...keep, ...undeletable], raw)
      return {
        // Only what actually left the disk counts as removed: the tool reports
        // these ids, and an id that is still in the ledger must not appear.
        removed: deleted,
        undeletable,
        dryRun,
        kept: ledgerRewritten ? keep.length + undeletable.length : entries.length,
        busy: false,
        ledgerRewritten,
      }
    } finally {
      release()
    }
  }

  /** Keep the ledger within `maxEntries` by dropping the oldest. */
  pruneToLimit() {
    // Hot path: the cache answers "under the cap" without touching the disk.
    const cached = this._cache
    if (cached !== undefined && cached.entries.length <= this.maxEntries) return 0

    const release = this._acquireLock()
    if (release === undefined) return 0
    try {
      const { readable, stat, raw, entries } = this._freshLedger()
      if (!readable) return 0
      if (entries.length <= this.maxEntries) {
        this._primeCache(stat, entries)
        return 0
      }
      const sorted = [...entries].sort((a, b) => String(a.ts).localeCompare(String(b.ts)))
      const overflow = sorted.slice(0, entries.length - this.maxEntries)
      const failed = []
      for (const entry of overflow) {
        try {
          rmSync(join(this.entriesDir, entry.id), { recursive: true, force: true })
        } catch {
          // The directory survived, so the ledger line must survive with it:
          // dropping the line would orphan a script that no tool can reach.
          failed.push(entry)
        }
      }
      if (failed.length === overflow.length) return 0 // nothing to rewrite
      const trimmed = overflow.length - failed.length
      this._rewriteLocked([...sorted.slice(overflow.length), ...failed], raw)
      return trimmed
    } finally {
      release()
    }
  }

  /** Aggregate counts for the status tool. */
  stats() {
    const entries = this._entries()
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

  // --- ledger internals -----------------------------------------------------

  /** `stat` of the ledger, or `undefined` when it does not exist. */
  _stat() {
    try {
      return statSync(this.indexPath)
    } catch {
      return undefined
    }
  }

  /**
   * Ledger text, or `undefined` when the file exists but cannot be read.
   *
   * The distinction matters: an empty string means "no entries", while a failed
   * read must never be interpreted as one. Otherwise a transient EMFILE/EACCES
   * caches an empty ledger under a valid signature, and a later rewrite persists
   * that emptiness over the real file.
   */
  _readRaw() {
    let exists = false
    try {
      exists = existsSync(this.indexPath)
    } catch {
      exists = false
    }
    if (!exists) return ''
    try {
      return readFileSync(this.indexPath, 'utf8')
    } catch {
      return undefined
    }
  }

  /** Parse ledger text, skipping torn or corrupt lines. */
  _parse(raw) {
    const out = []
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      try {
        out.push(JSON.parse(trimmed))
      } catch {
        // Two records fused by a crashed append share one line. Recover both
        // rather than dropping a record whose script is still on disk.
        const parts = trimmed.split(/(?=\{"id":)/)
        if (parts.length < 2) continue
        for (const part of parts) {
          if (part.length === 0) continue
          try {
            out.push(JSON.parse(part))
          } catch {
            /* genuinely corrupt fragment: skip it */
          }
        }
      }
    }
    return out
  }

  /**
   * Cached ledger entries. The cache is only trusted while the file signature is
   * unchanged; anything else is reloaded from disk.
   */
  _entries() {
    const stat = this._stat()
    if (stat === undefined) {
      this._cache = undefined
      return []
    }
    const key = ledgerKey(stat)
    if (this._cache !== undefined && this._cache.key === key) return this._cache.entries
    const raw = this._readRaw()
    if (raw === undefined) {
      // A failed read is not an empty ledger: report nothing, cache nothing, so
      // the next call retries instead of pinning an empty view forever.
      this._cache = undefined
      return []
    }
    const entries = this._parse(raw)
    this._cache = { key, entries }
    return entries
  }

  /**
   * Fresh (uncached) ledger snapshot. Rewrite paths must never act on a cached
   * view: they are about to replace the file, so they need what is in it now.
   * `readable: false` means "the file exists but could not be read" — callers
   * must abort instead of rewriting from an empty snapshot.
   */
  _freshLedger() {
    const stat = this._stat()
    const raw = this._readRaw()
    return { stat, raw, readable: raw !== undefined, entries: raw === undefined ? [] : this._parse(raw) }
  }

  /**
   * Keep the ledger newline-terminated before an append. A power loss during
   * `appendFileSync` can leave a half line; the next append would glue a record
   * onto it and make one unparsable line out of two good records.
   */
  _ensureLedgerTerminated() {
    const stat = this._stat()
    if (stat === undefined || stat.size === 0) return
    let fd
    try {
      fd = openSync(this.indexPath, 'r')
      const byte = Buffer.allocUnsafe(1)
      const read = readSync(fd, byte, 0, 1, stat.size - 1)
      if (read === 1 && byte[0] !== 0x0a) appendFileSync(this.indexPath, '\n', 'utf8')
    } catch {
      /* best effort: a failed repair must not fail the append */
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd)
        } catch {
          /* already closed */
        }
      }
    }
  }

  /** Cache a snapshot whose signature was taken no later than the read. */
  _primeCache(stat, entries) {
    const key = ledgerKey(stat)
    this._cache = key === undefined ? undefined : { key, entries }
  }

  /**
   * Extend the cache with the line just appended, but only when the file is
   * exactly the bytes the cache already represents plus that line. Anything else
   * means a second writer exists and the cache is dropped instead of guessed at.
   */
  _rememberAppend(previous, before, line, entry) {
    if (previous === undefined || before === undefined || previous.key !== ledgerKey(before)) {
      this._cache = undefined
      return
    }
    const after = this._stat()
    if (after === undefined || after.size !== before.size + Buffer.byteLength(line, 'utf8')) {
      this._cache = undefined
      return
    }
    previous.entries.push(entry)
    previous.key = ledgerKey(after)
  }

  /**
   * Replace the ledger atomically: write a temporary file, fold in any line
   * another process appended after our snapshot, then rename over the original.
   * Callers must already hold the lock.
   */
  _rewriteLocked(entries, rawSnapshot) {
    // Without a trustworthy snapshot there is no way to merge a concurrent
    // append, and replacing the file would silently drop it. Refuse instead.
    if (typeof rawSnapshot !== 'string') return false
    const text = entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length > 0 ? '\n' : '')
    const tmp = `${this.indexPath}.${process.pid}-${Date.now().toString(36)}.tmp`
    try {
      writeFileSync(tmp, text, 'utf8')
      const tail = this._tailSince(rawSnapshot)
      if (tail.length > 0) appendFileSync(tmp, tail, 'utf8')
      renameSync(tmp, this.indexPath)
      // Never prime the cache here. A writer can append between the rename and
      // any stat taken after it, and that signature would then match a cache
      // missing its line — the entry would be invisible until the next change.
      this._cache = undefined
      return true
    } catch {
      try {
        rmSync(tmp, { force: true })
      } catch {
        /* nothing to clean up */
      }
      this._cache = undefined
      return false
    }
  }

  /** Bytes appended after the snapshot we rewrote from, if any. */
  _tailSince(rawSnapshot) {
    const offset = Buffer.byteLength(rawSnapshot, 'utf8')
    const stat = this._stat()
    if (stat === undefined || stat.size <= offset) return ''
    const length = stat.size - offset
    let fd
    try {
      fd = openSync(this.indexPath, 'r')
      const buffer = Buffer.allocUnsafe(length)
      const read = readSync(fd, buffer, 0, length, offset)
      return buffer.subarray(0, read).toString('utf8')
    } catch {
      return ''
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd)
        } catch {
          /* already closed */
        }
      }
    }
  }

  /**
   * Advisory lock around ledger rewrites, so two DSH windows sharing one vault
   * cannot interleave a purge with a trim. Returns a release function, or
   * `undefined` when the lock is held by a live process.
   */
  _acquireLock() {
    const lockPath = join(this.dir, 'ledger.lock')
    try {
      mkdirSync(this.dir, { recursive: true })
    } catch {
      /* an unwritable vault fails the open below, which is handled */
    }
    const token = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let fd
      try {
        fd = openSync(lockPath, 'wx')
        try {
          writeFileSync(fd, JSON.stringify({ pid: process.pid, token, ts: new Date().toISOString() }), 'utf8')
        } catch {
          /* the lock is still ours even if its body is empty */
        }
        closeSync(fd)
      } catch {
        if (fd !== undefined) {
          try {
            closeSync(fd)
          } catch {
            /* already closed */
          }
        }
        if (!this._stealDeadLock(lockPath)) return undefined
        continue
      }
      return () => {
        // Only release a lock that is still ours: a stolen lock belongs to the
        // process that stole it, and deleting it would let a third writer in.
        let held
        try {
          held = JSON.parse(readFileSync(lockPath, 'utf8'))
        } catch {
          return
        }
        if (held?.token !== token) return
        try {
          rmSync(lockPath, { force: true })
        } catch {
          /* already gone */
        }
      }
    }
    return undefined
  }

  /**
   * Whether a held lock can be taken over.
   *
   * Age alone is not evidence of death: a live process can sit inside the
   * critical section for longer than the threshold (OS sleep, a slow recursive
   * delete, a debugger), and stealing there gives two writers. So the lock
   * records its owner's pid, and it is stolen only when that process is
   * verifiably gone — with the age heuristic reserved for locks whose body
   * cannot be read at all.
   */
  _stealDeadLock(lockPath) {
    let owner
    try {
      owner = JSON.parse(readFileSync(lockPath, 'utf8'))
    } catch {
      owner = undefined
    }
    if (owner !== undefined && Number.isInteger(owner.pid)) {
      if (isProcessAlive(owner.pid)) return false
    } else {
      let mtimeMs
      try {
        mtimeMs = statSync(lockPath).mtimeMs
      } catch {
        return true // vanished between the open and the stat: retry
      }
      if (Date.now() - mtimeMs <= LOCK_STALE_MS) return false
    }
    try {
      rmSync(lockPath, { force: true })
    } catch {
      return false
    }
    return true
  }
}

export { newEntryId }
