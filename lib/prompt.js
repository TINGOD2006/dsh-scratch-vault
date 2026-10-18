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

/** Session id carried by a tool execution, when one is attributable. */
export function sessionIdOf(execution) {
  const id = execution?.agent?.id ?? execution?.agent?.session?.id
  return typeof id === 'string' && id.length > 0 ? id : 'unknown'
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
  const candidates = [
    execution?.agent?.session?.header?.cwd,
    // Defensive: a surface that flattens the header onto the session.
    execution?.agent?.session?.cwd,
    execution?.agent?.session?.header?.workspaceRoot,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return fallback
}

/**
 * The discipline text injected before every model step.
 * @param {{ vaultDir: string }} input
 * @returns {string}
 */
export function disciplineText(input) {
  return [
    '## Scratch discipline (dsh-scratch-vault)',
    '',
    'Operation scripts — probes, one-off converters, diagnostics, anything written only',
    'to be run once — do NOT belong in the workspace. The workspace holds deliverables and',
    'real project source; a helper script left behind is noise the user has to clean up.',
    '',
    'In order of preference:',
    '',
    '1. `run_script({ language, code, description })` — runs a program from a session scratch',
    '   file outside the workspace. No workspace write at all. This is the right answer to',
    '   "I just need to run something".',
    '2. `$DSH_SCRATCH` — a per-session directory outside the workspace, already writable under',
    '   the active sandbox (PowerShell: `$env:DSH_SCRATCH`). Put any file here that must exist',
    '   on disk, then run it by its absolute path.',
    '3. The workspace — only for files the user will keep.',
    '',
    'If a scratch file is written into the workspace anyway, this plugin redirects it to',
    '`$DSH_SCRATCH` and reports the real path in the tool result. Read that path from the',
    'result; do not assume the workspace path exists.',
    '',
    `Collected scripts are archived under \`${input.vaultDir}\`: use \`scratch_list\`, \`scratch_show\`,`,
    '`scratch_promote` (copy one back into the workspace as a real deliverable) and `scratch_purge`.',
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
          text: () => disciplineText({ vaultDir: config.vaultDir }),
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
