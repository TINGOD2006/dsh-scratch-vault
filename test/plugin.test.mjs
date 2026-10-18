/**
 * Integration test: load the plugin the way the loader does, and mount it.
 *
 * `lib/` has no host imports at all, so `import('../lib/index.js')` inside a
 * plain `node` process is exactly the module graph the host would build. That
 * makes this file the regression net for the failure mode that actually bit:
 * a plugin that is syntactically fine and passes every unit test but cannot be
 * imported, which the host reports only as `failed to import`.
 *
 * `apply()` reads `DSH_HOME` through `resolveConfig`, so every test points it at
 * a throwaway directory — otherwise the mount would write the real vault.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as plugin from '../lib/index.js'

const TOOL_NAMES = [
  'run_script',
  'scratch_import',
  'scratch_list',
  'scratch_promote',
  'scratch_purge',
  'scratch_show',
  'scratch_status',
]

function withTempHome(run) {
  const home = mkdtempSync(join(tmpdir(), 'sv-plugin-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    return run(home)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
}

function stubContext() {
  const handlers = new Map()
  const sections = []
  const contributors = []
  const tools = new Map()
  const services = {
    systemPrompt: {
      section(section) {
        sections.push(section)
        return () => {}
      },
    },
    shellEnv: {
      register(contributor) {
        contributors.push(contributor)
        return () => {}
      },
    },
    shell: {
      resolve: (request) => request,
      execute: async () => ({
        result: async () => ({
          exitCode: 0,
          timedOut: false,
          aborted: false,
          stdout: { text: tmpdir(), truncated: false },
          stderr: { text: '', truncated: false },
          sandbox: { mode: 'workspace-write', denied: false, enforcement: 'partial' },
        }),
      }),
    },
    sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: process.cwd() }) },
  }
  const ctx = {
    get: (name) => services[name],
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, [])
      handlers.get(event).push(handler)
      return () => {}
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    logger: {},
  }
  return { ctx, handlers, sections, contributors, tools }
}

test('the module exposes the loader-facing surface', () => {
  assert.equal(plugin.name, 'scratch-vault')
  assert.deepEqual(plugin.inject, ['tools'])
  assert.equal(typeof plugin.apply, 'function')
  // Re-exports kept for tests and for anyone building on the plugin.
  assert.equal(typeof plugin.resolveConfig, 'function')
  assert.equal(typeof plugin.ScratchVault, 'function')
  assert.equal(typeof plugin.classifyWrite, 'function')
  assert.equal(typeof plugin.createShellRoots, 'function')
})

test('apply() mounts every layer and reports what it installed', () => {
  withTempHome((home) => {
    const h = stubContext()
    const installed = plugin.apply(h.ctx)

    assert.deepEqual([...h.tools.keys()].sort(), [...TOOL_NAMES].sort())
    assert.deepEqual([...installed.tools].sort(), [...TOOL_NAMES].sort())

    assert.equal(h.sections.length, 1)
    const text = typeof h.sections[0].text === 'function' ? h.sections[0].text({}) : h.sections[0].text
    assert.match(text, /run_script/)
    assert.match(text, /DSH_SCRATCH/)
    assert.equal(h.contributors.length, 1)
    assert.equal(h.contributors[0].name, 'scratch-vault')
    assert.deepEqual(Object.keys(h.contributors[0].variables).sort(), ['DSH_SCRATCH', 'DSH_VAULT'])

    assert.equal(installed.interception, true)
    // Two handlers on tools/execute: the warm-up hook and the interceptor.
    assert.equal(h.handlers.get('tools/execute').length, 2)
    assert.equal(h.handlers.get('tools/pre-execute').length, 1)
    assert.equal(h.handlers.get('tools/post-execute').length, 1)

    // The mount is observable on disk: the vault exists and the build is named.
    // Asserted against the exported constant so bumping the tag cannot silently
    // leave this test pinning a build that no longer exists.
    assert.ok(existsSync(join(home, 'scratch-vault', 'index.jsonl')), 'the vault ledger should exist')
    const trace = readFileSync(join(home, 'scratch-vault', 'shell-roots.log'), 'utf8')
    assert.match(trace, new RegExp(`apply build=${plugin.BUILD_TAG}`))
  })
})

test('the shell-env contributor resolves synchronously, before any probe lands', () => {
  withTempHome((home) => {
    const h = stubContext()
    plugin.apply(h.ctx)

    const value = h.contributors[0].resolve({ agent: { id: 'sess-env' } })

    assert.equal(typeof value.DSH_SCRATCH, 'string')
    assert.ok(value.DSH_SCRATCH.length > 0)
    assert.equal(value.DSH_VAULT, join(home, 'scratch-vault'))
    assert.match(value.DSH_SCRATCH, /sess-env/)
  })
})

test('apply() survives a composition that mounts nothing but the tool registry', () => {
  withTempHome(() => {
    const bare = {
      tools: { register: () => () => {} },
      on: () => () => {},
      get: () => undefined,
    }
    // Every optional service is reached through ctx.get() and must degrade,
    // never throw: a hygiene plugin that refuses to load helps nobody.
    const installed = plugin.apply(bare)

    assert.deepEqual([...installed.tools].sort(), [...TOOL_NAMES].sort())
    assert.ok(Array.isArray(installed.prompt))
    assert.equal(installed.interception, true)
  })
})
