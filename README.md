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

- Verified on macOS. Windows and Linux are implemented and **not tested**.
- Active skill/tool advice is off by default, for the reason above.

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
