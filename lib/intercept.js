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
 * How long an intercepted call may wait for its `post-execute` before its pending
 * record is considered abandoned. Generous on purpose: the record only has to
 * survive one tool dispatch, so anything older than a minute means the hook was
 * skipped, not that the call is slow.
 */
const PENDING_TTL_MS = 60_000

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
  // An existing target is an artifact, not a probe (classify rule 2). A probe the
  // plugin redirected never exists in the workspace afterwards, so anything that is
  // already there belongs to the user — including a deliverable script the model
  // is iterating on. `existsSync` must never throw into the tool pipeline.
  let targetExists = false
  try {
    targetExists = context.exists(originalPath) === true
  } catch {
    targetExists = false
  }
  const decision = classifyWrite({ absolutePath: originalPath, workspaceRoot: root, config, projectRoot, targetExists })

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

/** Programs that take a script path as an argument. */
const RUNNER_PATTERN =
  /^(?:python[0-9.]*|py|node|nodejs|deno|bun|tsx|ts-node|pwsh|powershell|cmd|bash|sh|zsh|fish|ruby|perl|lua|php|rscript|julia)$/i

/** The base program name of one command word (`C:\Py\python.exe` → `python`). */
function commandWord(word) {
  const base = word.split(/[\\/]/).pop() ?? word
  return base.replace(/\.(?:exe|cmd|bat|com)$/i, '')
}

/**
 * Is this offset in the "script argument" position of a command?
 *
 * Rewriting anything path-shaped is too aggressive: `grep -q "_probe.py" notes.txt`,
 * `git commit -m "rerun _probe.py"` and a here-string that *generates* a script all
 * contain the name of a file without executing it, and rewriting them corrupts a
 * working command or bakes a machine-specific temp path into a deliverable. So a
 * token is only a candidate when it is the first word of a command (a directly
 * executed script) or an argument of a known interpreter (`python _probe.py`,
 * `pwsh -File _probe.ps1`, `node -r x _diag.mjs`).
 */
function inScriptPosition(command, offset) {
  let i = offset - 1
  let steps = 0
  while (i >= 0 && steps < 8) {
    const ch = command[i]
    if (ch === ' ' || ch === '\t' || ch === '"' || ch === "'" || ch === '`') {
      i -= 1
      continue
    }
    // A command separator ends the previous command: this token starts a new one.
    if (/[;&|(){}\n]/.test(ch)) return true
    let end = i
    while (i >= 0 && !/[\s;&|(){}\n'"]/.test(command[i])) i -= 1
    const word = command.slice(i + 1, end + 1)
    if (word.length === 0) {
      i -= 1
      continue
    }
    if (RUNNER_PATTERN.test(commandWord(word))) return true
    // Flags belong to a runner (`python -u x.py`, `pwsh -NoProfile -File x.ps1`):
    // keep walking back to find the program they belong to.
    if (word.startsWith('-') || word.startsWith('/')) {
      steps += 1
      continue
    }
    return false
  }
  return i < 0
}

/**
 * Where this offset sits relative to quoting and comments.
 *
 * A single-quoted run is a shell payload (`sh -c 'cd build && node x.py'`) or a
 * here-string body — text that is data for the shell, not this command's argv, so
 * its working directory is not the one `cwdBefore` computes and rewriting inside it
 * is how a working command starts failing. Double quotes are NOT skipped: a quoted
 * absolute path is the normal way to pass one on Windows.
 */
function quoteContext(command, offset) {
  const lineStart = command.lastIndexOf('\n', offset - 1) + 1
  let inSingle = false
  let inDouble = false
  let comment = false
  for (let i = lineStart; i < offset; i += 1) {
    const ch = command[i]
    if (inSingle) {
      if (ch === "'") inSingle = false
      continue
    }
    if (inDouble) {
      if (ch === '"') inDouble = false
      continue
    }
    if (ch === "'") {
      inSingle = true
      continue
    }
    if (ch === '"') {
      inDouble = true
      continue
    }
    // PowerShell/cmd comment: `#` at a word boundary starts it.
    if (ch === '#' && (i === lineStart || /[\s;&|]/.test(command[i - 1]))) {
      comment = true
      break
    }
  }
  return { inSingle, comment }
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

    // Data, not argv: a comment or a single-quoted payload.
    const quoting = quoteContext(whole, offset)
    if (quoting.comment || quoting.inSingle) return token

    // Only the program-slot of a command is a file this command runs.
    if (!inScriptPosition(whole, offset)) return token

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
  let warnedNoRoot = false

  /**
   * Remember a decision until `post-execute` can turn it into a note. The map is
   * bounded because an execution whose post-execute never runs (the harness skips
   * it when a `tools/execute` listener throws) would otherwise leak one record per
   * tool call, forever. Records carry their own timestamp so a stale entry — one
   * whose call is long gone — is evicted before a live one.
   */
  const remember = (callId, decision) => {
    if (pending.size >= config.maxPendingRewrites) {
      for (const [key, value] of pending) {
        if (Date.now() - (value.at ?? 0) > PENDING_TTL_MS) pending.delete(key)
      }
    }
    if (pending.size >= config.maxPendingRewrites) {
      const oldest = pending.keys().next().value
      if (oldest !== undefined) {
        pending.delete(oldest)
        warn(`dropped a pending rewrite: ${config.maxPendingRewrites} calls have not settled`)
      }
    }
    pending.set(callId, { ...decision, at: Date.now() })
  }

  const warn = (message) => {
    try {
      ctx.logger?.warn?.(`scratch-vault: ${message}`)
    } catch {
      /* logging must never break a tool call */
    }
  }

  const contextFor = (exec) => {
    const sessionId = sessionIdOfExecution(exec)
    // No fallback here on purpose. `workspaceRootOf(exec)` falls back to the host
    // process cwd (the harness install directory); every workspace path then
    // classifies as `outside-workspace`, interception turns itself off, and nothing
    // says so. An unattributable execution must be skipped loudly instead of
    // silently mis-resolving.
    const workspaceRoot = workspaceRootOf(exec, '')
    if (workspaceRoot.length === 0) {
      if (!warnedNoRoot) {
        warnedNoRoot = true
        warn('cannot resolve this session\'s workspace root — interception is skipped for it')
      }
      return undefined
    }
    return {
      config,
      workspaceRoot,
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
        const context = contextFor(exec)
        const decision = context === undefined ? undefined : decideExecution(exec, context)
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
        const context = contextFor(exec)
        const decision = context === undefined ? undefined : decideExecution(exec, context)
        if (decision !== undefined && decision.action === 'vault' && config.interceptMode === 'redirect') {
          exec.arguments = { ...exec.arguments, file_path: decision.scratchPath }
          remember(exec.callId, decision)
        } else if (decision !== undefined && decision.action === 'vault' && config.interceptMode === 'report') {
          warn(`would intercept ${decision.relativePath} (${decision.rule}) — interceptMode is "report"`)
          remember(exec.callId, { ...decision, reportOnly: true })
        }
      } else if (config.rewriteShell) {
        const args = exec?.arguments
        if (args !== null && typeof args === 'object' && typeof args.command === 'string') {
          const context = contextFor(exec)
          if (context === undefined) return await next()
          const { command, rewrites } = rewriteCommand(args.command, context)
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

      // A failed write was not written. Annotating it with "was written to … run it
      // by that absolute path" would send the model chasing a file that does not
      // exist — and it happens for real: a `write` and an `edit` of the same path in
      // one parallel dispatch, or an `edit` whose `old_string` no longer matches.
      if (result?.isError === true) return next()

      // Do not fabricate a content list: whatever produced a non-array result owns
      // that result, and replacing it with `[]` would drop the payload.
      if (!Array.isArray(result?.content)) return next()

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
          // The file itself may be exactly what the user asked for. Name the one
          // call that undoes the redirect, instead of leaving the model to infer it
          // from a wall of discipline text.
          extra +=
            ' If this script IS the deliverable the user asked for, call ' +
            `scratch_promote({ id: "${entry.id}", targetPath: ${JSON.stringify(decision.originalPath)} }) ` +
            'to put it back in the workspace.'
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
