# Changelog

Every release of Jev Advisor, newest first.

## 0.6.24

- **A git discard is refused only when it would lose something.**
  - Today's rule matched `reset --hard`, `clean -f`, `checkout -- <path>`, `checkout .`, `checkout -f` and `restore` by spelling. It now runs one bounded git call in the directory the command acts on: the hook's cwd, a leading `cd X &&`, or `-C`.
    - `reset --hard` counts staged and unstaged changes to tracked files.
    - `clean` counts what a dry run of the same arguments would remove. The argument list is rebuilt without `-f`, and a test proves the dry run deletes nothing.
    - `checkout` and `restore` count worktree changes under their paths.
  - **Nothing would be lost:** the command takes the ordinary Jev path. It is never a local allow.
  - **Something would be lost:** the refusal names a count and an example, and gives the exact `git stash push` to run.
  - **Not a loss:** `next-env.d.ts`, `*.tsbuildinfo`, `.next/` and build folders that tools regenerate. A secret is still a loss.
  - **The refusal stays:** inside `ssh`, `eval`, `bash -c` or `$(…)`; with `--git-dir`, `--work-tree` or `GIT_DIR=`; outside a repository; or on a git error or timeout. (JEVADV-100)
- **`gh pr update-branch` writes only the pull request's branch.** A local fact now tells Jev which branch the command writes, the same way the deploy/publish signal does. Before: 5 of 5 refused under a "never write on main" policy. After: 5 of 5 allowed. `gh pr merge` and a push to main are judged as before. `GATE_DECISION_RULES_VERSION` is now 8, so verdicts cached under the old rules are judged again. (JEVADV-103)

## 0.6.23

- **Agents band: where each agent works.** Each row shows the agent's
  branch, preceded by its worktree's name when it is not the lead's.
  - A leading `word/` that every shown branch shares is dropped. A long
    branch is cut from the left, so its end stays visible.
  - An Agent call with `isolation: "worktree"` shows "new worktree" until
    the agent's first write or `cd` reveals the path.
- **Where the place comes from.** The engine never reports a subagent's
  shell directory, so the place is, in order:
  - the spawn's `cwd`;
  - the directory of the agent's own Edit, Write or NotebookEdit;
  - its Bash `cd <dir>` (alone or before `&&` / `;`);
  - its `git -C <dir>`.

  Read, Grep and Glob never count. Git runs once per directory (cached, 64
  entries) after the tool call returns, never during the band render. A
  detached HEAD or a git failure shows no branch.
- **Layout.** The effort column goes first, then the reason's long wording.
  Then the description is cut, down to 16 cells, to keep the place. Then the
  place shrinks to the branch alone and to 10 cells. On the two-line layout
  (40 columns) the branch sits on the second line, before the description.
  A row with no place lends those cells to its description.

## 0.6.22

- **Jev health probes.** `npm run jev-health -- <usage|flips|redaction>` calls
  Jev only, never the `claude` CLI.
  - `usage [--days N]` reads the router and steward logs. For each option it
    prints the count, share, mean confidence and mean margin. An option
    nobody picked becomes a finding once its question has 30 answers.
  - `flips [--commands-file F] [--runs N]` puts the gate questions about a
    committed 42-command corpus to Jev N times (5 by default). It reports
    the answers that changed, the threshold crossings and the gate verdicts
    that flipped. Failed calls are counted apart.
  - `redaction --commands-file F` asks about each command twice, redacted and
    raw, and lists the verdicts and thresholds that differ. The raw state
    comes from an injected redactor that no hook passes; a test reads the
    hooks' source to keep it that way.
- **Distribution margin.** Router rows log `margin` (top probability minus
  runner-up) for the tier and `workKindMargin` for the work kind. Steward
  rows log `margin` for the verdict. The field is absent, never 0 or NaN,
  when Jev gives no usable probabilities. No floor changed.
- **Redaction.** These now reach Jev masked:
  - a glued `*PASSWORD` or `*PASSWD` name (`PGPASSWORD=`);
  - `--password <value>` and `--passwd <value>`;
  - `-p <value>` inside a registry login (docker, podman, buildah, skopeo,
    nerdctl);
  - `--body` or `-b` inside `gh secret set`;
  - openssl's `-k <value>` and `pass:<value>`.

  `ssh -p`, `docker run -p`, `curl -k` and `gh pr create --body` keep their
  values.

## 0.6.21

- **Gate logs stop growing forever.** Gate decision files older than 8 days
  are folded into a small running-totals file and then deleted. The board's
  "all time" and "this version" windows and the A/B count read the totals
  plus the live files, so no number changes across a fold. The fold writes
  its totals atomically before it deletes anything, never counts a file
  twice, and runs at most once a day.
- **The last redirection forms are read.** `&>file`, `&>>file`, `>|file`
  and a redirection glued to the word before it (`echo hi>x`) name their
  file, like the spaced form; `2>&1` and `>&2` do not. The gate's own-file
  protection reads them too.
- **A failed Jev call says why.** Unjudged gate rows record the failure
  class (timeout, network, 4xx, 5xx, overload, malformed) and its status.
- **A transient Jev failure is retried once.** A 5xx or network failure is
  retried after `Retry-After` (or 250 ms), only when at least 1.5 s of the
  gate's budget remain; never more than one retry per call.
- **Oversized commands.** A state over 16,000 characters is first condensed
  (long words and blobs elided) and judged by Jev. If it is still too large,
  Jev is not asked: only the local rules apply and the gate says so.

## 0.6.20

- **Agent-team teammates are routed.** Claude Code never fires `agent.spawn`
  for a teammate, so the router never saw one. The router now keeps the
  task from the lead's `Agent` call and judges the teammate at its first
  step, with the same Jev call, guards, work kind and definition effort
  floor as a subagent at spawn. That model and effort apply to every later
  step, and the decision log writes a row with `point: "teammate"`.
- **The agents band tells the truth.** An agent the plugin did not see
  start shows the model its own answers report and the effort its steps
  are sent with, instead of `? ?`. The reason says what is known: a
  teammate (routed at its first step, or created outside the router), an
  agent already running when the plugin loaded, or one not seen at launch.
  It no longer guesses a plugin reload. A teammate's row stays while the
  host runs it, not only until its first answer.

## 0.6.19

- **No key no longer means approved.** When the gate has no key, cannot reach
  Jev or has its key rejected, it shows its notice and leaves the decision to
  Claude Code's own permission rules, instead of returning `allow` and
  skipping the prompt. Nothing changes in bypassPermissions.
- **The gate hook never crashes and never hangs on git.** Every hook entry
  point fails open on an unexpected error, and the gate's git calls go
  through one helper with a timeout. Redirections without a space
  (`>../x`, `>>../x`, `1>../x`, `2>>file`) are read like the spaced form.
- **Decision history is safe from an empty field.** The log size must be a
  whole number of at least 1 in the panel, the stored config and the log
  writer, so an empty or zero value can no longer wipe the history.
- **A readiness you set survives a restart.** A new owner override on the
  Models tab ("Treat measurement as ready") is kept in Orca's storage and
  applied by every mirror, including the one at boot; with it off, a real
  loss of readiness still shows.
- **Panels:** every escaped name on the board and in the config panel is
  tested with hostile input; the hand-copied panel functions are tested
  against their originals (one had drifted); labels are tied to their
  controls; the panels declare their language.
- **Data:** the model reclassification log rotates by the hour, the A/B
  results file keeps the newest 5,000 rows, the A/B CLI records results
  before it rewrites its queue, and the skills mod's prompt hook can no
  longer fail on its clock.
- **Cleanup:** two unused modules, two stale typecheck configs and the
  broken `self-check` script are gone; the installer recognises its hook
  entries by the script they run, and only takes account folders that hold
  a Claude config.

## 0.6.18

- **A real typecheck.** `typescript` and `@types/node` are development
  dependencies; `tsconfig.json` (strict, `noEmit`, `nodenext`,
  `allowImportingTsExtensions`, `erasableSyntaxOnly`, `verbatimModuleSyntax`)
  checks the Node code and its tests, and the skills mod is checked against
  Claude Code's own types. `npm run typecheck` runs first in `npm run check`,
  which CI runs, so a type error fails CI. The hand-written Node shim that
  shadowed `@types/node` is gone.
- **Three bugs the typecheck found**, each fixed with a failing test first:
  - a destination mirror row without a string label made the gate's Jev call
    throw, so every command in that destination was judged as if Jev were
    unreachable;
  - a push whose directory cannot be known (`git -C "$X" push`,
    `cd "$X" && git push`) was described to Jev as a push from the session's
    own checkout and branch; it is now unknown, as the local rules already
    read it;
  - the measure-only hold rule (0.6.16) read a tool's arguments from a field
    Claude Code never sends, so it never saw a failing test run.
- **The gate's last unguarded inputs.** The plugin's Orca storage
  (`storage.json` and the encrypted secrets the key file is rewritten from)
  joins the files an agent may not edit, through Bash and the Edit and Write
  tools. Claude Code's own `settings.json` stays editable; a removed hook
  entry is reinstalled by the worker's rescan and reported by `status`.

## 0.6.17

- **The gate guards its own rules.** A command that writes, moves, truncates,
  removes or edits a file the gate or the router reads to decide is refused
  with the reason ("edits the gate's own rules; change them in the Advisor
  panel"): the config mirrors (policies, team owners, deny-tier switches,
  catalogs, queue mode, quotas, explicit models, mod-skills settings, the
  key file), the gate's cache state and the Orca profile index. That holds
  for redirects, `tee`, `sed -i`, `cp`/`mv`, `rm`, `truncate` and
  interpreter code, in `~`, `$HOME`, absolute and relative spellings;
  reading them stays allowed. Claude Code's Edit, Write, MultiEdit and
  NotebookEdit tools get a new hook entry that refuses only those paths,
  with no network call (about 1 ms on other files). Install, uninstall,
  status and the hooks check know the new entry ("Edit guard").
- **A PR merge is the reviewed path.** Jev is told that `gh pr merge` merges a
  pull request through its review on the server, whatever the local branch,
  so it is no longer refused under `never_write_to_main` from a checkout on
  main; `gh pr merge --admin` from main still is. A merge through
  `gh api …/merges` into main, which skips review and used to pass, is now
  refused.
- **Settings backups are owner-only.** New backups are written 0600 and
  install and status tighten existing ones.
- **The gate's decision log rotates by the hour**, and every reader (the
  Activity tab, the gate status, calibration, the A/B counter) reads the
  hourly files and the old single file, so no history is lost. A failed
  append is counted and shown on the board.
- Command families skip `time`, `nice`, `nohup`, `env` and `command`; the
  privacy test skips outside a git checkout; the installer accepts
  `doctor`; the A/B benchmark CLI runs from a path with a space.

## 0.6.16

- **Effort by work kind at subagent spawn.** The Jev call that picks a
  subagent's tier also names its work kind (execute, read, review, implement,
  design) with a confidence. In active mode an execute or read run goes at
  high at most on Sonnet 5 (never extra high) and at medium on Opus 5.5 and
  Sonnet 5.5; review, implement and design are unchanged. It is a ceiling,
  never a raise, and it holds for a sensitive topic, a client's site, a
  pointer prompt, a person's `max` or numeric effort, and a confidence under
  0.7. Its own switch (off / measure / active) is in the Models tab, per
  account, default measure; each subagent decision row logs the kind, its
  source, the keywords' kind as a cross-check and the effort it would send.
  Evaluated on 200 held-out real spawns: 0.66 precision, 7% of the flagged
  runs edited (keywords: 0.53, 29%).
- **No router `low` on work that may edit.** The simple tier's default effort
  is medium; `low` is sent only when a person set it for the tier, or on a
  subagent whose work kind is execute or read with the switch active.
- **An agent definition's declared effort is a floor.** The router may raise
  it, never lower it; `max` or a numeric budget is left as it is.
- **Router decisions join their steps.** Decision rows carry `sessionId`,
  `turnId` and `agentId`; main-session step rows log the step's phase, the
  run of execute steps it follows and the effort a hold rule would send.
  Nothing sent in the main session changes.
- **Cache probe.** 0 of 32 mid-turn effort changes through the hook missed
  the cache (95% bound 10.9%); see odd/research/phase-effort.md.

## 0.6.15

- **The gate reads only what runs.** A command's words in command position,
  and the paths and refs they act on, are what the local rules and Jev read;
  every other quoted text (a `for` list, a script's arguments, `python3 -c`
  source that only prints, a heredoc written to a file) reaches Jev as a
  placeholder, unless the program runs it (`eval`, `bash -c`, `ssh`,
  `watch`, `xargs`, `find -exec`, `$( )`, SQL clients, interpreter source read
  the way its language reads it, f-strings included). On 512 commands the
  gate had stopped in real sessions, the ones that only edit, read or test
  locally went from 39 stopped to 14, none refused; every remaining refusal
  is the command's own action.
- **A `requires_human` policy is judged on what the action does.** Planning
  (`terraform plan`) and reading cluster state (`kubectl get`, `describe`,
  `logs`) no longer ask a person under a policy that says they do not; apply
  and destroy still stop.
- **Exact push destination, SQL on stdin, resource names in the cache.** Jev
  is told where a push goes, so a push to `main` from a feature checkout is
  no longer a coin flip; SQL piped, here-stringed or heredoc'd into `psql`,
  `mysql` or `sqlite3` is refused like `psql -c "DROP TABLE …"`; and the
  verdict cache keys on the resource a command names, so `docker volume rm
  prod_pgdata` and `dev_pgdata` never share a verdict (cache hit rate
  unchanged at 36%).
- **The context steward acts on 1M-token sessions.** It compacts at the end
  of a turn once a session reaches 600k tokens (or 80% of the main model's
  window, if smaller), measured on the session's main model rather than the
  router's current one, which had compacted a session nine times at
  160–230k after a switch to Haiku. A 400k tier (compact unless Jev is sure
  the task is half done) ships in measure mode with its own switch. Every
  decision row now records Jev's verdict, the session, the turn and the
  windows. Research: `odd/research/steward-1m.md`.
- **The agents band shows the effort each agent really runs at, and where it
  comes from** (`alto (heredado)`, `medio (Jev)`), and the router logs the
  effort of every step and its source, measure only. Research:
  `odd/research/effort-per-task.md`, `odd/research/phase-effort.md`.

## 0.6.14

- **Every running agent on its own row, above the prompt.** The status line
  used to group subagents by model (`agentes: 1 en Opus 5.5 (pedido
  explícito), 1 en Sonnet 5.5 (Jev lo bajó) …`), so it did not say which
  agent ran which model. A band above the prompt now lists each one while it
  runs: its type (a prefix every row shares, such as `acme-`, dropped), what
  it is doing, its model, its effort and why (asked for explicitly, lowered
  or raised by Jev, inherited…). Two agents of the same type are told apart
  by what they are doing. The band fits the terminal's width (narrow
  terminals drop the effort column first, then give each agent two lines),
  gives way to a question with options, and disappears when no agent runs.
  The status line keeps the main session and says `agentes: N`.
- **An agent started before the plugin reloaded is no longer lost.** The list
  of running agents is kept in the session's state and checked against the
  agents Claude Code says are running, so a reload no longer drops one from
  the count; one the plugin never saw start is shown as "no data: started
  before the plugin reloaded".
- **A call quoted inside a string is not a call.** 0.6.13 read the commands
  a `python`, `node`, `perl` or `ruby` heredoc runs by their text, so a
  script that only wrote a document quoting a force push was refused as a
  force push. Each body is now read the way its own language reads it:
  strings and comments are text, and only a call in the code counts. The
  same call written as code (`x = os.system(…)` included) is still refused.
- **The Models tab explains an empty catalog on a new install.** Before the
  plugin's worker has loaded the shipped models, the tab names them and says
  what to look for in the plugin's log if they do not appear after
  restarting Orca, instead of only "add a model with the form below". A
  catalog someone emptied on purpose keeps the old text.

## 0.6.13

Fewer false stops, one verdict per effect for team prohibitions, no private
path sent to Jev, and a gate that returns as soon as it has decided. From the
0.6.12 QA (`odd/qa/qa-0.6.12.md`, N-01..N-04) and a client report.

- **A feature branch whose name holds a protected word is no longer refused.**
  `git push -u origin fix/cin-1184-production-azure-storage`, `fix/main-menu`
  and `feat/master-data` were refused as pushes to a shared branch. Only the
  destination ref counts now: `main`, `HEAD:main`, `HEAD:refs/heads/main`,
  `feature/x:production`, `--delete main` and `:main` are still refused. A
  bare `git push` is judged where git would send it (`push.default`, the
  branch's upstream), so a feature branch tracking `main` is refused too.
- **Text in a data position is data.** A commit or tag message (`-m`, `-F -`,
  including the `-m "$(cat <<'EOF' … EOF)"` form agents write every commit
  in), a `gh` title, body or notes, `orca terminal send --text`, and a heredoc
  written to a file are read as a placeholder: a `git push --force` quoted in
  them is no longer stopped. `eval "$(cat <<EOF …)"` still runs its body and
  is still judged. Lines that credit an AI (`Co-Authored-By:` and the like)
  stay visible so a `no_ai_attribution` policy keeps working.
- **A `prohibits` policy is judged on violation, not on topic.** Jev is asked
  which prohibition the action breaks, and "writing on a branch" is spelled
  out: any change to its files (tracked or new), its history, or a push to
  it. For `never_write_to_main`, `touch`, `cp`, `echo >>`, `git commit` and
  `git push origin main` in a main checkout are refused from there and
  through `cd`/`git -C`; `git tag`, `git fetch` and creating a branch are
  allowed. Measured on 73 labelled rows (55 reach Jev): the gap between the
  lowest violation and the highest non-violation went from -0.27 to +0.66.
- **New local refusals** (the retry is refused too): `echo ~ | xargs rm -rf`,
  `find ~ -delete`, `find / -delete`, `git push --mirror`, and `kubectl` or
  `terraform` with their own global options before the verb (`kubectl
  --context prod delete`, `kubectl -n web delete`, `terraform -chdir=infra
  apply|destroy`). A `find` with a filter (`-name`, `-path`) is a cleanup and
  is not refused.
- **A heredoc fed to `python`, `node`, `perl` or `ruby` is read for the
  commands it runs** (`os.system`, `subprocess`, `execSync`, `system`,
  backticks): a force push inside one is refused, a `print` of the same text
  is not.
- **No home or volume path reaches Jev.** Every path under the home directory
  or on another volume is a placeholder, registered or not; system paths
  (`/etc`, `/usr`, `/tmp` …) stay in clear because their name carries the
  risk.
- **The gate returns right after its verdict**: from a median of 1.4 s to
  6 ms between the verdict and the hook's exit.

Still advice, on purpose: `sqlite3 app.db "DROP TABLE …"` (a local file; the
gate cannot tell production from a scratch database) and `curl -o f && bash
f` (decided in 0.6.12). SQL fed to `psql`/`mysql` through stdin (a pipe, a
herestring, a heredoc) is advice, not a refusal, as is any DROP that nothing
says is production.

## 0.6.12

The 0.6.11 live QA (`odd/qa/qa-0.6.11.md`) found commands that a local rule or
a team policy must refuse, passing or getting only advice. An advice lets an
identical retry through, so each of these is now a refusal:

- **A recursive delete of the root or home directory in any spelling:**
  `rm -fr /`, `rm -r -f /`, `rm --recursive --force /`, `rm -Rf ~`,
  `rm -rf ~/`, `${HOME}`, the home directory's absolute path, `(rm -rf ~)`,
  and `cd / && rm -rf *`.
- **A force push in any spelling:** `git push -fu`, `-uf`, and git's global
  options before `push` (`git -C <dir> push --force`, `git --no-pager push
  --force`, `git -c k=v push --force`).
- **A push to a protected branch** through `git -C <dir>`, an `env` prefix,
  or a backslash-newline continuation (`git push \` + newline + `origin
  main`).
- **Remote code fed to a shell or an interpreter:** through `tee`,
  `/bin/bash`, `env bash`, `bash <(curl …)`, `bash -c "$(curl …)"`,
  `eval "$(curl …)"`, and `| python3`/`perl`/`ruby`/`node`.
- **A command is judged where it acts, not where the session is.**
  `cd other-repo && git commit`, `git -C other-repo commit` and
  `bash -c 'cd other-repo && …'` are judged in `other-repo` and its branch:
  a write to `main` from a session on a feature branch is refused by a
  policy such as `never_write_to_main`, and a commit to a feature branch
  from a session on `main` is no longer refused. The recorded project and
  command family follow the target too (`cd x && git commit` is family
  `git` in `x`'s project, not `cd` in the session's).

Ordinary work keeps passing: `rm -rf node_modules`, `git push -u origin
feature`, `--force-with-lease` on your own branch, `curl … | jq`, `curl … |
python3 -m json.tool`, and the same phrases inside `grep`, `echo`, a commit
message or a heredoc body.

## 0.6.11

- **The skill and tool measurement log no longer goes silent.** Claude
  Code's hook filesystem rejects files over 4 MiB, so the single log
  stopped recording at 4,194,231 bytes. Records now go to one file per UTC
  hour; the daily count, the readiness check and the panel read the old
  file and every hourly one together.
- **Set up is one step, and the doctor checks what it installed.** The
  hooks run with an absolute path to a Node 24 or newer found at install
  time, so they work in any shell. The panel says so when no such Node
  exists. The doctor runs every installed hook exactly as written. An Orca
  account added after Set up gets the hooks without pressing it again.
  Install and uninstall write `settings.json` only through the guarded
  write, and never delete a skills-mod copy they did not install.
- **The hooks run from any repository.** Set up from a development
  checkout used to write the plugin's path as relative, so the gate only
  ran inside that checkout. It is now stored as an absolute path; press
  Set up once after updating to rewrite it.
- **The repository, branch and path names the plugin knows about reach
  Jev as placeholders.** See "Names" under "What leaves your machine". A
  path it never registered (a directory named only inside a command) still
  goes in clear.
- **The router reads your usage live.** It uses the tighter of the 5-hour
  and 7-day windows from Claude Code itself instead of only the Orca
  mirror, and each decision records the source.
- **The status line is shorter.** A plain decision no longer prints its
  `(etapa: …)` label, which only repeated the model shown.
- **Every Models and Policies choice opens on the first click.** Per-tier
  effort, *When a person must approve* and *Models fixed by an agent* are
  button groups instead of dropdowns, which Orca's panel could leave
  unresponsive while it refreshed.
- **Measured and left as they were:** the router's 70% confidence floor
  (no figure in three days of decisions says another value holds better),
  and upgrades still change the model at once rather than raising effort
  first, because an effort change rewrites the prompt cache too.

## 0.6.10

- **The standard tier now uses Sonnet 5.5.** All four models (Haiku 4.5,
  Sonnet 5.5, Opus 5.5 and Fable 5.1) carry their published prices, the
  effort levels they support and their context windows, all from one
  catalog. Fable 5.1 is priced at its published $10 / $50 per million
  tokens; it used to be estimated as twice Opus.
- **A long conversation is never moved to a model that cannot hold it.**
  Haiku 4.5 has a 200K context window and the others 1M. The router keeps
  the context window as a floor on every decision, so a conversation that
  no longer fits Haiku stays on a larger model.
- **The Board names models from the catalog**, so a model shows the same
  name there as in the router and the Models tab.
- **The catalog checks Anthropic's public pages once a day.** The plugin
  reads the public models and pricing pages (now fetched from
  `platform.claude.com`) and offers any change through the existing
  catalog notice. If a page fails or changes format, the last good data
  is kept.

## 0.6.9

- **Every account's router and context steward mode can be changed again.**
  In Orca, a drop-down lower down the settings panel did not open, so with
  several accounts only the first rows could be changed. Off, Measure and
  Active are now three buttons, with the chosen one filled in and announced
  as pressed to screen readers.

## 0.6.8

- **Work that stays inside your team no longer asks a person.** A new field
  in the Policies tab, *Repositories your team owns*, lists the GitHub or
  GitLab owners whose repositories are yours. When every part of a command
  stays inside them (a local git command, pushing a work branch to one of
  their repositories, opening, editing or commenting on a pull request
  there, replying to a review), policies that require a person are not
  asked about it. Merging, pushing to a protected branch, force pushes,
  and anything aimed at a repository outside the list are still asked, and
  `prohibits` policies are still judged. Empty (the default) changes
  nothing.
- **A person's approval no longer stalls an unattended agent, if you want
  it that way.** *When a person must approve*, also in the Policies tab:
  *Ask now* (the default, as before) or *Queue it and carry on*. Queued,
  the command does not run; the agent is told it waits for a person, not to
  retry it or work around it, and to carry on with the rest. The item shows
  under **Waiting for you**, first in the board's Gate tab, with the
  policy, project, command and when. To release one, tell the agent in
  that session to run it again: you are asked at that moment. A queued
  command never runs without you, and with no session id to match a retry
  by, the gate asks now instead of queueing.
- **The subagents running now are in the status line**, with the model each
  one runs and why: `agents: 2 on Opus 5.5 (explicit request)`, `1 on
  Haiku 4.5 (chosen by Jev)`. The Consumption tab counts the main
  conversation's and the subagents' steps and tokens apart.
- **A model fixed by the Agent call or an agent definition is judged, not
  pinned.** *Models fixed by an agent* in the Models tab: *Judge them* (the
  default) or *Keep them*. Judged, and only with the router in `active`
  mode, Jev may lower that model when the task is simple and it is sure;
  never when it is unsure, when the prompt points to a document, when the
  work is sensitive or already failing, and in a client's repository never
  below the session's own model. The status line says `lowered by Jev`
  when it did. A definition's model is read from the project's
  `.claude/agents` and then the account's; a plugin's own agents are not
  read, so their model is judged like any other subagent's.

## 0.6.7

- **Linux works with Orca's own CLI and data folder.** On Linux the Orca
  CLI is `orca-ide`, and a bare `orca` there is usually the GNOME screen
  reader. The plugin called `orca` everywhere, so on Linux the account
  list, the board's project names, the destination list, the doctor and
  the project a session runs in all came back empty. It now runs
  `ORCA_CLI_COMMAND` when Orca sets it, `orca-ide` on Linux and `orca`
  elsewhere, and never falls back to `orca` on Linux.
- **Orca's accounts are found on Linux.** A packaged Linux Orca keeps its
  data in `~/.config/orca-ide` (or `$XDG_CONFIG_HOME/orca-ide`), not
  `~/.config/orca`, so an install run without Orca's own
  `ORCA_USER_DATA_PATH` found no accounts to install the hooks into.

## 0.6.6

- **Tool suggestions work again.** Jev accepts at most 255 options in one
  question, and a session with MCP servers carries 266 to 448 tools, so
  every tool decision since 2026-09-26 failed and none was ever made. The
  tools are now asked in batches Jev accepts, and a failed decision records
  the HTTP status Jev answered.
- **`awk` and `sed -n` are no longer waved through on their name alone.**
  `awk` can run a command with `system()`, a pipe or `getline`, and GNU
  `sed` with its `e` command; both used to skip every check. They still
  skip Jev when they only read and print (`sed -n '1,40p' file`,
  `awk '{print $1}' file`); anything else is judged. An `awk` program or
  `sed` script that can run a command (`system()`, a pipe, `getline`,
  sed's `e`) is read as code by the local rules, like `python3 -c`, so a
  destructive command inside one reaches the coding model as an advice
  instead of being allowed. One that only edits or prints text naming a
  command is still a mention.
- **A `<<` inside quotes, a `<<<` here-string or a `<<` in a comment no
  longer hides the next lines.** The shell runs those lines, so the local
  rules now read them.
- **Secrets are removed from prompts before Jev sees them in every
  feature.** The gate, router and steward already did this; the subagent
  model choice and the skill and tool suggestions now do too, and so do the
  skill and tool records written to disk.
- **A quote in a project or branch name can no longer inject code into the
  Advisor board.**

## 0.6.5

- **A cached verdict no longer answers for a different target.** The
  command gate remembers Jev's verdict for 30 days, keyed by the command's
  shape rather than its exact text, so `rm -rf dist` and `rm -rf build`
  share one answer. Until now that shape also blurred WHICH thing a
  command acted on: `gh pr merge 12` and `gh pr merge 13`, or
  `git push origin feature/x` and `git push origin main`, had the same
  shape. Once the first was allowed, the second was allowed from the
  cache, and Jev never saw it.
- **What stays exact now**: for `gh`, `glab` and `jira`, the PR, issue,
  MR or ticket number, a URL, the `--repo` owner/repo, the target named
  right after the subcommand (`gh pr merge feature/x`,
  `gh repo delete acme/app`) and a `gh api` endpoint. For `git push`, the
  remote and every branch or refspec. Everything else folds as before:
  file arguments, titles, bodies and messages still share one answer, so
  the cache keeps its reach.
- **Secrets stay out.** A URL keeps only its scheme, host and path, never
  a password, a query string or a fragment. A `gh api` endpoint drops its
  query string. Bodies, titles, request fields, headers and push options
  are never kept, even when they look like a number.
- **Old entries are retired.** Every verdict cached before 0.6.5 misses
  once, and the command is judged fresh.
- **Not covered**: a branch or repository named after an unrelated flag
  (`gh pr merge --squash feature/x`) still folds, because the gate cannot
  tell whether that flag takes a value. A PR number there is still exact.

## 0.6.4

- **A context steward that compacts the conversation when a task is
  done.** Every later step of a long session re-reads the whole context
  from cache, and that re-reading is most of what a long session costs.
  After a turn ends, if the context is over the account's threshold
  (120k tokens by default), Jev is asked one question: did this turn close
  a task, is the work still in the middle of one, or has the person moved
  to a new topic? When a task closed, the steward compacts the main
  conversation. The summary keeps the task file with its open items and
  next step, the branch, the last commits, PR numbers, decisions and
  standing constraints. Mid-task it does nothing, unless the context
  reaches the hard limit (80% of the window). Subagents are never
  compacted.
- **It starts by only measuring.** The default mode is `measure`: it logs
  what it would have done and changes nothing. `active` is opt-in per
  account, in the config panel's Models tab, next to the router. The
  threshold is set there too.
- **What Jev sees**: the last two prompts a person wrote (redacted, at
  most 600 characters), the turn's counts (tool calls, edits, tests,
  commits) and the context size. No file paths and no file contents.
- **Where you see it**: the status line shows `contexto 90k → 10k (tarea
  cerrada)`, or what it would have done in measure mode. The board's
  Consumption tab counts compactions applied and estimates the tokens
  each later step no longer re-reads.
- **Measured live** in one interactive session: the context went from
  about 90k to 10k tokens, and the next step's cache read fell from
  89,940 to 42,165 tokens (−53%). What remains is the fixed system and
  tools prefix, which no compaction touches.
- **Not yet**: headless (`claude -p` / SDK) sessions are never compacted,
  because Claude Code does not offer plugin compaction there yet. They are
  logged as `notApplied: headless`.

## 0.6.3

- **The Activity tab shows what happened per project, not a lifetime
  tally.** The flat "By project (whole log)" bar list is gone. In its
  place, one card per project (the top 6 by recent activity, with a
  "show more" toggle for the rest): a 7-day activity chart, gate outcomes
  (allowed, advised, asked, blocked) as labelled numbers, tokens and
  estimated cost by model, and — only when the router made a decision for
  that project — its switches and estimated saving. Every number comes
  from a log this plugin actually writes; nothing is invented, and cost
  is always worded as a list-price estimate, never a bill. The turn-usage
  and router-decision logs now carry the project name, the same identity
  the skills mod already resolves, so an older record without one reads
  honestly as "(unknown project)" rather than being dropped.
- **A subagent the router upgrades now actually runs at the upgraded
  effort.** A subagent raised to a higher tier for complex work (say,
  Opus at high effort) was logged with that effort but its first API step
  still ran at whatever effort it inherited, because the rule guarding
  against an unwanted raise only ever lowered effort, never raised it.
  Fixed: on a subagent's cold first step, the tier's effort now applies
  in both directions; a guard still only ever protects a higher inherited
  effort from being lowered, never blocks a raise. A person's own `max`
  or numeric budget is still never touched, and an explicit parent model
  still means no change. The decision log now records the effort the
  step actually sends, not the raw target computed at spawn, so the two
  can no longer disagree.

## 0.6.2

- **Effort follows the work, not the account's default.** An account that
  sets Opus to `xhigh` ran every main step at `xhigh`: an upgrade back to
  the session's own model restored the account's effort, and a turn whose
  tier stayed on the same model never looked at effort at all. Now an
  upgrade uses the tier's own effort (analyse work runs Opus at `high`,
  deep reasoning at `xhigh`), and every person prompt on the same model
  recalculates it. A higher effort applies at once when Jev is at least 70%
  sure, and no guard blocks it. A lower one rewrites the prompt cache, so it
  has to earn it the way a cheaper model does: the same lower effort on two
  prompts in a row (one under quota pressure), no guard holding, and a
  saving that beats the rewrite by 20%. The saving is measured, never
  assumed: it is the account's own median output per step at each effort
  on that model over the last 7 days, and with fewer than 20 steps at
  either effort the effort stays. A person's own `max` or numeric budget is
  never lowered. Each decision is logged with its effort and a reason
  (`effort-raise`, `effort-lower`, `effort-hysteresis`, `effort-break-even`,
  `effort-unknown-savings`), and the status line says why an effort was
  kept.
- **You choose the effort each tier asks for, per account.** The Models tab
  shows, for each account, each tier, the model it resolves to there, and
  its effort. Saving writes `routerEffort` next to `routerMode` in that
  account's settings.json; only what differs from the defaults is stored.
- **The Models tab explains itself.** The intro says what the ladder, the
  router switch and the effort table each do; the catalog names its source
  once instead of on every card; the classic subagent hook's checkbox is
  labelled as the legacy switch it is (it only acts where the router is not
  active).
- **A prompt that only points to a document no longer picks the model.**
  Agents are often started with a short pointer such as "Read
  /path/brief.md and do what it says"; Jev judged the pointer, found it
  simple, and a complex job could start on Haiku. A short prompt (under 400
  characters) whose main content is a path to read and act on, in English
  or Spanish, or a bare path to a `.md`/`.txt` file, is now a guard
  (`pointer-prompt`): the session keeps its own model and effort at session
  start, no downgrade happens on it later, and a subagent spawned with one
  keeps its parent's model. It never blocks an upgrade. A prompt that names
  a file but asks for work ("arregla el bug en src/a.ts") is not a pointer.
- **The router rows name accounts by email and show the real mode.** Each
  account row in the Models tab shows the email Orca reports for it (its
  short id when none is known), and the mode is re-read whenever the panel
  opens and every 10 minutes, so a mode set from a terminal shows up. A
  Save re-reads first: if the mode or effort changed elsewhere since the
  row was drawn, the row shows the real value and nothing is written.
- **The status line says what applied and what only measured.** It starts
  with one `jev` and each part says plainly what it did:
  `jev · skill: branch-pr (measuring only) · tools: no change (measuring
  only) · model: Opus 5.5 · kept: session already started`. A skill or tool
  reads `(applied)` only when its advice was actually injected; the router
  keeps `would use:` in measure mode, and a warm session says why it kept
  the model.
- **A failed look no longer counts as a failed turn.** The previous-failure
  guard counted every tool error, so an `ls` of a missing file or a `which`
  that found nothing kept a light turn on the session's expensive model.
  Errors from read-only probes (Read, Grep, Glob, LS, and shell commands
  made only of programs such as `ls`, `cat`, `grep`, `find`, `cd` or
  `git status`) no longer count; any other failure, and every failing
  test, still counts as a failed turn, which Jev now weighs.
- **The status line says why it kept a model.** When the router keeps the
  model it runs although Jev's tier would pick another (a guard held it,
  Jev was unsure, one lower turn is not enough yet, or switching costs
  more than it saves), the line says so and names the tier as Jev's:
  `jev · model: Opus 5.5 · extra high effort · kept: low confidence
  (Jev: ask)`, where it used to read `(stage: ask)` as if asking needed
  Opus. Switches read as before.
- **Jev decides; a failure or a sensitive word is a fact, not a veto.** Of
  83 router decisions in one day, 30 were held by a guard, and the word
  list fired on "pre-release reviewer". A failing previous turn and a
  sensitive topic no longer hold the model on their own: they reach Jev as
  `previous_turn.failed` and `topic_flags` (category names such as
  `deploy` or `credentials`, never prompt words), and the tier question
  tells Jev to weigh them. A client site or a scoped policy no longer holds
  the model either: client protection is the command gate's, unchanged,
  and the destination kind is a fact Jev reads. The hard guards left are
  Jev's own low confidence or failure and a pointer prompt. A turn the
  engine starts by itself restores the floor only on those; a failed test
  there reaches Jev at the next prompt. No guard ever blocks
  raising the effort: under one, the effort is the higher of the
  session's own and the tier's, at session start, at a stage and for a
  subagent, and an effort lowered on the session's own model comes back
  to its own.

## 0.6.1

- **A background task's notification can no longer downgrade a session in
  the middle of its own work.** `$.session.messages()` carries no origin,
  so the router used to treat a notification exactly like a person's own
  prompt: it ran a full stage decision and counted toward the two-turn
  downgrade hysteresis. Two notifications landing back to back could
  satisfy that hysteresis and switch a small-context session to a cheaper
  model mid-task with nobody having asked for it (on a large context, only
  the break-even check happened to hold the floor). The router now reads
  `prompt.submit`'s own `origin.kind` — the one place that actually says
  whether a prompt came from a person (typed, Remote Control, `claude -p`)
  or from something else (a task notification, a scheduled trigger, a peer
  session, ...) — and skips Jev and the hysteresis count for anything that
  is not a person's own prompt, the same way it already skips both for a
  turn the engine starts by itself. The local floor guards (a previous
  failure, a sensitive topic) still hold, without asking Jev, exactly as
  before.
- **A subagent's own effort now matches the tier it was routed to, instead
  of the parent's, clamped.** A subagent starts with a cold context, so its
  first step is another place a switch is free — but effort had no field of
  its own there yet: a subagent the router sent to Sonnet for standard work
  ran every step at `high`, the parent's own `xhigh` clamped down to what
  Sonnet supports, never the tier's own `medium`. The router now sets that
  subagent's effort to its tier's own on its first step and keeps it there
  for every step after, active mode only, and only when the parent gave no
  explicit model (that is intent) and no guard held at spawn. It only ever
  lowers effort, never raises it, and it never touches a person's own `max`
  or numeric budget.

## 0.6.0

- **Jev picks the model and effort each session needs (model router).**
  On a Claude Max plan the weekly limit is spent mostly on re-reading the
  conversation, not on answers: over three days of real sessions, cache
  reads were 74% of Sonnet's usage and 57% of Opus's, with an average of
  243k (Sonnet) and 379k (Opus) tokens of context re-read per response.
  So the router saves by running simple work on a cheaper model, and it
  never switches in the middle of a warm conversation: the prompt cache is
  kept per model and per effort level, and a switch writes the whole
  context again (measured: every switch started from zero cache reads).
  - **Where it decides.** At the first prompt of a session (nothing cached
    yet), when a subagent starts (its context is new), and at a later turn
    only when it pays: an upgrade happens at once; a downgrade needs the
    same lower tier on two turns in a row AND an estimated saving over the
    remaining steps that beats the cache rewrite by 20%.
  - **What it picks from.** Four tiers per account: Haiku 4.5 (no effort),
    Sonnet 5.5 (medium), Opus 5.5 (high), and Fable 5.1 (extra high) only
    when the catalog marks it available and the account has an open Fable
    weekly window; otherwise the top tier is Opus. A gateway account (a
    non-Anthropic `ANTHROPIC_BASE_URL`) uses the models its own
    `ANTHROPIC_DEFAULT_*_MODEL` settings name; its prices are unknown, so
    it never downgrades on cost.
  - **Jev decides; a few hard guards hold the floor.** It never goes below
    the session's own model when Jev is less than 70% sure (or fails), or
    when the prompt only points to a document to read and act on. Two
    things are facts Jev weighs rather than vetoes: a previous turn that
    failed (a failing test, or an error from a call that is not a
    read-only probe such as `ls`, `cat` or a failed `cd`) and a request
    that touches security, credentials, a release, a deploy, a migration
    or production (in English or Spanish). Upgrading is always allowed,
    and no guard ever blocks raising the effort. A model you pick yourself
    mid-session wins. A client site or a policy scoped to the session's
    destination does not hold the model: protecting a client (no data
    deleted, no force push, no deploy) is the command gate's job, and it
    keeps doing it exactly as before. The destination's kind reaches Jev
    as a fact (`destination_kind`), so a trivial prompt in a client
    project is answered by a light model.
  - **Measure first.** The switch has three positions: `measure` (the
    default: it decides, logs and shows "would use:" on the status line,
    and changes nothing), `active`, and `off`. Set it per account in the
    Advisor settings (Models → Jev model router), or in Claude Code's own
    `/config` ("Jev model router"); both are the same setting, stored in
    that account's settings.json. It applies to new sessions.
  - **On the board.** The Consumption card gains a "Model router" part:
    the last 24 hours of decisions by point and tier, applied against
    measured, and an estimated saving at list prices for applied switches.
  - **What is measured.** Every decision is one line in
    `model-router-decisions-<hour>.jsonl` under the cache folder: the
    point (start, stage, subagent), the tier, Jev's confidence, the model
    before and after, whether it was applied, the reason and guard, and,
    for a downgrade, the context size, rewrite cost, per-step saving and
    expected steps. Never the prompt text.
  - **Near a usage limit.** The router reads the 5-hour and 7-day usage
    live from Claude Code and uses whichever is closer to its limit (the
    Orca quota mirror fills a missing window while it is at most 30
    minutes old). From 95%, standard work may drop to the simple tier, but
    only right after a turn that edited no files and had no failing tool
    or test. Between 80% and 94% no tier moves; a downgrade just needs one
    agreeing turn instead of two. Each decision records where its figure
    came from (`live`, `live+mirror`, `mirror` or `none`).
  - **The model does not know it was switched.** After a switch, if you
    ask the model which model it is, it may still name the session's
    configured model: its system prompt names that one and the router
    does not change it. The model that really answered is the one on the
    status line and in the API's own usage records.

## 0.5.3

- **The person-facing effect line now weighs every reason Jev cited, not
  just the first.** An advised `rm -rf tmp/` on an untracked local dir with
  no collaborators used to read "jev · avisó al modelo: lo verán otras
  personas" — a claim nothing about that command supported. Every risk
  reason is now checked, in a fixed priority order, and "other people will
  see it" is reachable only through the one reason that actually says so;
  everything else (a borderline score, an unspecified consequence) reads
  "Jev no está seguro de que sea inofensivo" / "Jev isn't sure it's
  harmless" instead of a claim it cannot back up.
- **A policy's hard stop and human ask name the POLICY, never the team's
  own rule text.** That text is arbitrary, often-English content, and
  interpolating it produced a mixed-language line even on a Spanish locale
  ("jev · bloqueó `git add README.md`: Never write directly on main or
  develop, not even a one-line fix.") — and, worse, leaked into the
  person's own confirmation prompt for a `requires_human` ask
  ("producción exige que decida una persona: Deploying to production...").
  Both now read "jev · bloqueó `<command>`: lo prohíbe la política `<id>`"
  and "La política `<id>` pide que decidas si se ejecuta `<command>`" (or
  their English equivalents) — the command and the policy, nothing else.
- **The two "asking Jev" hook status messages are localized.** Claude Code
  shows each hook's own status line while it runs; it was always English
  regardless of your locale setting. The Bash gate and the Agent-matcher
  model-reclassification hooks now read your locale the same way the gate
  itself does. Reinstalling after a locale change updates the text in
  place — an entry written under either locale is still recognised as
  ours, so nothing is ever duplicated or orphaned.

## 0.5.2

- **The person-facing line finally says WHAT Jev decided and ON WHICH
  command.** "jev · avisó al modelo: si sale mal, habrá que limpiar
  después" named neither. Every line now carries the command (truncated to
  the part that mattered) and a concrete effect, in priority order: named
  files it would lose, a deploy or a publish, the effect leaving this
  machine, that it cannot be undone, or — when nothing more specific is
  known — that other people will see it. The vague "if it goes wrong…"
  framing is gone from what a person reads; it can still appear in the
  reason the MODEL gets, where it is a fair description of an uncertain
  risk score.
- **An identical retry that actually ran is no longer silent.** It used to
  say nothing, because the person had already seen the original advice —
  but a silent success looks exactly like the model quietly doing something
  else instead. It now gets its own line: "jev · the model confirmed it and
  it ran: `<command>`".
- **A hard stop and a human ask both name the rule, not just show the
  model's own REFUSED text to the person too.** A local deny-tier rule or a
  `prohibits` policy now reads "jev · blocked `<command>`: `<rule, in plain
  words>`"; a `requires_human` policy reads "jev · `<policy id>` asks you to
  decide: `<command>`".
- **`curlPipeShell` finally gets the same mention-vs-command treatment as
  the rest of the deny tier, and covers `wget` too.** It used to be the one
  rule with none: a heredoc handed to `python3 -` that only edited a JSON
  value containing the text of an install one-liner was hard-refused as if
  a shell had run it. It now checks each side of a real pipe in command
  position — a grep pattern, an echoed sentence or a heredoc body naming
  the shape as data is never enough on its own.

## 0.5.1

- **Security fix — upgrade.** The fast path that waves obviously-safe
  commands through (`isObviouslySafeCommand`) and the check that tells a
  mention apart from a run (`mentionsRatherThanRuns`) used to split a
  command on `&&`/`||`/`;`/`|` alone. A trailing single `&`, or a real
  newline after a harmless-looking first line, never split there — so the
  rest of the line, including a real `rm -rf $HOME` on the next line, rode
  through unseen, never reaching the deny tier or Jev. The deny tier's own
  segment splitter already handled both correctly; only this fast path did
  not. Fixed: a newline and a single `&` now separate commands everywhere,
  and a split this can't do with confidence (an unclosed quote) fails
  closed instead of being trusted.
- **Jev sees risk → the coding model gets advised, not you.** The risk
  stage's own borderline "ask" no longer stops a person: it hands the model
  a concrete reason — what it would affect, which files hold work git
  cannot recover (resolved against your real, current git status), and a
  safe alternative when there is one — and lets it decide. An identical
  retry by the same session within 10 minutes goes through without asking
  Jev again. You still see a one-line notice either way.
- **A `prohibits` team policy is a hard stop, not a question.**
  `requires_human` still asks a person; `prohibits` now refuses the model
  outright, the same way a local deny-tier rule does — nobody is
  interrupted.
- **Own-branch pushes and git's own guarded deletes stop needing Jev at
  all.** A plain, non-force push of a branch nobody else shares, or one of
  git's own guarded delete/worktree operations, is allowed locally once no
  team policy is left that could still apply.
- **Deploy and publish commands are never "local and cheap."**
  `gh workflow run`, `npm publish`, `docker push`, `vercel --prod`/
  `vercel deploy`, `netlify deploy --prod`, `fly deploy` and similar are
  floored to at least an advice, and the fact reaches Jev so a destination
  policy can still catch a real one.
- **The verdict cache now knows about your policies.** Its key
  fingerprints the policies that would apply and the destination's own
  ceiling override, so editing a policy invalidates any stale cached
  verdict instead of replaying it for up to 30 days.
- **Legacy policy kinds migrate themselves, and a missing one is visible.**
  A row still stored with a pre-rename Spanish kind converts to English
  automatically on activation; a row with no recognisable kind at all is
  still never guessed, but the Advisor board now names it instead of
  silently judging nothing for it.
- **The skills mod actually loads.** Its installed copy now mirrors this
  repository's own layout, with a generated manifest, so Claude Code's
  engine accepts it — before 0.5.1 it never actually loaded on any machine.
  It also now lists skills installed as symbolic links (it used to skip
  them, and many skill installers use links), and it reads the session's
  own skills folder, `$CLAUDE_CONFIG_DIR/skills`, when Claude Code runs
  under a separate config directory, as Orca-managed accounts do.

One developer's own replay of 151 real commands through this machine's
gate, before and after this redesign: normal-work interruptions of a person
dropped from 37 to 2 (both the owner's own policy on client pull requests —
a real human decision, never the risk judgement itself), and harmful
commands went from 2 silently allowed (plus the newline bypass this
release also fixes) to 0 passing without at least an advice or an outright
refusal. That is one machine's own replay, not a guarantee about yours.
