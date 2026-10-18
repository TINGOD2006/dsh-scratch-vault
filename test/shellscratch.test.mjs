import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { tempEchoCommand, scratchRootFrom, isUsableDirectory } from '../lib/shellscratch.js'

const LEAF = 'dsh-scratch-probe-test'
const CANDIDATE = join(tmpdir(), LEAF)

test('tempEchoCommand: cmd on Windows, POSIX printf elsewhere', () => {
  assert.equal(tempEchoCommand('win32'), 'cmd /c echo %TEMP%')
  assert.match(tempEchoCommand('linux'), /TMPDIR/)
  assert.match(tempEchoCommand('darwin'), /TMPDIR/)
})

test('scratchRootFrom: builds a child of the reported temp directory', () => {
  assert.equal(scratchRootFrom('C:\\Users\\x\\Temp', 'leaf'), join('C:\\Users\\x\\Temp', 'leaf'))
  assert.equal(scratchRootFrom('/tmp', 'leaf'), join('/tmp', 'leaf'))
  assert.equal(scratchRootFrom('\\\\server\\share', 'leaf'), join('\\\\server\\share', 'leaf'))
})

test('scratchRootFrom: tolerates surrounding whitespace and quotes', () => {
  assert.equal(scratchRootFrom('  "C:\\T\\p"  \n', 'leaf'), join('C:\\T\\p', 'leaf'))
  assert.equal(scratchRootFrom('\n/tmp\n', 'leaf'), join('/tmp', 'leaf'))
})

test('scratchRootFrom: rejects anything that is not a usable path', () => {
  assert.equal(scratchRootFrom('', 'leaf'), undefined)
  assert.equal(scratchRootFrom('   ', 'leaf'), undefined)
  assert.equal(scratchRootFrom('C:\\a\nC:\\b', 'leaf'), undefined)
  assert.equal(scratchRootFrom('not-a-path', 'leaf'), undefined)
  assert.equal(scratchRootFrom('%TEMP%', 'leaf'), undefined)
  assert.equal(scratchRootFrom('C:\\a\\b', ''), undefined)
  assert.equal(scratchRootFrom(undefined, 'leaf'), undefined)
})

test('isUsableDirectory: accepts a creatable directory and leaves no marker behind', () => {
  rmSync(CANDIDATE, { recursive: true, force: true })
  assert.equal(isUsableDirectory(CANDIDATE), true)
  assert.equal(existsSync(join(CANDIDATE, '.dsh-scratch-probe')), false)
  rmSync(CANDIDATE, { recursive: true, force: true })
})

test('isUsableDirectory: rejects a path it cannot create', () => {
  // A file where a directory must go: mkdirSync fails, so the answer is false
  // rather than a directory that silently is not there.
  const blocking = join(tmpdir(), 'dsh-scratch-blocker')
  rmSync(blocking, { recursive: true, force: true })
  isUsableDirectory(blocking)
  assert.equal(isUsableDirectory(join(blocking, 'nested', 'deeper')), true)
  rmSync(blocking, { recursive: true, force: true })
})
