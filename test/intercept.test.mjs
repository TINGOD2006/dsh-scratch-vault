import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'

import { decideExecution, rewriteCommand } from '../lib/intercept.js'
import { normalizeConfig } from '../lib/config.js'
import { scratchPathFor } from '../lib/paths.js'
import { workspaceRootOf } from '../lib/prompt.js'

const ROOT = resolve('C:', 'work', 'demo')
const SCRATCH = resolve('C:', 'tmp', 'dsh-scratch')

const config = normalizeConfig({ scratchRoot: SCRATCH })

const context = ({ projectRoot = false, existing = [], mode } = {}) => ({
  config: mode === undefined ? config : normalizeConfig({ scratchRoot: SCRATCH, interceptMode: mode }),
  workspaceRoot: ROOT,
  probeProjectRoot: () => projectRoot,
  exists: (p) => existing.includes(p),
  sessionId: 'sess-1',
})

const exec = (filePath) => ({
  name: 'write',
  callId: 'c1',
  arguments: { file_path: filePath },
  agent: { id: 'sess-1' },
})

test('a scratch write is redirected into the session scratch root', () => {
  const decision = decideExecution(exec('_probe.py'), context())
  assert.equal(decision.action, 'vault')
  assert.equal(decision.rule, 'scratch-name')
  assert.equal(
    decision.scratchPath,
    scratchPathFor({
      scratchRoot: SCRATCH,
      sessionId: 'sess-1',
      workspaceRoot: ROOT,
      originalPath: resolve(ROOT, '_probe.py'),
    }),
  )
})

test('a deliverable write is not touched', () => {
  const decision = decideExecution(exec('report.csv'), context())
  assert.equal(decision.action, 'keep')
  assert.equal(decision.scratchPath, undefined)
})

test('report mode decides but produces no scratch path', () => {
  const decision = decideExecution(exec('_probe.py'), context({ mode: 'report' }))
  assert.equal(decision.action, 'vault')
  assert.equal(decision.scratchPath, undefined, 'report mode must not rewrite anything')
})

test('only write and edit are inspected', () => {
  const readExec = { name: 'read', callId: 'c2', arguments: { file_path: '_probe.py' }, agent: { id: 's' } }
  assert.equal(decideExecution(readExec, context()), undefined)
})

test('a malformed execution is ignored instead of throwing', () => {
  assert.equal(decideExecution(undefined, context()), undefined)
  assert.equal(decideExecution({ name: 'write', arguments: null }, context()), undefined)
  assert.equal(decideExecution({ name: 'write', arguments: { file_path: 42 } }, context()), undefined)
})

test('an existing workspace file keeps running from the workspace', () => {
  const target = resolve(ROOT, '_probe.py')
  const { command, rewrites } = rewriteCommand('python _probe.py', context({ existing: [target] }))
  assert.equal(command, 'python _probe.py')
  assert.equal(rewrites.length, 0)
})

test('a redirected script reference in a command follows the scratch mapping', () => {
  const { command, rewrites } = rewriteCommand('python _probe.py --fast', context())
  assert.equal(rewrites.length, 1)
  const expected = scratchPathFor({
    scratchRoot: SCRATCH,
    sessionId: 'sess-1',
    workspaceRoot: ROOT,
    originalPath: resolve(ROOT, '_probe.py'),
  })
  assert.equal(command, `python ${expected} --fast`)
})

test('source paths inside a protected directory are never rewritten', () => {
  const { command, rewrites } = rewriteCommand('python src/app.py', context({ projectRoot: true }))
  assert.equal(command, 'python src/app.py')
  assert.equal(rewrites.length, 0)
})

test('non-script arguments are left alone', () => {
  const { command } = rewriteCommand('python -X utf8 data.csv', context())
  assert.equal(command, 'python -X utf8 data.csv')
})

// A glob must never be rewritten: the match would be the suffix only
// (`*.test.mjs` matches `.test.mjs`), so rewriting it corrupts the pattern into
// `*<scratch path>` and the command fails with a nonsense path.
test('glob patterns are never rewritten', () => {
  for (const command of [
    'Get-ChildItem "$d\\test\\*.test.mjs"',
    'Get-ChildItem "$d\\lib\\*.js","$d\\test\\*.mjs"',
    'node test/*.test.mjs',
    'python *.py',
    'python file*.py',
    'python _probe?.py',
    'python [ab].py',
  ]) {
    const result = rewriteCommand(command, context())
    assert.equal(result.command, command, `glob was corrupted: ${command}`)
    assert.equal(result.rewrites.length, 0, `glob was rewritten: ${command}`)
  }
})

test('a glob beside a real script reference does not disarm the real reference', () => {
  const { command, rewrites } = rewriteCommand('Remove-Item *.py -WhatIf; python _probe.py', context())
  const expected = scratchPathFor({
    scratchRoot: SCRATCH,
    sessionId: 'sess-1',
    workspaceRoot: ROOT,
    originalPath: resolve(ROOT, '_probe.py'),
  })
  assert.equal(command, `Remove-Item *.py -WhatIf; python ${expected}`)
  assert.equal(rewrites.length, 1)
})

// A shell variable reference must never be rewritten. `$env:DSH_SCRATCH\probe.py`
// matches the token pattern starting at the variable NAME (`$` and `:` are
// ordinary characters to it), so the rewrite produced
// `$env:C:\...\scratch\...\workspace\DSH_SCRATCH\workspace\probe.py` — the shell
// then interpolates a path that contains the literal variable name, and the
// command dies with "can't open file". A plugin whose whole purpose is to make
// scratch scripts runnable must never break the documented way to run them.
test('shell variable references are never rewritten', () => {
  for (const command of [
    'python $env:DSH_SCRATCH\\workspace\\_probe.py',
    'python $env:DSH_SCRATCH/workspace/_probe.py',
    'python "$env:DSH_SCRATCH\\_probe.py"',
    'python $DSH_SCRATCH/_probe.py',
    'python ${DSH_SCRATCH}/_probe.py',
    'python %TEMP%\\_probe.py',
    'python %DSH_SCRATCH%\\_probe.py',
    'Set-Content "$env:DSH_SCRATCH\\out.txt" ok',
  ]) {
    const result = rewriteCommand(command, context())
    assert.equal(result.command, command, `variable reference was corrupted: ${command}`)
    assert.equal(result.rewrites.length, 0, `variable reference was rewritten: ${command}`)
  }
})

// The extension match must not fire on a prefix of a longer name: `x.py.bak`
// matches `.py`, and rewriting yields `<scratch>/x.py.bak` for a file that is not
// a script at all.
test('a longer filename is not treated as a script reference', () => {
  for (const command of ['python report.py.bak', 'python notes.mjs.old', 'node data.js.map']) {
    const result = rewriteCommand(command, context())
    assert.equal(result.command, command, `prefix match corrupted: ${command}`)
    assert.equal(result.rewrites.length, 0, `prefix match rewritten: ${command}`)
  }
})

// The documented workflow — write to `$DSH_SCRATCH`, run it by absolute path —
// must survive the shell rewriter, and a plain relative reference must still be
// redirected.
test('a plain relative reference is still redirected alongside variable forms', () => {
  const { command, rewrites } = rewriteCommand(
    'python $env:DSH_SCRATCH\\_probe.py; python _probe.py',
    context(),
  )
  const expected = scratchPathFor({
    scratchRoot: SCRATCH,
    sessionId: 'sess-1',
    workspaceRoot: ROOT,
    originalPath: resolve(ROOT, '_probe.py'),
  })
  assert.equal(command, `python $env:DSH_SCRATCH\\_probe.py; python ${expected}`)
  assert.equal(rewrites.length, 1, 'only the real workspace reference may be redirected')
})

// The exact command that this plugin corrupted in live use. Three separate
// mistakes, none of which the tests above covered, because all three came from
// ordinary PowerShell that merely *ends* in a script extension:
//
//   $meta.relativePath   → matched `.r`  (the match is `$meta.r`)
//   ...\meta.json        → matched `.js` (the match is `\meta.js`)
//   $v\index.jsonl       → matched `.js` (the match is `$v\index.js`)
//
// Each rewrite injected a scratch path into what is really a property name, a JSON
// data filename, or a JSONL data filename, and the shell died with a parse error.
// A hygiene plugin must never corrupt the command that inspects its own vault.
test('real PowerShell that merely ends in a script extension is left alone', () => {
  const command = [
    '$v = "C:\\vault\\dsh"',
    '"entries: " + (Get-ChildItem "$v\\entries" -Directory | Measure-Object).Count',
    '"ledger: " + (Get-Content "$v\\index.jsonl" | Measure-Object -Line).Lines',
    'Get-ChildItem "$v\\entries" -Directory | ForEach-Object {',
    '  $meta = Get-Content "$v\\entries\\$($_.Name)\\meta.json" -Raw | ConvertFrom-Json',
    '  "{0} {1} {2}B {3}" -f $_.Name, $meta.relativePath, $meta.bytes, $meta.rule',
    '}',
  ].join('\n')

  const result = rewriteCommand(command, context())
  assert.equal(result.command, command, 'data filenames and property names were rewritten')
  assert.equal(result.rewrites.length, 0)
})

// A `cd` earlier in the command rebases every relative token after it. Resolving
// those against the workspace root pointed a working `Get-ChildItem intercept.js`
// at a scratch path that does not exist — the command that was working before the
// plugin existed. These cases change directory OUTSIDE the workspace, so the token
// resolves outside it and is left alone.
test('a directory change outside the workspace leaves relative tokens alone', () => {
  for (const command of [
    "cd 'C:\\other\\project\\lib'\nGet-ChildItem intercept.js,index.js,tools.js",
    'Set-Location C:\\some\\dir\nnode build.js',
    'cd ..\\elsewhere; node _diag.mjs',
  ]) {
    const result = rewriteCommand(command, context())
    assert.equal(result.command, command, `token rebased after cd: ${command}`)
    assert.equal(result.rewrites.length, 0, `token rewritten after cd: ${command}`)
  }
})

// Refusing to rewrite after ANY `cd` was too blunt: `cd <workspace>` then
// `python _probe.py` is the everyday shape, and there the token MUST still be
// redirected — to the scratch path of the file the write produced.
test('a directory change inside the workspace rebases the token onto its real scratch path', () => {
  // `ROOT` is built with `resolve('C:', ...)`, which node treats as "current directory
  // on drive C" — so the literal `C:\work\demo` is NOT the same path. Interpolate ROOT.
  for (const [command, relative] of [
    ['cd sub && python _probe.py', 'sub/_probe.py'],
    ['pushd tools; node _diag.mjs', 'tools/_diag.mjs'],
    [`Set-Location ${ROOT}\\nested\npython _probe.py`, 'nested/_probe.py'],
  ]) {
    const expected = scratchPathFor({
      scratchRoot: SCRATCH,
      sessionId: 'sess-1',
      workspaceRoot: ROOT,
      originalPath: resolve(ROOT, relative),
    })
    const result = rewriteCommand(command, context())
    assert.equal(result.rewrites.length, 1, `token was not redirected: ${command}`)
    assert.ok(
      result.command.includes(expected),
      `expected ${expected} in: ${result.command}`,
    )
  }
})

// A working directory that cannot be known statically (a shell variable, a bare
// `cd` to the home directory, `~`) must not be guessed: the token is left alone.
test('an unresolvable working directory leaves relative tokens alone', () => {
  for (const command of [
    'cd $env:WORK\npython _probe.py',
    'cd %WORK%\npython _probe.py',
    'cd\npython _probe.py',
    'cd ~/proj\npython _probe.py',
  ]) {
    const result = rewriteCommand(command, context())
    assert.equal(result.command, command, `token rebased on an unknown cwd: ${command}`)
    assert.equal(result.rewrites.length, 0, `token rewritten on an unknown cwd: ${command}`)
  }
})

// The same command without the `cd` still gets redirected — the guard must not
// disarm the feature wholesale.
test('an absolute reference is still redirected even when the command changes directory', () => {
  const absolute = resolve(ROOT, '_probe.py')
  const command = `cd C:\\somewhere\npython ${absolute}`
  const { command: out, rewrites } = rewriteCommand(command, context())
  assert.equal(rewrites.length, 1, 'an absolute path stays unambiguous after a cd')
  assert.notEqual(out, command)
})

// A Windows absolute path must be redirected whole. `:` is not in the token
// character class, so without an explicit drive-letter prefix the match started at
// `\dir\_probe.py` and the replacement produced `C:C:\scratch\...\_probe.py` — a
// path that cannot resolve. Every absolute form of the same file has to work.
test('a Windows absolute path is redirected with its drive letter intact', () => {
  const expected = scratchPathFor({
    scratchRoot: SCRATCH,
    sessionId: 'sess-1',
    workspaceRoot: ROOT,
    originalPath: resolve(ROOT, '_probe.py'),
  })
  const forms = [
    `${ROOT}\\_probe.py`,
    `${ROOT}/_probe.py`,
    `${ROOT.replace(/\//g, '\\')}\\_probe.py`,
  ]
  for (const form of forms) {
    const { command, rewrites } = rewriteCommand(`python ${form}`, context())
    assert.equal(rewrites.length, 1, `absolute path was not redirected: ${form}`)
    assert.equal(command, `python ${expected}`, `drive letter was mangled: ${form}`)
    assert.equal(rewrites[0].from, form, 'the whole absolute token must be the match')
  }
})

// --- workspace root resolution
//
// Regression for a silent, total failure: `workspaceRootOf` read
// `agent.session.cwd`, which does not exist (`Session` is
// `class Session { readonly header: SessionHeader }`). It fell back to the HOST's
// cwd — the profile directory — so every workspace path classified as
// `outside-workspace` and interception switched itself off entirely, while every
// tool still reported success. The unit contexts above hid it by passing a
// `workspaceRoot` directly; only a realistically-shaped execution exposes it.
test('the workspace root comes from session.header.cwd, not the host cwd', () => {
  const realistic = {
    name: 'write',
    callId: 'c-live',
    arguments: { file_path: '_probe.py' },
    agent: { id: 'sess-1', session: { header: { cwd: ROOT }, id: 'sess-1' } },
  }
  assert.equal(workspaceRootOf(realistic, 'FALLBACK'), ROOT)

  // The bug's exact shape: a session with no top-level cwd must NOT fall back.
  assert.equal(workspaceRootOf({ agent: { session: { header: {} } } }, 'FALLBACK'), 'FALLBACK')
})

test('a realistically-shaped execution is intercepted end to end', () => {
  const live = {
    name: 'write',
    callId: 'c-live',
    arguments: { file_path: '_probe_live_test.py' },
    agent: { id: 'sess-1', session: { header: { cwd: ROOT }, id: 'sess-1' } },
  }
  const liveContext = { ...context(), workspaceRoot: workspaceRootOf(live, 'FALLBACK') }
  assert.equal(liveContext.workspaceRoot, ROOT, 'the host cwd must not be used as the root')

  const decision = decideExecution(live, liveContext)
  assert.equal(decision.action, 'vault', 'a scratch write in the session workspace must be redirected')
  assert.equal(decision.rule, 'scratch-name')
  assert.equal(
    decision.scratchPath,
    scratchPathFor({
      scratchRoot: SCRATCH,
      sessionId: 'sess-1',
      workspaceRoot: ROOT,
      originalPath: resolve(ROOT, '_probe_live_test.py'),
    }),
  )
})
