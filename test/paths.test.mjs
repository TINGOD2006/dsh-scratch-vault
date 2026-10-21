import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'

import { globToRegExp, matchAnyGlob } from '../lib/glob.js'
import {
  isInside,
  relativeInside,
  sanitizeSegment,
  scratchPathFor,
  sessionScratchDir,
} from '../lib/paths.js'

const ROOT = resolve('C:', 'work', 'demo')
const SCRATCH = resolve('C:', 'tmp', 'dsh-scratch')

test('glob: * does not cross a separator, ** does', () => {
  assert.equal(globToRegExp('*.py').test('a.py'), true)
  assert.equal(globToRegExp('*.py').test('sub/a.py'), false)
  assert.equal(globToRegExp('**/*.py').test('sub/deep/a.py'), true)
  assert.equal(globToRegExp('src/**').test('src/a/b.py'), true)
})

test('glob: matchAnyGlob reports the pattern that fired', () => {
  assert.equal(matchAnyGlob('a/b.py', ['nope', 'a/**']), 'a/**')
  assert.equal(matchAnyGlob('a/b.py', []), undefined)
  assert.equal(matchAnyGlob('a/b.py', ['[bad']), undefined, 'a broken pattern must not throw')
})

test('glob: a pathological multi-** pattern stays linear', () => {
  // `(?:[^/]*/)*` nested ten times backtracks exponentially: this exact input
  // took 55 s before the matcher became a segment DP. It runs on the tool-dispatch
  // event loop, so the whole session stalled.
  const pattern = '**/**/**/**/**/**/**/**/**/**/x'
  const subject = Array.from({ length: 40 }, (_, i) => `s${i}`).join('/')
  const started = Date.now()
  const fired = matchAnyGlob(subject, [pattern])
  const elapsed = Date.now() - started
  assert.equal(fired, undefined)
  assert.ok(elapsed < 1000, `matching took ${elapsed}ms`)
})

test('containment uses resolved paths', () => {
  assert.equal(isInside(ROOT, join(ROOT, 'a.py')), true)
  assert.equal(isInside(ROOT, ROOT), true)
  assert.equal(isInside(ROOT, resolve(ROOT, '..', 'other')), false)
  assert.equal(relativeInside(ROOT, join(ROOT, 'sub', 'a.py')), 'sub/a.py')
  assert.equal(relativeInside(ROOT, resolve(ROOT, '..', 'x.py')), undefined)
})

test('segment sanitising removes what a shell or filesystem cannot take', () => {
  assert.equal(sanitizeSegment('a<b>c:d'), 'a_b_c_d')
  assert.equal(sanitizeSegment('..'), '_')
  assert.equal(sanitizeSegment('   '), '_')
  assert.equal(sanitizeSegment('normal_name.py'), 'normal_name.py')
})

test('the scratch mapping preserves in-workspace structure', () => {
  const mapped = scratchPathFor({
    scratchRoot: SCRATCH,
    sessionId: 'sess-1',
    workspaceRoot: ROOT,
    originalPath: join(ROOT, 'sub', 'dir', '_probe.py'),
  })
  assert.equal(mapped, join(sessionScratchDir(SCRATCH, 'sess-1'), 'workspace', 'sub', 'dir', '_probe.py'))
  assert.equal(isInside(SCRATCH, mapped), true, 'the mapping must stay inside the scratch root')
  assert.equal(isInside(ROOT, mapped), false, 'the mapping must stay outside the workspace')
})

test('the scratch mapping is a pure function of the input path', () => {
  const input = {
    scratchRoot: SCRATCH,
    sessionId: 'sess-1',
    workspaceRoot: ROOT,
    originalPath: join(ROOT, '_probe.py'),
  }
  assert.equal(scratchPathFor(input), scratchPathFor({ ...input }))
})

test('distinct source names never collide after sanitising', () => {
  // `a:b.py` and `a*b.py` both sanitise to `a_b.py`; without a disambiguating
  // suffix the second write silently overwrote the first and the vault archived
  // the wrong body.
  const map = (name) =>
    scratchPathFor({
      scratchRoot: SCRATCH,
      sessionId: 'sess-1',
      workspaceRoot: ROOT,
      originalPath: join(ROOT, name),
    })
  const first = map('a:b.py')
  const second = map('a*b.py')
  assert.notEqual(first, second)
  assert.equal(map('a:b.py'), first, 'the mapping stays pure')
})

test('a path outside the workspace falls back to its base name', () => {
  const mapped = scratchPathFor({
    scratchRoot: SCRATCH,
    sessionId: 'sess-1',
    workspaceRoot: ROOT,
    originalPath: resolve('C:', 'other', '_probe.py'),
  })
  assert.equal(mapped, join(sessionScratchDir(SCRATCH, 'sess-1'), 'workspace', '_probe.py'))
})
