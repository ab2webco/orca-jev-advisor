# Jev Advisor

An Orca Lab plugin that judges what your agents are about to do, before
they do it — and stays out of the way the rest of the time.

Agents run commands. Most are harmless and interrupting you about them is
noise; a few are not, and finding out afterwards is expensive. This plugin
puts a fast, cheap judgement in front of every command an agent issues:
one that lets `npm test` and `rm -rf node_modules` through without a word,
refuses `terraform apply` and `git push --force` outright, and — for
everything else Jev sees as risky — hands the coding model a concrete
reason instead of interrupting you. A person is only asked when your own
team policy says a human has to decide; nothing else stops to ask anymore.

The judgement is made by [Jev](https://typesafe.ai) (TypeSafe), which
answers small typed questions in a few hundred milliseconds for a fraction
of a cent — not by a large model reasoning about your shell.

## What changed in 0.5.1

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

One developer's own replay of 151 real commands through this machine's
gate, before and after this redesign: normal-work interruptions of a person
dropped from 37 to 2 (both the owner's own policy on client pull requests —
a real human decision, never the risk judgement itself), and harmful
commands went from 2 silently allowed (plus the newline bypass this
release also fixes) to 0 passing without at least an advice or an outright
refusal. That is one machine's own replay, not a guarantee about yours.

## What you actually see

Nothing, most of the time. That is the point.

```
git status                        (silent, never leaves your machine)
npm test                          (silent)
rm -rf node_modules                allowed — reversible, local and cheap
git push --force origin main      jev · blocks: force push: rewrites the
                                   remote — anyone who already pulled breaks
                                   (the same REFUSED text reaches the MODEL;
                                   you see this short notice)
gh workflow run deploy.yml        jev · advised the model: triggers a
                                   deployment workflow on GitHub Actions
                                   (one line for you; the model gets the
                                   full reason and decides)
gh pr merge 812 --squash          jev · asks: client_always_asks requires
                                   a person to decide (only because YOUR
                                   OWN team policy names this — never the
                                   risk judgement by itself)
```

How often it stops a person depends entirely on what your agents do and
what your own team policies say, so this README does not promise a ratio.
What one developer's own replay of 151 real commands from this machine's
traffic showed (see "What changed in 0.5.1" above): human interruptions on
normal work dropped from 37 to 2, and no harmful command passed without at
least an advice or an outright refusal. That is one machine's own replay,
not a promise about yours. The plugin counts it for you instead — the
Advisor panel shows how many decisions were made, how many passed, and how
long each took, on your own traffic.

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
`ghp_`, `AKIA…`, `npm_`, `hf_`, `pypi-`, `shpat_`, `sq0atp-`, `rk_live_`,
`sk_live_`, `whsec_`, `dop_v1_`, `SG.`, and similar); a webhook token embedded
in a URL *path* (a Slack `hooks.slack.com/services/T…/B…/<token>`, a Discord
`/api/webhooks/<id>/<token>`, a Microsoft Teams `webhook.office.com/…`) — the
host and every id segment survive, only the token segment is masked; a URL's
own `token=`/`access_token=`/`api_key=`/`password=`/`secret=`/`sig=`/
`signature=` query parameter (`key=` only when its value also looks like a
credential — long and mixed in case, digits or base64 punctuation, since a
bare `key=` is one of the most common, least secret-shaped query names in
ordinary traffic); an AWS secret-access-key-shaped value or a base64
credential, even one containing a `/`; and other long, random-looking strings
that are their own standalone token. Only the value is replaced with a fixed
marker — variable names, flags, hosts and paths stay exactly as written,
because that structure is what the judgement reasons about.

**Precision (JEVADV-29):** a token or path segment that sits inside a
filesystem path or a URL (a long opaque id after `/Volumes/.../claude-501/`,
Claude's own `-Users-name-Projects-repo` session-folder naming, a
`claude.ai/code/artifact/<id>` URL) is never masked, even when it would
otherwise look exactly like a high-entropy secret — only an explicit
secret-named query parameter inside a URL still is. A `<word>_<uuid>` or
`<word>_<hex>` id (`term_<uuid>`, `rctx2_<hex>`) is never masked either: an id
references something, it does not grant access to it.

**Precision, continued (JEVADV-37):** two of those exemptions had themselves
gone too far. A value containing a `/` is no longer assumed to be a path or
URL just because it contains one — an AWS secret access key and a base64
credential commonly do too, and are now masked unless the value actually
starts with a path/URL marker (`/`, `~`, a Windows `\`, a URL scheme) or reads
as real path segments rather than base64. And the `<word>_<alnum>` id
exemption above now requires the suffix to actually be a UUID or lowercase
hex — narrow enough that a real npm/Hugging Face token (also shaped
`word_<long-mixed-case-run>`) is masked instead of exempted, at the accepted
cost of one further false positive: a mixed-case-and-digit id that is neither
hex nor a UUID (an Anthropic tool-call id fabricated past 32 characters) is
now masked too, though a real one (30 characters) never reaches the
high-entropy floor in the first place. `src/core/secret_redaction.test.ts`
covers both classes with a synthetic set (never the owner's own corpus).

**Precision, continued (JEVADV-40):** the "reads as real path segments"
exemption above only recognised a single lowercase word or a single
Capitalized word, so a directory tree built entirely from compound
camel/PascalCase developer names (`ClientWork/BackEnd/DataLayer/UserRepo`)
had no plain segment left to save it and was masked as if it were a
credential. Every `/`-delimited segment must now read as an ordinary word —
all-lowercase, a single Capitalized word, or a camel/PascalCase compound of
them — for the whole value to be waved through; one genuinely secret-shaped
segment mixed among otherwise ordinary ones is still masked, since a single
word-like neighbour can never vouch for it.

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

These figures predate the advice mechanism below, which adds up to three
local `git` calls (never a network one) when it fires — not re-measured
for this release.

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
policy either permits, prohibits, or requires a person. A `prohibits` or
`requires_human` match settles the command outright, skipping the risk
judgement entirely — a policy is only ever allowed to make the gate MORE
careful, never less. A `permits` match does not skip the risk stage: it
only means no `requires_human`/`prohibits` policy stands in the way, and
the consequence-ceiling risk rule still gets the final say, because the
coverage question alone isn't reliable enough to greenlight something risky
by itself — a policy about reading code and running tests has, in
practice, matched an unrelated `rm -rf dist` at high confidence. Policies
are global by default, and a rule that genuinely belongs to one project can
be scoped to it. A policy also declares its scope: a single command (the
default), how the agent works across many commands — process scope, e.g.
*screenshots get looked at before being called done*, *the cheapest
available model handles a mechanical task* — or already enforced by a
local deny rule before Jev ever runs, e.g. *never rewrite history on a
remote* and *never discard uncommitted work* — local-rule scope. A
command-gate stop never checks a command against a process or local-rule
policy: a process policy describes the workflow that produced the command,
not the command itself, so no shell command can be "the concrete instance"
of it either way; a local-rule policy's real instances are already refused
by the command gate's own deny-tier rules — outright, or as an advice to
the model when that rule's own switch is off — before the policy stage
ever runs, so a command that reaches the policy stage naming one only
*mentions* it in quoted data, and Jev cannot honestly answer whether a
mention is "a concrete instance" of a rule that never ran.

A policy row still stored with a pre-rename Spanish kind (`permite`/
`prohibe`/`pregunta`) is converted to its English equivalent automatically
the first time the plugin activates. A row with no recognisable kind at
all is never guessed — it stays excluded from judgement exactly as
before — but the Advisor board now names how many such rows exist and
which ids they are, instead of silently judging nothing for them.

**Thresholds.** Sensible defaults, measured. Change them only with
evidence.

**Cache.** A verdict is cached per command shape and repository, so a
repeat doesn't cost a second Jev call. The cache key also fingerprints the
policies that would apply to the matched destination and its
consequence-ceiling override, so adding, removing or editing a policy
invalidates any stale cached verdict instead of letting it keep replaying
for up to 30 days.

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
| Force push (`--force`/`-f`, or a leading `+refspec`) | segment, mention vs command | The pattern spans arbitrary text after `git push`, so whole-string matching let it reach across a separator into an unrelated segment (e.g. `git push origin --delete x && git branch -f main origin/main` was wrongly denied as a force push). A `+refspec` (`git push origin +main`) is a force push too — git's own forced-update syntax, scoped to one ref. `--force-with-lease`/`--force-if-includes` never match this rule at all — they don't qualify for the local allow below either, so they take the ordinary Jev path — and a `--force-with-lease` aimed at a protected branch is still caught by the row right below. |
| Push to a protected branch (`main`/`master`/`production`) | segment, mention vs command, narrowed to a real shared remote | Same spanning-quantifier reason, plus the narrowing described further down: a push whose remote resolves to a local, non-shared repository isn't a shared-branch push at all. |
| `rm -rf /` (or `~`/`$HOME`) | segment, mention vs command | Naming this phrase in a `grep` pattern, a quoted argument or a heredoc body is not running it — see "Three severities" below. |
| Discarding uncommitted work (`git checkout`/`git restore`/`git reset --hard`/`git clean -f`) | command, with a segment-level fallback | This check already segments the command on its own and extracts `$(...)`/backtick substitutions, `bash -c`/`eval`/`su -c`/`script -c` bodies, `ssh`'s remote command and `watch`'s command first; pre-splitting again would break that extraction. `git reset --hard`/`git clean -f` used to be their own, separate, quote-blind regex — folded in here so all four subcommands get the same tokenizer and command-position discipline. The rule also reads each segment through the same mention-vs-command scan the rows above and below use, so a reset or clean spelled out through a non-shell interpreter (`python3 -c "...os.system('git reset --hard')..."`) is still caught even though the tokenizer only understands shell syntax. |
| `DROP`/`TRUNCATE TABLE`/`DATABASE`/`SCHEMA` | segment, mention vs command (a SQL client's own execute flag still denies) | `DROP TABLE` inside a `psql -c`/`mysql -e` argument is unambiguous SQL execution, not ambiguous interpreter code, so it keeps denying outright there — see "Three severities" below. |
| `kubectl delete`/`drain` | segment, mention vs command | Same reasoning as `rm -rf` above: a mention in a script or a search pattern goes to Jev instead of stopping locally. |
| `terraform`/`tofu apply` | segment, mention vs command | Same reasoning. |
| `terraform`/`tofu destroy` | segment, mention vs command | Same reasoning. |
| `curl \| bash`/`sh`/`zsh` | command (mandatory, spans the pipe) | This rule matches ACROSS a pipe by design — the whole point is catching a curl piped into a shell. Segment scope would silently disable it. |

A quoted separator (for example `git commit -m "build && test"`) never
splits a segment: the text inside the quotes stays part of one segment,
exactly as a shell would read it.

**Push to a protected branch, narrowed to an actual shared branch.** A push
naming `main`/`master`/`production` is only a shared-branch push once its
remote resolves to somewhere shared. `git push -u origin main` in a
brand-new personal repo whose `origin` is a local bare directory (or a
`file://` URL given directly) is not that: the rule resolves `origin` from
the repository's own `.git/config` (a linked worktree's shared commondir,
never the network) — its `pushurl` when the remote has one (`git remote
set-url --push`, where fetches and pushes go to two different places),
`url` otherwise, exactly the way `git push` itself resolves it — and lets
that one case continue to the ordinary Jev path instead of stopping
locally. Anything it cannot positively resolve without the network —
GitHub/GitLab/SSH/HTTPS remotes, an unknown remote name, an unreadable
config — keeps denying exactly as before. Force push is unaffected and
stays denied everywhere, including to a local remote.

**Three severities: a run denies, ambiguous interpreter code advises, a
mention goes to Jev instead of stopping locally.** Eight of the nine
`NEVER_SILENTLY` rules — every one but curl-pipe-shell, which matches
across a pipe by design and stays a plain whole-command check — are read
through the SAME model (`someSegmentMatches`, `src/core/git_discard.ts`),
which resolves each segment to one of three outcomes, never just two:

- **Deny** — a match in **command position**: the segment's own command,
  `$(...)`/backtick substitutions, a real shell/login/watch wrapper's
  command (`bash -c`/`sh -c`/`zsh -c`/`dash -c`/`ksh -c`, whichever program
  precedes the shell — `parallel sh -c "…"`, `flock f sh -c "…"`) —
  `eval`/`su -c`/`script -c`/`ssh`'s remote command/`watch`'s command are
  recognised only at the segment's resolved command position, never as an
  arbitrary later token — `grep -n watch "…" f` must not read `watch` as a
  command just because the word appears in grep's own argument. A hard
  stop, exactly as before.
- **Advises the model** — a match that exists ONLY because an
  **interpreter CODE string** stayed visible (`python`/`python3 -c`,
  `node -e`/`-p`/`--eval`, `ruby -e`, `perl -e`/`-E`, `php -r`,
  `osascript -e` — these commonly shell out, so they are never treated as
  inert data). The gate genuinely cannot tell executed code from a literal
  test string there — a regex classifier's own fixture, or a script that
  merely reads such a string from a file, looks identical to one that
  really does shell out — so this is no longer a hard stop: it becomes an
  advice to the coding model, phrased as a conditional ("this text appears
  only inside inline interpreter code, which may be data rather than a
  command; if it ran, it would: …"), never asserted as fact. A SQL client's
  own execute flag (`psql -c`, `mysql -e`) is the one exception: there is
  no "maybe this is just data" reading of a `-c`/`-e` SQL argument, so
  `DROP TABLE` inside one of those still denies outright, never softening
  to an advice.
- **Goes to Jev** — a match that exists ONLY because a quoted argument of
  some OTHER, non-executing program stayed visible is a **mention**, not a
  run: it is NOT a local-rule match at all (JEVADV-37) — the command
  continues to the ordinary Jev path (a real risk/policy judgment) exactly
  the way a command led by a mention-only verb (`grep`, `echo`, `sed`, …)
  already did before this, rather than stalling an unattended agent on a
  local question nobody is there to answer (`git grep`'s own pattern and
  `sed`'s script argument are programs reading data, not commands —
  neither ever ran the phrase they merely contain).

A rule's own on/off switch (the panel's deny-tier toggles) only ever
matters once a rule has already decided to deny: turning it off downgrades
that `deny` to an advice to the coding model — the same mechanism above,
phrased as fact rather than a conditional, since a toggled-off match WAS a
real command-position run — never to a human `ask`, and never to a silent
`allow`. A mention was never a `deny` to downgrade from, and always
reaches Jev regardless of the switch.

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
resolves to a mention, never silently allowed, never denied outright, and
(JEVADV-37) never a local ask either — it goes to Jev instead. A
`$(...)`/backtick substitution stays visible regardless of
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
reaching the ordinary Jev judgment.

## Local allow: your own branch, and git's own guards

A plain, non-force push of a branch nobody else shares — or one of git's
own guarded delete/worktree operations (`git branch -d`/`--delete`,
`git worktree remove` without `--force`/`-f`, `git worktree prune`, or
`git worktree add` without `--force`/`-f`/`-B`) — cannot destroy anything
on its own, so it can skip Jev's judgment once nothing else is left to
check it. The sequence can be led by exactly one `cd <dir> &&`, and it can
carry the output plumbing a real agent almost always adds: `2>&1`, `>&2`,
discarding to `/dev/null`, or a pipe into a downstream reader that is
already tier-1a-safe on its own (`| tail`, `| grep`, …) — never a fresh
action in its own right. Joined by `&&`, `;` or that trailing `|`; never a
bare `&` or a newline.

This never replaces anything above: the deny-tier rules still run first,
and a team policy still gets the final say when one applies:

- When no command-scoped policy applies to the matched destination at all,
  the command is allowed locally, right here — no Jev call, no cache
  read or write.
- When at least one does, Jev is still asked, but only the policy coverage
  question: the risk axes (reversible/external/consequence) never decide
  for a qualifying command, not even a high consequence score, but a real
  `requires_human`/`prohibits` policy (*never write to main*, *a client's
  PR always needs a person*) still stops it.

Only six push flags qualify at all — `-u`/`--set-upstream`, `-q`/`--quiet`,
`-v`/`--verbose` — never a short cluster or a `--flag=value` form. `--force`,
`--force-with-lease` and anything else (including `--no-verify`, which
skips hooks) disqualify: they take the ordinary Jev path instead, where the
protected-branch rule above still hard-stops anything aimed at
`main`/`master`/`production`, `--force-with-lease` included.

## Deploy and publish: never "local and cheap"

A command that triggers a deployment or publishes an artefact is floored
to at least an advice, whatever the risk stage would otherwise have said.
`gh workflow run`, `gh release create`, `npm`/`pnpm`/`yarn publish`,
`twine upload`, `cargo publish`, `gem push`, `docker push`, `vercel --prod`
or `vercel deploy`, `netlify deploy --prod`, `fly deploy`, `eas submit`, an
`eas update --branch production`, `fastlane deliver`/`pilot`/`supply`,
`helm install`/`upgrade` and `kubectl apply` are all recognised, in
command position only — a mention inside a grep pattern or a quoted
argument never counts. The same fact is
folded into the SAME state Jev already reads for the risk and policy
questions, so a destination policy (e.g. *a client's site always asks a
person*) can catch a real deploy/publish command too, not just the risk
axes. This closes a real gap: a GitHub Actions deploy dispatch on a client
repository was once allowed outright, with Jev's own reason reading
"reversible, local and cheap."

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
