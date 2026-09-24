# Backlog

Things worth doing, not started. Each entry says what it is, why, and the
first thing to verify — because several ideas in this project died on a
contract nobody checked first.

---

## Jev picks the agent and model by the effort a task needs

**What.** Orca launches agents. Today the model is chosen by hand. Jev already
scores effort for two other things — which skill fits a prompt, which tool fits
a turn — so scoring "how much model does this task need" is the same shape,
not a new capability. A small, well-specified task goes to a fast model
(Haiku, Sonnet); a large or ambiguous one goes to a stronger one (Opus, Fable).
The choice should also be able to reach the other accounts configured in Orca,
not only the Claude ones.

**Why.** It is the same goal as the rest of this plugin stated plainly by its
owner: speed with fewer tokens. A large model is slow at deciding and expensive
in context; sending a mechanical task to it wastes both. Picking the model is
itself a decision, and decisions are what Jev is for.

**Feasibility: answered, and it is no — today.** Traced through Orca's source
with citations:

- `contributes.agents` exists (`plugin-manifest.ts:142`) but is **inert**. Its
  schema is a bare `{ path }` (`plugin-content-pack-contributions.ts:55`), and
  no parser for that file exists anywhere — compare
  `parsePluginVmRecipeArtifact` (`plugin-vm-recipe-artifact.ts:40`), which is
  what a real one looks like. Its only consumer is a byte-size check
  (`plugin-artifact-validation.ts:82`). A plugin can declare an agent profile
  and nothing will ever read it.
- A plugin **automation** can choose the agent BINARY but never a model:
  `pluginAgentAutomationSchema` carries `provider` and no model field
  (`plugin-automation-contribution.ts:65`).
- The model is decided from **global settings**, per agent type, not per task:
  `resolveTuiAgentLaunchArgs` reads `settings.agentDefaultArgs`
  (`tui-agent-launch-defaults.ts:82`), and chat-mode options come from
  `settings.nativeChatSessionOptions`.
- No plugin surface reaches that decision. The host API's whole method table
  (`plugin-host-method-bindings.ts:71-166`) has nothing for it, and
  `settings.set` is scoped to the plugin's own namespace.

The one adjacent capability: `terminal.sendText` could type a CLI's own
`/model` command into an ALREADY-RUNNING pane. That is reconfiguring a session
that already started on whatever Settings chose — not choosing at launch — and
building on it would be a workaround, not a feature.

**So the question stops being "can a plugin do this" and becomes "what do we
add to Orca", because Orca is ours.** Three candidates, smallest first:

1. Give `pluginAgentAutomationSchema` a model/session-options field and thread
   it through `plugin-automation-managed-fields.ts:66` into
   `headless-workspace-create.ts:43`, beside `startupAgent`.
2. Make the per-launch override reachable from a plugin. `agentArgs` already
   exists as a parameter on `LaunchAgentInNewTabArgs`
   (`launch-agent-in-new-tab.ts:37`) — it simply has no plugin-facing entry
   point. A capability-gated host method, gated as `terminal.sendText` is,
   would close it.
3. Actually implement the agent-profile artifact: a
   `parsePluginAgentProfileArtifact` mirroring the VM recipe one, with a schema
   carrying a model id and an account hint, and a registry the launch UI reads.

Option 2 is the smallest and the most general. Option 3 is the one that makes
`contributes.agents` mean something instead of being a declared-but-dead
contribution point.

**Accounts.** Orca already models the other providers as distinct agent
binaries — `claude`, `codex`, and `claude-zai`, the z.ai/GLM wrapper with its
own isolated config directory (`tui-agent-config.ts:12-70`). So "route to the Z
account" is expressible as an agent identity today; what is missing is only the
model choice within one, and any automatic routing at all.

**Then, and only then:** what the effort signal is measured against. A model
choice never checked against how the task actually went is a preference dressed
as a decision -- the same trap as an unmeasured threshold. Measurement mode
first, active mode only once there is data, exactly as the skills mod is
sequenced.

---

## Policy seeds cannot be updated once imported

The import merges by id and skips what you already have, so a corrected
baseline never reaches anyone who imported the old one. Needs a way to see what
differs and choose, never a blind overwrite — that would destroy edited
policies.

---

## Test isolation is opt-in, and it has failed three times

`mirrorCatalogAndPolicies` and `activate()` spawn subprocesses that write to the
real `~/.config/orca-supervisor/`, regardless of any fake host injected at the
module boundary. Three separate runs reached the developer's real files; one
destroyed their policies, recovered from Orca's plugin storage. The current
guard is an `options.mirror` override each test must remember to pass. The
durable fix is in `src/core/paths.ts`: refuse a real production path under test,
or honour an env override on every platform rather than XDG on Linux only.

---

## Nobody has run this on Windows or Linux

Implemented and unit-tested on both; executed on neither. The Windows path in
particular carries the `shell: true` decision for `.cmd` resolution and the
current-directory exposure that comes with it, and a symlink question that Node
answers differently there.

---

## Measurement-mode sampling for the skills mod

Two Jev calls per prompt, on every prompt, for data that is invisible until the
thresholds exist. Sampling a fraction would collect the same distribution at a
fraction of the load. Do this only after the mod has run long enough to know
what the distribution looks like — sampling a thing you have never observed is
how you miss the tail.

---

## Panel: cross the skills-mod switches against the copy on disk

**What.** `modSkillsLine()` in `adapters/orca/panels/config.html:1759` returns
"not installed" when `modCopy.exists` is false, and the switches elsewhere on
the same panel read `active`/`activeTools` from
`~/.config/orca-supervisor/mod-skills-config.json`. Nobody crosses the two, so
the panel can show switches turned ON while the mod is not on disk at all —
switches commanding nothing.

**Why.** Observed after successive updates: `modCopy exists:false` across all
four config roots while the config said `active:true, activeTools:true`, and
`mod-skills-measurements.jsonl` had never been created, meaning the mod had
never run on that machine. Neither the panel nor any log said a word.

**First thing to verify.** Whether the update path reinstalls the copy at all,
or only the first install does — `adapters/orca/install-claude-integration.mjs`.
The panel warning is the symptom; a copy that survives an update is the fix.
Both are wanted: make the copy synchronous on activation, and have the panel
say so when the two disagree.

---

## Skills mod: sample instead of measuring every prompt

**What.** Measurement mode makes two Jev calls per prompt (rank every skill,
then re-read the top three) on every prompt of every session, indefinitely.

**Why.** It is a permanent cost for data nobody has put a finish line on.
"Not ready yet" has no metric and no date.

**First thing to verify.** `src/core/ab_benchmark_config.ts` already has the
mould — `shouldSample` plus a daily cap, config-gated and fail-open. Check it
applies cleanly to `adapters/claude/mod-skills/hooks/index.ts` before writing
anything new. The activation metric has to be stated too (for example N >= 1000
records and precision@1 above a named threshold against what the model actually
loaded), otherwise active mode stays a promise with no path.

---

## Windows: test the symlink path once, or declare it unsupported

**What.** `modLinkWarning` has never been observed rejecting anything. The
README already admits it.

**Why.** Either it works and nobody has seen it, or it is dead code pretending
to be support. Both are cheap to resolve and only one is honest.

---

## Upstream: Claude Code has no event for a refused hook ask

**What.** Under `bypassPermissions`, neither Esc nor answering "No" to the
hook's own dialog fires `PermissionDenied` — that event belongs to the
permission system, which bypass mode never invokes.

**Why.** The whole history of `gate-approvals.jsonl` reads 51 approved and 0
rejected: the `rejected` branch of `gate-outcome.ts` is dead code in that mode,
and calibration only ever learns from approvals. The local mitigation
(`notRun`, v0.3.1) is correct and its semantics must not be changed — but the
missing event is upstream and should be reported as such.
