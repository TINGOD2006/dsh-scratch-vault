/**
 * Tool-surface tests.
 *
 * `registerTools` only ever touches `ctx.tools.register`, `ctx.get` and the
 * vault, so a two-method stub context is a faithful harness — no Cordis runtime
 * needed. The vault is the real implementation, pointed at a throwaway home.
 *
 * The point of these tests is the safety contract of `scratch_import`: it must
 * never delete a workspace file it did not first collect and verify.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig } from '../lib/config.js'
import { ScratchVault } from '../lib/vault.js'
import { registerTools } from '../lib/tools.js'

function harness({ projectManifest = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sv-tools-'))
  const home = join(root, 'home')
  const workspace = join(root, 'ws')
  mkdirSync(workspace, { recursive: true })
  if (projectManifest) writeFileSync(join(workspace, 'package.json'), '{}\n', 'utf8')

  const config = resolveConfig({ dshHome: home, env: {}, cwd: workspace })
  const vault = new ScratchVault({
    dir: config.vaultDir,
    maxEntries: config.maxVaultEntries,
    maxEntryBytes: config.maxEntryBytes,
    retainDays: config.retainDays,
  })

  const definitions = new Map()
  const ctx = {
    tools: {
      register(definition) {
        definitions.set(definition.name, definition)
        return () => definitions.delete(definition.name)
      },
    },
    get: () => undefined,
  }
  registerTools(ctx, { config, vault })

  const exec = { agent: { id: 'sess-tools-test', session: { cwd: workspace } } }
  const call = (name, args) => definitions.get(name).execute(args, exec)

  return {
    root,
    home,
    workspace,
    config,
    vault,
    definitions,
    call,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

test('registerTools exposes the full tool surface', () => {
  const h = harness()
  try {
    assert.deepEqual(
      [...h.definitions.keys()].sort(),
      ['run_script', 'scratch_import', 'scratch_list', 'scratch_promote', 'scratch_purge', 'scratch_show', 'scratch_status'],
    )
  } finally {
    h.cleanup()
  }
})

test('every registered tool has the shape the registry requires', () => {
  const h = harness()
  try {
    for (const [name, definition] of h.definitions) {
      assert.equal(definition.name, name)
      assert.equal(typeof definition.description, 'string')
      assert.ok(definition.description.length > 20, `${name} needs a real description`)
      assert.equal(typeof definition.execute, 'function')
      assert.equal(typeof definition.output.render, 'function')
      assert.equal(definition.output.schema.type, 'object')
      assert.equal(definition.parameters.type, 'object')
      assert.ok(definition.parameters.properties, `${name} needs parameters`)
    }
  } finally {
    h.cleanup()
  }
})

/**
 * A harness whose `ctx.get` answers with a fake shell, so `run_script`'s request
 * can be inspected without spawning anything.
 */
function shellHarness({ shellEnv } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sv-shell-'))
  const home = join(root, 'home')
  const workspace = join(root, 'ws')
  mkdirSync(workspace, { recursive: true })

  // Keep the scratch root inside the throwaway tree: the default is the real
  // platform temp, and a test must not scatter files there.
  const config = { ...resolveConfig({ dshHome: home, env: {}, cwd: workspace }), scratchRoot: join(root, 'scratch') }
  const vault = new ScratchVault({
    dir: config.vaultDir,
    maxEntries: config.maxVaultEntries,
    maxEntryBytes: config.maxEntryBytes,
    retainDays: config.retainDays,
  })

  const definitions = new Map()
  /** Every request handed to `shell.resolve`. */
  const requests = []
  const services = {
    shell: {
      resolve: (request) => {
        requests.push(request)
        return request
      },
      execute: async () => ({ result: async () => ({ exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }) }),
    },
    ...(shellEnv === undefined ? {} : { shellEnv }),
  }
  const ctx = {
    tools: {
      register(definition) {
        definitions.set(definition.name, definition)
        return () => definitions.delete(definition.name)
      },
    },
    get: (name) => services[name],
  }
  registerTools(ctx, { config, vault })

  const exec = { agent: { id: 'sess-shell', session: { header: { cwd: workspace }, id: 'sess-shell' } } }

  return {
    root,
    workspace,
    requests,
    run: (args) => definitions.get('run_script').execute(args, exec),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

// Regression for a silent environment hole: the harness injects `$DSH_SCRATCH`
// into a shell tool call via `ctx.shellEnv.collect(exec)`, but `run_script`
// bypasses the shell tool and calls `ctx.shell.execute` itself. Without its own
// collect() the variable is simply absent, so a program launched through the
// plugin's own flagship tool could not see the scratch root it documents — it
// printed `undefined` and died on the first `join(undefined, ...)`.
test('run_script passes the collected dshEnv to the shell it starts', async () => {
  const h = shellHarness({
    shellEnv: { collect: () => ({ DSH_SCRATCH: 'C:\\scratch\\sess-shell', DSH_VAULT: 'C:\\vault' }) },
  })
  try {
    await h.run({ language: 'node', code: 'console.log(1)\n', description: 'probe' })

    assert.equal(h.requests.length, 1)
    assert.deepEqual(h.requests[0].dshEnv, {
      DSH_SCRATCH: 'C:\\scratch\\sess-shell',
      DSH_VAULT: 'C:\\vault',
    })
  } finally {
    h.cleanup()
  }
})

test('run_script still runs when the shellEnv service is absent', async () => {
  const h = shellHarness()
  try {
    const result = await h.run({ language: 'node', code: 'console.log(1)\n', description: 'probe' })
    assert.equal(result.exitCode, 0)
    assert.equal(h.requests.length, 1)
    assert.equal(h.requests[0].dshEnv, undefined, 'a missing shellEnv must not be invented')
  } finally {
    h.cleanup()
  }
})

test('scratch_import requires a non-empty paths array', () => {
  const h = harness()
  try {
    // The guard throws synchronously, like every other tool-argument guard here.
    assert.throws(() => h.call('scratch_import', {}), /paths/)
    assert.throws(() => h.call('scratch_import', { paths: [] }), /paths/)
  } finally {
    h.cleanup()
  }
})

test('dryRun reports without writing to the vault or deleting anything', async () => {
  const h = harness()
  try {
    const file = join(h.workspace, '_probe.py')
    writeFileSync(file, 'print("hi")\n', 'utf8')

    const result = await h.call('scratch_import', { paths: ['_probe.py'], dryRun: true })

    assert.equal(result.dryRun, true)
    assert.equal(result.summary['would-import'], 1)
    assert.equal(result.results[0].wouldRemoveOriginal, true)
    assert.equal(result.results[0].classifierAction, 'vault')
    assert.equal(result.results[0].rule, 'scratch-name')
    assert.ok(existsSync(file), 'dry run must not delete the original')
    assert.deepEqual(h.vault.all(), [], 'dry run must not write the ledger')
    assert.equal(existsSync(h.vault.entriesDir), false, 'dry run must not create the entries dir')
  } finally {
    h.cleanup()
  }
})

test('import collects the script, verifies it, then removes the workspace copy', async () => {
  const h = harness()
  try {
    const source = 'import sys\nprint(sys.argv)\n'
    const file = join(h.workspace, '_probe.py')
    writeFileSync(file, source, 'utf8')

    const result = await h.call('scratch_import', { paths: ['_probe.py'] })

    assert.equal(result.summary.imported, 1)
    const [entry] = result.results
    assert.equal(entry.originalRemoved, true)
    assert.equal(entry.classifierAction, 'vault')
    assert.equal(existsSync(file), false, 'the original must be gone')

    const entries = h.vault.all()
    assert.equal(entries.length, 1)
    assert.equal(entries[0].id, entry.id)
    assert.equal(entries[0].source, 'scratch_import')
    assert.equal(entries[0].rule, 'legacy-import')
    assert.equal(readFileSync(join(h.vault.entriesDir, entry.id, 'script'), 'utf8'), source)
  } finally {
    h.cleanup()
  }
})

test('keepOriginal collects the script and leaves the workspace copy alone', async () => {
  const h = harness()
  try {
    const file = join(h.workspace, '_probe.py')
    writeFileSync(file, 'x = 1\n', 'utf8')

    const result = await h.call('scratch_import', { paths: ['_probe.py'], keepOriginal: true })

    assert.equal(result.summary.imported, 1)
    assert.equal(result.results[0].originalRemoved, false)
    assert.ok(existsSync(file))
    assert.equal(h.vault.all().length, 1)
  } finally {
    h.cleanup()
  }
})

test('a non-UTF-8 file is refused instead of mangled and then deleted', async () => {
  const h = harness()
  try {
    // `readFileSync(path, 'utf8')` turns these bytes into U+FFFD, and comparing the
    // vault copy against the SAME lossy decode always passes — so the old flow
    // deleted the only intact copy and kept mangled text.
    const bytes = Buffer.from([0x61, 0xb8, 0xe9, 0xff, 0x62])
    const file = join(h.workspace, '_probe.py')
    writeFileSync(file, bytes)

    const result = await h.call('scratch_import', { paths: ['_probe.py'] })

    assert.equal(result.results[0].status, 'not-utf8')
    assert.ok(existsSync(file), 'the original must survive')
    assert.ok(readFileSync(file).equals(bytes), 'the original must be byte-identical')
    assert.deepEqual(h.vault.all(), [])
  } finally {
    h.cleanup()
  }
})

test('a protected source file is never collected or deleted', async () => {
  const h = harness({ projectManifest: true })
  try {
    mkdirSync(join(h.workspace, 'src'), { recursive: true })
    const file = join(h.workspace, 'src', '_probe.py')
    writeFileSync(file, 'y = 3\n', 'utf8')

    const result = await h.call('scratch_import', { paths: ['src/_probe.py'] })

    assert.equal(result.summary.refused, 1)
    assert.equal(result.results[0].rule, 'protected-dir')
    assert.ok(existsSync(file))
    assert.deepEqual(h.vault.all(), [])
  } finally {
    h.cleanup()
  }
})

test('paths outside the workspace are refused', async () => {
  const h = harness()
  try {
    const outside = join(h.root, 'stray.py')
    writeFileSync(outside, 'y = 2\n', 'utf8')

    const result = await h.call('scratch_import', { paths: ['../stray.py', outside] })

    assert.equal(result.summary.refused, 2)
    assert.ok(existsSync(outside), 'a refused path must never be deleted')
    assert.deepEqual(h.vault.all(), [])
  } finally {
    h.cleanup()
  }
})

test('a missing path is reported, not thrown', async () => {
  const h = harness()
  try {
    const result = await h.call('scratch_import', { paths: ['nope.py'] })
    assert.equal(result.summary.missing, 1)
    assert.match(result.results[0].detail, /no such file/)
  } finally {
    h.cleanup()
  }
})

test('a directory is refused', async () => {
  const h = harness()
  try {
    mkdirSync(join(h.workspace, '_scratch'))
    const result = await h.call('scratch_import', { paths: ['_scratch'] })
    assert.equal(result.summary.refused, 1)
    assert.match(result.results[0].detail, /not a regular file/)
  } finally {
    h.cleanup()
  }
})

test('the classifier verdict follows the workspace shape', async () => {
  const plain = harness()
  const project = harness({ projectManifest: true })
  try {
    // `helper.py` matches no name heuristic, so it is the bare-root-script rule
    // (or nothing) that decides — which is exactly what the manifest probe gates.
    for (const h of [plain, project]) writeFileSync(join(h.workspace, 'helper.py'), 'z = 3\n', 'utf8')

    const bare = await plain.call('scratch_import', { paths: ['helper.py'], dryRun: true })
    assert.equal(bare.results[0].classifierAction, 'vault')
    assert.equal(bare.results[0].rule, 'bare-root-script')

    // With a manifest present the same file is no longer "a bare script at the
    // root of a workspace that has no project manifest", so the classifier
    // declines to touch it — but an explicit request still imports it.
    const inProject = await project.call('scratch_import', { paths: ['helper.py'], dryRun: true })
    assert.equal(inProject.results[0].classifierAction, 'keep')
    assert.equal(inProject.results[0].rule, 'no-rule')

    const forced = await project.call('scratch_import', { paths: ['helper.py'] })
    assert.equal(forced.summary.imported, 1)
    assert.equal(forced.results[0].classifierAction, 'keep')
    assert.equal(existsSync(join(project.workspace, 'helper.py')), false)
  } finally {
    plain.cleanup()
    project.cleanup()
  }
})

test('an oversized file is refused rather than silently truncated', async () => {
  const h = harness()
  try {
    const file = join(h.workspace, '_huge.py')
    writeFileSync(file, 'x'.repeat(h.config.maxEntryBytes + 1), 'utf8')

    const result = await h.call('scratch_import', { paths: ['_huge.py'] })

    assert.equal(result.summary['too-large'], 1)
    assert.ok(existsSync(file))
    assert.deepEqual(h.vault.all(), [])
  } finally {
    h.cleanup()
  }
})

test('relative paths resolve against the session workspace', async () => {
  const h = harness()
  try {
    mkdirSync(join(h.workspace, 'sub'), { recursive: true })
    writeFileSync(join(h.workspace, 'sub', '_inner.py'), 'q = 4\n', 'utf8')

    const result = await h.call('scratch_import', { paths: ['sub/_inner.py'] })

    assert.equal(result.summary.imported, 1)
    assert.equal(result.results[0].relativePath, 'sub/_inner.py')
    assert.equal(existsSync(join(h.workspace, 'sub', '_inner.py')), false)
  } finally {
    h.cleanup()
  }
})

test('scratch_status reports the configured roots', async () => {
  const h = harness()
  try {
    const status = await h.call('scratch_status', {})
    assert.equal(status.vaultDir, h.config.vaultDir)
    assert.equal(status.scratchRoot, h.config.scratchRoot)
    assert.equal(status.interceptMode, 'redirect')
    assert.equal(typeof status.stats.count, 'number')
  } finally {
    h.cleanup()
  }
})

// The `targetPath` description promises a destination inside the workspace, so
// the tool has to enforce it: `vault.promote` writes wherever the host process
// can, which is anywhere.
test('scratch_promote refuses a destination outside the workspace', () => {
  const h = harness()
  try {
    const entry = h.vault.record({
      sessionId: 'sess-tools-test',
      originalPath: '_probe.py',
      content: 'print(1)\n',
      rule: 'scratch-name',
      source: 'intercept',
    })
    assert.equal(entry.stored, true)

    const escape = join(h.root, 'escaped.py')
    assert.throws(
      () => h.call('scratch_promote', { id: entry.id, targetPath: escape }),
      /must be inside the session workspace/,
    )
    assert.equal(existsSync(escape), false, 'nothing may be written outside the workspace')

    const inside = join(h.workspace, 'kept.py')
    const result = h.call('scratch_promote', { id: entry.id, targetPath: inside })
    assert.equal(result.promoted, true)
    assert.equal(result.relativePath, 'kept.py')
    assert.equal(readFileSync(inside, 'utf8'), 'print(1)\n')
  } finally {
    h.cleanup()
  }
})
