import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createShellRoots } from '../lib/shellroots.js'

const FALLBACK = join(tmpdir(), 'deep', 'nested', 'dsh-scratch')
const LEAF = 'dsh-scratch'
const EXPECTED = join(tmpdir(), LEAF)

function ctxWith(shell, extra = {}) {
  const services = { shell, ...extra }
  return { get: (name) => services[name] }
}

function shellReturning(text, { throws = false } = {}) {
  return {
    requests: [],
    resolve: (request) => request,
    execute: async function (request) {
      this.requests.push(request)
      if (throws) throw new Error('boom')
      return { result: async () => ({ stdout: { text } }) }
    },
  }
}

test('resolveSync returns the configured root until the probe lands', () => {
  const roots = createShellRoots(ctxWith(shellReturning(tmpdir())), { scratchRoot: FALLBACK })
  const first = roots.resolveSync('s1', { id: 's1' })
  assert.equal(first, FALLBACK, 'must never block a tool call on a shell round-trip')
})

test('the cached root replaces the fallback once the probe settles', async () => {
  const roots = createShellRoots(ctxWith(shellReturning(tmpdir())), { scratchRoot: FALLBACK })
  roots.resolveSync('s1', { id: 's1' })
  assert.equal(await roots.settled('s1'), EXPECTED)
  assert.equal(roots.resolveSync('s1'), EXPECTED)
  assert.equal(roots.roots.get('s1'), EXPECTED)
  rmSync(EXPECTED, { recursive: true, force: true })
})

test('roots are cached per session', async () => {
  const shell = shellReturning(tmpdir())
  const roots = createShellRoots(ctxWith(shell), { scratchRoot: FALLBACK })
  roots.resolveSync('a', { id: 'a' })
  assert.equal(await roots.settled('a'), EXPECTED)
  roots.resolveSync('b', { id: 'b' })
  await roots.settled('b')
  assert.equal(shell.requests.length, 2, 'each session probes once')
  roots.resolveSync('a')
  roots.resolveSync('b')
  assert.equal(shell.requests.length, 2, 'a cached session never re-probes')
  rmSync(EXPECTED, { recursive: true, force: true })
})

test('a burst of calls for one session probes only once', async () => {
  const shell = shellReturning(tmpdir())
  const roots = createShellRoots(ctxWith(shell), { scratchRoot: FALLBACK })
  for (let i = 0; i < 25; i++) roots.resolveSync('one', { id: 'one' })
  await roots.settled('one')
  assert.equal(shell.requests.length, 1)
  rmSync(EXPECTED, { recursive: true, force: true })
})

test('the probe asks the shell for its own temp, through the session sandbox policy', async () => {
  const shell = shellReturning(tmpdir())
  const policies = []
  const roots = createShellRoots(
    ctxWith(shell, { sandboxPolicy: { resolve: (request) => { policies.push(request); return { mode: 'workspace-write' } } } }),
    { scratchRoot: FALLBACK, platform: 'win32' },
  )
  roots.resolveSync('s1', { id: 's1' })
  await roots.settled('s1')
  assert.equal(shell.requests[0].command, 'cmd /c echo %TEMP%')
  assert.deepEqual(policies, [{ session: { id: 's1' } }], 'the policy must be resolved for the session')
  assert.equal(shell.requests[0].sandboxPolicy.mode, 'workspace-write')
  rmSync(EXPECTED, { recursive: true, force: true })
})

test('the configured root survives a shell that reports something unusable', async () => {
  for (const answer of ['', '   ', 'nonsense', '%TEMP%', 'C:\\a\nC:\\b']) {
    const roots = createShellRoots(ctxWith(shellReturning(answer)), { scratchRoot: FALLBACK })
    roots.resolveSync('s1', { id: 's1' })
    assert.equal(await roots.settled('s1'), FALLBACK, `answer ${JSON.stringify(answer)}`)
    assert.equal(roots.resolveSync('s1'), FALLBACK)
  }
})

test('the configured root survives a shell call that throws', async () => {
  const roots = createShellRoots(ctxWith(shellReturning('', { throws: true })), { scratchRoot: FALLBACK })
  roots.resolveSync('s1', { id: 's1' })
  assert.equal(await roots.settled('s1'), FALLBACK)
})

test('a composition without a shell service degrades instead of failing', async () => {
  const roots = createShellRoots({ get: () => undefined }, { scratchRoot: FALLBACK })
  assert.equal(roots.resolveSync('s1', { id: 's1' }), FALLBACK)
  assert.equal(await roots.settled('s1'), FALLBACK)
})

test('an unusable session id is normalised, not dropped', () => {
  const roots = createShellRoots(ctxWith(shellReturning(tmpdir())), { scratchRoot: FALLBACK })
  assert.equal(roots.resolveSync(undefined, undefined), FALLBACK)
  assert.equal(roots.resolveSync('', undefined), FALLBACK)
})

test('the trace records why a non-standard root was chosen', async () => {
  const messages = []
  const roots = createShellRoots(ctxWith(shellReturning(tmpdir())), { scratchRoot: FALLBACK }, {
    log: (m) => messages.push(m),
  })
  roots.resolveSync('s1', { id: 's1' })
  await roots.settled('s1')
  assert.equal(messages.length, 1)
  assert.match(messages[0], /shell scratch root = /)
  rmSync(EXPECTED, { recursive: true, force: true })
})

test('a probe that changes nothing is still recorded', async () => {
  const messages = []
  const roots = createShellRoots(ctxWith(shellReturning(tmpdir())), { scratchRoot: EXPECTED }, {
    log: (m) => messages.push(m),
  })
  roots.resolveSync('s1', { id: 's1' })
  await roots.settled('s1')
  assert.equal(messages.length, 1)
  assert.match(messages[0], /same temp as the host/)
})

test('a logger that throws cannot break resolution', async () => {
  const roots = createShellRoots(ctxWith(shellReturning(tmpdir())), { scratchRoot: FALLBACK }, {
    log: () => {
      throw new Error('logger exploded')
    },
  })
  roots.resolveSync('s1', { id: 's1' })
  assert.equal(await roots.settled('s1'), EXPECTED)
  rmSync(EXPECTED, { recursive: true, force: true })
})

test('isUsableDirectory still holds for the root the probe selects', async () => {
  const roots = createShellRoots(ctxWith(shellReturning(tmpdir())), { scratchRoot: FALLBACK })
  roots.resolveSync('s1', { id: 's1' })
  await roots.settled('s1')
  assert.equal(existsSync(EXPECTED), true, 'the chosen root must exist for run_script to write into')
  rmSync(EXPECTED, { recursive: true, force: true })
})
