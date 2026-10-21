import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'

import { classifyWrite, createProjectRootProbe, RULES } from '../lib/classify.js'
import { normalizeConfig } from '../lib/config.js'

const ROOT = join('C:', 'work', 'demo')
const config = normalizeConfig({})

/** Non-project workspace: no manifest at the root. */
const noProject = { config, workspaceRoot: ROOT, projectRoot: false }
/** Real project workspace. */
const project = { config, workspaceRoot: ROOT, projectRoot: true }

const at = (rel) => join(ROOT, ...rel.split('/'))

test('leading underscore marks a scratch script', () => {
  const d = classifyWrite({ ...noProject, absolutePath: at('_probe_amiya.py') })
  assert.equal(d.action, 'vault')
  assert.equal(d.rule, RULES.SCRATCH_NAME)
})

test('leading dot marks a scratch script', () => {
  const d = classifyWrite({ ...noProject, absolutePath: at('.tps-bridge-check.mjs') })
  assert.equal(d.action, 'vault')
  assert.equal(d.rule, RULES.SCRATCH_NAME)
})

test('a bare root script in a manifest-less workspace is scratch', () => {
  const d = classifyWrite({ ...noProject, absolutePath: at('amiya_batch.py') })
  assert.equal(d.action, 'vault')
  assert.equal(d.rule, RULES.BARE_ROOT_SCRIPT)
})

test('the same bare root script inside a real project is left alone', () => {
  const d = classifyWrite({ ...project, absolutePath: at('amiya_batch.py') })
  assert.equal(d.action, 'keep')
  assert.equal(d.rule, RULES.NO_RULE)
})

test('a protected directory beats a scratch-shaped name', () => {
  const d = classifyWrite({ ...noProject, absolutePath: at('src/_probe.py') })
  assert.equal(d.action, 'keep')
  assert.equal(d.rule, RULES.PROTECTED_DIR)
})

// Windows paths are case-insensitive, so `SRC` IS `src` on disk. Comparing the
// segments byte-exactly meant `SRC/_probe.py` — a script inside the user's real
// source tree — was moved out of the workspace while `src/_probe.py` was protected,
// which is the one failure the classifier is ordered to avoid.
test('directory protection follows the filesystem case rules', () => {
  const d = classifyWrite({ ...noProject, absolutePath: at('SRC/_probe.py') })
  if (process.platform === 'win32') {
    assert.equal(d.action, 'keep')
    assert.equal(d.rule, RULES.PROTECTED_DIR)
  } else {
    // On a case-sensitive filesystem `SRC` is a different directory, and nothing
    // protects it — the scratch-shaped name wins.
    assert.equal(d.action, 'vault')
    assert.equal(d.rule, RULES.SCRATCH_NAME)
  }
})

test('a scratch directory marks everything beneath it', () => {
  const d = classifyWrite({ ...project, absolutePath: at('tmp/convert.py') })
  assert.equal(d.action, 'vault')
  assert.equal(d.rule, RULES.SCRATCH_DIR)
})

test('deliverables are untouched', () => {
  for (const rel of ['README.md', 'data/report.csv', 'notes.txt', 'assets/logo.png']) {
    const d = classifyWrite({ ...noProject, absolutePath: at(rel) })
    assert.equal(d.action, 'keep', `${rel} should be kept`)
  }
})

test('excludeGlobs wins over every scratch rule', () => {
  const withExclude = normalizeConfig({ excludeGlobs: ['_keep_me.py'] })
  const d = classifyWrite({
    config: withExclude,
    workspaceRoot: ROOT,
    projectRoot: false,
    absolutePath: at('_keep_me.py'),
  })
  assert.equal(d.action, 'keep')
  assert.equal(d.rule, RULES.EXCLUDED)
})

test('targets outside the workspace are never touched', () => {
  const d = classifyWrite({ ...noProject, absolutePath: join('C:', 'elsewhere', '_probe.py') })
  assert.equal(d.action, 'keep')
  assert.equal(d.rule, RULES.OUTSIDE_WORKSPACE)
})

test('a disabled plugin keeps everything', () => {
  const off = normalizeConfig({ enabled: false })
  const d = classifyWrite({
    config: off,
    workspaceRoot: ROOT,
    projectRoot: false,
    absolutePath: at('_probe.py'),
  })
  assert.equal(d.action, 'keep')
  assert.equal(d.rule, RULES.DISABLED)
})

test('interception can be switched off independently', () => {
  const off = normalizeConfig({ interceptWrites: false })
  const d = classifyWrite({
    config: off,
    workspaceRoot: ROOT,
    projectRoot: false,
    absolutePath: at('_probe.py'),
  })
  assert.equal(d.action, 'keep')
  assert.equal(d.rule, RULES.DISABLED)
})

test('the project-root probe reports what exists, and caches', () => {
  const seen = []
  const probe = createProjectRootProbe((p) => {
    seen.push(p)
    const posix = p.split('\\').join('/')
    return posix.startsWith('C:/a/') && posix.endsWith('package.json')
  })
  const manifests = ['package.json', 'pyproject.toml']
  assert.equal(probe('C:/a', manifests), true)
  assert.equal(probe('C:/a', manifests), true)
  assert.equal(seen.length, 1, 'the second lookup must come from cache')
  assert.equal(probe('C:/b', manifests), false)
})

test('an unreadable root is treated as a project root (fail safe)', () => {
  const probe = createProjectRootProbe(() => {
    throw new Error('denied')
  })
  assert.equal(probe('C:/locked', ['package.json']), true)
})

// Regression: rule 4 matched a scratch-sounding base name WITHOUT checking the
// extension, so ordinary repository files whose names merely look scratchy were
// diverted into the vault. `.gitignore` is the case that caught it — the plugin
// intercepted the author's own .gitignore while this repository was being set up.
test('a dotfile with no script extension is kept, not vaulted', () => {
  for (const name of ['.gitignore', '.env', '.editorconfig', '_headers', '.npmrc']) {
    const d = classifyWrite({ ...noProject, absolutePath: at(name) })
    assert.equal(d.action, 'keep', `${name} must not be diverted`)
    assert.equal(d.rule, RULES.NO_RULE, `${name} must match no rule`)
  }
})

test('a scratch-sounding name WITH a script extension is still vaulted', () => {
  const d = classifyWrite({ ...noProject, absolutePath: at('_probe_amiya.py') })
  assert.equal(d.action, 'vault')
  assert.equal(d.rule, RULES.SCRATCH_NAME)
})

// Rule 2: the user's goal may BE the script. An existing file is an artifact, and
// updating it (write over, or edit) must never move it — a redirected probe never
// exists in the workspace afterwards, so presence on disk can only mean "real".
test('a target that already exists is kept, whatever its name', () => {
  for (const rel of ['_probe.py', '.check.mjs', 'tmp/convert.py', 'amiya_batch.py']) {
    const d = classifyWrite({ ...noProject, absolutePath: at(rel), targetExists: true })
    assert.equal(d.action, 'keep', `${rel} exists, so it must be kept`)
    assert.equal(d.rule, RULES.EXISTING_FILE, `${rel} must match the existing-file rule`)
  }
})

test('explicit allowlist still outranks the existing-file rule', () => {
  const withExclude = normalizeConfig({ excludeGlobs: ['amiya_batch.py'] })
  const d = classifyWrite({
    config: withExclude,
    workspaceRoot: ROOT,
    projectRoot: false,
    absolutePath: at('amiya_batch.py'),
    targetExists: true,
  })
  assert.equal(d.action, 'keep')
  assert.equal(d.rule, RULES.EXCLUDED, 'the user-named file is reported as such, not as merely existing')
})

test('targetExists defaults to "not present", so a new probe is still vaulted', () => {
  const d = classifyWrite({ ...noProject, absolutePath: at('_probe.py') })
  assert.equal(d.action, 'vault')
  assert.equal(d.rule, RULES.SCRATCH_NAME)
})

