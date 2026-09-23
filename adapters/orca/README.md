# orca-jev-advisor (Orca plugin)

The `orca-supervisor` project's Orca adapter: the container for a
Jev-backed (TypeSafe) decision layer that runs *inside* Orca,
as a plugin, instead of as a separate CLI. It only sees its own
worktree for direct actions (`terminal.sendText`, `workspace.readContext`),
but maintains a cross-worktree board through `storage` and the
only global event that exists (`agent.status.changed`).

It doesn't duplicate logic: all the decision-making (Jev, the three
verdicts, the typed storage, the log) lives in `../../src/core/` and is
the same one used by the `tools/` CLIs and the Claude Code hook in
`adapters/claude/`. This directory is just Orca's surface: the manifest,
the worker, and the two panels.

## What's here

```
orca-plugin.json           manifest: panels, commands, events, capabilities
main.mjs                    worker: activate(host) -> { commands, teardown }
write-secret-mirror.mjs      sidecar: writes/reads the key mirror (see below)
panels/board.html            navigation panel: live board table
panels/config.html           settings panel: key, catalog, policies, thresholds
icons/advisor.svg            icon used by both panels
```

## The three commands

- **`advisor.decide`** — receives `{ actions: string[] }`, runs
  `decideDestination` (policy first, risk after, same as
  `tools/decide.ts`) on each one, logs each verdict in the log
  (`src/core/log.ts`), and shows a notification with the summary.
  Returns the array of decisions.
- **`advisor.board`** — returns the current contents of `storage`'s
  `board`: the `{worktreeId, paneKey, state, receivedAt, updatedAt}`
  table that `main.mjs` keeps updated by listening to
  `agent.status.changed`.
- **`advisor.doctor`** — checks four things and returns
  `{ok, checks[]}`:
  - `api-key`: not just that there's a resolved key (`secrets` or the
    environment/file fallback) -- it makes a real, minimal call to
    Jev and reports what actually happened: valid key (Jev responded),
    rejected key (401/403), no network (timeout or connection error),
    or no key. A dead key shows up red here, not green.
  - `secret-mirror`: whether the mirror file (see the next
    section) matches what's currently in `secrets`.
  - `orca-cli`: whether the `orca` binary responds to `status --json`
    (`process:spawn` capability -- nothing is ever sent to a real
    terminal).
  - `catalog`: whether the catalog stored in `storage` has a valid
    shape.

## The key mirror (`~/.config/orca-supervisor/env`)

The settings panel stores the TypeSafe key in `secrets`
(encrypted by Orca with Electron's `safeStorage`), but the `tools/`
CLIs and `adapters/claude/gate-bash.ts` run as plain Node, outside
of Electron, and can't read `secrets` -- it's a real boundary, not an
oversight. That's why, every time the key changes in `secrets` (saved
or deleted from the panel) and also when the worker activates,
`main.mjs` mirrors its value to `~/.config/orca-supervisor/env`
(`TYPESAFE_API_KEY=...`, the same fallback already documented by
`src/core/secrets.ts`), with **`0600`** permissions and an atomic
write (temp file + `rename`). When the key is deleted, the mirror is
deleted too (or just that line is removed from it, if the file had
other content).

The worker can't write that file itself: its permission sandbox
only lets it read its own plugin root (measured, not assumed --
writing there threw instead of resolving). The write instead runs in
`write-secret-mirror.mjs`, a clean child process (`mandoSinValla`, the
same `/usr/bin/env -u NODE_OPTIONS` pattern already used by
`orca-wa-inbox/main.mjs` for this same class of problem). The key
crosses to that child only via **stdin**, never via argv (visible in
any `ps`) nor in any `orca.log`.

This means that, as of this version, the panel is the only place
where the user writes the key -- but the file still exists on
disk, in plain text, with the permissions of a file only its owner
can read. Anyone who'd rather not have that mirror on disk should
know this before saving the key from the panel.

## How the board gets filled across worktrees

`terminal.sendText` and `workspace.readContext` are **limited to
the plugin's active worktree** -- that's verified, not an assumption.
`agent.status.changed`, on the other hand, is the only global event: it
carries `worktreeId` in its payload regardless of which worktree the
worker instance that receives it is running in. Since `storage` doesn't
appear on the list of capabilities limited to the active worktree, this
plugin treats it as the shared channel: every instance that receives
the event writes the same `board` key, so any worktree that opens the
panel sees the state of all of them. Crossing into *action* on another
worktree (not just reading) would still need `process:spawn` to invoke
`orca terminal send` from outside -- that's exactly what this skeleton
does NOT do yet (see below).

## What's built

- The Jev client, the three decision families, the typed store, the
  log, and key resolution -- all in `../../src/core/`, with
  explicit guards and no `any` anywhere.
- The manifest declares panels, commands, events, and capabilities,
  and every path it declares (`main`, each `panel.entry`, each `icon`)
  exists on disk -- verified with a script that reads the JSON and
  checks each path.
- `main.mjs` subscribes to the three events, keeps the board
  updated, exposes the three commands, and its `teardown` cancels the
  three subscriptions -- nothing is left running after Orca kills the
  worker.
- The two panels are plain HTML+CSS+JS, no build, no external
  request, readable at narrow width (visually tested against 320px of
  content width, the tightest case for a side panel).

## What's NOT built (and why)

- **The panel ↔ worker bridge is a documented proposal, not a
  confirmed contract.** The two HTML files assume a `postMessage`
  protocol (`advisor:ready`, `advisor:requestBoard`,
  `advisor:board`, `advisor:requestConfig`, `advisor:config`,
  `advisor:saveSecret`, `advisor:clearSecret`, `advisor:saveConfig`,
  `advisor:saveResult`) because the panel runs in a sandboxed iframe
  with an opaque origin and that's the only channel possible. There
  was no access to the real runtime that instantiates an Orca panel to
  confirm the exact names of those messages -- adjust them here and in
  `main.mjs` as soon as they're confirmed. Today `main.mjs` doesn't
  have the side that listens for those messages: it only exposes the
  three manifest commands.
- **The activation contract (`activate(host) -> {commands, teardown}`)
  is a reasoned assumption, documented in `main.mjs`'s header**,
  not something verified against Orca's runtime. The 13 host methods
  (`workspace.readContext`, `terminal.sendText`, `notifications.show`,
  `storage.*`, `secrets.*`, `settings.*`, `events.subscribe`) are
  verified; how Orca invokes `activate` and dispatches an invoked
  command to the `commands` map is not.
- **No automations.** The manifest leaves `contributes.automations: []`
  with a note (`_automationsNote`) explaining that, when one is
  designed (for example, a periodic review of the log or the board),
  it goes there.
- **No action crosses worktrees yet.** `advisor.decide` judges
  actions; it doesn't execute them on any worktree. Executing on
  another worktree would require spawning `orca terminal send` via
  `process:spawn` -- the capability is declared because it's
  anticipated, but it isn't used anywhere in this skeleton (and this
  task explicitly asked not to execute `orca terminal send` /
  `terminal create`).
- **None of this is installed or loaded in a real Orca
  configuration.** Neither `~/.claude/settings.json` nor Orca's
  configuration were touched.

## How to load it as a development plugin

This wasn't run as part of this task (installing the plugin was
out of scope); these are the steps as documented by the reference
manifest (`orca-wa-inbox`) for a plugin loaded from disk:

1. Open Orca's plugin settings and add this folder
   (`adapters/orca/`) as a development plugin path
   (`devPluginPaths` in Orca's configuration, following the pattern
   seen in other plugins).
2. Orca should read `orca-plugin.json`, validate that `main.mjs`
   exists, and offer the plugin in the list of installed/in-development
   plugins.
3. Configure the TypeSafe key from the settings panel
   (`Jev Advisor` under settings) -- that stores it via `secrets`, not
   on disk.
4. Invoke `advisor.doctor` first to confirm that the key, the `orca`
   CLI, and the catalog are in order before using `advisor.decide`.

## Node and dependencies

Node ≥24, `"type": "module"`, zero dependencies, no build step.
`main.mjs` imports `.ts` files directly from `../../src/core/` thanks
to Node's native "type stripping" -- the same mechanism already used
by `tools/*.ts` and `adapters/claude/gate-bash.ts`.
