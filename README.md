# dsh-scratch-vault

**Codex-style scratch execution for DeepSeek Harness — operation scripts run outside the workspace, and get collected in the plugin.**

English | [中文](README.zh.md)

A DSH plugin that keeps agent workspaces to deliverables. The throwaway probes,
one-off converters and diagnostics an agent writes only to run once no longer
land in your repository: they execute from a session scratch root outside the
workspace, and every one of them is archived in a plugin-owned vault you can
list, read, promote, or purge.

```
before                                    after
repo/                                     repo/
├── src/                                  ├── src/
├── _probe_models.py        ← noise       ├── package.json
├── _recon_api.py           ← noise       └── (deliverables only)
├── tmp_convert.mjs         ← noise
├── apply-paths.ps1         ← noise       vault/
└── package.json                          └── entries/20261012…-a1b2c3/script
```

---

## Why

Long-running agent tasks accumulate intermediate files. The files themselves cost
nothing on disk; the cost is that every later `glob`, `grep` and directory
listing has to wade through them, which pushes irrelevant content into context
and makes the agent re-derive what it already did.

DSH already has most of the machinery to prevent this. Its `workspace-write`
sandbox grants writes under the workspace root **or** a platform temporary root
(`writableRoots` returns the workspace root, `/tmp` and `os.tmpdir()`), and the
workspace change summary already excludes temporary roots (`isTemporaryPath` —
"scratch paths that never enter the change summary"). What is missing is the part
that routes scratch work there, and the part that remembers it.

This plugin is those two parts.

## Install

```sh
dsh plugin --profile desktop add github:TINGOD2006/dsh-scratch-vault
```

Then restart DSH. From a local checkout:

```sh
dsh plugin --profile desktop add link:C:/path/to/dsh-scratch-vault
```

On Windows use forward slashes in the path, or pnpm will splice the drive letter
into the profile directory and the plugin will install without activating.

Requirements: Node ≥ 22 and a DSH build that mounts the `tools` service. The
plugin declares **no dependencies at all** — not even `@deepseek-ai/dsh-tools`.
A linked plugin's bare specifiers resolve against its *real* path, which never
reaches the profile's `node_modules`, so one host import is enough to make the
whole plugin fail to load with nothing but `failed to import` to show for it.
Tool definitions are therefore assembled by hand in `lib/tools.js`, producing
exactly the shapes `defineTool` produces. Nothing to install, nothing to keep in
sync.

Editing any file under `lib/` requires a **full DSH restart**. The loader builds
its module graph at boot and caches each module by its resolved URL, so
disabling and re-enabling the bundle re-runs the cached module's `apply()` — it
does not re-import the file.

## What it does

### L2 — discipline, environment, inline execution

- **A system-prompt section** telling the model that operation scripts belong in
  the scratch root, not the workspace.
- **`$DSH_SCRATCH` and `$DSH_VAULT`**, injected into every shell call through
  `ctx.shellEnv`. The namespace is rebuilt per shell call, so the value is always
  the calling session's own directory.
- **`run_script({ language, code, description })`** — the "run it without writing
  a file into the workspace" tool. The program is written to a scratch file
  outside the workspace and executed through `ctx.shell`, so it runs under the
  session's sandbox policy. This is the right answer to "I just need to run
  something".

### L3 — interception

`tools/execute` is the only seam that runs *around* dispatch and can therefore
change what a tool body receives: the registry passes the mutable execution into
the waterfall, and `dispatchToolBody` reads `exec.arguments` afterwards.
(`tools/pre-execute` cannot do this — its decision type is
`allow | deny | cancel | ask`, with no place to put arguments.)

When a `write` or `edit` targets a scratch script inside the workspace, its
`file_path` is rewritten to the session scratch root, and the tool result tells
the model the real absolute path plus the vault entry id. Shell commands that
reference the redirected script are rewritten too.

Two properties keep this safe:

- **The mapping is a pure function of the path** (`scratchPathFor`). DSH
  dispatches tool calls in parallel groups, so a `write` and the `pwsh` that runs
  it can be in flight simultaneously; anything order-dependent would race.
- **A shell token is only rewritten when the workspace file does not exist.** A
  legacy leftover that really is on disk keeps running from disk.

The shell rewriter is deliberately conservative, because a missed rewrite costs one
uncollected file while a wrong rewrite breaks a command that used to work. A token
is left alone when it sits next to a glob metacharacter, extends a longer filename
(`x.py.bak`), is part of a shell variable reference (`$env:X\a.py`,
`$DSH_SCRATCH/a.py`, `%TEMP%\a.py`), or is **relative and its working directory
cannot be determined** — `cd $env:WORK`, `cd %WORK%`, a bare `cd` (which goes to the
home directory), `cd ~/proj`.

A relative token after an earlier `cd`/`Set-Location`/`pushd` is resolved against the
directory that change put the shell in, not blindly against the workspace root:
`cd <workspace>` then `python _probe.py` is the everyday shape and still redirects to
the scratch path the write produced, while `cd …\lib` then `Get-ChildItem notes.js`
refers to a real file and is left alone. Absolute paths stay unambiguous and are
always redirected, drive letter included.

A token is only rewritten in a **program position**: the argument slot of an
interpreter or runner (`python`, `node`, `pwsh`, `bash`, `ruby`, `lua`, …) or the
command word itself (`.\_probe.ps1`). A script name in a `#` comment, a commit
message, a `grep` pattern or a single-quoted shell payload is *data* — either the
command does not run it, or it runs it under a different working directory — and
rewriting it there breaks a command that used to work or bakes a machine-specific
temp path into a generated file.

### L4 — the vault

Every intercepted script is archived under the vault directory with a JSONL
ledger, plus `scratch_list`, `scratch_show`, `scratch_promote` (copy one back
into the workspace as a real deliverable) and `scratch_purge`.

`scratch_import` retrofits residue that was already in the workspace before the
plugin existed: it collects the paths you name, verifies the vault copy
byte-for-byte, and only then removes the original (`keepOriginal: true` keeps it,
`dryRun: true` reports without touching either side). Two guard rails matter here:
it only collects files whose bytes survive a UTF-8 round trip — a lossy decode
would be stored as U+FFFD, and "verifying" the vault copy against the same decode
would always pass — and it never deletes a file the classifier protects. A path
inside `src/`, `node_modules/` or an `excludeGlobs` allowlist entry is reported as
refused and left exactly where it is.

Every vault write happens inside the plugin's own process, and that is load
bearing. `<vaultDir>` lives under `DSH_HOME`, outside the session workspace and
therefore outside the sandbox's writable roots: a program the agent runs through
the shell **cannot** write the vault, and neither can a sandboxed tool.
Collection only works on the host side of that boundary — which is precisely
where these tools run.

The ledger is append-only, and the two operations that must rewrite it anyway —
the retention purge and the `maxVaultEntries` trim — write a temporary file and
rename it into place, so an interrupted rewrite can never truncate the history.
Reads are served from an in-memory cache keyed by the ledger's `stat`; any other
writer, including a second DSH window sharing the vault, changes that signature
and the next read reloads. A `ledger.lock` serializes rewrites between windows:
when it is held, a purge declines (`busy: true`) instead of deleting entry
directories the other writer is about to re-advertise. The lock names its owner's
pid, so a lock left by a dead process is stolen while a slow-but-alive holder is
left alone.

Two failure modes are handled explicitly rather than by luck. A ledger that exists
but cannot be read is never treated as an empty one — reporting nothing, caching
nothing, and refusing to rewrite, because rewriting an unreadable ledger would
persist the emptiness over real history. And a torn final line, the one thing a
crashed append can damage, is re-terminated before the next append instead of
fusing two records into one unparsable line.

Retention is applied at every mount (`autoPurge`): the window is a policy, not a
chore, so the vault does not grow until someone remembers `scratch_purge`. Set
`autoPurge: false` to keep it fully manual.

## Configuration

There is no Cordis `Config` schema on purpose. A profile that cannot resolve a
schema library's peer dependency would fail to mount the plugin entirely, and a
workspace-hygiene plugin that refuses to load is worse than one with no settings
form. Configuration is a plain JSON file instead:

```
<vaultDir>/scratch-vault.json          # default: ~/.dsh/scratch-vault/scratch-vault.json
$DSH_SCRATCH_VAULT_CONFIG              # or point at any JSON file
```

Every key is optional; missing keys fall back to the built-in defaults.

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch. |
| `interceptMode` | `"redirect"` | `"redirect"` moves the write; `"deny"` refuses it and explains the alternative; `"report"` **changes nothing** but logs every file that would have been intercepted. |
| `scratchRoot` | `""` → `<os.tmpdir()>/dsh-scratch` | Where scratch files live. Must be outside the workspace. |
| `vaultDir` | `""` → `<DSH_HOME>/scratch-vault` | Where collected scripts are archived. |
| `interceptWrites` | `true` | Whether `write`/`edit` are inspected at all. |
| `rewriteShell` | `true` | Whether shell command references follow a redirected write. |
| `injectPrompt` | `true` | Whether the discipline section is added to the prompt. |
| `exposeEnv` | `true` | Whether `DSH_SCRATCH`/`DSH_VAULT` are injected into shell calls. |
| `registerRunScript` | `true` | Whether `run_script` is offered. |
| `interpreters` | `{python,node,powershell,bash}` | Executable per language. |
| `extensions` | `{python:".py",node:".mjs",…}` | Scratch file extension per language. |
| `scriptExtensions` | 27 entries | Which extensions can be scratch scripts. |
| `scriptNamePatterns` | narrow set | Base-name regexes marking a scratch script. |
| `scratchDirNames` | `_scratch`, `tmp`, … | Directory names that mark everything beneath them. |
| `protectDirs` | `src`, `lib`, `test`, … | Never touched — a project's real source. |
| `excludeGlobs` | `[]` | Deliverable allowlist, workspace-relative. |
| `treatBareRootScriptsAsScratch` | `true` | A script at the root of a workspace with no project manifest is scratch. |
| `autoPurge` | `true` | Run one retention purge when the plugin mounts. |
| `retainDays` | `14` | Purge cutoff. |
| `maxVaultEntries` | `2000` | Ledger cap; oldest are dropped. |
| `maxEntryBytes` | `4194304` | Above this the entry is recorded but its bytes are not stored. |

Settings are discovered in the documented order: `<vaultDir>/scratch-vault.json`
first, then the file `$DSH_SCRATCH_VAULT_CONFIG` points at, then the built-in
defaults. A value that references an environment variable that is not set is a
configuration error, not a directory name: the setting falls back to its default
and the mount logs a warning instead of creating a literal `%VAR%` directory that
a shell would expand to something else anyway.

### Start with `report` mode

On an unfamiliar repository, set `"interceptMode": "report"` first. It records
what the classifier *would* have done without moving a single file, which is the
cheap way to find out whether `scriptNamePatterns` needs tuning for your layout.

## How the classifier decides

A false positive silently diverts a real deliverable; a false negative merely
leaves a helper script behind — the status quo. Every default therefore leans
toward keeping the file, and the rules are ordered worst-case-first:

1. `excludeGlobs` matched → **keep** (the user named this file).
2. The destination already exists on disk → **keep**. An existing file is an
   artifact, not a probe: a redirected scratch write never exists in the workspace
   afterwards, so anything already there belongs to the user. This is what keeps
   "the script IS the deliverable" workflows intact — writing over a deliverable,
   or editing it after the first write, never moves it.
3. A directory segment is in `protectDirs` → **keep** (real source wins over any
   scratch heuristic). Segments are compared case-insensitively on Windows, where
   `SRC` and `src` are the same directory.
4. A directory segment is in `scratchDirNames` → **vault** (same case rule).
5. The base name matches `scriptNamePatterns` (`_probe.py`, `.check.mjs`,
   `tmp_x.sh`, `recon_*.py`) **and** its extension is in `scriptExtensions` →
   **vault**. The extension gate is what keeps `.gitignore`, `.env` and
   `.editorconfig` out of the vault — their names look like scratch files, but
   they are ordinary repository files.
6. A script-extension file sits directly at the root of a workspace with **no**
   project manifest → **vault**. This is the rule that separates "a scratch
   folder" from "a repository".
7. Otherwise → **keep**.

Rules 5 and 6 are the only ones that can guess wrong, and both only fire on a
**new** file. If the user asked for that file itself, the redirect is undone by
`scratch_promote` — the tool result names the entry id and the exact call to make
— so nothing is lost even in the misjudged case. In a workspace where scripts
genuinely ARE the deliverable, set `treatBareRootScriptsAsScratch: false` (or list
them in `excludeGlobs`) and rule 6 stops firing.

## The tools

| Tool | Purpose |
|---|---|
| `run_script` | Run a program from a scratch file; no workspace write. |
| `scratch_import` | Collect scripts already in the workspace; verify, then remove. |
| `scratch_list` | Newest-first listing, optionally per session. |
| `scratch_show` | One entry plus its source. |
| `scratch_promote` | Copy a vaulted script back into the workspace. |
| `scratch_purge` | Delete entries past the retention window; dry run by default. |
| `scratch_status` | Effective configuration and vault counts. |

## Known limits

- **The vault is not a security boundary.** It records what the plugin moved; it
  does not stop an agent that decides to write a file into the workspace by some
  path the classifier calls a deliverable.
- **Interception is per-write.** A script produced by a shell redirect
  (`python … > out.py`) or by a program the agent runs is only caught if the
  shell token matched a rewritten reference; the file itself is not moved.
- **The shell rewriter under-covers on purpose.** Shell variables, globs, longer
  filenames, relative paths after a `cd`, and anything that is not in a program
  position (a comment, a commit message, a `grep` pattern, a quoted payload) are
  left untouched (see L3), so a scratch script referenced in one of those shapes is
  not redirected. Redirecting it would have broken a working command.
- **The classifier is name- and location-based.** It does not read the file.
- **Retention is time-based and runs at mount.** `autoPurge` applies `retainDays`
  once per session start, so a long session can still accumulate entries; the
  `maxVaultEntries` cap bounds that.
- **`systemPrompt.section` cannot name the per-session path** (its text function
  receives only a scope key), which is why the path travels through
  `$DSH_SCRATCH` instead of the prompt.
- **`run_script` requires `ctx.shell`.** Without it the tool is not registered,
  and the other layers still work.
- **The vault cannot be written from inside the sandbox.** It sits under
  `DSH_HOME`, outside the workspace and therefore outside `writableRoots`; only
  plugin-side code can collect. A shell program the agent runs cannot.
- **Collecting is not automatic.** `scratch_import` is opt-in and explicit. The
  plugin never scans or sweeps the workspace on its own; it only diverts writes
  it intercepts and paths you hand it.
- **Editing the plugin needs a restart.** The loader caches the module by its
  resolved URL; disabling and re-enabling the bundle re-runs the *cached*
  module's `apply()`, it does not re-import the file.

## Development

```sh
node test/classify.test.mjs
node test/intercept.test.mjs
node test/paths.test.mjs
node test/plugin.test.mjs
node test/shellroots.test.mjs
node test/shellscratch.test.mjs
node test/tools.test.mjs
node test/vault.test.mjs
```

The suite is offline and fully dependency-free: every module under `lib/` is
imported by the tests, `lib/tools.js` included — `registerTools` touches only
`ctx.tools.register`, `ctx.get` and a vault, so a two-method stub context is a
faithful harness for it.

> Run the files directly rather than `node --test`. Under a confined DSH sandbox a
> child process with piped stdio fails with `EPERM`, which is what the test
> runner's file isolation uses.

## License

MIT
