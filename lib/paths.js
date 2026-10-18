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

/** Strip characters and shapes that cannot survive as a path segment. */
export function sanitizeSegment(segment) {
  const cleaned = String(segment)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f<>:"|?*]/g, '_')
    .replace(/[\\/]/g, '_')
    .replace(/^\.+$/, '_')
    .trim()
  return cleaned.length > 0 ? cleaned : '_'
}

/** `<scratchRoot>/<sessionId>` — one scratch area per session. */
export function sessionScratchDir(scratchRoot, sessionId) {
  return join(scratchRoot, sanitizeSegment(sessionId))
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
    .map(sanitizeSegment)
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
