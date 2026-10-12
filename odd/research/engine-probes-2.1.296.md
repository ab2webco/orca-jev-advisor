# Engine probes on Claude Code 2.1.296 (track M0)

Research for the memory module (M8–M11), the steward pre-cold tier (S) and
the typing measurement (K0), 2026-10-12. Every answer below comes from a real
session on the installed engine (`claude --version` → `2.1.296 (Claude Code)`),
not from the declarations. The probe mods lived in the session scratchpad and
were deleted afterwards; none of their code is in the repository.

Paths are written with placeholders: `<config>` is `$CLAUDE_CONFIG_DIR` (an
Orca account folder), `<repo>` is the main checkout, `<wt>` a git worktree of
it, `<scratch>` the scratchpad.

## TL;DR

| Probe | Answer | Consequence |
|---|---|---|
| a. `tool.call` answers an MCP call without `next` | **Yes**, with a **string** or an **array of content blocks** (both observed). The model reads it as the tool's result. An object result (`{ content: [...] }`) is rejected with a `tool_use_error`. No permission rule is needed. Engram is never called. | M11's intercept works: answer `{ result: '<text>' }` and spool. Return a string or an array, never an object. |
| b. `$.mcp.call` server name | The **name the session connected**: `engram` for the user-scope server, `plugin_engram_engram` (or `plugin:engram:engram`) for a plugin-provided one. Only one exists at a time: the engine suppresses the plugin copy when a manual `engram` exists. `$.mcp.call` **is subject to permission rules**; without an allow rule a headless call is refused. | M1 takes the server from `$.tool.list()` names, never a constant. A refusal is its own state (`permission`), not "Engram down". |
| c. Section carrying MCP instructions | **None.** No `prompt.section` carries them. They arrive as a **`prompt.attachment` of type `mcp_instructions_delta`**. | M11 trims Engram's instructions in `prompt.attachment{type:'mcp_instructions_delta'}`, not in `prompt.section`. |
| d. Auto-memory dir for a worktree session | `<config>/projects/<slug of the main checkout>/memory/`, keyed by **`$.session.repo().root`**, not the worktree cwd. Transcripts stay under the **worktree's** slug. | M10 builds the dir from `$.session.repo().root` (fallback `$.session.cwd()`), as memory-fork does with cwd but corrected for worktrees. |
| e. `$.session.compact` from `prompt.submit` / idle timer | `prompt.submit`: **No**, refused by a host check in both headless and interactive. Idle timer (`$.clock.after`): **Yes in an interactive session**, refused in headless (`-p`/SDK). Measured: 39,033 → 6,246 tokens in 8.5 s, reusing the warm cache (31,945 cache-read tokens). | S (pre-cold) is viable as designed: a timer re-armed per main turn, compaction while the cache is warm. The "on return" variant at `prompt.submit` is impossible. The engine carries its own flag-gated idle compaction (see Side findings), so S must not race it. |
| f. Cache signals at turn end and on resume | Turn end (`classic.Stop`, `turn.complete`): **no 1h/5m split**, no TTL. Resume: `classic.SessionStart` carries `seconds_since_last_response`, `context_tokens`, `prompt_cache_likely_expired`, `estimated_cache_write_usd`, **but not `cache_ttl`**. `prompt_cache_warm` and `cache_ttl` come only with a **`classic.PostModelSwitch`**, which fires on resume only when the model changes. | The TTL still needs the transcript tail (cache-clock's `readTtl`). Resume decisions can use `prompt_cache_likely_expired` directly. |
| g. `prompt.edit` in headless | **No.** 0 events in every `-p` run (prompts arrive with `origin.kind: "sdk"`). In an interactive session it fires once per keystroke (`origin.kind: "composer"`). | K0 must measure inside real interactive sessions (Orca terminals), never from a `-p` harness. |

## Method

- **The d.ts.** The engine writes its declarations beside a mod it loads from
  a folder the person owns, but only while the plugin-dir watch is on. The
  watch is off in headless sessions (`CLAUDE_CODE_PLUGIN_DIR_WATCH ?? !nonInteractive`
  in the engine), so `claude --plugin-dir <mod> -p ok` alone writes nothing.
  `/plugin-types` is not available in `-p` either. What worked:

  ```sh
  CLAUDE_CODE_PLUGIN_DIR_WATCH=1 claude --plugin-dir <scratch>/m0-probe --model haiku -p "Reply with the single word ok."
  ```

  Debug log: `type root of m0-probe at <scratch>/m0-probe/.claude-plugin/types:
  entries claude-code, claude-code-tools, claude-code-mcp; wrote
  .claude-plugin/types/claude-code/index.d.ts, .claude-plugin/types/claude-code-tools/index.d.ts, ...`.

  New in 2.1.296: the built-in tools' inputs (`BuiltinToolInputs`) moved out
  of `claude-code` into `claude-code-tools/index.d.ts`. With only the core
  file, `npm run typecheck` failed on `hooks/index.ts:2851-2852` (the `Agent`
  call's `name`, `description`, `prompt`, `model` became `unknown`). The fix
  copies both engine files verbatim
  (`adapters/claude/mod-skills/claude-code.d.ts`, `claude-code-tools.d.ts`)
  and adds the tools file to both mod tsconfigs. `npm run typecheck` is clean.
- **The probe mod.** One plain-JS hooks module, `hooks/register.js`, with a
  mode read from `M0_MODE`. It logged every event below to a JSONL file in
  the scratchpad and returned `next(e)` unchanged everywhere except the
  probed `tool.call`.
- **Isolation from Engram.**
  - The first four sessions used full user settings: three d.ts runs in
    `<scratch>/m0-probe` and one `/plugin-types` attempt in
    `<scratch>/m0-types`. The user-scope `SessionStart`, `UserPromptSubmit`
    and `SessionEnd` hook scripts of Engram ran in them.
  - Those hooks recorded four sessions in Engram (three under project
    `m0-probe`, one under `m0-types`) and their prompts: `Reply with the
    single word ok.` three times, and the `/plugin-types <scratch>/m0-types`
    line once.
  - The model made **no** Engram tool call in those sessions. Their
    transcripts hold two `Bash` tool uses and nothing else.
  - The Engram MCP server runs an autosync to a remote server, so those
    records may have left the machine. Nothing was deleted in Engram.
  - Every probe after that ran with `--setting-sources project,local`, which
    drops those settings hooks. The Engram MCP server came from
    `--mcp-config` or from a shim plugin without hooks.
  - The probe's `tool.call` answered `mem_save` itself and denied every other
    Engram write tool. The only call that reached Engram after the first
    four sessions was `mem_current_project`.
- **Models.** Haiku 5.5 everywhere. The whole probe set cost about $0.05 at
  list price.

## a. `tool.call` answering an MCP tool without `next`

Code shape:

```js
on('tool.call', async ($, e, next) => {
  if (e.tool === 'mcp__engram__mem_save' || e.tool === 'mcp__plugin_engram_engram__mem_save') {
    return { result: 'M0-PROBE: queued for the memory module, not sent to Engram' } // no next
  }
  if (ENGRAM_WRITE.test(e.tool)) return { deny: 'M0 probe: Engram writes are blocked' }
  return next(e)
}).catch(() => ({ deny: 'M0 probe hook failed; blocked for safety' }))
```

Command (run 3, string result, allow rule present):

```sh
M0_MODE=probe-a M0_RESULT_SHAPE=string claude --plugin-dir <scratch>/m0-probe \
  --mcp-config <scratch>/m0-mcp.json --allowedTools "ToolSearch mcp__engram__mem_save" \
  --setting-sources project,local --model haiku --output-format stream-json --verbose \
  -p 'Load the tool mcp__engram__mem_save with ToolSearch, then call it exactly once with title "m0 probe", type "discovery", content "m0 probe". Then reply with only the exact text the tool returned, verbatim, in double quotes.'
```

Observed (stream-json, then the debug log):

```
TOOL_USE ToolSearch {"query": "select:mcp__engram__mem_save", "max_results": 1}
TOOL_USE mcp__engram__mem_save {"title": "m0 probe", "type": "discovery", "content": "m0 probe"}
TOOL_RESULT "M0-PROBE: queued for the memory module, not sent to Engram" is_error= None
RESULT "M0-PROBE: queued for the memory module, not sent to Engram"
[DEBUG] tool.call mcp__engram__mem_save toolu_…: resolved by a hooks module (result)
```

No `tools/call` to the Engram server appears in the debug log.

Run 3b: same prompt, **no allow rule** for `mem_save` (`--allowedTools "ToolSearch"`),
and the result as an object `{ content: [{ type: 'text', text: '…' }] }`:

```
TOOL_RESULT "<tool_use_error>tool.call step resolved mcp__engram__mem_save with a result
that does not match its output shape: [ { "code": "invalid_union", "errors": [
  [ { "expected": "string", … "received object" } ],
  [ { "expected": "array",  … "received object" } ],
  [ { "expected": "undefined", … "received object" } ] ] … ]</tool_use_error>" is_error= True
permission_denials: []
[DEBUG] tool.call mcp__engram__mem_save toolu_…: resolved by a hooks module (result)
```

Run 3c: no allow rule, the result as an array
`[{ type: 'text', text: 'M0-PROBE-ARRAY: …' }]`:

```
TOOL_RESULT [{"type": "text", "text": "M0-PROBE-ARRAY: queued for the memory module, not sent to Engram"}] is_error= None
RESULT "M0-PROBE-ARRAY: queued for the memory module, not sent to Engram"   permission_denials: []
[DEBUG] tool.call mcp__engram__mem_save toolu_…: resolved by a hooks module (result)
```

**Conclusion: yes.**
- A hook may answer an MCP call without `next`. The model sees the hook's
  answer as the tool's result, with no error flag.
- Both a string (run 3) and an array of content blocks (run 3c) are
  accepted. An object is rejected, and the model then sees a
  `tool_use_error`.
- Runs 3b and 3c had no allow rule for `mem_save`, and no denial was
  recorded. So the intercept does not depend on the person's permission
  settings. The permission check appears to sit beneath `next` (inferred,
  not traced in the engine).
- For M11, answer with a short string such as
  `"Saved by the memory module at turn end."` and spool the arguments.

## b. `$.mcp.call` server name for Engram

Code shape (at the main `turn.complete`, after `next`):

```js
for (const server of ['engram', 'plugin_engram_engram', 'plugin:engram:engram']) {
  try { probes.push({ server, ok: true, result: await $.mcp.call(server, 'mem_current_project', {}) }) }
  catch (err) { probes.push({ server, ok: false, error: String(err.message) }) }
}
const engramTools = (await $.tool.list()).filter((t) => /engram/.test(t.name)).map((t) => t.name)
```

Run 1, `--setting-sources project,local` and no other MCP config: the
user-scope servers in `<config>/.claude.json` are not loaded with the user
source dropped, so there is no Engram server:

```
{"server":"engram","ok":false,"error":"m0-probe: $.mcp.call: no connected MCP tool \"mem_current_project\" on a server named \"engram\""}
tool.list engram: []
```

Run 2, user-scope `engram` via `--mcp-config` plus a shim plugin named
`engram` that declares an `engram` MCP server, **no allow rule**:

```
[DEBUG] Suppressing plugin MCP server "plugin:engram:engram": duplicates manually-configured "engram"
{"server":"engram","ok":false,"error":"m0-probe: $.mcp.call(engram, mem_current_project) refused: Claude requested permissions to use mcp__engram__mem_current_project, but you haven't granted it yet."}
{"server":"plugin_engram_engram","ok":false,"error":"… no connected MCP tool \"mem_current_project\" on a server named \"plugin_engram_engram\""}
```

Run 2b, `--mcp-config` with `--allowedTools mcp__engram__mem_current_project`:

```
{"server":"engram","ok":true,"result":{"content":[{"type":"text","text":"{\"available_projects\":null,\"cwd\":\"<wt>\",\"project\":\"orca-supervisor\",\"project_path\":\"<repo>\",\"project_source\":\"git_remote\"}"}],"isError":false}}
plugin_engram_engram / plugin:engram:engram → "no connected MCP tool …"
```

Run 2c, shim plugin only, with `--allowedTools mcp__plugin_engram_engram__mem_current_project`:

```
engram → "no connected MCP tool \"mem_current_project\" on a server named \"engram\""
plugin_engram_engram → ok, same JSON as above
plugin:engram:engram → ok, same JSON as above
tool.list engram: ["mcp__plugin_engram_engram__mem_capture_passive", …, "mcp__plugin_engram_engram__mem_update"]  (19 tools)
```

**Conclusion.**
- The server name to call is whichever one the session connected. The two
  spellings are never live together, because the engine drops the plugin
  copy when a manual `engram` server exists.
- In the Orca account probed here, the Engram plugin (0.1.3) ships no MCP
  server, and the server is the user-scope `engram`. So today's answer is
  `engram`.
- M1 must derive the server from `$.tool.list()` names, using the regex in
  review §5.2. `ToolInfo` has no server field.
- `mem_current_project` returns
  `{ content: [{ type: 'text', text: '<JSON>' }], isError: false }`. The JSON
  holds `project`, `project_path`, `project_source`, `cwd` and
  `available_projects`. Parse `content[0].text`.
- **Correction to the d.ts note** ("No permission prompt: the plugin's call
  ... is the grant"): on 2.1.296, `$.mcp.call` goes through the permission
  rules. Without an allow rule it is refused in a headless session.
  - The Orca account's user settings allow `mcp__engram__mem_current_project`,
    `mem_save`, `mem_judge` and `mem_update`, so the owner's sessions pass.
  - A person without those rules gets a refusal. M1/M9 must classify it as
    `permission`, show it on the panel, and fall back. They must not mark
    Engram as down.
  - Untested: whether an interactive session shows the person a prompt for
    this call instead of refusing.

## c. Which `prompt.section` carries the MCP server instructions

Code shape: `prompt.section`, `prompt.compose` and `prompt.attachment`
hooks, each logging the name or type, the length, and whether the text
contains `# MCP Server Instructions`.

Run 1 (headless, graft and claude.ai servers connected) and run 7
(interactive). The section names were the same in both, except
`env_info_model`, which appears only in the headless run:

```
act_dont_rederive, action_caution, autonomy_append, bg-session, brief, brook_heron,
communication, context_management, delivering_work_max, endconv_deferred_hint,
env_info_model, env_info_simple, fable_identity, focus_mode, heron_brook, memory,
opus5_reduced_delegation, overcorrection, pronouns, session_guidance,
subagent_steer_delegation, task_continuity, tool_param_json, willow_tern
→ hasMcpInstructions = false for every one
```

Attachments in the same runs:

```
agent_listing_delta, date, deferred_tools_delta, environment, instructions,
mcp_instructions_delta, model, remote_session_change, session_context,
skill_listing, total_tokens_reminder
ATTACH mcp_instructions_delta 1187 mcp= True
  "# MCP Server Instructions\n\nThe following MCP servers have provided instructions for how to use their tools and resources:\n\n## graft …"
ATTACH instructions 13026 engram= True   (the CLAUDE.md text, which carries the "mem_save proactively" rule)
```

Runs with Engram connected (2b, 2c and 3b): Engram's own block is in the
same attachment type, and no section mentions Engram.

```
run 2b  mcp_instructions_delta len 3098 hasEngram=true
        "# MCP Server Instructions … ## engram\nEngram provides persistent memory that survives across sessions and…"
run 2c  mcp_instructions_delta len 5007 hasEngram=true   (plugin-provided copy, after "## claude.ai Claude Docs")
run 3b  mcp_instructions_delta len 3098 hasEngram=true   ("## engram" first)
        mcp_instructions_delta len 2016 hasEngram=false  (a second delta: "## claude.ai Claude Docs", a server that connected later)
sections with hasEngram=true: none, in all three runs
```

`prompt.compose` → `traits: ["lean","print","skills"]` (headless) and
`["lean","skills"]` (interactive). The sections came back as
`lean_body, communication, pronouns, action_caution, session_guidance, memory,
env_info_simple, context_management, act_dont_rederive, heron_brook, total_tokens`.

**Conclusion: no section carries them.**
- MCP server instructions are the `prompt.attachment` with
  `type === 'mcp_instructions_delta'`, one text block with a `## <server>`
  heading per server.
- M11 removes or rewrites Engram's block there, cutting from the Engram
  server's `## ` heading to the next `## `.
- One session can carry several deltas, because servers connect at
  different times. The hook must handle every delta, not only the first.
- The exact heading of a plugin-provided copy was not captured, since the
  log was clipped. Match the heading by the server name taken from
  `$.tool.list()`.
- The `memory` section is the auto-memory instructions (see d). It is the
  right place for a "memory is handled at turn end" line in the no-Engram
  case.
- The CLAUDE.md rule arrives as the `instructions` attachment. The module
  must not touch it, as the review already says.

## d. Where the engine writes auto-memory for a worktree session

Code shape: at `session.start`, log `$.session.cwd()`, `$.session.root()`,
`$.session.repo()`. At the main `turn.complete`, log
`$.session.usage({ breakdown: 'summary' }).context.breakdown.memoryFiles`.
Log the `memory` section's text.

Run 1, cwd = `<wt>` (a git worktree of `<repo>`):

```
session.start: cwd "<wt>", root "<wt>",
  repo {"root":"<repo>","remote":"git@github.com:ab2webco/orca-jev-advisor.git","internal":false,"name":null}
memoryFiles: [ {path: "<home>/.claude/CLAUDE.md", type: "Project"}, …,
  {path: "<config>/projects/-<repo slug>/memory/MEMORY.md", type: "AutoMem", tokens: 739} ]
memory section: "# Memory\n\nYou have a persistent file-based memory at
  `<config>/projects/-<repo slug>/memory/`. This directory already exists — write to it directly …"
classic.SessionStart transcript_path: "<config>/projects/-<repo slug>--claude-worktrees-agent-…/<session>.jsonl"
```

On disk, `<config>/projects/-<repo slug>--claude-worktrees-agent-…/` holds the
probe transcripts and no `memory/`.

The probe ran in a nested git worktree (`<repo>/.claude/worktrees/…`), not
in an Orca sibling worktree (`<repo>-<branch>`). The on-disk history covers
the Orca case:
- `-<repo slug>-0624`, `-<repo slug>-advisor-board-redesign`,
  `-<repo slug>-config-panel-fixes`, `-<repo slug>-gate-approval-learning`,
  `-<repo slug>-jev-060-router` and the other Orca worktree slugs hold
  transcripts and no `memory/`.
- A sibling worktree of the same repository with a different folder name
  (4 transcripts) has no `memory/` either.
- The main checkout's slug is the only one with a `memory/` folder.

**Conclusion.**
- Auto-memory lives at `<config>/projects/<slug(repo().root)>/memory/`. The
  slug is the path with every non-alphanumeric character replaced by `-`.
  `<config>` is `CLAUDE_CONFIG_DIR`, which in Orca is the account folder, so
  the memory differs per Orca account.
- Every worktree of a repository shares the main checkout's memory. The
  session's transcripts stay under the worktree's own slug.
- memory-fork's `memoryDir` slugs `$.session.cwd()`, which is wrong for any
  worktree session. M10 must use `$.session.repo()?.root ?? $.session.cwd()`.
- For the paths, trust the engine's own two reports: the `memory` section
  text and the `AutoMem` entry of `memoryFiles`.

## e. `$.session.compact` from `prompt.submit` and from an idle timer

Code shape:

```js
on('prompt.submit', async ($, e, next) => {
  if (mode === 'submit-compact') await tryCompact($, 'prompt.submit (before next)')
  return next(e)
})
on('turn.complete', async ($, e, next) => {
  const r = await next(e)
  if (!e.agentId && mode === 'timer-compact' && !armed) { armed = true; $.clock.after(5000, () => tryCompact($, 'clock.after while idle')) }
  return r
})
// tryCompact: $.session.usage() before/after + await $.session.compact({ instructions: 'M0 probe compaction' })
```

Run 4, headless resume of a 28k-token session, `prompt.submit`:

```
{"kind":"compact.call","where":"prompt.submit (before next)","ok":false,"ms":1,
 "error":"m0-probe: session.compact: called from a prompt.submit hook, it would compact under the turn this hook is holding; call it from a later event (turn.complete) (host check)"}
```

Run 8, the same in an interactive session (pty), gave an identical error.

Run 5, headless (stream-json input kept open, 40 s idle between two prompts),
timer 5 s after the first `turn.complete`:

```
{"kind":"compact.call","where":"clock.after while idle","ok":false,"ms":0,
 "error":"m0-probe: $.session.compact: not available in a headless (-p / SDK) session yet: compaction here runs inside a turn (a /compact prompt); catch it and carry on"}
```

Run 7, an **interactive** session under a pty: resume, type the prompt,
Enter, then 75 s idle. The timer fired 5 s after `turn.complete`:

```
classic PreCompact  {"trigger":"manual","custom_instructions":"M0 probe compaction"}
classic PostCompact {"trigger":"manual","compact_summary":"<summary>…"}
{"kind":"compact.call","where":"clock.after while idle","ok":true,"ms":8549,
 "result":{"tokensBefore":39033,"tokensAfter":6246,
   "usage":{"input_tokens":7972,"output_tokens":1688,"cache_read_input_tokens":31945,"cache_creation_input_tokens":3},
   "messages":2},
 "costBefore":{"usd":0.00760188},"costAfter":{"usd":0.009562905},
 "ctxBefore":{"tokens":39029,"window":1000000,"percent":4},"ctxAfter":{"window":1000000}}
```

**Conclusion.**
- **`prompt.submit`: no** in either mode. The host refuses it because the
  hook holds the turn. The "compact on return" variant of S is impossible.
  The earliest point after a prompt is `turn.complete`, which the steward
  already uses.
- **Idle timer: yes, in interactive sessions**, which is how Orca runs
  Claude. It is refused in `-p`/SDK sessions, where S must catch the
  rejection and do nothing.
- **Cost.**
  - The compaction request reused the cached prefix: 31,945 tokens at cache
    read, 7,972 uncached input, 1,688 output, about 3 cache-write tokens.
    That is $0.00196 on Haiku 5.5 at list price, in 8.5 s, with the person
    idle.
  - The context went from 39,033 to 6,246 tokens, so the next turn writes
    about 6k tokens to the cache instead of re-writing 39k cold.
  - This confirms the review's model: a warm compaction costs about 0.1×
    the context, plus the tail and the summary output.
- The calling plugin's own `session.compact` hook does not see its own call
  ("runs through every hook but the calling one"). The classic
  `PreCompact`/`PostCompact` hooks do, with `trigger: "manual"`. S's log
  must therefore record its result from the `$.session.compact()` return
  value.

## f. Cache signals at turn end and on resume

Code shape: `on('classic.*', …)` logging every scalar field of `e`, plus
`turn.complete`'s `usage`.

Turn end, every run:

```
classic Stop: {"permission_mode":"default","effort":{…},"stop_hook_active":false,
  "last_assistant_message":"ok","background_tasks":[0],"session_crons":[0], + session_id, transcript_path, cwd, prompt_id}
turn.complete: {"reason":"answer","durationMs":874,
  "usage":{"input_tokens":2,"output_tokens":4,"cache_read_input_tokens":10978,"cache_creation_input_tokens":12232,"model":"claude-haiku-5-5"}}
```

For comparison, the `-p --output-format json` result of the same run *does*
split the write: `"cache_creation":{"ephemeral_1h_input_tokens":12232,"ephemeral_5m_input_tokens":0}`.
That is the SDK's result, not a hook's.

Resume, run 4 (headless, `--resume` with no `--model`):

```
classic SessionStart: {"source":"resume","seconds_since_last_response":38,"context_tokens":28184,
  "prompt_cache_likely_expired":false,"estimated_cache_write_usd":0.0056}
classic PostModelSwitch: {"from_model":"claude-sonnet-5-5","to_model":"claude-haiku-5-5","requested_model":"claude-haiku-5-5",
  "source":"resume","context_tokens":28184,"prompt_cache_warm":true,"cache_ttl":"1h",
  "estimated_cache_write_usd":0.0056,"pricing":"catalog"}
```

Resume, run 7 (interactive, `--model haiku`, same model as the transcript):
`SessionStart` with `"seconds_since_last_response":52,"context_tokens":31950,"prompt_cache_likely_expired":false,"estimated_cache_write_usd":0.0064`
and **no** `PostModelSwitch`. No `PreModelSwitch` fired in any run.

**Conclusion.**
- At turn end, neither `classic.Stop` nor `turn.complete` says which cache
  bucket was written. The TTL still needs the transcript tail
  (`transcript_path` is in every classic event), as cache-clock does.
- On resume, `classic.SessionStart` carries `prompt_cache_likely_expired`,
  `seconds_since_last_response`, `context_tokens` and
  `estimated_cache_write_usd`. It does not carry `cache_ttl` or
  `prompt_cache_warm`.
- Those two come only with `classic.PostModelSwitch`, which fires on resume
  only when the restored model differs.
- Only `prompt_cache_likely_expired: false` was observed: every gap was
  under a minute. The `true` case was not reproduced, because it needs a
  gap longer than the TTL (1h).

## g. `prompt.edit` in headless and `-p` sessions

Code shape: `on('prompt.edit', async ($, e, next) => { log(origin, text, start, end); return next(e) })`.

Headless runs 1, 2, 2b, 2c, 3b, 3c, 4 and 5: **0** `prompt.edit` rows. Run 3's
own log was overwritten by run 4, which resumed the same session. Their
`prompt.submit` had `origin: {"kind":"sdk"}`.

Interactive run 7: 29 characters were typed about 200 ms apart, then Enter.

```
prompt.edit ×30 (one initial empty draft, then one per key):
  {"origin":{"kind":"composer"},"text":"","start":0,"end":0}
  {"origin":{"kind":"composer"},"text":"R","start":1,"end":1}
  …
  {"origin":{"kind":"composer"},"text":"Reply with the single word ok","start":29,"end":29}
prompt.submit {"text":"Reply with the single word ok.","origin":{"kind":"composer"}}
```

(The logged `text` is the draft *before* the edit, as the d.ts says.)

**Conclusion: no** for headless. `prompt.edit` exists only for the
interactive composer. K0 must measure in real interactive sessions:
- record the clock at every `prompt.edit` whose origin is `composer`;
- at `prompt.submit` with origin `composer`, log the gap since the last
  edit and the number of edits.

A paste arrives as one edit. A prompt Orca injects without the composer
has no edits at all, and K0 must count those prompts separately. A `-p`
harness cannot produce this data.

## Side findings

- **Probe runs left traces outside the scratchpad.**
  - Transcripts of these probe sessions are under `<config>/projects/`:
    the worktree slug, plus `…-scratchpad-m0-probe` and
    `…-scratchpad-m0-types`. The last two have empty `memory/` folders.
  - The Engram settings hooks recorded the first four sessions and their
    prompts (see Method).
  - Our installed mod also wrote measurement rows for the first runs.
  - Weekly measurements that read `<config>/projects` will count these runs.
    They are a handful of Haiku turns.
- **The engine has its own pre-cold compaction** (seen in the binary, not
  exercised). It matters for S, which could duplicate it or race it.
  - A `compact_sleep` timer compacts an idle session before the cache
    lapses: by default at 0.9 of the TTL, only with a 1h TTL and a warm
    cache, and above `minTokens`.
  - `minTokens` defaults to 200,000, with a floor of 100,000, and is
    overridable with `CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS`.
  - It is gated by the server flag `tengu_sunny_locket`, whose mode is
    `off` / `log` / `compact`, plus an idle-compaction setting. Its outcomes
    are logged as `tengu_sleep_compact_fired`.
  - S should detect it (an unprompted compaction near 0.9 TTL with no plugin
    trigger) and stand down when it is on.
  - The separate `CLAUDE_CODE_IDLE_THRESHOLD_MINUTES` (75) and
    `CLAUDE_CODE_IDLE_TOKEN_THRESHOLD` (100k) only show a "new task?
    /clear" hint.
- **A pty test must avoid the project MCP dialog.** An interactive session
  in a nested worktree shows the "New MCP server found in this project:
  graft" dialog first, and that dialog consumes keystrokes. Use
  `--strict-mcp-config`. Unset `CLAUDE_CODE_CHILD_SESSION` too, or the
  transcript is not saved.
