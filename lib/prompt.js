/**
 * L2 — discipline and environment.
 *
 * Two contributions, deliberately session-agnostic:
 *
 *  1. A system-prompt section telling the model where scratch work goes.
 *  2. A `ctx.shellEnv` contributor exposing `DSH_SCRATCH` / `DSH_VAULT`.
 *
 * The section text cannot name the per-session scratch path, because
 * `systemPrompt.section` is assembled from an `AssembleContext` that carries only
 * a scope key — no session id. That is exactly why the environment channel
 * exists: the contributor's `resolve(execution)` DOES receive the tool execution,
 * so it can resolve the concrete session directory per shell call, and the prompt
 * only has to mention the variable name.
 *
 * @module dsh-scratch-vault/prompt
 */

import { sessionScratchDir } from './paths.js'

/**
 * Bucket for executions no session id can be attributed to.
 *
 * A literal `'unknown'` would merge every such execution — across sessions and
 * across concurrently running DSH processes sharing this machine — into one
 * scratch directory, while each shell is only granted write access to its OWN
 * private temp. The pid keeps two processes apart; within one process the shared
 * bucket is unavoidable but at least it is not someone else's private directory.
 */
const UNKNOWN_SESSION = `unknown-${process.pid.toString(36)}`

/** Session id carried by a tool execution, when one is attributable. */
export function sessionIdOf(execution) {
  const id = execution?.agent?.id ?? execution?.agent?.session?.id
  return typeof id === 'string' && id.length > 0 ? id : UNKNOWN_SESSION
}

/**
 * The workspace root a Session belongs to, or `undefined` when it carries none.
 * @param {unknown} session the harness Session object
 * @returns {string | undefined}
 */
export function sessionWorkspaceRoot(session) {
  const candidates = [
    session?.header?.cwd,
    // Defensive: a surface that flattens the header onto the session.
    session?.cwd,
    session?.header?.workspaceRoot,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return undefined
}

/**
 * The workspace root a tool execution belongs to.
 *
 * The session exposes this as `session.header.cwd` — `Session` is
 * `class Session { readonly header: SessionHeader }` and has NO top-level `cwd`.
 * The harness resolves the same value as
 * `agent.session.header.cwd ?? sandboxPolicy.workspaceRoot`.
 *
 * Getting this wrong is the worst kind of failure this plugin can have, because it
 * is silent: the fallback is the *host's* own cwd (the profile directory), every
 * workspace path then classifies as `outside-workspace`, and interception turns
 * itself off while every tool still reports success. `scratch_status` cannot reveal
 * it either — only a live write test can. Hence one shared accessor, used by both
 * the interception layer and the vault tools, and covered by a test that builds a
 * realistically-shaped execution.
 *
 * @param {unknown} execution a tool execution (`ToolExecutionInput`)
 * @param {string} [fallback] used when the session is not attributable
 * @returns {string}
 */
export function workspaceRootOf(execution, fallback = process.cwd()) {
  return sessionWorkspaceRoot(execution?.agent?.session) ?? fallback
}

/**
 * The discipline text injected before every model step.
 *
 * Rendered from the configuration that is actually in force, because advice that
 * names a tool this profile did not register — or promises a redirect that `deny`
 * mode refuses — is worse than no advice: it makes the model's first, cheapest
 * action fail.
 *
 * @param {{ runScript?: boolean, interceptMode?: string, interceptWrites?: boolean }} [input]
 * @returns {string}
 */
export function disciplineText(input = {}) {
  const runScript = input.runScript !== false
  const interceptMode = input.interceptMode ?? 'redirect'
  const interceptWrites = input.interceptWrites !== false

  const options = []
  if (runScript) {
    options.push(
      [
        '`run_script({ language, code, description })` — runs a program from a session scratch',
        '   file outside the workspace. No workspace write at all. This is the right answer to',
        '   "I just need to run something".',
      ].join('\n'),
    )
  }
  options.push(
    [
      '`$DSH_SCRATCH` — a per-session directory outside the workspace, already writable under',
      '   the active sandbox (PowerShell: `$env:DSH_SCRATCH`). Put any file here that must exist',
      '   on disk, then run it by its absolute path.',
    ].join('\n'),
    'The workspace — only for files the user will keep.',
  )

  let interception
  if (!interceptWrites) {
    interception = [
      'Write interception is not active in this session: nothing will be moved for you, so put',
      'operation scripts in `$DSH_SCRATCH` yourself.',
    ]
  } else if (interceptMode === 'deny') {
    interception = [
      'A scratch-looking write into the workspace is REFUSED with an explanation — do not retry',
      'it unchanged. Move the file to `$DSH_SCRATCH` and run it from there by its absolute path.',
    ]
  } else if (interceptMode === 'report') {
    interception = [
      'Interception is in report mode: writes are NOT moved, only recorded. Still put operation',
      'scripts in `$DSH_SCRATCH` — a file left in the workspace is the user\'s noise to clean up.',
    ]
  } else {
    interception = [
      'If a scratch file is written into the workspace anyway, this plugin redirects it to',
      '`$DSH_SCRATCH` and reports the real path in the tool result. Read that path from the',
      'result; do not assume the workspace path exists.',
    ]
  }

  return [
    '## Scratch discipline (dsh-scratch-vault)',
    '',
    'Operation scripts — probes, one-off converters, diagnostics, anything written only',
    'to be run once — do NOT belong in the workspace. The workspace holds deliverables and',
    'real project source; a helper script left behind is noise the user has to clean up.',
    '',
    'In order of preference:',
    '',
    ...options.map((entry, index) => `${index + 1}. ${entry}`),
    '',
    ...interception,
    '',
    'The other half of that rule: when the file the user asked for IS the deliverable — they',
    'want the script itself, not the output of running it — it belongs in the workspace.',
    'A file that already exists there is never moved, so iterating on a real deliverable is',
    'unaffected; if a NEW deliverable script was redirected, call `scratch_promote` at once',
    'to put it back.',
    '',
    'Collected scripts are archived in a host-side vault: `scratch_list` lists them,',
    '`scratch_show` reads one, `scratch_promote` copies one back into the workspace as a real',
    'deliverable, and `scratch_purge` applies the retention window. `scratch_status` reports',
    'where the vault lives.',
  ].join('\n')
}

/**
 * Install the L2 contributions. Every step is independently optional: a missing
 * service degrades one capability instead of failing the plugin.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ config: object }} options
 * @returns {{ registered: string[] }}
 */
export function installPrompt(ctx, options) {
  const { config } = options
  const registered = []

  if (config.injectPrompt) {
    const systemPrompt = typeof ctx.get === 'function' ? ctx.get('systemPrompt') : undefined
    if (systemPrompt && typeof systemPrompt.section === 'function') {
      try {
        systemPrompt.section({
          name: 'scratch-vault-discipline',
          // Late but not last: this is advice about how to work, so it should read
          // after the harness's own mechanics rather than before them.
          order: 900,
          // Rendered from the live config: naming an unregistered tool, or promising
          // a redirect that `deny` refuses, sends the model into a guaranteed error.
          text: () =>
            disciplineText({
              runScript: config.registerRunScript,
              interceptMode: config.interceptMode,
              interceptWrites: config.interceptWrites,
            }),
        })
        registered.push('systemPrompt.section')
      } catch {
        /* a section-order collision must not break the plugin */
      }
    }
  }

  if (config.exposeEnv) {
    const shellEnv = typeof ctx.get === 'function' ? ctx.get('shellEnv') : undefined
    if (shellEnv && typeof shellEnv.register === 'function') {
      try {
        shellEnv.register({
          name: 'scratch-vault',
          variables: {
            DSH_SCRATCH: {
              description:
                'Per-session scratch directory outside the workspace; writable under the active sandbox. Put throwaway operation scripts here.',
            },
            DSH_VAULT: {
              description:
                'Directory holding the dsh-scratch-vault collection of operation scripts kept out of workspaces.',
            },
          },
          resolve(execution) {
            const sessionId = sessionIdOf(execution)
            // The root is resolved per session: the shell sandbox hands each
            // session its own private temp directory, and `os.tmpdir()` names a
            // directory the shell is not allowed to write to.
            const root =
              typeof options.scratchRootFor === 'function'
                ? options.scratchRootFor(sessionId, execution?.agent?.session)
                : config.scratchRoot
            return {
              DSH_SCRATCH: sessionScratchDir(root, sessionId),
              DSH_VAULT: config.vaultDir,
            }
          },
        })
        registered.push('shellEnv')
      } catch {
        /* duplicate contributor name under HMR: ignore */
      }
    }
  }

  return { registered }
}
