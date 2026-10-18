/**
 * The classifier: "is this write an operation script, or a deliverable?"
 *
 * This is the only judgement in the plugin that can do harm. A false positive
 * silently diverts a file the user actually asked for; a false negative leaves a
 * helper script in the workspace, which is merely the status quo. Every default
 * therefore leans toward `keep`, and the ordering below is worst-case-first:
 * an explicit allowlist and a project's real source tree both win over every
 * scratch heuristic.
 *
 * @module dsh-scratch-vault/classify
 */

import { basename, extname, join } from 'node:path'
import { matchAnyGlob } from './glob.js'
import { relativeInside } from './paths.js'

/**
 * Rule ids, in evaluation order. Exported so tests and `interceptMode: 'report'`
 * output can name the exact rule that fired.
 */
export const RULES = Object.freeze({
  DISABLED: 'disabled',
  OUTSIDE_WORKSPACE: 'outside-workspace',
  EXCLUDED: 'excluded',
  PROTECTED_DIR: 'protected-dir',
  SCRATCH_DIR: 'scratch-dir',
  SCRATCH_NAME: 'scratch-name',
  BARE_ROOT_SCRIPT: 'bare-root-script',
  NO_RULE: 'no-rule',
})

const KEEP_RULES = new Set([
  RULES.DISABLED,
  RULES.OUTSIDE_WORKSPACE,
  RULES.EXCLUDED,
  RULES.PROTECTED_DIR,
  RULES.NO_RULE,
])

/**
 * Classify one write target.
 *
 * @param {{
 *   absolutePath: string,
 *   workspaceRoot: string,
 *   config: object,
 *   projectRoot?: boolean,
 * }} input
 *   `projectRoot` is whether the workspace root carries a project manifest; the
 *   caller caches that probe because it costs a directory read.
 * @returns {{ action: 'keep' | 'vault', rule: string, relativePath?: string, reason: string }}
 */
export function classifyWrite(input) {
  const { absolutePath, workspaceRoot, config } = input
  const keep = (rule, reason) => ({ action: 'keep', rule, reason })

  if (!config.enabled || !config.interceptWrites) {
    return keep(RULES.DISABLED, 'interception is disabled')
  }

  const rel = relativeInside(workspaceRoot, absolutePath)
  if (rel === undefined) {
    return keep(RULES.OUTSIDE_WORKSPACE, 'target is outside the session workspace')
  }

  const segments = rel.split('/')
  const base = basename(absolutePath)

  // 1. An explicit allowlist always wins — the user named this file.
  const excluded = matchAnyGlob(rel, config.excludeGlobs)
  if (excluded !== undefined) {
    return { action: 'keep', rule: RULES.EXCLUDED, relativePath: rel, reason: `matched excludeGlobs "${excluded}"` }
  }

  // 2. A real source tree is never scratch, whatever the file is called.
  const dirSegments = segments.slice(0, -1)
  const protectedSegment = dirSegments.find((s) => config.protectDirs.includes(s))
  if (protectedSegment !== undefined) {
    return {
      action: 'keep',
      rule: RULES.PROTECTED_DIR,
      relativePath: rel,
      reason: `inside protected directory "${protectedSegment}"`,
    }
  }

  // 3. An explicit scratch directory marks everything beneath it.
  const scratchSegment = dirSegments.find((s) => config.scratchDirNames.includes(s))
  if (scratchSegment !== undefined) {
    return {
      action: 'vault',
      rule: RULES.SCRATCH_DIR,
      relativePath: rel,
      reason: `inside scratch directory "${scratchSegment}"`,
    }
  }

  // 4. A scratch-shaped base name (`_probe.py`, `.tps-check.mjs`, `tmp_x.sh`).
  //    Gated on the extension on purpose: a dot-leading or tmp-leading name is
  //    only evidence of a scratch *script* when the file is a script at all.
  //    Without the gate, ordinary repository files — `.gitignore`, `.env`,
  //    `.editorconfig`, `_headers` — are silently diverted, which is exactly the
  //    false positive this module exists to avoid.
  const extension = extname(base).toLowerCase()
  if (config.scriptExtensions.includes(extension)) {
    const nameMatch = config.scriptNamePatterns.find((re) => re.test(base))
    if (nameMatch !== undefined) {
      return {
        action: 'vault',
        rule: RULES.SCRATCH_NAME,
        relativePath: rel,
        reason: `base name "${base}" matches /${nameMatch.source}/i`,
      }
    }
  }

  // 5. A bare script at the root of a workspace that has no project manifest.
  //    This is the rule that separates "a scratch folder" from "a repository".
  if (
    config.treatBareRootScriptsAsScratch &&
    input.projectRoot !== true &&
    segments.length === 1 &&
    extension.length > 0 &&
    config.scriptExtensions.includes(extension)
  ) {
    return {
      action: 'vault',
      rule: RULES.BARE_ROOT_SCRIPT,
      relativePath: rel,
      reason: `"${extension}" file at the root of a workspace with no project manifest`,
    }
  }

  return keep(RULES.NO_RULE, 'no scratch rule matched')
}

/**
 * Default manifest probe, cached per workspace root for the life of the process.
 * A workspace does not grow a `package.json` mid-session in any realistic case,
 * and a stale `true` only ever means "keep", i.e. the safe direction.
 *
 * @param {(path: string) => boolean} existsSyncLike
 * @returns {(workspaceRoot: string, manifests: readonly string[]) => boolean}
 */
export function createProjectRootProbe(existsSyncLike) {
  const cache = new Map()
  return (workspaceRoot, manifests) => {
    const cached = cache.get(workspaceRoot)
    if (cached !== undefined) return cached
    let found = false
    for (const manifest of manifests) {
      try {
        if (existsSyncLike(join(workspaceRoot, manifest))) {
          found = true
          break
        }
      } catch {
        /* unreadable root: treat as project root, i.e. do not intercept */
        found = true
        break
      }
    }
    cache.set(workspaceRoot, found)
    return found
  }
}

export { KEEP_RULES }
