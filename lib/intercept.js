/**
 * L3 — interception.
 *
 * `tools/execute` is the only seam that runs *around* dispatch and therefore the
 * only one that can change what a tool body receives: the registry passes the
 * mutable execution into the waterfall and `dispatchToolBody` reads
 * `exec.arguments` afterwards. `tools/pre-execute` cannot do this — its decision
 * type is `allow | deny | cancel | ask` and carries no arguments.
 *
 * Two rules keep the rewriting safe:
 *
 *  - The scratch path is a PURE function of the original path (`scratchPathFor`),
 *    so a `write` and the `pwsh` that runs it — which DSH may dispatch in the same
 *    parallel group — agree without sharing state.
 *  - A shell token is only redirected when the workspace file does NOT exist.
 *    A legacy leftover that really is on disk keeps running from disk; the plugin
 *    never points a command at a file the write has not produced.
 *
 * @module dsh-scratch-vault/intercept
 */

import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { classifyWrite, createProjectRootProbe } from './classify.js'
import { scratchPathFor } from './paths.js'
import { workspaceRootOf } from './prompt.js'

/** Tool names whose only meaningful argument is a destination file. */
const FILE_TOOLS = new Set(['write', 'edit'])

/**
 * Decide what to do with one execution's target path.
 * @returns {undefined | { action: 'keep' | 'vault', rule: string, reason: string,
 *   originalPath: string, scratchPath?: string, relativePath?: string }}
 */
export function decideExecution(exec, context) {
  const { config, exists = existsSync, probeProjectRoot, workspaceRoot } = context
  const name = exec?.name
  if (typeof name !== 'string' || !FILE_TOOLS.has(name)) return undefined

  const args = exec?.arguments
  if (args === null || typeof args !== 'object') return undefined
  const raw = args.file_path
  if (typeof raw !== 'string' || raw.trim().length === 0) return undefined

  const root = workspaceRoot
  if (typeof root !== 'string' || root.length === 0) return undefined

  const originalPath = isAbsolute(raw) ? raw : resolve(root, raw)
  const projectRoot = probeProjectRoot(root, config.projectManifests)
  const decision = classifyWrite({ absolutePath: originalPath, workspaceRoot: root, config, projectRoot })

  if (decision.action !== 'vault') return { ...decision, originalPath }
  if (config.interceptMode === 'report') return { ...decision, originalPath }

  return {
    ...decision,
    originalPath,
    scratchPath: scratchPathFor({
      scratchRoot: context.scratchRoot ?? config.scratchRoot,
      sessionId: sessionIdOfExecution(exec),
      workspaceRoot: root,
      originalPath,
    }),
  }
}

function sessionIdOfExecution(exec) {
  const id = exec?.agent?.id ?? exec?.agent?.session?.id
  return typeof id === 'string' && id.length > 0 ? id : 'unknown'
}

/**
 * Resolve the working directory in effect at `offset`, or `undefined` when it cannot
 * be known statically.
 *
 * A `cd`/`Set-Location`/`pushd` earlier in the command rebases every relative token
 * after it, so resolving those against the workspace root is wrong: `cd ...\lib` then
 * `Get-ChildItem intercept.js` names a file that really exists, and rewriting it to a
 * scratch path breaks a command that worked before the plugin existed.
 *
 * The fix is NOT to stop rewriting once any `cd` appears — that would also disable
 * redirection for the everyday `cd <workspace>` then `python draft.py` shape. Follow
 * the directory changes that precede the token instead.
 *
 * `undefined` means "unknown, leave the token alone": a target built from a shell
 * variable (`cd $env:FOO`) or a bare `cd` (which goes to the home directory) cannot
 * be resolved without running the shell.
 */
function cwdBefore(command, offset, workspaceRoot) {
  const changePattern =
    /(?:^|[;&|\n]|\bthen\b)[ \t]*(?:cd|chdir|pushd|set-location)\b(?:[ \t]+-[\w]+)*[ \t]*("[^"]*"|'[^']*'|[^\s;&|]+)?/gi
  let cwd = workspaceRoot
  let match
  while ((match = changePattern.exec(command)) !== null) {
    if (match.index >= offset) break
    const raw = match[1]
    // A bare `cd` goes to the home directory — not knowable.
    if (raw === undefined || raw === '-') {
      cwd = undefined
      continue
    }
    const target = raw.replace(/^['"]|['"]$/g, '')
    // `$env:FOO`/`%FOO%` and `~` (the home directory) are not resolvable statically.
    if (target.length === 0 || /[$%]/.test(target) || target.startsWith('~')) {
      cwd = undefined
      continue
    }
    cwd = isAbsolute(target) ? target : cwd === undefined ? undefined : resolve(cwd, target)
  }
  return cwd
}

/**
 * Rewrite script-looking tokens in a shell command to their scratch counterparts.
 *
 * Conservative by design: a candidate is skipped when
 *
 *  - it is part of a glob (`*.test.mjs`) — the match would be the suffix only,
 *    and rewriting it corrupts the pattern into `*<scratch path>`;
 *  - it starts inside or right after a variable reference
 *    (`$env:DSH_SCRATCH\probe.py`, `%TEMP%\probe.py`) — the match begins at
 *    the variable NAME, so rewriting yields `$env:<scratch path>`, a command that
 *    cannot run;
 *  - the character after it is a word character or a dot (`x.py.bak`) — the match
 *    is a prefix of a longer filename;
 *  - the effective working directory at that point cannot be determined;
 *  - the workspace file exists (legacy leftover, run it where it is);
 *  - its replacement contains whitespace (quoting a token that may already sit
 *    inside quotes is not worth the risk);
 *  - it fails classification.
 *
 * @returns {{ command: string, rewrites: Array<{ from: string, to: string }> }}
 */
export function rewriteCommand(command, context) {
  const { config, workspaceRoot, probeProjectRoot, exists = existsSync } = context
  const rewrites = []
  if (typeof command !== 'string' || command.length === 0) return { command, rewrites }

  const extensionPattern = config.scriptExtensions
    .map((e) => e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')
  // A path-ish token ending in a known script extension. The optional `[A-Za-z]:`
  // prefix keeps a Windows drive letter INSIDE the match: `:` is not in the character
  // class, so without it `C:\dir\_probe.py` matched only `\dir\_probe.py` and the
  // replacement produced `C:C:\scratch\...\_probe.py` — an unresolvable path.
  const tokenPattern = new RegExp(`(?:[A-Za-z]:)?[\\w./\\\\~$-]+(?:${extensionPattern})`, 'gi')

  // A directory change earlier in the command rebases every relative token that
  // follows it, so resolving those against the workspace root is simply wrong:
  // `cd ...\lib` then `Get-ChildItem intercept.js` refers to a file that DOES
  // exist, and rewriting it to `<scratch>/intercept.js` breaks a working command.
  //
  // Refusing to rewrite after ANY `cd` was too blunt, though: `cd <workspace>` then
  // `python _probe.py` is the everyday shape, and there the token must still be
  // redirected. Resolve the effective working directory per token instead, and leave the
  // token alone only when that directory cannot be determined (see `cwdBefore`).
  const out = command.replace(tokenPattern, (token, offset, whole) => {
    if (token.includes(' ')) return token
    const before = offset > 0 ? whole[offset - 1] : ''
    const after = whole[offset + token.length] ?? ''

    // The character class cannot contain glob metacharacters, so a `*`/`?`/`[`
    // immediately BEFORE the match means we matched a suffix of a glob pattern
    // (`*.test.mjs` → `.test.mjs`) rather than a real file reference.
    if (/[*?[\]]/.test(before) || /[*?[\]]/.test(after)) return token

    // `$env:DSH_SCRATCH\probe.py` and `%TEMP%\probe.py` are NOT file
    // references: the match starts inside (or immediately after) a shell variable
    // reference, and rewriting it produces `$env:<scratch path>` — a command that
    // fails with "can't open file". `$`, `%`, `:` and `}` are all ordinary
    // characters to the token pattern, so this has to be excluded explicitly.
    //
    // Two shapes have to be caught, and neither check alone is enough:
    //   - `...$env:DSH_SCRATCH\probe.py` / `%TEMP%\probe.py` — the match begins
    //     after the `:`/`%`, so the tell is the character BEFORE it;
    //   - `$DSH_SCRATCH/probe.py` — `$` is in the token class, so the match begins
    //     AT the `$` and there is no preceding character at all. The tell is then in
    //     the token itself.
    //
    // A Windows drive letter needs no exemption here: `[A-Za-z]:` is part of the token
    // pattern, so the match starts at the drive letter and is preceded by whitespace.
    if (/[\w$%:}~-]/.test(before) || /[$%]/.test(token)) return token

    // A longer filename (`x.py.bak`) makes the extension match a prefix.
    if (/[\w.]/.test(after)) return token

    // A relative token is relative to the working directory in effect at THAT point in
    // the command, which an earlier `cd` may have changed. `cwdBefore` returns
    // `undefined` when the directory cannot be determined statically; the token is then
    // left alone rather than resolved against the wrong base.
    let absolute
    if (isAbsolute(token)) {
      absolute = token
    } else {
      const cwd = cwdBefore(whole, offset, workspaceRoot)
      if (cwd === undefined) return token
      absolute = resolve(cwd, token)
    }
    if (exists(absolute)) return token // legacy leftover: run it where it is

    const projectRoot = probeProjectRoot(workspaceRoot, config.projectManifests)
    const decision = classifyWrite({ absolutePath: absolute, workspaceRoot, config, projectRoot })
    if (decision.action !== 'vault') return token

    const replacement = scratchPathFor({
      scratchRoot: context.scratchRoot ?? config.scratchRoot,
      sessionId: context.sessionId,
      workspaceRoot,
      originalPath: absolute,
    })
    if (/[\s"']/.test(replacement)) return token
    rewrites.push({ from: token, to: replacement })
    return replacement
  })

  return { command: out, rewrites }
}

/**
 * Install the L3 listeners.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ config: object, vault: import('./vault.js').ScratchVault }} options
 */
export function installInterception(ctx, options) {
  const { config, vault } = options
  const probeProjectRoot = createProjectRootProbe(existsSync)
  const pending = new Map() // callId -> rewrite record

  const warn = (message) => {
    try {
      ctx.logger?.warn?.(`scratch-vault: ${message}`)
    } catch {
      /* logging must never break a tool call */
    }
  }

  const contextFor = (exec) => {
    const sessionId = sessionIdOfExecution(exec)
    return {
      config,
      workspaceRoot: workspaceRootOf(exec),
      probeProjectRoot,
      exists: existsSync,
      sessionId,
      // Ask where this session's shell can write; `os.tmpdir()` is not it.
      scratchRoot:
        typeof options.scratchRootFor === 'function'
          ? options.scratchRootFor(sessionId, exec?.agent?.session)
          : config.scratchRoot,
    }
  }

  // --- deny mode: refuse the write instead of moving it
  ctx.on('tools/pre-execute', async (exec, next) => {
    try {
      if (config.enabled && config.interceptWrites && config.interceptMode === 'deny') {
        const decision = decideExecution(exec, contextFor(exec))
        if (decision !== undefined && decision.action === 'vault') {
          return {
            kind: 'deny',
            reason:
              `dsh-scratch-vault: "${decision.relativePath}" is an operation script, not a deliverable ` +
              `(${decision.reason}). Run it with run_script({ language, code, description }) instead, or write it to ` +
              '$DSH_SCRATCH and run it by absolute path. Set interceptMode to "redirect" to have it moved automatically.',
          }
        }
      }
    } catch (error) {
      warn(`pre-execute check failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    return next()
  })

  // --- redirect mode: move the target, and shell references to it
  ctx.on('tools/execute', async (exec, next) => {
    try {
      if (!config.enabled || !config.interceptWrites) return await next()

      if (FILE_TOOLS.has(exec?.name)) {
        const decision = decideExecution(exec, contextFor(exec))
        if (decision !== undefined && decision.action === 'vault' && config.interceptMode === 'redirect') {
          exec.arguments = { ...exec.arguments, file_path: decision.scratchPath }
          if (pending.size >= config.maxPendingRewrites) {
            const oldest = pending.keys().next().value
            if (oldest !== undefined) pending.delete(oldest)
          }
          pending.set(exec.callId, decision)
        } else if (decision !== undefined && decision.action === 'vault' && config.interceptMode === 'report') {
          warn(`would intercept ${decision.relativePath} (${decision.rule}) — interceptMode is "report"`)
          pending.set(exec.callId, { ...decision, reportOnly: true })
        }
      } else if (config.rewriteShell) {
        const args = exec?.arguments
        if (args !== null && typeof args === 'object' && typeof args.command === 'string') {
          const { command, rewrites } = rewriteCommand(args.command, contextFor(exec))
          if (rewrites.length > 0) {
            exec.arguments = { ...args, command }
            warn(
              `redirected ${rewrites.length} script reference(s) in "${exec.name}": ` +
                rewrites.map((r) => `${r.from} → ${r.to}`).join(', '),
            )
          }
        }
      }
    } catch (error) {
      warn(`execute rewrite failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    return next()
  })

  // --- report the real path, and archive the script
  ctx.on('tools/post-execute', async (exec, result, next) => {
    try {
      const decision = pending.get(exec?.callId)
      if (decision === undefined) return next()
      pending.delete(exec.callId)

      if (decision.reportOnly) return next()

      const note =
        `[dsh-scratch-vault] "${decision.relativePath}" was written to ${decision.scratchPath} instead of the workspace ` +
        `(${decision.reason}). Run it by that absolute path. \`$DSH_SCRATCH\` is the session scratch root.`

      let extra = note
      if (result?.isError !== true) {
        try {
          const content = readFileSync(decision.scratchPath, 'utf8')
          const entry = vault.record({
            sessionId: decision.sessionId ?? sessionIdOfExecution(exec),
            originalPath: decision.originalPath,
            scratchPath: decision.scratchPath,
            content,
            reason: decision.reason,
            rule: decision.rule,
            source: exec.name,
            callId: exec.callId,
            workspaceRoot: workspaceRootOf(exec),
          })
          extra += ` Archived as vault entry ${entry.id} (scratch_list / scratch_show).`
        } catch (error) {
          extra += ` (Could not archive it: ${error instanceof Error ? error.message : String(error)})`
        }
      }

      const content = Array.isArray(result?.content) ? result.content : []
      return { kind: 'accept', content: [...content, { type: 'text', text: extra }] }
    } catch (error) {
      warn(`post-execute annotation failed: ${error instanceof Error ? error.message : String(error)}`)
      return next()
    }
  })

  return { pending }
}
