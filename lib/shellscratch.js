/**
 * Locating a scratch root the *shell* can actually write to.
 *
 * The naive answer — `os.tmpdir()` — is wrong on a sandboxed deployment, and
 * wrong in a way that only shows up when the model tries to use it:
 *
 *  - `os.tmpdir()` is evaluated in the **host** process and returns the real
 *    platform temp area (e.g. `C:\Users\...\AppData\Local\Temp`).
 *  - DSH's Windows ACL sandbox gives each shell its **own** private temp
 *    directory (it creates `mkdtempSync(join(temp, "dsh-"))` and then overrides
 *    `TMP`/`TEMP` for the child), and its ACL grants write access to that
 *    directory and the workspace only.
 *
 * So a scratch root under the host temp is writable by this plugin's own Node
 * code but **denied** to the model's shell:
 *
 *     New-Item : Access to the path 'C:\Users\...\Temp\dsh-scratch\<session>' is denied.
 *
 * This module holds the pure pieces of the answer — how to ask, and how to
 * decide whether the answer is usable. `shellroots.js` runs the probe per
 * session and caches it.
 *
 * @module dsh-scratch-vault/shellscratch
 */

import { mkdirSync, statSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A command that prints the shell's own temp directory. Written to work from
 * either PowerShell or cmd on Windows, and from any POSIX shell elsewhere.
 * @param {NodeJS.Platform} [platform]
 * @returns {string}
 */
export function tempEchoCommand(platform = process.platform) {
  return platform === 'win32' ? 'cmd /c echo %TEMP%' : 'printf %s "${TMPDIR:-/tmp}"'
}

/**
 * Derive an absolute scratch root from a shell-reported temp directory.
 * Returns undefined for anything that does not look like a usable path, so a
 * probing failure degrades instead of writing to a garbage location.
 *
 * @param {unknown} tempDir - raw stdout of the probe
 * @param {string} leaf - directory name to create under it
 * @returns {string | undefined}
 */
export function scratchRootFrom(tempDir, leaf) {
  if (typeof leaf !== 'string' || leaf.length === 0) return undefined
  const trimmed = String(tempDir ?? '')
    .trim()
    .replace(/^"|"$/g, '')
  // A multi-line or empty answer is not a path we can trust.
  if (trimmed.length === 0 || /[\r\n]/.test(trimmed)) return undefined
  // Require something path-shaped: drive letter, UNC, or a leading slash.
  if (!/^([A-Za-z]:[\\/]|\\\\|\/)/.test(trimmed)) return undefined
  return join(trimmed, leaf)
}

/**
 * Confirm that `directory` can be created and written by this process. The
 * plugin has to be able to create the directory it hands out, so a directory
 * this process cannot create is rejected rather than configured.
 *
 * @param {string} directory
 * @returns {boolean}
 */
export function isUsableDirectory(directory) {
  const marker = join(directory, '.dsh-scratch-probe')
  try {
    mkdirSync(directory, { recursive: true })
    writeFileSync(marker, '', 'utf8')
    statSync(directory)
    rmSync(marker, { force: true })
    return true
  } catch {
    return false
  }
}
