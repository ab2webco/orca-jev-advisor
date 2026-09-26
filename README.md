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
writes seven things, all listed in the settings panel. **Revert
everything** puts back the hook entries, the env var and the skills-mod
copy. Clearing the key from the settings panel deletes the key file
separately. The three JSON mirrors below are never deleted by any action
here — each is only ever overwritten by its own next save:

| What | Where | Why |
|---|---|---|
| Seven hook entries — four on the command gate (`PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionDenied`) plus three on model reclassification (`PreToolUse`, `PostToolUse`, `PostToolUseFailure`) | `settings.json` in every Claude Code config root, including Orca's own per-account ones | so the gate and the model hooks run in Orca's agent panes, not only outside them |
| `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` | the same files | required by the skill and tool advisories |
| The API key, plain text, mode `600` | `~/.config/orca-supervisor/env` | the gate runs outside Orca and cannot reach encrypted plugin storage |
| A copy of the skills mod | `skills/orca-jev-mod-skills` under every one of the same config roots | so Claude Code auto-loads it in each one |
| A human-readable mirror of the destination catalog (not secret) | `~/.config/orca-supervisor/catalog.json` | the gate reads it outside Orca, with no channel back into plugin storage |
| A human-readable mirror of the team policies (not secret) | `~/.config/orca-supervisor/policies.json` | same reason |
| A human-readable mirror of the model catalog (not secret) | `~/.config/orca-supervisor/models-catalog.json` | the model hook reads it outside Orca to rank a recommendation |

Nothing is sent anywhere except the questions themselves, to
`api.typesafe.ai` (see "What leaves your machine" below). Your commands are
not stored: the measurement log keeps a coarse command *family* (`git
push`, `rm -rf`, `terraform`) and never the command, because a command can
carry a secret in an env assignment.

## What leaves your machine

The command gate's risk and policy questions carry the proposed command
itself — Jev has to read it to judge what it does. Before that request
leaves this machine, anything that looks like a credential *value* in the
command text is masked first: an `export TOKEN=…` / `NAME=value` assignment
whose name mentions key, token, secret, password, auth, credential, private,
sig or signature; an `Authorization: Bearer …` header; the password half of a
`user:pass@host` URL or a `curl -u user:pass`; a known token prefix (`sk-`,
`ghp_`, `AKIA…`, and similar); a URL's own `token=`/`access_token=`/
`api_key=`/`password=`/`secret=`/`sig=`/`signature=` query parameter (`key=`
only when its value also looks like a credential — long and mixed in case,
digits or base64 punctuation, since a bare `key=` is one of the most common,
least secret-shaped query names in ordinary traffic); and other long,
random-looking strings that are their own standalone token. Only the value is
replaced with a fixed marker — variable names, flags, hosts and paths stay
exactly as written, because that structure is what the judgement reasons
about.

**Precision (JEVADV-29):** a token or path segment that sits inside a
filesystem path or a URL (a long opaque id after `/Volumes/.../claude-501/`,
Claude's own `-Users-name-Projects-repo` session-folder naming, a
`claude.ai/code/artifact/<id>` URL) is never masked, even when it would
otherwise look exactly like a high-entropy secret — only an explicit
secret-named query parameter inside a URL still is. A `<word>_<uuid>` or
`<word>_<hex>` id (`term_<uuid>`, `toolu_…`, `rctx2_<hex>`) is never masked
either: an id references something, it does not grant access to it. Measured
over the owner's own 70,300-command corpus, these two classes — plus URL path
segments — accounted for the large majority of a 13.7% overall mask rate that
was mostly false positives; `src/core/secret_redaction.test.ts` reports the
before/after rate over a synthetic set instead of that real corpus.

This masking runs only on the copy sent to Jev. The local rules that refuse
a force push, a recursive delete or a dropped table always judge the real,
unredacted command, and — as already noted above — nothing written to this
machine's own logs contains the command text either way.

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
the settings panel, by hand or from a proposal: "Search Orca" lists
repositories Orca already knows that your catalog does not, one row per
repository, and you pick its kind (client-site, project, service, support)
before adding it — never guessed for you. This can only propose a
repository Orca has already opened as a worktree; one it has never touched
is invisible to the plugin.

A command run inside a *linked* git worktree — the shape Orca itself
creates, next to the main checkout rather than inside it
(`~/Projects/cineco-frontend-cin-985` beside `~/Projects/cineco-frontend`)
— matches its repository's destination too. When the cwd itself has no
catalog entry, the gate reads the worktree's own `.git` file from disk to
find its main checkout and matches that instead (`src/core/linked_worktree.ts`);
a nested, direct match on the cwd always wins over this fallback, and a
plain sibling directory that is not actually a worktree of the catalogued
repository never matches by name alone.

**Policies.** Standing decisions the team has already made, so nobody is
asked twice — *work goes on a feature branch*, *never write directly to
main*, *anything touching a client's product is confirmed by a human*. A
policy either permits, prohibits, or requires a person; when one covers
what an agent is about to do, that settles it without judging risk at all.
Policies are global by default, and a rule that genuinely belongs to one
project can be scoped to it. A policy also declares its scope: a single
command (the default), how the agent works across many commands — process
scope, e.g. *screenshots get looked at before being called done*, *the
cheapest available model handles a mechanical task* — or already enforced by
a local deny/ask rule before Jev ever runs, e.g. *never rewrite history on a
remote* and *never discard uncommitted work* — local-rule scope. A
command-gate stop never checks a command against a process or local-rule
policy: a process policy describes the workflow that produced the command,
not the command itself, so no shell command can be "the concrete instance"
of it either way; a local-rule policy's real instances are already refused
or asked about by the command gate's own deny-tier rules before the policy
stage runs, so a command that reaches the policy stage naming one only
*mentions* it in quoted data, and Jev cannot honestly answer whether a
mention is "a concrete instance" of a rule that never ran.

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
counts for that command, and a plain subshell stays whole. A redirection
such as `2>&1`, `&>` or `>|` is part of its command, not a separator:

| Rule | Scope | Why |
|------|-------|-----|
| Force push (`--force`/`-f`) | segment, two-level | The pattern spans arbitrary text after `git push`, so whole-string matching let it reach across a separator into an unrelated segment (e.g. `git push origin --delete x && git branch -f main origin/main` was wrongly denied as a force push). |
| Push to a protected branch (`main`/`master`/`production`) | segment, two-level | Same spanning-quantifier reason. |
| `rm -rf /` (or `~`/`$HOME`) | command | No spanning quantifier; matching the whole command is already precise. |
| Discarding uncommitted work (`git checkout`/`git restore`/`git reset --hard`/`git clean -f`) | command, two-level | This check already segments the command on its own and extracts `$(...)`/backtick substitutions, `bash -c`/`eval`/`su -c`/`script -c` bodies, `ssh`'s remote command and `watch`'s command first; pre-splitting again would break that extraction. `git reset --hard`/`git clean -f` used to be their own, separate, quote-blind regex — folded in here so all four subcommands get the same tokenizer and command-position discipline. The rule also reads each segment through the same two-level scan the force-push/protected-branch rows use below, so a reset or clean spelled out through a non-shell interpreter (`python3 -c "...os.system('git reset --hard')..."`) is still caught even though the tokenizer only understands shell syntax. |
| `DROP`/`TRUNCATE TABLE`/`DATABASE`/`SCHEMA` | command | No spanning quantifier. |
| `kubectl delete`/`drain` | command | No spanning quantifier. |
| `terraform`/`tofu apply` | command | No spanning quantifier. |
| `terraform`/`tofu destroy` | command | No spanning quantifier. |
| `curl \| bash`/`sh`/`zsh` | command (mandatory) | This rule matches ACROSS a pipe by design — the whole point is catching a curl piped into a shell. Segment scope would silently disable it. |

A quoted separator (for example `git commit -m "build && test"`) never
splits a segment: the text inside the quotes stays part of one segment,
exactly as a shell would read it.

**Two-level rules: a run denies, a mention asks.** Force push,
protected-branch and discard are all read through the SAME two-level model
(`someSegmentMatches`, `src/core/git_discard.ts`): a match in **command
position** — the segment's own command, `$(...)`/backtick substitutions, a
real shell/login/watch wrapper's command (`bash -c`/`sh -c`/`zsh -c`/`eval`/
`su -c`/`script -c`/`ssh`'s remote command/`watch`'s command, recognised only
at the segment's resolved command position, never as an arbitrary later
token — `grep -n watch "…" f` must not read `watch` as a command just
because the word appears in grep's own argument), or an **interpreter CODE
string** (`python`/`python3 -c`, `node -e`/`-p`/`--eval`, `ruby -e`, `perl
-e`/`-E`, `php -r`, `osascript -e` — these commonly shell out, so they stay
code, never data, even though they are not shell syntax) — still **denies**.
A match that exists ONLY because a quoted argument of some OTHER,
non-executing program stayed visible now **asks** instead: a person decides,
rather than the model being refused outright for a phrase nobody was ever
going to run (`git grep`'s own pattern and `sed`'s script argument are
programs reading data, not commands). A rule's own on/off switch (the panel's
deny-tier toggles) only ever matters once a rule has already decided to deny:
turning it off downgrades that `deny` to `ask`, exactly as before; it never
touches a match that had already resolved to `ask` on its own.

Within a segment, a quoted argument is read the way a shell does: a *single
quoted word* (`"main"`, `"-f"`) is still an ordinary argument and counts as
command position. A quoted argument *with whitespace in it* — a commit
message, a PR body — is opaque to the pattern (no match at all, not even a
mention) ONLY when the program reading it is known to treat that argument as
data, never as something to run: `printf`/`echo`'s own arguments; `git commit
-m`/`--message`/`-F`, `git tag -m`, `git notes add -m`; `git grep`'s pattern
and `git log`'s `-S`/`-G`/`--grep`; `gh`'s `--body`/`-b`/`--title`/`-t`/
`--subject`/`--message`/`-m`, whatever the subcommand; the PATTERN argument
of `grep`/`egrep`/`fgrep`/`rg`/`ag` (its first non-flag argument, or the value
of `-e`/`--regexp`); `jq`'s filter argument; and, for ANY program, a generic
set of text flags — `--body`/`--title`/`--message`/`--description`/
`--comment`/`--text`/`--subject`/`--summary`/`--note`, space-separated or
`=value` (`-m` deliberately stays OUT of this generic set: it is too
overloaded a flag letter across unrelated tools to safely generalise, so it
stays scoped to where it was already allowlisted above). Everywhere else —
including an unrecognised program — a quoted argument stays visible and now
resolves to a mention (`ask`), never silently allowed and never denied
outright. A `$(...)`/backtick substitution stays visible regardless of
quoting (its source text still becomes part of the enclosing command's own
arguments at runtime, so it is always command position), and so does the
script argument of a real shell/login/watch wrapper, read RECURSIVELY
through the same allowlist, so a data position inside a wrapped command
(`ssh host 'git commit -m "git push --force"'`) still goes opaque rather
than the whole wrapped line becoming visible. This closes three live false
positives: a `printf` whose double-quoted text merely spelled out a hard
reset was refused as if that command had run; a command actually run by
another program (`ssh host "git push --force origin main"`, `su -c "git push
-f origin main"`) was waved through as if it were merely descriptive text;
and a mention sitting in a program's own argument (`git grep "git reset
--hard"`, `sed -i 's/git reset --hard//' f`) was hard-denied instead of
asked about.

## Models

Every subagent call (the `Agent` tool) gets a model recommendation before
it starts: Jev reads the task and picks the best fit from your own model
catalog's ladder — the same cheap-judgement trade the command gate makes,
applied to model choice instead of command risk.

**Measurement by default.** Same discipline as skill/tool advice below:
this ships recording what Jev would have picked next to what the subagent
actually ran on, changing nothing you can observe, until there is a real
record to calibrate against.

**Active mode is off by default**, and even once turned on a rewrite
still needs all of the following, checked in order: the active switch
itself; readiness (at least 1000 comparable decisions with a match rate
of 70% or higher); the call's permission mode (only `bypassPermissions`
lets a rewrite return an "allow" decision without overriding what the
person's own permission rules would have produced); and Jev's own
confidence in the recommendation (at least 0.7). Any one of these failing
means the subagent runs on whatever model was already requested.

**Revert.** The same **Revert everything** action (Settings → Jev
Advisor, or the *Advisor: Revert the Claude Code side* command) removes
the three model hooks along with the command gate's four — there is
nothing model-specific to undo separately. It does not delete
`models-catalog.json`: like the destination and policy mirrors, that file
is only ever overwritten by a later mirror, never cleared by this or any
other action.

**Not yet proven end to end.** A live active rewrite — active mode
actually swapping a subagent's model in an installed session — has not
been run yet.

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

### Active skill mode never leaves you with neither

If you do turn skill advice on: the engine's own skill listing is withheld
for a turn only when a skill was actually loaded in its place. Jev picking
nothing, timing out, or its SKILL.md failing to read all fall back to the
listing you'd see with the mod off — never to silence on both sides. The
tool-relevance path is now sampled the same way skill selection already
was, so measurement mode's cost stays bounded on both paths, not just one.
Turning skill advice on before a week of measurement-mode data exists is
still not recommended (see above); doing so anyway is recorded, not
blocked — each decision carries whether the activation metric was actually
met at the time, so an "active but uncalibrated" run stays visible in the
data rather than silent.

## Not ready yet

- Active skill/tool advice is off by default, for the reason above.
- Active model reclassification has not been proven end to end: a live
  rewrite in an installed session has not been run yet (see Models above).

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
