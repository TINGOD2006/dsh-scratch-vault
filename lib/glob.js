/**
 * Minimal glob matcher — no dependency, matched against POSIX-style relative
 * paths. `**` crosses directory separators; `*` and `?` never do.
 *
 * Scope is deliberate: this exists to support `excludeGlobs` (a deliverable
 * allowlist), not to reimplement a full glob dialect. Brace expansion and
 * character classes are unsupported on purpose — an unsupported pattern simply
 * never matches, which for an allowlist means "vault it", and the default
 * configuration ships no globs at all.
 *
 * @module dsh-scratch-vault/glob
 */

/**
 * Convert one glob to an anchored RegExp.
 * @param {string} glob - pattern using `*`, `?` and `**`.
 * @returns {RegExp} anchored matcher over a POSIX-style relative path.
 */
export function globToRegExp(glob) {
  let out = ''
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i]
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        // `**/` swallows any number of leading segments, `/**` any trailing one.
        if (glob[i + 2] === '/') {
          out += '(?:[^/]*/)*'
          i += 2
        } else {
          out += '.*'
          i += 1
        }
      } else {
        out += '[^/]*'
      }
      continue
    }
    if (ch === '?') {
      out += '[^/]'
      continue
    }
    out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${out}$`)
}

/**
 * Test a relative path against a list of globs.
 * @param {string} relativePath - POSIX-style path, no leading slash.
 * @param {readonly string[]} globs - candidate patterns.
 * @returns {string | undefined} the first matching pattern, if any.
 */
export function matchAnyGlob(relativePath, globs) {
  if (!Array.isArray(globs) || globs.length === 0) return undefined
  for (const glob of globs) {
    if (typeof glob !== 'string' || glob.length === 0) continue
    let re
    try {
      re = globToRegExp(glob)
    } catch {
      continue // an unusable pattern must never take down a tool call
    }
    if (re.test(relativePath)) return glob
  }
  return undefined
}
