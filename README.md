# Jev Advisor

An Orca Lab plugin that judges what your agents are about to do, before
they do it — and stays out of the way the rest of the time.

Agents run commands. Most are harmless and interrupting you about them is
noise; a few are not, and finding out afterwards is expensive. This plugin
puts a fast, cheap judgement in front of every command an agent issues:
one that lets `npm test` and `rm -rf node_modules` through without a word,
and stops to ask before `gh pr merge`, `terraform apply` or
`git push --force`.

The judgement is made by [Jev](https://typesafe.ai) (TypeSafe), which
answers small typed questions in a few hundred milliseconds for a fraction
of a cent — not by a large model reasoning about your shell.

## What you actually see

Nothing, most of the time. That is the point.

```
git status                       (silent, never leaves your machine)
npm test                         (silent)
rm -rf node_modules              allowed — reversible, local and cheap
gh pr merge 812 --squash         asks    — if this is wrong, it breaks
                                           something someone cares about
git push --force origin main     asks    — local rule: rewrites the remote,
                                           anyone who already pulled breaks
```

How often it stops depends entirely on what your agents do, so this README
does not quote a ratio: the only measurements available today come from
sessions spent deliberately testing dangerous commands, which is not what
your week looks like. The plugin counts it for you instead — the Advisor
panel shows how many decisions were made, how many passed, and how long
each took, on your own traffic.

## Install

1. Install the plugin from the Ab2Web marketplace in Orca, or load this
   repository as a development plugin.
2. Open **Settings → Jev Advisor** and paste a TypeSafe API key. It is
   stored with Electron's `safeStorage`, encrypted, and never shown in
   full again.
3. Press **Set up** under *Claude Code integration*.

That is all. There is nothing to configure in your terminal, and no
`settings.json` to edit by hand.

**Without a key it still protects you.** A set of local rules — force
pushes, recursive deletes from `/` or `$HOME`, dropping a table, deleting
a running pod, `curl | bash` — run in about a millisecond, with no network
and no key at all. The key only buys judgement on the grey cases.

## What it writes outside itself

A plugin that reaches outside its own directory should say so. This one
writes four things, all listed in the settings panel, and **Revert
everything** puts them back:

| What | Where | Why |
|---|---|---|
| A `PreToolUse` hook | every Claude Code config root, including Orca's own per-account ones | so the gate runs in Orca's agent panes, not only outside them |
| `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` | the same files | required by the skill and tool advisories |
| The API key, plain text, mode `600` | `~/.config/orca-supervisor/env` | the gate runs outside Orca and cannot reach encrypted plugin storage |
| A link to the skills mod | the same config roots | so Claude Code loads it |

Nothing is sent anywhere except the questions themselves, to
`api.typesafe.ai`. Your commands are not stored: the measurement log keeps
a coarse command *family* (`git push`, `rm -rf`, `terraform`) and never the
command, because a command can carry a secret in an env assignment.

## What it costs

Measured, not estimated:

| | |
|---|---|
| A command resolved locally | ~111 ms, no network |
| A command judged by Jev | ~230–380 ms median |
| A repeated command | ~277 ms, served from cache without asking Jev |
| Per 1000 decisions | a few cents |

## Configuring it

**Destinations.** Not every repository deserves the same freedom. A
destination is a worktree plus how certain the plugin must be before it
acts there: your own tooling can be judged loosely, a client's production
site cannot. The plugin ships an example catalog with placeholder paths
that matches nothing — a shipped catalog full of somebody else's
repositories would be worse than none — so today you add your own from
the settings panel. Orca already knows your worktrees, and building the
catalog from them at install is the obvious next step; it is not built
yet.

**Policies.** Standing decisions the team has already made, so nobody is
asked twice — *work goes on a feature branch*, *never write directly to
main*, *anything touching a client's product is confirmed by a human*. A
policy either permits, prohibits, or requires a person; when one covers
what an agent is about to do, that settles it without judging risk at all.
Policies are global by default, and a rule that genuinely belongs to one
project can be scoped to it.

**Thresholds.** Sensible defaults, measured. Change them only with
evidence.

## Command gate: deny-tier rule scope

A handful of `NEVER_SILENTLY` rules — the ones that never run unannounced,
regardless of the API key or Jev — deny by default. Each rule is evaluated
either against the whole command or against each of the command's segments
(the parts a shell would run separately, split on `&&`, `||`, `;`, `|`, `&`
or a newline, with quoted text left untouched) independently. Parentheses
never split a segment: a `$(...)` or backtick substitution is part of the
arguments of the command it feeds, so a flag or branch it produces still
counts for that command, and a plain subshell keeps its command whole:

| Rule | Scope | Why |
|------|-------|-----|
| Force push (`--force`/`-f`) | segment | The pattern spans arbitrary text after `git push`, so whole-string matching let it reach across a separator into an unrelated segment (e.g. `git push origin --delete x && git branch -f main origin/main` was wrongly denied as a force push). |
| Push to a protected branch (`main`/`master`/`production`) | segment | Same spanning-quantifier reason. |
| `rm -rf /` (or `~`/`$HOME`) | command | No spanning quantifier; matching the whole command is already precise. |
| `git reset --hard` / `git clean -f` | command | Same — no spanning quantifier. |
| Discarding uncommitted work (`git checkout`/`git restore`) | command | This check already segments the command on its own and extracts `$(...)`/backtick substitutions, `bash -c` and `eval` bodies first; pre-splitting again would break that extraction. |
| `DROP`/`TRUNCATE TABLE`/`DATABASE`/`SCHEMA` | command | No spanning quantifier. |
| `kubectl delete`/`drain` | command | No spanning quantifier. |
| `terraform`/`tofu apply` | command | No spanning quantifier. |
| `terraform`/`tofu destroy` | command | No spanning quantifier. |
| `curl \| bash`/`sh`/`zsh` | command (mandatory) | This rule matches ACROSS a pipe by design — the whole point is catching a curl piped into a shell. Segment scope would silently disable it. |

A quoted separator (for example `git commit -m "build && test"`) never
splits a segment: the text inside the quotes stays part of one segment,
exactly as a shell would read it.

## What is measured, and what is not

The command gate's thresholds were calibrated against a labelled corpus of
commands, run repeatedly against the live API rather than chosen by
intuition. The defaults are the result of that.

Two honest limits:

- **The surrounding repository changes the judgement**, and reasonably so:
  the same merge is not equally consequential on a throwaway branch and on
  a client's main branch. The calibration does not yet cover that
  variation, so treat the defaults as good rather than final.
- **Skill and tool selection ship in measurement mode**, which changes
  nothing you can observe. They record what would have been suggested next
  to what the model actually did. Their thresholds are not calibrated, so
  turning them on is not recommended yet — that record is what makes the
  numbers real instead of invented.

## Not ready yet

- Active skill/tool advice is off by default, for the reason above.

## Platform support

**Verified on macOS.** Windows and Linux are implemented, and every
platform-sensitive module now takes its target platform and environment as
plain arguments (rather than reading `process.platform`/`process.env`
itself), which makes it possible to drive `win32` and `linux` behavior from
this macOS machine and check the arithmetic without the real OS. That is
what the phrase "proven by simulation" below means: it is evidence about
this code's own path/permission logic, not a report that Claude Code, Orca,
or a real filesystem behaves identically on those platforms. Nobody has run
this plugin on Windows or Linux.

**Proven by simulation** (unit-tested with `win32`/`linux` inputs, including
a Windows home directory containing a space and both states of
`XDG_CONFIG_HOME`/`XDG_CACHE_HOME`):

- Where this plugin's own config/cache files resolve to: `~/.config` /
  `~/.cache` on macOS; the same, but honoring `XDG_CONFIG_HOME` /
  `XDG_CACHE_HOME` when set, on Linux; `%APPDATA%` / `%LOCALAPPDATA%` on
  Windows (`src/core/paths.ts`). Linux ignoring those two variables was a
  real gap this audit closed — Orca's own code honors them, and a
  developer's Orca and this plugin now agree on where things live.
- Where Orca's own per-account `userData` (and therefore Claude Code's
  per-account config root) resolves to on each platform
  (`src/core/orca_accounts.ts`) — this module already handled the same XDG
  case correctly before this audit; it now also has a test suite.
- The command gate's cache-key logic (`src/core/command_shape.ts`)
  correctly recognizes a Windows absolute path (`C:\...`, `C:/...`, or a
  `\\server\share` UNC path) as absolute, instead of silently resolving it
  *relative to the current directory* — which is what it did before this
  audit, and which could misclassify a target genuinely outside the working
  tree as inside it, letting a dangerous out-of-tree command reuse a safe
  in-tree verdict. This was a real, fixed bug, not a hypothetical.
- Destination matching (`src/core/destination_match.ts`) and worktree
  catalog derivation (`src/core/worktree_catalog.ts`) both already handled
  `\` separators, including a Windows path with a space in it.
- `write-secret-mirror.mjs`'s `chmod 600` on the API key mirror: it already
  told the truth about Windows before this audit (best-effort, never
  claims the mode holds, and `statMirror()`'s disclosure names the platform
  so the config panel does not imply a POSIX guarantee NTFS cannot give).

**Executed on real Linux** (2026-09-24, not simulated and not reasoned
about): the full suite in a `node:24-slim` container on Node 24.21.0, on
both architectures — **541 tests, 541 passing, 0 failing on `aarch64` and
the same on `x86_64`.** Reproduce it with:

```sh
git archive HEAD | tar -x -C /tmp/orca-linux-run
docker run --rm -v /tmp/orca-linux-run:/app -w /app node:24-slim \
  node --test --experimental-strip-types
```

Windows remains unexecuted. A container cannot stand in for it, and saying
so is more useful than a green tick from a machine that is not Windows.

**Proven by inspection, not simulation** (reasoned from documented Node.js
behavior, not exercised by a test): sidecar processes are spawned via
`execFile` with an argument array and no shell, so a Windows path
containing a space in `--allow-fs-read=...`/`--allow-fs-write=...` is
passed as one argument, not split by a naive string join; `fs.rename` is
atomic-with-overwrite on both Windows and POSIX in the Node version this
project requires. The Windows-only `SYSTEM` prefix list added during this
audit only covers the `C:` drive (`C:\Windows`, `C:\Program Files`,
`C:\ProgramData`) — a target on another drive letter is not specially
recognized and simply falls through to the ordinary in-tree/out-of-tree
check, same as before this list existed.

**Unverifiable without the real machine**, and expected to need attention
if something breaks:

- ~~Directory symlink creation for the mod-skills integration.~~ **Resolved
  in 0.3.1**: the installer no longer creates a symlink at all. It copies the
  mod's directory (`installModCopy`, marked with
  `.orca-jev-mod-skills.source.json`) because the plugin worker runs under
  Node's permission model without `--allow-fs-write`, where `fs.symlink`
  fails with `ERR_ACCESS_DENIED` regardless of the platform. A copy needs no
  Developer Mode and no elevated process, so the Windows question this entry
  described no longer exists; `modLinkWarning` is gone from the code.
- Whether Claude Code itself resolves `%APPDATA%`/`%USERPROFILE%` and
  spawns the gate hook (`node <path>`) the way its own settings.json schema
  documents on Windows, and whether Orca launches the plugin worker and its
  sidecars there with the environment shape this code assumes (`APPDATA`,
  `LOCALAPPDATA`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, `PATH`).
- Case-sensitivity at the very last step of the command gate's in-tree
  check on Windows: `cwd` and the matched destination's root are compared
  byte-for-byte, which is correct on case-sensitive POSIX filesystems; NTFS
  is case-preserving but case-insensitive, and this project has no evidence
  either way about whether the strings it compares ever differ only in
  case in practice.

If you run this on Windows or Linux and something in this list turns out
wrong, that is exactly the gap this section warned about — please report
it rather than assuming the simulation covered it.

## For contributors

```
src/core/         everything that decides, with no I/O of its own
adapters/orca/    the Orca plugin: manifest, worker, panels
adapters/claude/  the Claude Code side: the command gate, the hooks mod
```

`src/core/` takes what it needs as parameters — the API key, the storage
host, the clock, `fetch` — instead of reaching for the environment or the
disk. That is what lets the same code run inside Orca's plugin worker,
inside a Claude Code hook with no Node built-ins at all, and inside a test
with nothing real behind it.

One rule matters more than the rest: **the gate fails open.** A missing key, a
timeout, an unparseable answer, a bug of ours — all of it allows. A gate
that turns its own defects into a prompt on every command is worse than no
gate, because people learn to dismiss it. Real danger is caught by the
local rules, which need neither network nor key.

Run the tests with `node --test src/core/*.test.ts`. There is no build
step: Node runs the TypeScript directly.
