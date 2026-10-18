/**
 * Configuration for dsh-scratch-vault.
 *
 * Deliberately free of any `Config` schema export: the plugin normalizes its own
 * plain-object config instead. A profile that cannot resolve a peer dependency
 * for a schema library would then fail to mount the plugin, and a workspace-hygiene
 * plugin that refuses to load is strictly worse than one with no settings form.
 *
 * Precedence (high → low): `scratch-vault.json` in the vault directory,
 * `$DSH_SCRATCH_VAULT_CONFIG` (a path to a JSON file), built-in defaults.
 *
 * @module dsh-scratch-vault/config
 */

import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { homedir, tmpdir } from 'node:os'

/** File name of the optional external config, inside the vault directory. */
export const CONFIG_FILENAME = 'scratch-vault.json'

/**
 * Default configuration.
 *
 * `interceptMode` is the load-bearing knob:
 *   - `'redirect'` (default) rewrites the write target to the scratch root and
 *     tells the model the real path; the workspace never sees the file.
 *   - `'deny'` refuses the write outright and tells the model what to do instead.
 *   - `'report'` changes nothing in the profile's behaviour but records every
 *     file that WOULD have been intercepted. Use this first, on an unfamiliar
 *     repository, to validate the classifier before trusting it.
 */
export const DEFAULTS = Object.freeze({
  enabled: true,

  /** `''` → `<os.tmpdir()>/dsh-scratch`. Must stay outside the workspace. */
  scratchRoot: '',
  /** `''` → `<DSH_HOME>/scratch-vault`. */
  vaultDir: '',

  // --- L2: discipline + environment + inline execution
  injectPrompt: true,
  exposeEnv: true,
  registerRunScript: true,
  /** Interpreters offered by `run_script`, keyed by language id. */
  interpreters: Object.freeze({
    python: 'python',
    node: 'node',
    powershell: 'pwsh',
    bash: 'bash',
  }),
  extensions: Object.freeze({
    python: '.py',
    node: '.mjs',
    powershell: '.ps1',
    bash: '.sh',
  }),
  runScriptTimeoutMs: 120000,

  // --- L3: interception
  interceptWrites: true,
  interceptMode: 'redirect',
  rewriteShell: true,

  // --- classification
  scriptExtensions: Object.freeze([
    '.py', '.pyw', '.mjs', '.cjs', '.js', '.mts', '.cts', '.ts',
    '.ps1', '.psm1', '.psd1', '.sh', '.bash', '.zsh', '.fish',
    '.bat', '.cmd', '.rb', '.pl', '.pm', '.lua', '.php', '.r', '.jl',
    '.vbs', '.wsf', '.sql',
  ]),
  /**
   * Base-name patterns (JS regex source, case-insensitive). A base name matching
   * any of these is a scratch script regardless of where it sits. The defaults
   * are intentionally narrow: a false positive silently diverts a real
   * deliverable, which is worse than letting one helper script through.
   */
  scriptNamePatterns: Object.freeze([
    '^[_.]',
    '^(tmp|temp|scratch|probe|diag|debug|dbg|recon|adhoc|oneoff|throwaway)[-_.]',
    '(^|[-_.])(tmp|temp|scratch|probe|diag|debug|dbg|recon|adhoc|oneoff|throwaway)([-_.]|$)',
  ]),
  /** A directory segment with one of these names marks everything below it. */
  scratchDirNames: Object.freeze([
    '_scratch', '.scratch', 'scratch', '_tmp', '.tmp', 'tmp',
    '_work', '.work', 'dsh-scratch',
  ]),
  /** Never touch anything under these segments — they are a project's real source. */
  protectDirs: Object.freeze([
    '.git', 'node_modules', 'src', 'lib', 'app', 'packages', 'test', 'tests',
    'spec', 'docs', 'vendor', 'venv', '.venv', 'dist', 'build', 'target',
    '__pycache__', 'site-packages',
  ]),
  /** Extra deliverable allowlist, matched against the workspace-relative path. */
  excludeGlobs: Object.freeze([]),
  /**
   * In a workspace with no project manifest at its root, any script-extension
   * file sitting directly at the root counts as scratch. This is the rule that
   * catches the common `amiya_batch.py` / `apply-dsh-host-paths.ps1` leftovers
   * without touching a real project's files.
   */
  treatBareRootScriptsAsScratch: true,
  /** Manifest file names whose presence marks a real project root. */
  projectManifests: Object.freeze([
    'package.json', 'pyproject.toml', 'setup.py', 'setup.cfg', 'Cargo.toml',
    'go.mod', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'tsconfig.json',
    'Makefile', 'CMakeLists.txt', 'composer.json', 'Gemfile', 'mix.exs',
    'deno.json', 'bun.lockb', '.git',
  ]),

  // --- L4: vault
  recordInlineRuns: true,
  retainDays: 14,
  maxVaultEntries: 2000,
  maxEntryBytes: 4 * 1024 * 1024,
  /** Bound on the retired exec-argument map, in entries. */
  maxPendingRewrites: 512,
})

/** Coerce and clamp the raw config. Never throws on user input. */
function normalize(raw) {
  const merged = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) }
  const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback)
  const num = (value, fallback, min, max) => {
    const n = Number(value)
    if (!Number.isFinite(n)) return fallback
    return Math.min(max, Math.max(min, n))
  }
  const strArray = (value, fallback) => {
    if (!Array.isArray(value)) return [...fallback]
    const out = value.filter((v) => typeof v === 'string' && v.length > 0)
    return out.length > 0 || value.length === 0 ? out : [...fallback]
  }
  const record = (value, fallback) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...fallback }
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === 'string' && v.length > 0) out[k] = v
    }
    return Object.keys(out).length > 0 ? out : { ...fallback }
  }

  const mode = merged.interceptMode
  const interceptMode = mode === 'deny' || mode === 'report' ? mode : 'redirect'

  // Compile the name patterns once; a bad pattern is dropped, not fatal.
  const scriptNamePatterns = []
  for (const source of strArray(merged.scriptNamePatterns, DEFAULTS.scriptNamePatterns)) {
    try {
      scriptNamePatterns.push(new RegExp(source, 'i'))
    } catch {
      /* drop unusable pattern */
    }
  }

  return Object.freeze({
    ...merged,
    enabled: bool(merged.enabled, DEFAULTS.enabled),
    scratchRoot: typeof merged.scratchRoot === 'string' ? merged.scratchRoot.trim() : '',
    vaultDir: typeof merged.vaultDir === 'string' ? merged.vaultDir.trim() : '',
    injectPrompt: bool(merged.injectPrompt, DEFAULTS.injectPrompt),
    exposeEnv: bool(merged.exposeEnv, DEFAULTS.exposeEnv),
    registerRunScript: bool(merged.registerRunScript, DEFAULTS.registerRunScript),
    interpreters: record(merged.interpreters, DEFAULTS.interpreters),
    extensions: record(merged.extensions, DEFAULTS.extensions),
    runScriptTimeoutMs: num(merged.runScriptTimeoutMs, DEFAULTS.runScriptTimeoutMs, 1000, 3600000),
    interceptWrites: bool(merged.interceptWrites, DEFAULTS.interceptWrites),
    interceptMode,
    rewriteShell: bool(merged.rewriteShell, DEFAULTS.rewriteShell),
    scriptExtensions: strArray(merged.scriptExtensions, DEFAULTS.scriptExtensions).map((e) =>
      e.startsWith('.') ? e.toLowerCase() : `.${e.toLowerCase()}`,
    ),
    scriptNamePatterns,
    scratchDirNames: strArray(merged.scratchDirNames, DEFAULTS.scratchDirNames),
    protectDirs: strArray(merged.protectDirs, DEFAULTS.protectDirs),
    excludeGlobs: strArray(merged.excludeGlobs, DEFAULTS.excludeGlobs),
    treatBareRootScriptsAsScratch: bool(
      merged.treatBareRootScriptsAsScratch,
      DEFAULTS.treatBareRootScriptsAsScratch,
    ),
    projectManifests: strArray(merged.projectManifests, DEFAULTS.projectManifests),
    recordInlineRuns: bool(merged.recordInlineRuns, DEFAULTS.recordInlineRuns),
    retainDays: num(merged.retainDays, DEFAULTS.retainDays, 0, 3650),
    maxVaultEntries: num(merged.maxVaultEntries, DEFAULTS.maxVaultEntries, 1, 1000000),
    maxEntryBytes: num(merged.maxEntryBytes, DEFAULTS.maxEntryBytes, 1024, 512 * 1024 * 1024),
    maxPendingRewrites: num(merged.maxPendingRewrites, DEFAULTS.maxPendingRewrites, 16, 100000),
  })
}

/** Expand `~`, `%VAR%` and `$VAR`, then make absolute against a base. */
export function expandPath(value, base) {
  if (typeof value !== 'string' || value.length === 0) return ''
  let out = value
  if (out === '~' || out.startsWith('~/') || out.startsWith('~\\')) {
    out = join(homedir(), out.slice(1))
  }
  out = out.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (whole, name) =>
    process.env[name] ?? whole,
  )
  out = out.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (whole, name) =>
    process.env[name] ?? whole,
  )
  return isAbsolute(out) ? resolve(out) : resolve(base, out)
}

/**
 * Resolve the config that governs this process.
 * @param {{ dshHome?: string, env?: Record<string, string | undefined>, cwd?: string }} [options]
 * @returns {ReturnType<typeof normalize> & { scratchRoot: string, vaultDir: string, configPath: string }}
 */
export function resolveConfig(options = {}) {
  const env = options.env ?? process.env
  const dshHome =
    options.dshHome ?? env.DSH_HOME ?? join(homedir(), '.dsh')
  const base = options.cwd ?? process.cwd()

  // The vault directory has to be known before the config can live inside it, so
  // the built-in default is computed first and a configured value only moves it.
  const preliminary = normalize({ vaultDir: '' })
  const explicitConfigPath = expandPath(env.DSH_SCRATCH_VAULT_CONFIG ?? '', base)
  const preliminaryVault = expandPath(preliminary.vaultDir, dshHome) ||
    join(dshHome, 'scratch-vault')

  let fromFile = {}
  const configPath = explicitConfigPath || join(preliminaryVault, CONFIG_FILENAME)
  if (configPath && existsSync(configPath)) {
    try {
      fromFile = JSON.parse(readFileSync(configPath, 'utf8'))
    } catch {
      fromFile = {} // a corrupt config must not prevent the plugin from mounting
    }
  }

  const normalized = normalize(fromFile)
  const vaultDir = expandPath(normalized.vaultDir, dshHome) || join(dshHome, 'scratch-vault')
  const scratchRoot = expandPath(normalized.scratchRoot, tmpdir()) ||
    join(tmpdir(), 'dsh-scratch')

  return Object.freeze({ ...normalized, scratchRoot, vaultDir, configPath })
}

export { normalize as normalizeConfig }
