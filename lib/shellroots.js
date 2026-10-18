/**
 * Per-session scratch roots.
 *
 * `os.tmpdir()` is the wrong answer on a sandboxed deployment, and it is wrong
 * in a way that only surfaces when the model tries to use it: it is evaluated in
 * the **host** process and names the real platform temp area, while DSH's
 * Windows ACL sandbox gives each shell its own private temp directory (it
 * creates `mkdtempSync(join(temp, "dsh-"))` and overrides `TMP`/`TEMP` for the
 * child). A scratch root under the host temp is writable by this plugin's Node
 * code and **denied** to the model's shell.
 *
 * The private directory is only discoverable by asking a shell — and the answer
 * can differ per session, because the sandbox policy is resolved per session.
 * So the probe is keyed by session id and cached, and it is kicked off as soon
 * as any tool execution reveals a session, which in practice is one tool call
 * before the model first reads `$DSH_SCRATCH`.
 *
 * Until a session's probe lands, that session gets the configured root. Nothing
 * ever blocks on the probe: a scratch root is an optimisation, and a tool call
 * must not wait on a shell round-trip to discover where to put a file.
 *
 * @module dsh-scratch-vault/shellroots
 */

import { basename } from 'node:path'
import { isUsableDirectory, scratchRootFrom, tempEchoCommand } from './shellscratch.js'

/**
 * @param {{ get?: (name: string) => any }} ctx
 * @param {{ scratchRoot: string }} config
 * @param {{ platform?: NodeJS.Platform, timeoutMs?: number, log?: (message: string) => void }} [options]
 */
export function createShellRoots(ctx, config, options = {}) {
  const fallback = config.scratchRoot
  const leaf = basename(fallback) || 'dsh-scratch'
  const platform = options.platform ?? process.platform
  const timeoutMs = options.timeoutMs ?? 15_000

  /** sessionId -> discovered root */
  const roots = new Map()
  /** sessionId -> in-flight probe, so a burst of tool calls probes once */
  const inFlight = new Map()

  const note = (message) => {
    try {
      options.log?.(message)
    } catch {
      /* logging must never break a tool call */
    }
  }

  const service = (name) => {
    try {
      return typeof ctx?.get === 'function' ? ctx.get(name) : undefined
    } catch {
      return undefined
    }
  }

  async function probe(sessionId, session) {
    const shell = service('shell')
    if (!shell || typeof shell.resolve !== 'function' || typeof shell.execute !== 'function') {
      note(`${sessionId}: no shell service — keeping ${fallback}`)
      return fallback
    }

    let sandboxPolicy
    try {
      sandboxPolicy = service('sandboxPolicy')?.resolve?.(session === undefined ? {} : { session })
    } catch {
      sandboxPolicy = undefined
    }

    let stdout
    try {
      const handle = await shell.execute(
        shell.resolve({
          command: tempEchoCommand(platform),
          timeoutMs,
          ...(sandboxPolicy === undefined ? {} : { sandboxPolicy }),
        }),
      )
      const result = await handle.result()
      stdout = result?.stdout?.text
    } catch (error) {
      note(`${sessionId}: probe failed (${error instanceof Error ? error.message : String(error)}) — keeping ${fallback}`)
      return fallback
    }

    const candidate = scratchRootFrom(stdout, leaf)
    if (candidate === undefined) {
      note(`${sessionId}: probe returned no usable path (${JSON.stringify(stdout ?? '')}) — keeping ${fallback}`)
      return fallback
    }

    if (candidate === fallback) {
      note(`${sessionId}: shell reports the same temp as the host (${candidate})`)
      roots.set(sessionId, candidate)
      return candidate
    }

    if (!isUsableDirectory(candidate)) {
      note(`${sessionId}: ${candidate} is not creatable — keeping ${fallback}`)
      return fallback
    }

    roots.set(sessionId, candidate)
    note(`${sessionId}: shell scratch root = ${candidate}`)
    return candidate
  }

  /**
   * The scratch root for one session, never blocking.
   * @param {string} sessionId
   * @param {unknown} [session] the harness Session object, when one is reachable
   */
  function resolveSync(sessionId, session) {
    const id = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : 'unknown'
    const cached = roots.get(id)
    if (cached !== undefined) return cached

    if (!inFlight.has(id)) {
      const run = probe(id, session).catch(() => fallback)
      inFlight.set(id, run)
      void run.finally(() => inFlight.delete(id))
    }
    return fallback
  }

  /** Await a session's probe. Exposed for tests and diagnostics. */
  function settled(sessionId) {
    return inFlight.get(sessionId) ?? Promise.resolve(roots.get(sessionId) ?? fallback)
  }

  return { resolveSync, settled, roots, probe, fallback }
}
