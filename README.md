# orca-supervisor

Multi-project supervisor that routes an "assignment" (a natural language
request: an outage, a support message, a ticket, a change to a client's
site, a blocked agent) to the correct Orca terminal,
using Jev (TypeSafe) for judgment and TypeScript code for facts.

Zero dependencies, zero build. Each `.ts` file runs directly with
Node 24 (`node src/file.ts`), thanks to native "type stripping".

## Two adapters, one core

This repository is a single product with two thin surfaces over a
shared core, and neither of the two can do the other's job:

- **Orca plugin API** — 13 host methods, `agent.status.changed`, panels,
  `secrets`, `process:spawn`. Sees all worktrees. Cannot touch Claude
  Code's prompt pipeline, tool calls, or compaction.
- **Claude Code** — `settings.json` hooks (`PreToolUse`, etc.) and, later,
  function hooks (`prompt.attachment` / `prompt.submit`).
  Can filter commands, route skills, and replace compaction. Only
  sees its own session.

```
src/core/        # everything that decides: jev, decisions, store, log, secrets, catalog, policies
adapters/orca/   # the Orca plugin: manifest, main.mjs, panels
adapters/claude/ # the Claude Code side: the PreToolUse gate, later the prompt hooks
```

`src/core/` never does extra I/O: each module receives what it needs as a
parameter (the API key, the `storage` host, the `secrets` host) instead
of reading the environment or disk on its own. That's what lets the
same code serve both the Claude Code gate and an Orca plugin
worker that can die and restart at any time
(`adapters/orca/main.mjs`).

See `adapters/orca/README.md` for the Orca plugin (what is built, what
isn't, and how to load it as a development plugin).

## The three commands

```bash
# 1. Read-only: shows Orca's live state cross-referenced with the catalog.
node src/supervisor.ts --self-check

# 2. Dry run: decides what it would do with an assignment, without touching any terminal.
#    If there is no TYPESAFE_API_KEY, it prints exactly the payload that would
#    have been sent to Jev, instead of calling the network.
node src/supervisor.ts "the whatsapp bot stopped responding"

# 3. Real execution: only when the decision was 'act' and you trust the result.
node src/supervisor.ts "the whatsapp bot stopped responding" --execute
```

`--execute` is the only way for something to actually be sent to a terminal.
Without that flag, everything is a dry run (the default everywhere).

## How to add a destination

Edit `catalog.json` and add an object to the `destinations` array:

```json
{
  "id": "my-destination",
  "label": "Human-readable destination name",
  "kind": "service",
  "worktreePath": "/exact/path/to/the/worktree",
  "terminalTitleMatch": "text that appears in the terminal title",
  "autonomy": { "actThreshold": 0.9, "confirmThreshold": 0.6, "maxAutoDelicateness": 2 }
}
```

- `kind` is one of: `service`, `client-site`, `project`, `support`.
- `worktreePath` must match EXACTLY the `path` field returned by
  `orca worktree ps --json` (verify it with `--self-check`).
- `terminalTitleMatch` is optional: if the worktree has several terminals,
  it filters by a fragment (case-insensitive) of the title. If it doesn't
  match any of them, it falls back to any terminal in the worktree.
- `autonomy.confirmThreshold` and `autonomy.actThreshold` must be in
  `(0, 1]`, and `actThreshold >= confirmThreshold`. They are compared
  against Jev's `unambiguousDestination` response (how clearly the
  assignment points to a single destination, not how risky it is to act).
  Below `confirmThreshold` the supervisor always asks a human;
  between the two thresholds, it asks for confirmation before acting; at or
  above `actThreshold`, it acts directly (if it also passes the
  delicateness axis and the handle is in a condition to receive the
  instruction).
- `autonomy.maxAutoDelicateness` is an integer from 0 to 4 (level index,
  0-based -- as the real API returns it, measured live; scale defined in
  `src/jev.ts`, from "trivial" (0) to "critical" (4)). Above that level,
  `decide.ts` always asks for a human, **no matter how unambiguous
  the assignment was** — clarity and risk are independent axes,
  composed in code, never mixed into a single question to the model (see
  "Why two axes" below).
  - **Policy for `client-site`**: a client site should never
    receive a write without a human approving it. That's why every
    `client-site` destination in this catalog uses
    `maxAutoDelicateness: 0`: since the delicateness score is a
    continuous average over the scale, it only ever equals exactly 0
    when the model is completely certain the assignment is trivial,
    something that in practice almost never happens for a client's
    site. The result is that the `act` action is effectively
    unreachable for those destinations: at most they reach `confirm`.

The 4 rows shipped in `catalog.json` are a real seed from this
machine (see the `_note` field in the file) just so the skeleton has
something to route. Replace them with your own destinations.

## Why two axes (and not one)

It was measured live against the real Jev API that a single compound
question ("is it safe and appropriate to act without confirming?") never
separates anything: it gave 0.19–0.44 in absolutely every case
tested, both clear and ambiguous ones, because it mixed ambiguity,
reversibility, and external impact into a single number. It was
replaced with two atomic questions evaluated in parallel:

- `unambiguousDestination` (`noul` type): only asks whether the
  assignment points to a single destination without ambiguity. Measured:
  0.78–0.82 in clear cases, 0.09–0.43 in ambiguous cases — a gate at 0.6
  got it right 6/6. Neither the choice confidence (`choice.confidence`)
  nor the margin between the first and second place work as a
  substitute: both failed on real cases where the assignment was
  ambiguous between two client sites.
- `delicateness` (`score` type, kept as-is): it does discriminate well
  on its own and is left as a question to the model; what changed is
  that the risk composition (comparing against `maxAutoDelicateness`) is
  now code, not the model. Measured live: the real API returns `legend`
  as an object that maps each level index (as text, `"0"`..`"4"`) to its
  description, not as a plain string, and `score` is the continuous
  average over those indices (e.g. 2.85 for "the bot isn't responding"
  on the 0..4 scale of this catalog).

## Where the API key goes

Resolution order (the first one that exists wins):

```bash
# 1. Environment variable (preferred).
export TYPESAFE_API_KEY="sk-..."
```

```
# 2. Development alternative: a single-line file.
# ~/.config/orca-supervisor/env
TYPESAFE_API_KEY=sk-...
```

Without either of the two, `supervisor.ts` never calls the Jev network: it
instead prints the exact payload it would have sent, so you can
review it before configuring the key. The key is never printed, never
passed to a shell subprocess, and never appears in an error message.

**The file `~/.config/orca-supervisor/env` is a development patch,
not a production solution.** Storing a key in plain text on disk
is acceptable for testing this skeleton locally, but the Orca plugin
(`adapters/orca/`) asks for the key in its settings panel and stores it
using Orca's `secrets` capability — never in a plain text
file. `src/core/secrets.ts` implements exactly that precedence order:
the `secrets` store first (only inside the plugin), the
environment variable next, the development file last.

## Architecture (at a glance)

### `src/core/` — the core shared by both adapters

- `src/core/jev.ts` — generic Jev HTTP client: request/
  response types, hand-written guards, a retry with backoff only on
  429/529, and a hard latency budget via `AbortController`. Receives
  the key as a parameter; never reads the environment or disk.
- `src/core/decisions.ts` — the three decision families, each a pure
  function over already-obtained responses: `decideDestination`
  (policy first, risk after — the original `decide()` from
  the destination decision), `decideAction` (the command gate's axes
  gate, the same one used by `adapters/claude/gate-bash.ts`), and
  `scoreComplexity` (a `score` question that maps a task to a
  capability level).
- `src/core/store.ts` — typed facade over the `storage` keys that
  this plugin owns: `catalog`, `policies`, `board`, `log`, `config`.
  Each read validates and returns a typed value or a documented default;
  a corrupted value never throws inside the worker.
- `src/core/log.ts` — the decision log, append-only and bounded (the
  oldest entries get trimmed). For every decision it stores when, what
  was judged, Jev's raw responses, the verdict, and whether a human
  overrode it later. This is what makes the thresholds calibratable.
- `src/core/secrets.ts` — resolves the TypeSafe key (see the previous
  section); never prints it or includes it in an error.
- `src/core/catalog.ts` — loads and validates `catalog.json` (moved
  here from `src/catalog.ts`; still used by `supervisor.ts`'s routing
  engine).
- `src/core/policies.ts` — loads and validates a policies file
  (`{id, rule}[]`), loaded once and shared by every consumer.

### The routing engine (`node src/supervisor.ts`)

These files are a separate feature -- routing an assignment to the
correct terminal by cross-referencing the catalog with Orca's live state,
with its own set of 5 questions to Jev -- and were not touched in this
pass beyond moving `catalog.ts` and `apiKey.ts` (see below):

- `src/orca.ts` — typed wrappers over the `orca` CLI (worktree ps,
  terminal list/wait/send/read), with `runOrca` validating the
  `{id, ok, result|error}` envelope.
- `src/projection.ts` — cross-references catalog + live state into a
  small, deterministic projection; every derived fact (idle minutes,
  which handle corresponds to which destination) is calculated here,
  never asked of Jev.
- `src/jev.ts` — Jev client *specialized* for routing:
  builds the projector's 5 parallel questions (`encargoType`,
  `destination`, `targetAgent`, `delicateness`, `unambiguousDestination`)
  and validates the response. Different from `src/core/jev.ts`, which is
  generic and doesn't know about any domain question.
- `src/decide.ts` — pure function: Jev responses + destination
  thresholds → `{action, destinationId, handle, instruction, reason,
  ambiguityNoul, delicatenessScore}`. Composes two independent axes
  (ambiguity, delicateness) plus the handle's readiness; never derives
  the decision from a single question to the model.
- `src/act.ts` — waits for the terminal to be ready and sends the text;
  `execute:false` (the default) only describes the commands.
- `src/supervisor.ts` — the CLI. It's the only file that prints anything.
  (`src/apiKey.ts` was removed: it now imports `resolveApiKey` from
  `src/core/secrets.ts`, which does exactly the same thing for this use
  case plus the `secrets` precedence when running inside the plugin.)

### There are no CLI entry points

There used to be three (`tools/ask-or-act.ts`, `tools/policy-gate.ts`,
`tools/decide.ts`), written before the plugin existed so the decisions
could be exercised against the real API from a terminal. They are gone.

Nothing in the product ever called them, and they had started to drift:
`ask-or-act.ts` still carried its own copy of a three-axis risk rule that
measurement later showed to be wrong — it would have shipped advice the
gate itself no longer follows. Three ways to make the same judgement means
three things to keep in step, and they did not stay in step.

What they did is now reached through the plugin: the `advisor.decide`
command judges one or more described actions, and the Bash gate judges
commands automatically without anyone typing anything.

### `adapters/claude/` — the Claude Code gate

- `adapters/claude/gate-bash.ts` — the `PreToolUse` hook (formerly
  `hooks/gate-bash.ts`). Its three levels and its local pattern lists
  (`OBVIOUSLY_SAFE`, `NEVER_SILENTLY`) remain exactly the
  same -- they are measured and correct, including that `git branch`
  only matches its read-only forms (`-D`/`-d`/`-M`/`-m` do NOT
  belong on the safe list and therefore fall through to Jev or to
  manual confirmation, never executed silently). What changed is that
  the third level (the call to Jev) now uses
  `buildActionGateQuestions` / `decideAction` from
  `src/core/decisions.ts` and `callJev` / `resolveApiKey` from
  `src/core/`, instead of having its own copy of the HTTP client and
  thresholds.

### Cross-platform compatibility (Windows/Linux/macOS)

This development machine is macOS (`darwin`). Everything marked
"verified" below was actually tested in this environment; the rest is
reasoned design against the official documentation and
`claude-code.d.ts`, but **untested** -- it's stated as such instead of
being taken for granted.

**Verified on macOS (darwin):**
- The `PreToolUse` hook in `gate-bash.ts` runs in exec form (`{type:
  "command", command: <node>, args: [<path to the gate>]}`, without a
  shell), even with a path that contains a space -- tested with
  `execFile` directly. Measured real latency: 20 runs, mean 78.2ms,
  range 66-92ms for the fast path (`OBVIOUSLY_SAFE`).
- `resolveNodeCommand()` distinguishes real Node from Electron-as-Node
  via `process.versions.electron`; in this environment it uses
  `process.execPath` directly (the verified path, not the fallback
  one).
- The key mirror (`adapters/orca/write-secret-mirror.mjs`) writes
  with `chmod 0600` and achieves it on this POSIX filesystem.
- `src/core/paths.ts` was tested with `process.platform` **simulated**
  as `win32`, `darwin`, and `linux` (not just this machine's real one):
  `resolveConfigDir`/`resolveCacheDir` correctly resolve all three,
  with and without `APPDATA`/`LOCALAPPDATA` present.
- The mod's own home/config/cache helper (`adapters/claude/mod-
  skills/hooks/runtime.ts` -- can't import `node:path`/`node:os`
  because the hook sandbox doesn't have Node) was tested with
  simulated environment variables for the three cases: POSIX (`HOME`),
  Windows with `USERPROFILE`+`APPDATA`+`LOCALAPPDATA`, and Windows
  without `APPDATA`/`LOCALAPPDATA` (derives `AppData/Roaming`/
  `AppData/Local` from `HOME`), and the no-home-at-all case (fails
  open: default key/language, no exception).
- `sidecarEnv()` (strips `NODE_OPTIONS` from the `env` that `execFile`
  receives, without `/usr/bin/env`) was tested on macOS.

**Designed for Windows and Linux, NOT tested on those real systems:**
- Whether the exec-form hook actually receives and executes `args`
  this way in Claude Code running on Windows or Linux.
- Whether `chmod` on Windows fails the way expected (the code
  attempts it and never treats it as fatal, but there is no real
  Windows machine to confirm what `fs.stat().mode` reports there
  afterward).
- Whether `%APPDATA%`/`%LOCALAPPDATA%` are populated the way assumed in
  a real Windows installation (only tested with simulated values).
- Any mixed path separator (`/` inside a path that starts
  with `C:\...`, as constructed by this code) against a real Windows
  `fs` -- it's assumed Windows accepts it (documented operating system
  behavior), but it wasn't run against a real Windows machine.
- Linux has nothing specific different from macOS in this code (both
  are the same POSIX branch in `src/core/paths.ts`), but none of
  this was run on a real Linux machine either.

If another dev installs this on Windows or Linux and something on this
list fails, it's exactly what this section predicted could fail without
being able to test it here.

### `adapters/orca/` — the Orca plugin

See `adapters/orca/README.md`.
