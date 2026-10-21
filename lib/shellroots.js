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
 * Until a session's probe lands, that session gets the configured root. A tool call
 * never waits on the probe for longer than the caller's own warm-up deadline: a
 * scratch root is an optimisation, and dispatch must not hang on a shell
 * round-trip. A probe that fails is cached too (for `negativeTtlMs`), because
 * otherwise every tool call in that session would spawn another shell.
 *
 * @module dsh-scratch-vault/shellroots
 */

import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { isUsableDirectory, scratchRootFrom, tempEchoCommand } from './shellscratch.js'
import { isInside } from './paths.js'
import { sessionWorkspaceRoot } from './prompt.js'

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
  /**
   * How long a failed probe keeps the fallback cached. Without this, a session
   * whose probe fails fails it again on EVERY tool execution — a synchronous
   * shell spawn on the dispatch path, which is worse than the problem it probes.
   */
  const negativeTtlMs = options.negativeTtlMs ?? 60_000

  /** sessionId -> discovered root */
  const roots = new Map()
  /** sessionId -> in-flight probe, so a burst of tool calls probes once */
  const inFlight = new Map()
  /** sessionId -> when its probe failed, so the failure can expire */
  const failedAt = new Map()
  /** sessionIds already warned about a root inside the workspace */
  const warned = new Set()

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

  /** A root inside the workspace would void the plugin's central guarantee. */
  function contained(sessionId, workspaceRoot, root) {
    if (workspaceRoot === undefined || typeof root !== 'string' || root.length === 0) return root
    if (!isInside(workspaceRoot, root)) return root
    const safe = join(tmpdir(), leaf)
    if (!warned.has(sessionId)) {
      warned.add(sessionId)
      note(
        `${sessionId}: ${root} is inside the workspace (${workspaceRoot}) — using ${safe} instead, ` +
          'because scratch work inside a workspace is exactly what this plugin prevents',
      )
    }
    return safe
  }

  /** Cache the fallback so a failed probe is not re-run on every tool call. */
  function keepFallback(sessionId, root) {
    roots.set(sessionId, root)
    failedAt.set(sessionId, Date.now())
    return root
  }

  async function probe(sessionId, session) {
    const workspaceRoot = sessionWorkspaceRoot(session)
    const base = contained(sessionId, workspaceRoot, fallback)
    const shell = service('shell')
    if (!shell || typeof shell.resolve !== 'function' || typeof shell.execute !== 'function') {
      note(`${sessionId}: no shell service — keeping ${base}`)
      return keepFallback(sessionId, base)
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
      note(`${sessionId}: probe failed (${error instanceof Error ? error.message : String(error)}) — keeping ${base}`)
      return keepFallback(sessionId, base)
    }

    const candidate = scratchRootFrom(stdout, leaf)
    if (candidate === undefined) {
      note(`${sessionId}: probe returned no usable path (${JSON.stringify(stdout ?? '')}) — keeping ${base}`)
      return keepFallback(sessionId, base)
    }

    const root = contained(sessionId, workspaceRoot, candidate)
    if (root === base) {
      note(`${sessionId}: shell reports the same temp as the host (${root})`)
      roots.set(sessionId, root)
      failedAt.delete(sessionId)
      return root
    }

    if (!isUsableDirectory(root)) {
      note(`${sessionId}: ${root} is not creatable — keeping ${base}`)
      return keepFallback(sessionId, base)
    }

    roots.set(sessionId, root)
    failedAt.delete(sessionId)
    note(`${sessionId}: shell scratch root = ${root}`)
    return root
  }

  /**
   * The scratch root for one session, never blocking.
   * @param {string} sessionId
   * @param {unknown} [session] the harness Session object, when one is reachable
   */
  function resolveSync(sessionId, session) {
    const id = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : 'unknown'
    const base = contained(id, sessionWorkspaceRoot(session), fallback)
    const cached = roots.get(id)
    if (cached !== undefined) {
      const at = failedAt.get(id)
      // A cached SUCCESS is final; a cached FAILURE expires, so a transient shell
      // outage does not pin the session to the host temp for its whole lifetime.
      if (at === undefined || Date.now() - at < negativeTtlMs) return cached
      roots.delete(id)
      failedAt.delete(id)
    }

    if (!inFlight.has(id)) {
      const run = probe(id, session).catch(() => base)
      inFlight.set(id, run)
      void run.finally(() => inFlight.delete(id))
    }
    return base
  }

  /** Await a session's probe. Exposed for tests and diagnostics. */
  function settled(sessionId) {
    return inFlight.get(sessionId) ?? Promise.resolve(roots.get(sessionId) ?? fallback)
  }

  return { resolveSync, settled, roots, probe, fallback }
}
