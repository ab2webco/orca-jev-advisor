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

**Verify first, before designing anything.** Whether an Orca plugin can
influence which model or agent a pane launches with. A first look at
`orca-oss/src/shared/plugins/plugin-manifest.ts` found no `agentProfiles`
contribution and no `model` field in the plugin manifest surface, though the
plugin list projection does mention agent profiles and
`PLUGIN_AGENT_PROFILE_MAX_BYTES` exists in
`src/main/plugins/plugin-artifact-validation.ts` — so the capability may exist
somewhere else, or may not exist for plugins at all. **If Orca does not expose
it, this cannot be a plugin feature and the honest answer is to say so rather
than build a scoring layer whose verdict nothing can act on.** That failure
mode already happened here twice: switches nobody could set, and a panel
control no decision read.

**Then, and only then:** what the effort signal is measured against. A model
choice that is never checked against how the task actually went is a preference
dressed as a decision — the same trap as an unmeasured threshold. Measurement
mode first, active mode only once there is data, exactly as the skills mod is
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
