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

test('a path outside the workspace falls back to its base name', () => {
  const mapped = scratchPathFor({
    scratchRoot: SCRATCH,
    sessionId: 'sess-1',
    workspaceRoot: ROOT,
    originalPath: resolve('C:', 'other', '_probe.py'),
  })
  assert.equal(mapped, join(sessionScratchDir(SCRATCH, 'sess-1'), 'workspace', '_probe.py'))
})
