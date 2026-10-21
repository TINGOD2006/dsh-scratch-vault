/**
 * L2 + L4 model-facing tools.
 *
 * `run_script` is the "run it without writing a file into the workspace" tool.
 * `scratch_import` is the retrofit: it collects residue that was already in the
 * workspace before the plugin existed. The remaining tools are the vault's
 * read/promote/purge surface, so the user and the model can both inspect what was
 * kept out of the workspace.
 *
 * Every vault write happens HERE, in the plugin's own process. That is not an
 * implementation detail: `<vaultDir>` defaults to a path under `DSH_HOME`, which
 * is outside the session workspace and therefore outside the file sandbox's
 * writable roots. A program that the agent runs through the shell CANNOT write
 * the vault; only host-side plugin code can. Collection has to happen on this
 * side of the boundary.
 *
 * NO `@deepseek-ai/*` IMPORT HERE, deliberately. The harness resolves host
 * packages for plugins installed under the profile's `node_modules`, but this
 * plugin is designed to be installed as a `link:` to a working tree — and a bare
 * specifier resolves against the *real* path of a linked package, which never
 * reaches the profile. A single host import therefore makes the whole plugin fail
 * to load with only "failed to import" to show for it. Building the tool
 * definitions by hand costs one small helper and removes the failure mode
 * entirely; the shapes produced are exactly what `defineTool` produces.
 *
 * @module dsh-scratch-vault/tools
 */

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { classifyWrite, createProjectRootProbe, RULES } from './classify.js'
import { inlineDir, isInside, relativeInside, sessionScratchDir } from './paths.js'
import { sessionIdOf, workspaceRootOf } from './prompt.js'

/**
 * Assemble a registry-ready tool definition.
 * @param {{ name: string, description: string, parameters: object,
 *           output: { schema: object, render: Function }, execute: Function }} spec
 */
export function tool(spec) {
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    output: { schema: spec.output.schema, render: spec.output.render },
    execute: spec.execute,
  }
}

/** A JSON-schema output declaration with a plain-text renderer. */
export function textOutput(schema) {
  return {
    schema,
    render: (_args, value) => [
      { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
    ],
  }
}

/** Bound the stringification of anything echoed back to the model. */
function clampTimeout(value, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(3_600_000, Math.max(1_000, n))
}

function requireString(args, key, toolName) {
  const value = args?.[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${toolName}: "${key}" is required and must be a non-empty string`)
  }
  return value
}

/**
 * Explain a purge that did not fully succeed. A partial outcome reported as a
 * plain count reads like success, so every non-clean state gets a sentence.
 */
function purgeNotes(result) {
  const notes = []
  if (result.busy === true) {
    notes.push('another process is rewriting the vault ledger — nothing was deleted, retry shortly')
  }
  if (result.ledgerUnreadable === true) {
    notes.push('the vault ledger could not be read — nothing was deleted and the ledger was left untouched')
  }
  if (result.ledgerRewritten === false) {
    notes.push('entry directories were deleted but the ledger could not be rewritten; run scratch_purge again')
  }
  const undeletable = Array.isArray(result.undeletable) ? result.undeletable : []
  if (undeletable.length > 0) {
    notes.push(
      `${undeletable.length} entr${undeletable.length === 1 ? 'y' : 'ies'} could not be deleted and stayed in the ledger`,
    )
  }
  return notes
}

/** Single-quote one argv element for the target shell. */
export function quoteArg(value, win) {
  const text = String(value)
  // PowerShell escapes an embedded single quote by doubling it; POSIX shells
  // close, emit an escaped quote, and reopen.
  return win ? `'${text.replace(/'/g, "''")}'` : `'${text.replace(/'/g, "'\\''")}'`
}

/** Compose the interpreter command line for one inline run. */
export function buildCommand({ language, exe, file, args, win }) {
  const q = (value) => quoteArg(value, win)
  if (language === 'powershell') {
    return [exe, '-NoProfile', '-File', q(file), ...args.map(q)].join(' ')
  }
  return [exe, q(file), ...args.map(q)].join(' ')
}

/** `YYYYMMDDHHMMSS-<rand>` for inline scratch file names. */
function stamp() {
  const iso = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
  return `${iso}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Register every tool.
 * @param {object} ctx - Cordis context (only `tools` and `get` are used).
 * @param {{ config: object, vault: import('./vault.js').ScratchVault }} options
 * @returns {{ registered: string[] }}
 */
export function registerTools(ctx, options) {
  const { config, vault } = options
  const registered = []
  const win = process.platform === 'win32'
  // `enabled: false` is the master switch: interception, the discipline prompt and
  // `run_script` all stop, but the vault stays INSPECTABLE — an off switch that
  // also hides the scripts already collected would strand them.
  const active = options.active !== false
  const get = (name) => (typeof ctx.get === 'function' ? ctx.get(name) : undefined)
  // Scratch files live where the session's own shell can reach them.
  const scratchRootFor = (sessionId, session) =>
    typeof options.scratchRootFor === 'function'
      ? options.scratchRootFor(sessionId, session)
      : config.scratchRoot
  const add = (definition, key) => {
    ctx.tools.register(definition)
    registered.push(key)
  }
  // Shares the classifier's cached manifest probe, so a `scratch_import` verdict
  // and an interception verdict never disagree about whether this is a project.
  const probeProjectRoot = createProjectRootProbe(existsSync)

  if (config.registerRunScript && active) {
    add(
      tool({
        name: 'run_script',
        description:
          'Run a program from a session scratch file OUTSIDE the workspace, so no operation script is ever left behind. ' +
          'Use this instead of writing a helper script into the repository: "write a probe, run it, read the output" becomes ' +
          'one call. The file is recorded in the scratch vault and its path is returned.',
        parameters: {
          type: 'object',
          properties: {
            language: {
              type: 'string',
              enum: Object.keys(config.interpreters),
              description: `Interpreter to run the program with. One of: ${Object.keys(config.interpreters).join(', ')}.`,
            },
            code: { type: 'string', description: 'Full program source. Written verbatim to the scratch file before it runs.' },
            description: {
              type: 'string',
              description: 'Short summary of what this program does, for the run record and the vault entry.',
            },
            args: { type: 'array', items: { type: 'string' }, description: 'Extra argv entries passed after the script path.' },
            cwd: {
              type: 'string',
              description:
                'Working directory for the run. Defaults to the session workspace, so relative paths still resolve against the project.',
            },
            timeoutMs: { type: 'number', description: `Deadline in milliseconds. Defaults to ${config.runScriptTimeoutMs}.` },
          },
          required: ['language', 'code', 'description'],
        },
        output: textOutput({ type: 'object', additionalProperties: true }),
        async execute(args, exec) {
          const language = requireString(args, 'language', 'run_script')
          const code = requireString(args, 'code', 'run_script')
          requireString(args, 'description', 'run_script')

          const exe = config.interpreters[language]
          const extension = config.extensions[language]
          if (exe === undefined || extension === undefined) {
            throw new Error(
              `run_script: unsupported language "${language}" — configure it under "interpreters" and "extensions" in ${config.configPath}`,
            )
          }

          // Resolve the shell before touching the scratch directory: a composition
          // without it must fail with the reason, not leave a stray program behind.
          const shell = get('shell')
          if (!shell || typeof shell.resolve !== 'function' || typeof shell.execute !== 'function') {
            throw new Error('run_script requires the harness shell service (ctx.shell), which is not mounted')
          }

          const sessionId = sessionIdOf(exec)
          const directory = inlineDir(scratchRootFor(sessionId, exec?.agent?.session), sessionId)
          mkdirSync(directory, { recursive: true })

          const file = join(directory, `${stamp()}${extension}`)
          writeFileSync(file, code, 'utf8')

          const extraArgs = Array.isArray(args.args) ? args.args.map((a) => String(a)) : []
          const command = buildCommand({ language, exe, file, args: extraArgs, win })

          const workspaceRoot = workspaceRootOf(exec)
          const timeoutMs = clampTimeout(args.timeoutMs, config.runScriptTimeoutMs)

          let sandboxPolicy
          try {
            sandboxPolicy = get('sandboxPolicy')?.resolve?.({})
          } catch {
            sandboxPolicy = undefined // fall back to the shell implementation's own default
          }

          // The harness builds `dshEnv` from the shellEnv registry at every shell
          // tool call — `const dshEnv = ctx.shellEnv.collect(exec)` — and that is
          // how `$DSH_SCRATCH` reaches the model's shells. A program launched
          // through THIS tool bypasses the shell tool entirely, so without an
          // explicit collect() the variable is simply absent and a scratch script
          // that reads it fails with `undefined`. Collect it here so run_script runs
          // its program under exactly the environment a `pwsh` call would have.
          let dshEnv
          try {
            dshEnv = get('shellEnv')?.collect?.(exec)
          } catch {
            dshEnv = undefined // a composition without shellEnv still runs, just without DSH_*
          }

          // A failed dispatch must not erase the program: the promise of this tool
          // is that the file is always in the vault, and a run that died (missing
          // interpreter, timeout, cancelled turn) is exactly the one worth reading
          // later. Record first, then rethrow the original error untouched.
          let result
          let executionError
          try {
            const handle = await shell.execute(
              shell.resolve({
                command,
                workdir: typeof args.cwd === 'string' && args.cwd.length > 0 ? args.cwd : workspaceRoot,
                timeoutMs,
                signal: exec.signal,
                ...(sandboxPolicy === undefined ? {} : { sandboxPolicy }),
                ...(dshEnv === undefined ? {} : { dshEnv }),
              }),
            )
            result = await handle.result()
          } catch (error) {
            executionError = error
          }

          let vaultId = null
          if (config.recordInlineRuns) {
            try {
              vaultId = vault.record({
                sessionId,
                originalPath: `(inline ${language})`,
                scratchPath: file,
                content: code,
                reason: String(args.description ?? ''),
                rule: 'run-script',
                source: 'run_script',
                workspaceRoot,
              }).id
            } catch {
              vaultId = null // archiving is best effort; it must not mask the run
            }
          }

          if (executionError !== undefined) throw executionError

          return {
            language,
            scriptPath: file,
            vaultId,
            exitCode: result.exitCode,
            timedOut: result.timedOut === true,
            aborted: result.aborted === true,
            stdout: result.stdout?.text ?? '',
            stderr: result.stderr?.text ?? '',
            stdoutTruncated: result.stdout?.truncated === true,
            stderrTruncated: result.stderr?.truncated === true,
            sandbox: result.sandbox ?? null,
          }
        },
      }),
      'run_script',
    )
  }

  // Importing MOVES workspace files, so it belongs to the active side of the switch.
  if (active)
    add(
    tool({
      name: 'scratch_import',
      description:
        'Collect operation scripts that are already sitting in the workspace into the vault — the retrofit for residue created before this ' +
        'plugin was installed, or before the write that produced it was intercepted. Verifies the vault copy byte-for-byte before removing ' +
        'the original, and reports what the classifier would have made of each path.',
      parameters: {
        type: 'object',
        properties: {
          paths: {
            type: 'array',
            items: { type: 'string' },
            description: 'Workspace-relative or absolute paths of the scripts to collect.',
          },
          keepOriginal: {
            type: 'boolean',
            description:
              'Keep the workspace copy. Default false: the original is removed once the vault copy is verified byte-identical.',
          },
          dryRun: {
            type: 'boolean',
            description: 'Report what would happen; write to the vault and delete nothing. Default false.',
          },
        },
        required: ['paths'],
      },
      output: textOutput({ type: 'object', additionalProperties: true }),
      execute(args, exec) {
        const requested = Array.isArray(args.paths) ? args.paths : []
        if (requested.length === 0) {
          throw new Error('scratch_import: "paths" is required and must be a non-empty array')
        }
        const keepOriginal = args.keepOriginal === true
        const dryRun = args.dryRun === true
        const sessionId = sessionIdOf(exec)
        const workspaceRoot = workspaceRootOf(exec)
        const projectRoot = probeProjectRoot(workspaceRoot, config.projectManifests)

        const results = []
        for (const raw of requested) {
          const given = String(raw)
          const absolutePath = isAbsolute(given) ? resolve(given) : resolve(workspaceRoot, given)
          const record = (status, extra = {}) => results.push({ path: given, status, ...extra })

          const rel = relativeInside(workspaceRoot, absolutePath)
          if (rel === undefined) {
            record('refused', { detail: 'target is outside the session workspace' })
            continue
          }

          let stat
          try {
            stat = statSync(absolutePath)
          } catch {
            record('missing', { detail: 'no such file' })
            continue
          }
          if (!stat.isFile()) {
            record('refused', { detail: 'not a regular file' })
            continue
          }
          if (stat.size > config.maxEntryBytes) {
            record('too-large', {
              detail: `${stat.size} bytes exceeds maxEntryBytes (${config.maxEntryBytes})`,
            })
            continue
          }

          let buffer
          try {
            buffer = readFileSync(absolutePath)
          } catch (error) {
            record('unreadable', { detail: error instanceof Error ? error.message : String(error) })
            continue
          }

          // The vault stores text, so only a byte-transparent decode is safe to
          // collect. Reading with `'utf8'` alone is lossy (GBK, Latin-1, binary
          // all become U+FFFD), and a string comparison afterwards would compare
          // two equally mangled strings and pass — then delete the only intact
          // copy. Decode, re-encode, and require the round trip to be exact.
          const content = buffer.toString('utf8')
          if (!Buffer.from(content, 'utf8').equals(buffer)) {
            record('not-utf8', {
              detail: 'not byte-transparent as UTF-8 text; the original was kept',
            })
            continue
          }

          // Counterfactual on purpose: an import target always exists on disk, so
          // the existing-file rule would answer "keep" for every single file and
          // make `classifierAction` meaningless. The question worth reporting is
          // "would the classifier have collected this when it was first written?".
          const verdict = classifyWrite({
            absolutePath,
            workspaceRoot,
            config,
            projectRoot,
            targetExists: false,
          })

          // The verdict gates DELETION, not collection: a protected source tree or
          // an explicit allowlist entry must not lose its file just because a
          // caller named its path.
          const guarded =
            verdict.action === 'keep' &&
            (verdict.rule === RULES.EXCLUDED ||
              verdict.rule === RULES.PROTECTED_DIR ||
              verdict.rule === RULES.OUTSIDE_WORKSPACE)

          if (dryRun) {
            record(guarded && !keepOriginal ? 'refused' : 'would-import', {
              relativePath: rel,
              bytes: stat.size,
              classifierAction: verdict.action,
              rule: verdict.rule,
              allowed: !guarded,
              detail: guarded ? 'the classifier protects this file; it will not be collected' : undefined,
              wouldRemoveOriginal: !keepOriginal && !guarded,
            })
            continue
          }

          if (guarded) {
            record('refused', {
              relativePath: rel,
              classifierAction: verdict.action,
              rule: verdict.rule,
              detail: 'the classifier protects this file (source tree or allowlist); the original was kept',
            })
            continue
          }

          let entry
          try {
            entry = vault.record({
              sessionId,
              originalPath: absolutePath,
              content,
              reason: 'pre-existing workspace operation script, imported by scratch_import',
              rule: 'legacy-import',
              source: 'scratch_import',
              workspaceRoot,
            })
          } catch (error) {
            // One failed entry must not discard the report for files already
            // imported (and whose originals are already gone).
            record('store-failed', { detail: error instanceof Error ? error.message : String(error) })
            continue
          }
          if (entry.stored === false) {
            record('store-failed', { detail: entry.storeError ?? 'vault.record did not persist the entry' })
            continue
          }

          // Never delete a workspace file unless the collected copy is provably
          // the same bytes.
          let verified = false
          try {
            verified = readFileSync(join(vault.entriesDir, entry.id, 'script')).equals(buffer)
          } catch {
            verified = false
          }
          if (!verified) {
            record('verify-failed', {
              id: entry.id,
              detail: 'the vault copy does not match the source; the original was kept',
            })
            continue
          }

          let originalRemoved = false
          if (!keepOriginal) {
            try {
              rmSync(absolutePath, { force: true })
              originalRemoved = !existsSync(absolutePath)
            } catch {
              originalRemoved = false
            }
          }

          record(keepOriginal || originalRemoved ? 'imported' : 'imported-original-kept', {
            relativePath: rel,
            id: entry.id,
            bytes: entry.bytes,
            sha256: entry.sha256,
            classifierAction: verdict.action,
            rule: verdict.rule,
            originalRemoved,
          })
        }

        const summary = {}
        for (const result of results) summary[result.status] = (summary[result.status] ?? 0) + 1

        return {
          dryRun,
          keepOriginal,
          vaultDir: vault.dir,
          workspaceRoot,
          requested: requested.length,
          summary,
          results,
        }
      },
    }),
    'scratch_import',
  )

  add(
    tool({
      name: 'scratch_list',
      description:
        'List operation scripts that dsh-scratch-vault kept out of the workspace, newest first. ' +
        'Use it to see what the agent has been running, or to find an entry id for scratch_show / scratch_promote.',
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Limit to one session id. Omit for every session.' },
          limit: { type: 'number', description: 'Maximum entries to return. Default 50.' },
        },
      },
      output: textOutput({ type: 'object', additionalProperties: true }),
      execute(args, exec) {
        const sessionId =
          typeof args.sessionId === 'string' && args.sessionId.length > 0 ? args.sessionId : undefined
        const limit = Number.isFinite(Number(args.limit)) ? Number(args.limit) : 50
        const entries = vault.list({ sessionId, limit })
        return {
          vaultDir: vault.dir,
          currentSessionId: sessionIdOf(exec),
          count: entries.length,
          stats: vault.stats(),
          entries,
        }
      },
    }),
    'scratch_list',
  )

  add(
    tool({
      name: 'scratch_show',
      description: 'Show one vaulted operation script: its record, and the source unless includeContent is false.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Entry id from scratch_list.' },
          includeContent: { type: 'boolean', description: 'Include the script source. Default true.' },
        },
        required: ['id'],
      },
      output: textOutput({ type: 'object', additionalProperties: true }),
      execute(args) {
        const id = requireString(args, 'id', 'scratch_show')
        const found = vault.read(id)
        if (found === undefined) throw new Error(`scratch_show: no vault entry "${id}"`)
        const includeContent = args.includeContent !== false
        return {
          entry: found.entry,
          content: includeContent ? (found.content ?? null) : undefined,
          contentOmitted: includeContent ? undefined : 'includeContent was false',
        }
      },
    }),
    'scratch_show',
  )

  add(
    tool({
      name: 'scratch_promote',
      description:
        'Copy a vaulted operation script back into the workspace as a real deliverable — the escape hatch for a file that was ' +
        'intercepted by mistake, or that turned out to be worth keeping.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Entry id from scratch_list.' },
          targetPath: { type: 'string', description: 'Absolute destination path inside the workspace.' },
        },
        required: ['id', 'targetPath'],
      },
      output: textOutput({ type: 'object', additionalProperties: true }),
      execute(args, exec) {
        const id = requireString(args, 'id', 'scratch_promote')
        const targetPath = requireString(args, 'targetPath', 'scratch_promote')
        // The parameter description above promises a destination inside the
        // workspace, so enforce it here — `vault.promote` writes wherever the
        // host process can, and the containment helpers live on this side.
        const workspaceRoot = workspaceRootOf(exec)
        const rel = relativeInside(workspaceRoot, targetPath)
        if (rel === undefined) {
          throw new Error(
            `scratch_promote: "targetPath" must be inside the session workspace (${workspaceRoot}); got ${targetPath}`,
          )
        }
        return { promoted: true, relativePath: rel, ...vault.promote(id, targetPath) }
      },
    }),
    'scratch_promote',
  )

  add(
    tool({
      name: 'scratch_purge',
      description:
        'Delete vault entries older than the retention window, and report how much is left. Runs as a dry run unless dryRun is false.',
      parameters: {
        type: 'object',
        properties: {
          olderThanDays: { type: 'number', description: `Age cutoff in days. Default ${config.retainDays}.` },
          dryRun: { type: 'boolean', description: 'Report only; delete nothing. Default true.' },
        },
      },
      output: textOutput({ type: 'object', additionalProperties: true }),
      execute(args) {
        const dryRun = args.dryRun !== false
        const result = vault.purge({
          olderThanDays: Number.isFinite(Number(args.olderThanDays)) ? Number(args.olderThanDays) : config.retainDays,
          dryRun,
        })
        return {
          dryRun,
          removedCount: result.removed.length,
          removedIds: result.removed.map((e) => e.id).slice(0, 100),
          keptCount: result.kept,
          // A shared vault can be mid-rewrite in another DSH window; the purge
          // then declines rather than risk making the ledger and the entry
          // directories disagree.
          busy: result.busy === true,
          ledgerRewritten: result.ledgerRewritten !== false,
          undeletableIds: (Array.isArray(result.undeletable) ? result.undeletable : [])
            .map((e) => e.id)
            .slice(0, 100),
          notes: purgeNotes(result),
          stats: vault.stats(),
          diskUsageBytes: vault.diskUsage(),
        }
      },
    }),
    'scratch_purge',
  )

  add(
    tool({
      name: 'scratch_status',
      description:
        'Report how dsh-scratch-vault is configured and what it has collected: scratch root, vault directory, interception mode, ' +
        'and vault counts. Use it before trusting (or troubleshooting) the interception behaviour.',
      parameters: { type: 'object', properties: {} },
      output: textOutput({ type: 'object', additionalProperties: true }),
      execute(_args, exec) {
        // Resolve the workspace root from THIS execution and report it. This is
        // the one field whose misresolution silently disables interception (the
        // fallback is the host's own cwd, so every workspace path looks
        // "outside-workspace" and nothing is ever redirected) — and it is
        // invisible to every other diagnostic, because the tools all still
        // succeed. Reporting it here makes the failure a one-glance diagnosis.
        const session = exec?.agent?.session
        const resolvedRoot = workspaceRootOf(exec, '(unresolved — host cwd)')
        const sessionId = sessionIdOf(exec)
        const root = scratchRootFor(sessionId, session)
        return {
          // `enabled: false` still answers here: the inspection and import tools
          // stay registered so a mis-set switch can be diagnosed and undone.
          enabled: config.enabled,
          active: config.enabled !== false,
          scratchRoot: config.scratchRoot,
          vaultDir: config.vaultDir,
          configPath: config.configPath,
          configWarnings: Array.isArray(config.warnings) ? config.warnings : [],
          interceptWrites: config.interceptWrites,
          interceptMode: config.interceptMode,
          rewriteShell: config.rewriteShell,
          injectPrompt: config.injectPrompt,
          exposeEnv: config.exposeEnv,
          autoPurge: config.autoPurge,
          retainDays: config.retainDays,
          scriptExtensions: config.scriptExtensions,
          excludeGlobs: config.excludeGlobs,
          // --- live resolution, per execution
          sessionId,
          workspaceRoot: resolvedRoot,
          scratchDir: sessionScratchDir(root, sessionId),
          // The whole promise is "outside the workspace"; if a configured root
          // lands inside one, say so here instead of quietly modifying it.
          scratchDirInsideWorkspace: isInside(resolvedRoot, root),
          sessionShape: {
            hasHeaderCwd: typeof session?.header?.cwd === 'string',
            hasFlatCwd: typeof session?.cwd === 'string',
          },
          stats: vault.stats(),
          diskUsageBytes: vault.diskUsage(),
        }
      },
    }),
    'scratch_status',
  )

  return { registered }
}
