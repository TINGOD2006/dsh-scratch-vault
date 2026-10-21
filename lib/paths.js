/**
 * Path arithmetic and the deterministic scratch mapping.
 *
 * The mapping MUST be a pure function of the input path: DSH dispatches tool
 * calls in parallel groups, so a `write` and the `pwsh` that runs the file can
 * be in flight at the same time. Anything order-dependent (a registry that the
 * write populates and the shell reads) would race. Deriving the scratch path
 * from the original path alone removes the race entirely.
 *
 * @module dsh-scratch-vault/paths
 */

import { createHash } from 'node:crypto'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** Convert to POSIX separators for matching and display. */
export function toPosix(value) {
  return String(value).split(sep).join('/')
}

/** Containment test on resolved absolute paths. */
export function isInside(root, target) {
  const rel = relative(resolve(root), resolve(target))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** Workspace-relative POSIX path, or `undefined` when the target escapes. */
export function relativeInside(root, target) {
  if (!isInside(root, target)) return undefined
  const rel = toPosix(relative(resolve(root), resolve(target)))
  return rel === '' ? undefined : rel
}

/** Names Windows refuses to use as a file, whatever the extension. */
const RESERVED_WIN_BASENAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i

/** Strip characters and shapes that cannot survive as a path segment. */
export function sanitizeSegment(segment) {
  let cleaned = String(segment)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f<>:"|?*]/g, '_')
    .replace(/[\\/]/g, '_')
    .replace(/^\.+$/, '_')
    .trim()
    // Windows silently strips trailing dots and spaces, so `foo.` and `foo` name
    // the same file — and an all-dots name would collapse back to the parent.
    .replace(/[. ]+$/, '')
  if (RESERVED_WIN_BASENAMES.test(cleaned)) cleaned = `_${cleaned}`
  return cleaned.length > 0 ? cleaned : '_'
}

/** `<scratchRoot>/<sessionId>` — one scratch area per session. */
export function sessionScratchDir(scratchRoot, sessionId) {
  return join(scratchRoot, sanitizeSegment(sessionId))
}

/**
 * Injective segment mapping.
 *
 * `sanitizeSegment` is lossy on purpose (it has to produce a name the OS accepts),
 * but two *different* source paths must never land on the same scratch file: the
 * second write would silently overwrite the first and the vault would archive the
 * wrong body. So whenever sanitising actually changed the segment, a short hash of
 * the original is appended. Ordinary names — the overwhelmingly common case — are
 * returned unchanged.
 *
 * @param {string} segment
 * @returns {string}
 */
export function stableSegment(segment) {
  const value = String(segment)
  const cleaned = sanitizeSegment(value)
  if (cleaned === value) return cleaned
  const digest = createHash('sha1').update(value, 'utf8').digest('hex').slice(0, 6)
  return `${cleaned}-${digest}`
}

/**
 * Maps an intercepted workspace path onto the session scratch root, preserving
 * the in-workspace directory structure so relative imports and sibling data
 * files keep working from the new location.
 *
 * @param {{ scratchRoot: string, sessionId: string, workspaceRoot: string, originalPath: string }} input
 * @returns {string} absolute path inside the scratch root.
 */
export function scratchPathFor({ scratchRoot, sessionId, workspaceRoot, originalPath }) {
  const root = sessionScratchDir(scratchRoot, sessionId)
  const rel = relativeInside(workspaceRoot, originalPath)
  const parts = (rel ?? basename(originalPath))
    .split('/')
    .map(stableSegment)
    .filter((p) => p.length > 0)
  // `rel` already excludes the workspace root itself, so `parts` is never empty
  // for a real target; keep a belt-and-braces fallback anyway.
  if (parts.length === 0) parts.push(sanitizeSegment(basename(originalPath)))
  return join(root, 'workspace', ...parts)
}

/** Directory holding the current module's own throwaway files. */
export function inlineDir(scratchRoot, sessionId) {
  return join(sessionScratchDir(scratchRoot, sessionId), '_inline')
}

/** Directory holding all collected vault entries. */
export function vaultEntriesDir(vaultDir) {
  return join(vaultDir, 'entries')
}

/** Append-only ledger of every collected script. */
export function vaultIndexPath(vaultDir) {
  return join(vaultDir, 'index.jsonl')
}
