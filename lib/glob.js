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
 * Matching is segment-wise with memoisation rather than one big RegExp. A regex
 * translation of `**\/**\/…` nests a quantifier inside every `**`, so a path that
 * fails to match backtracks over every way of splitting it between those groups:
 * `**\/**\/**\/**\/**\/**\/**\/**\/**\/**\/x` against a 40-segment path froze the
 * process for 55 seconds on the tool-dispatch event loop. The DP below is O(segments
 * × pattern segments) and cannot blow up, whatever the pattern looks like.
 *
 * @module dsh-scratch-vault/glob
 */

/** Compiled single-segment matchers, keyed by source. The cap is a leak guard. */
const CACHE_LIMIT = 256
const cache = new Map()

/**
 * Windows paths are case-insensitive, so an allowlist entry `Report.py` has to
 * match `report.py` there; on POSIX the distinction is real and is preserved.
 */
const FLAGS = process.platform === 'win32' ? 'i' : ''

function escapeLiteral(ch) {
  return ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
}

/** Compile one path segment (`*` and `?` only — `**` is handled by the DP). */
function segmentRegExp(segment) {
  const cached = cache.get(segment)
  if (cached !== undefined) return cached
  let out = ''
  for (const ch of segment) {
    if (ch === '*') out += '[^/]*'
    else if (ch === '?') out += '[^/]'
    else out += escapeLiteral(ch)
  }
  const compiled = new RegExp(`^${out}$`, FLAGS)
  if (cache.size >= CACHE_LIMIT) cache.clear()
  cache.set(segment, compiled)
  return compiled
}

/**
 * Collapse consecutive `**` segments: `**\/**\/x` is `**\/x`, and `a\/**\/**` is
 * `a\/**`. Only affects `globToRegExp`'s regex output; the DP already treats a run
 * of `**` as one.
 */
function collapseGlobStars(glob) {
  let out = glob
  let previous
  do {
    previous = out
    out = out.replace(/(^|\/)\*\*(?:\/\*\*)+(?=\/|$)/g, '$1**')
  } while (out !== previous)
  return out
}

/**
 * Convert one glob to an anchored RegExp.
 *
 * Present for API compatibility and for callers that want a matcher object; the
 * authoritative matcher is `matchGlob`, which cannot backtrack catastrophically.
 *
 * @param {string} glob - pattern using `*`, `?` and `**`.
 * @returns {RegExp} anchored matcher over a POSIX-style relative path.
 */
export function globToRegExp(glob) {
  const normalized = collapseGlobStars(String(glob))
  const cached = cache.get(`re:${normalized}`)
  if (cached !== undefined) return cached
  let out = ''
  for (let i = 0; i < normalized.length; i += 1) {
    const ch = normalized[i]
    if (ch === '*') {
      if (normalized[i + 1] === '*') {
        if (normalized[i + 2] === '/') {
          // `**/` swallows any number of leading segments.
          out += '(?:[^/]+/)*'
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
    out += escapeLiteral(ch)
  }
  const compiled = new RegExp(`^${out}$`, FLAGS)
  if (cache.size >= CACHE_LIMIT) cache.clear()
  cache.set(`re:${normalized}`, compiled)
  return compiled
}

/**
 * Match one POSIX relative path against one glob.
 * @param {string} relativePath - POSIX-style path, no leading slash.
 * @param {string} glob - pattern using `*`, `?` and `**`.
 * @returns {boolean}
 */
export function matchGlob(relativePath, glob) {
  const pathSegments = String(relativePath).split('/')
  const globSegments = collapseGlobStars(String(glob)).split('/')
  const memo = new Map()

  const walk = (gi, pi) => {
    const key = `${gi}:${pi}`
    const known = memo.get(key)
    if (known !== undefined) return known
    let result
    if (gi === globSegments.length) {
      result = pi === pathSegments.length
    } else {
      const segment = globSegments[gi]
      if (segment === '**') {
        // Zero segments, or consume one and stay on the same pattern segment.
        result = walk(gi + 1, pi) || (pi < pathSegments.length && walk(gi, pi + 1))
      } else {
        result = pi < pathSegments.length && segmentRegExp(segment).test(pathSegments[pi])
          ? walk(gi + 1, pi + 1)
          : false
      }
    }
    memo.set(key, result)
    return result
  }

  return walk(0, 0)
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
    let matched
    try {
      matched = matchGlob(relativePath, glob)
    } catch {
      continue // an unusable pattern must never take down a tool call
    }
    if (matched) return glob
  }
  return undefined
}
