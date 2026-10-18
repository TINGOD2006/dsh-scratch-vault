/**
 * dsh-scratch-vault — Codex-style scratch execution for DeepSeek Harness.
 *
 * The workspace is for deliverables. Operation scripts — the throwaway probes,
 * converters and diagnostics an agent writes only to run once — belong outside
 * it, and this plugin makes that the path of least resistance:
 *
 *   L2  a system-prompt discipline section, a `$DSH_SCRATCH` environment fact
 *       injected into every shell call, and a `run_script` tool that runs a
 *       program from a scratch file without touching the workspace at all;
 *   L3  interception on the `tools/execute` waterfall, which moves a scratch
 *       write's target out of the workspace and tells the model the real path;
 *   L4  a vault that collects every intercepted script, with list/show/promote/
 *       purge tools so nothing is lost silently.
 *
 * The mechanism leans on facts the harness already guarantees: `workspace-write`
 * already treats the platform temp area as writable (`writableRoots` returns the
 * workspace root, `/tmp` and `os.tmpdir()`), and the workspace change summary
 * already excludes temporary roots (`isTemporaryPath`), so a scratch script can
 * never appear as a spurious workspace change.
 *
 * The scratch root is NOT `os.tmpdir()`, though. That value is computed in this
 * process, and the shell sandbox hands each shell its own private temp directory
 * which it does not grant write access to. `shellroots.js` asks the shell where
 * its temp actually is, per session, and caches the answer.
 *
 * Configuration lives in a JSON file rather than a Cordis `Config` schema on
 * purpose — see `config.js` for why.
 *
 * @module dsh-scratch-vault
 */

import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

import { resolveConfig } from './config.js'
import { ScratchVault } from './vault.js'
import { installPrompt, sessionIdOf } from './prompt.js'
import { createShellRoots } from './shellroots.js'
import { installInterception } from './intercept.js'
import { registerTools } from './tools.js'

/** Loader-facing plugin name. */
export const name = 'scratch-vault'

/**
 * Build tag written to `<vaultDir>/shell-roots.log` on every `apply()`.
 *
 * BUMP THIS ON EVERY CHANGE to `lib/`. A `plugin_manager set_bundle` toggle
 * re-runs `apply()` but NOT the module import — the loader caches by file URL, so
 * a toggle re-executes the module instance loaded at boot. This tag is therefore
 * the only way to tell a stale build from a working one, and it is exported so the
 * test that asserts on it cannot drift out of sync with the value written.
 */
export const BUILD_TAG = 'marketready-v6'

/**
 * Hard dependency on the tool registry only: every other service is reached
 * through `ctx.get(...)` and degrades gracefully when a profile does not mount
 * it. Declaring them here would make the plugin refuse to load in a thinner
 * composition, which is the opposite of useful for a hygiene plugin.
 */
export const inject = ['tools']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  const config = resolveConfig({ env: process.env, cwd: process.cwd() })
  const vault = new ScratchVault({
    dir: config.vaultDir,
    maxEntries: config.maxVaultEntries,
    maxEntryBytes: config.maxEntryBytes,
    retainDays: config.retainDays,
  })

  try {
    vault.ensure()
  } catch {
    /* an unwritable vault must not stop the plugin: interception still works */
  }

  // Where a shell can actually write. Recorded in the vault directory so the
  // resolution is inspectable rather than a silent guess.
  const tracePath = join(config.vaultDir, 'shell-roots.log')
  // Unconditional proof-of-life. When a change to this file does not seem to
  // take effect, this line answers the only question that matters: which build
  // did the running host actually load? (See `BUILD_TAG`.)
  try {
    appendFileSync(
      tracePath,
      `${new Date().toISOString()} apply build=${BUILD_TAG} scratch=${config.scratchRoot}\n`,
      'utf8',
    )
  } catch {
    /* diagnostics only — never let tracing break a tool call */
  }
  const shellRoots = createShellRoots(ctx, config, {
    log: (message) => {
      ctx.logger?.debug?.(`scratch-vault: ${message}`)
      try {
        appendFileSync(tracePath, `${new Date().toISOString()} ${message}\n`, 'utf8')
      } catch {
        /* diagnostics only — never let tracing break a tool call */
      }
    },
  })

  // Resolve the per-session scratch root before the first tool call of that
  // session is dispatched. This belongs on `tools/execute` rather than
  // `tools/pre-execute`: that event decides allow/deny/ask and cannot await, so
  // a probe fired there would race the shell that is about to read
  // `$DSH_SCRATCH`. The execute waterfall IS awaited before dispatch, so by the
  // time the shell resolves its environment the answer is already cached.
  try {
    ctx.on('tools/execute', async (exec, next) => {
      try {
        const sessionId = sessionIdOf(exec)
        shellRoots.resolveSync(sessionId, exec?.agent?.session)
        await shellRoots.settled(sessionId)
      } catch {
        /* warm-up is best effort */
      }
      return next()
    })
  } catch {
    /* a composition without the tool pipeline still gets the other layers */
  }

  const scratchRootFor = (sessionId, session) => shellRoots.resolveSync(sessionId, session)
  const installed = {}

  try {
    installed.prompt = installPrompt(ctx, { config, scratchRootFor }).registered
  } catch (error) {
    installed.prompt = [`failed: ${error instanceof Error ? error.message : String(error)}`]
  }

  try {
    installed.tools = registerTools(ctx, { config, vault, scratchRootFor }).registered
  } catch (error) {
    installed.tools = [`failed: ${error instanceof Error ? error.message : String(error)}`]
  }

  try {
    installInterception(ctx, { config, vault, scratchRootFor })
    installed.interception = true
  } catch (error) {
    installed.interception = `failed: ${error instanceof Error ? error.message : String(error)}`
  }

  ctx.logger?.info?.(
    `scratch-vault ready — mode=${config.interceptMode} scratch=${config.scratchRoot} vault=${config.vaultDir}`,
  )

  return installed
}

export { resolveConfig } from './config.js'
export { ScratchVault } from './vault.js'
export { classifyWrite, RULES } from './classify.js'
export { scratchPathFor, sessionScratchDir, isInside, relativeInside } from './paths.js'
export { createShellRoots } from './shellroots.js'
