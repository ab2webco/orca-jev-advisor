# Release 0.6.13: fewer false stops, consistent policy verdicts, private paths, faster gate

## Objective
Close the open items of the 0.6.12 QA (odd/qa/qa-0.6.12.md N-01..N-04) and the
next gate items of the backlog, so that text is never judged as a command, a
team policy gives the same verdict for the same effect, no unregistered path
reaches Jev in clear, and the gate answers without a tail.
Authorized by the owner 2026-09-30: "dale pero hasta el 5 debería ser el
release" (points 1-5 of the pending list). Plane: JEVADV-82.

## Scope
- T1 F-09/N-03: text in a known data position is data. Values of message and
  body flags of known CLIs (`git commit|tag -m/--message/-F -`, `gh pr|issue|
  release create|edit|comment --title/--body/--notes`, `orca terminal send
  --text`) and heredoc bodies written to a file (`cat > f <<EOF`, `tee f <<EOF`,
  not fed to a shell or interpreter) are neither matched by local rules nor sent
  to Jev as text: Jev reads a placeholder. A script's own arguments
  (`node probe.mjs '<json>'`) stay as they are (the script may run them).
- T2 JEVADV-13, N-01/N-02: a `prohibits` policy is judged on violation, not
  topic. For `never_write_to_main` the line is: any change to the working tree
  or history of a main/develop checkout (a tracked or a new file, commit, merge,
  rebase, reset, cherry-pick, amend) violates; a tag, fetch, status, log, diff,
  or switching to or creating another branch does not. Calibrated on a labelled
  corpus against live Jev (the QA rows plus the other `prohibits` policies'
  positives and negatives), with the corpus size and measured band published.
- T3 N-04: of the eleven stops that were only advice in 0.6.12, these become
  local-rule refusals: `echo ~ | xargs rm -rf` and `find ~|/ -delete` (rmRf);
  `git push --mirror` (forcePush); `git push origin --delete main`,
  `git push origin :main` and a refspec whose destination is a protected branch
  (`feature/x:production`) (pushProtected). The python heredoc that runs
  `git push --force` is T5's. These stay advice, on purpose, and the reason is
  written in the README: `git merge` on main (T2 decides it by policy),
  `sqlite3 … DROP TABLE` (a local file, the gate cannot tell production from a
  scratch database), `curl -o f && bash f` (decided in 0.6.12), `kubectl
  --context prod delete` and `terraform apply` (normal work that a person
  approves; a team can add a policy).
- T4 F-06: no path reaches Jev in clear unless it is a system location whose
  name carries the risk (`/`, `/etc`, `/usr`, `/bin`, `/var`, `/tmp`, `/dev`,
  `/System`, `/Library` and the like). A path under the home directory or on
  another volume becomes a stable placeholder whether or not the plugin
  registered it: in the command, the repository context, the cross-repository
  sentence and skill/tool decisions. The home directory itself is `~`.
- T5 JEVADV-63 and JEVADV-68: a heredoc body fed to `python`/`python3`/`node`/
  `perl`/`ruby` is visible to the local rules (the python heredoc with
  `os.system('git push --force origin x')` is refused). The gate process ends
  right after its verdict: the budget timer is unref'd or the hook exits after
  writing; the tail is measured before and after.
- T6 README, QA in `odd/qa/qa-0.6.13.md` (replay of the 0.6.12 set plus the new
  rows), release 0.6.13, live check.

Out of scope: F-08 as a local rule (kubectl/terraform stay policy or advice),
F-10..F-14, the rest of the backlog.

## Checklist
- [x] T1 data positions are data. Proof: 10 regression tests (`command_text.test.ts` 6,
  `decisions.test.ts` 1, `git_discard.test.ts` 1, `gate-deny-spellings.test.mjs` 2) RED 7/10
  failing against a pass-through stub of `withDataTextAsPlaceholders`, GREEN 10/10, plus one
  guard added after (a heredoc inside `eval "$(cat <<EOF`/`echo "$(...)" | bash` stays
  visible); `npm test` 2718/2718. Live probe (working-tree hook, orca-supervisor): `orca
  terminal send --text 'run git push origin main and rm -rf /'` allow (was advice),
  `cat > /tmp/x.mjs <<'EOF'` with a force push in the body allow, `git push origin main`
  `REFUSED`, `git commit -m "$(cat <<'EOF' ...force push...EOF)"` allow (was `REFUSED` as a
  force push: the form Claude Code writes every commit message in), `git commit -F -`,
  `gh pr create --body-file -`, `tee f <<EOF` allow. `gh release create --notes '<text>'`
  stays advice: Jev reads `--notes ‹text›`, the advice is the deploy/publish floor ("creates
  a GitHub release"), not the text. Decisions: Jev reads `‹text›` in place of the value
  (quoted or not) of `git commit|tag -m/--message`, `gh pr|issue|release create|edit|comment
  --title/-t/--body/-b/--notes/-n` and `orca terminal send --text`, and in place of a heredoc
  body written by `cat >`/`tee` (not piped on), read by `git commit|tag -F -`/`gh --body-file
  -`, or the `cat` of `-m "$(cat <<'EOF'`; a value holding `$(`/backticks keeps its text. A
  heredoc opened inside a double-quoted `$(` is now read as one (it was invisible, so the
  message body reached the rules); it is stripped for the rules only when it is such a
  message, since `eval "$(cat <<EOF` runs it. `gh --notes/-n` joined gh's data flags for the
  rules (it was a mention, sent to Jev).
- [x] T2 prohibits judged on violation. Proof: `decisions.test.ts` 6 new tests RED 5/6
  (the below-gate case already held), GREEN 6/6; `command_text.test.ts` attribution test RED
  1/1, GREEN; `npm test` 2725/2725. Corpus (live Jev, jev-latest, 2026-09-30): 73 labelled
  rows (the 0.6.12 QA shapes E04/E13/G02/D15/D17 and N-01/N-02, plus positives and negatives
  for production_data, cutover, no_ai_attribution, active_uat, friday, large_pr), of which 55
  reach Jev (the rest pass locally as read-only); 33 violations (never_write_to_main 23,
  production_data 5, cutover 2, no_ai_attribution 2, active_uat 1) and 22 non-violations
  (never_write_to_main 16, production_data 4, cutover 1, friday 1). Old prompt (coverage +
  same_kind, 0.6.12 states, one run): 46/55 correct, band min(violation) - max(non-violation)
  = 0.50 - 0.77 = -0.27 (misses: `cp` into main x3, `git merge`, `git reset --soft`; wrong
  stops: `cd demo-app && git tag` x2), also -0.27 with the owner's line as the rule text. A
  violation question with the installed short rule text alone: -0.17. Shipped question (a
  `violation` choice over the prohibitions only, stating what writing on a branch means), on
  states captured from the new hook, three runs: 165/165 correct, band 0.85 - 0.19 = +0.66
  (lowest violation `cp /etc/hosts hosts-qa.txt` on main 0.85, highest non-violation `git
  worktree add ... -b` 0.19); gate 0.7. Acceptance probes, three runs each with a fresh cache
  and new file/tag names and sessions: `touch`, `cp`, `echo >>`, `git commit` in demo-app and
  through `cd`/`git -C` from orca-supervisor `REFUSED` by never_write_to_main 24/24; `git tag`
  from demo-app, from orca-supervisor (`cd`) and from feat-app (`cd`, `git -C`) allowed 12/12.
  Decisions: prohibitions leave the coverage question (it asks what a rule is ABOUT); a
  coverage answer naming a prohibition no longer stops anything; the violation is checked
  first, so a broken prohibition refuses even when a requires_human rule also covers the
  action; GATE_DECISION_RULES_VERSION 3 -> 4 so v3 verdicts are judged again. The meaning of
  writing on a branch lives in the question, not in the rule text, so the owner's installed
  rule ("Never write directly on main or develop, not even a one-line fix.") works unchanged.
  Found while measuring: with T1's placeholder, no_ai_attribution could no longer see a
  `Co-Authored-By`/`Generated with`/robot line (clear text: 4/4 stopped; placeholder: 0/2), so
  the placeholder now carries those lines and nothing else (`‹text with the line: ...›`).
  Changed on purpose: six decisions.test.ts cases that stopped on a prohibits COVERAGE answer
  now also carry the violation answer that stops them (that coverage path was the defect).
  Open, not T2: the verdict cache keys on the command's shape, so a deny cached for `docker
  volume rm prod_pgdata` answered `docker volume rm dev_pgdata`, and one for a PR body with
  an attribution line answered a clean body (see the report).
- [x] T0b (added 2026-09-30, urgent, reported by the lead) a push to a feature branch whose
  NAME holds a protected word is not a push to a shared branch. Reproduced on the installed
  0.6.12 hook from a client repository with a GitHub remote: `git push -u origin
  fix/cin-1184-production-azure-storage`, `fix/main-menu`, `feat/master-data` `REFUSED` (the
  rule matched `\b(main|master|production)\b` anywhere after `git push`; `-` and `/` are word
  boundaries). Proof: `deny_rule_shapes.test.ts` 2, `push_remote.test.ts` 5,
  `push_own_branch.test.ts` 1, `gate-deny-spellings.test.mjs` 2: RED 10/10 (5 of them as
  the missing `resolveImplicitPushDestination` export), GREEN 10/10; `npm test` 2735/2735.
  Live probe (working-tree hook, the same client repository): the three names above, `HEAD:fix/
  main-menu` allowed (own-branch allow); `git push origin main`, `HEAD:main`,
  `HEAD:refs/heads/main`, `feature/x:production`, `--delete main`, `:main` `REFUSED`; a
  scratch repo on `feature/x` tracking origin/main with `push.default=upstream`: `git push`
  and `git push origin` `REFUSED`, `git push -u origin HEAD` allowed. Decisions: the
  destination ref is judged exactly (after `:`, or the whole ref; `+` and `refs/heads/`
  dropped; with `--delete`/`-d` the ref itself); a remote named `production` and `main` as a
  SOURCE (`main:feature/x`) are no longer refusals; `--all`/`--branches` is a push to a
  shared branch (it pushes local main too). A push naming no destination is judged by what
  git would push (push_remote.ts `resolveImplicitPushDestination`, read from disk like the
  remote): explicit `HEAD` is the current branch; otherwise `push.default` (local over
  ~/.gitconfig over the XDG file, default `simple`): `simple`/`current` the current branch,
  `upstream`/`tracking` its `branch.<name>.merge`, `matching` a shared-branch push, `nothing`
  or no upstream nothing; a `remote.<name>.push` refspec, a detached HEAD or no repository
  stay unknown (not refused locally, as before). The own-branch allow uses the same answer,
  so a bare `git push` whose upstream is main under `upstream` no longer qualifies. The local
  remote exemption (JEVADV-39) applies to both. Protected names stay `main`, `master`,
  `production` (push_remote.ts; there is no config for them). This also delivers T3's three
  pushProtected spellings (`--delete main`, `:main`, `feature/x:production`).
- [x] T3 N-04 refusals. Proof: `deny_rule_shapes.test.ts` 3 new (xargs/find deny, filtered
  find and mentions not, `--mirror`) and `gate-deny-spellings.test.mjs` 8 new (the seven
  spellings refused twice, data stays data): RED 6/11 (the three push spellings were already
  green from T0b, the two data/negative cases hold), GREEN 11/11; `npm test` 2746/2746.
  Live probe (working-tree hook), each with an identical retry: from feat-app `echo ~ |
  xargs rm -rf`, `find ~ -delete`, `find / -delete` `REFUSED` rmRf, `git push --mirror`
  `REFUSED` forcePush; from orca-supervisor (GitHub remote) `git push origin --delete main`,
  `git push origin :main`, `git push origin feature/x:production` `REFUSED` pushProtected.
  From feat-app those three are set aside by the JEVADV-39 local-remote exemption (its
  origin is a local bare directory), so they reach Jev: `--delete main` and
  `feature/x:production` advice, `:main` `REFUSED` by never_write_to_main; the 0.6.12 QA rows
  H-force-delete-main/H-protected-feat-to-main ran there, so their replay needs a repository
  with a shared remote. Kept as advice (no local rule): `sqlite3 app.db "DROP TABLE users"`
  advice, `curl -o f && bash f` advice. Three of the five now stop by TEAM POLICY, not a local
  rule, through T2: `git merge feature/x` on main `REFUSED` never_write_to_main (as planned),
  `kubectl --context prod delete ns x` `REFUSED` production_data, `terraform -chdir=infra
  apply` asked by infrastructure_changes (requires_human). Decisions: `find` from root or home
  is the rule only when it deletes (`-delete`, `-exec`/`-execdir`/`-ok rm`) with nothing that
  narrows it (only depth, traversal, `-type` and print options); `-name`, `-path` and every
  other test make it a cleanup for Jev. Root or home printed by `echo`/`printf` through a
  real pipe into `xargs ... rm -r` is the rule. `--mirror` joined forcePush (it overwrites
  and deletes every remote ref).
- [x] T4 unregistered paths redacted. Proof: `jev_pseudonyms.test.ts` 4 new and
  `decisions.test.ts` 1 new (the request-building seam, `buildActionGateState`, the object
  `callJev` sends): RED 4/5 (a URL and a registered path's remainder already held), GREEN
  5/5; `npm test` 2751/2751. Live check on the recorded request bodies: a preload in the
  scratchpad wraps `fetch` in the hook process and writes every Jev request body; 64 requests
  from the T1 probes, the T2 corpus and 8 path probes (a `cp` into another checkout by
  absolute path, `cat ~/Projects/...`, a file under `~/Library/Application\ Support`, `cd`
  and `git -C` into a scratch repository, `rm -rf` and `du` of home paths, `/tmp`/`/var`
  paths): 0 bodies hold a `/Users/`, `/home/` or `/Volumes/` path or the account name. Seen
  in a body: `cp /etc/hosts <path-1>/hosts-t4.txt`, `cat <path-2> > <path-3>`, `du -sh ~`,
  `cp /tmp/a.txt /var/tmp/b.txt`. Decisions: done once in `JevNames.redactText`, after the
  registered names, so every text that already went through it (command, context,
  cross-repository sentence, destination label, policy rules, the skill and tool request)
  gets it; a path word starts at the start, whitespace, a quote, `=`, `(`, `,` or `>`
  (never after `:`, so a URL stays, nor after a placeholder), keeps `\ `-escaped characters,
  and drops a trailing `.`/`,`/`:`. In clear: `/`, a path under `etc usr bin sbin var tmp
  dev System Library private opt lib lib64 proc sys boot run Applications cores nix`, and a
  single-component path (`/data`, an awk `/error/` pattern); `/Users/<name>` or
  `/home/<name>` alone reads `~`; `~`, `$HOME`, `${HOME}` alone stay; everything else
  (under home, `~/...`, `$HOME/...`, another volume, `/mnt/x/y`) is a `<path-N>`, the same
  value the same placeholder in one request. Not covered: relative paths, Windows paths, and
  skill/tool candidate descriptions (plugin text, not the person's).
- [x] T5 interpreter heredocs and gate tail. Proof: `command_text.test.ts` 2 new,
  `gate-deny-spellings.test.mjs` 2 new, new `src/core/jev.test.ts` 2 (real timers): RED 4/6
  (the two print-only cases already held; jev.test.ts failed on the missing `defaultSleep`
  export), GREEN 6/6; `npm test` 2757/2757. Live probe (working-tree hook): the 0.6.12 row
  K-py-heredoc-force (`python3 - <<'PY'` + `os.system('git push --force origin x')`)
  `REFUSED` forcePush, retry too (was advice); a node heredoc `execSync('git push -f ...')`
  `REFUSED` forcePush; a python heredoc `subprocess.run(['rm', '-rf', '/'])` `REFUSED` rmRf;
  a python heredoc that only prints the same text allowed. Tail (scratchpad harness: spawn
  the hook, time from the verdict's first stdout byte to process exit, a fresh cache dir per
  run so Jev is really called, `touch` in feat-app): before, 5 runs, median 1395 ms (min
  1357, max 1426; total median 1999 ms, verdict at 604 ms); after, 10 runs, median 9 ms (min
  7, max 12; total median 536 ms). A local-rule refusal: 11 ms before, 2 ms after.
  Decisions: an interpreter heredoc body is replaced by the command lines it runs (every
  string argument of `os.system`, `os.popen`, `os.exec*`, `subprocess.*`, `exec`/`execSync`/
  `execFile*`/`spawn*`, `system`, `popen`, `Open3.*`; for perl and ruby also backtick, `qx`
  and `%x` strings), one per line, read in command position; the rest of the program stays
  out of view, so a print or a held string is still data. A shell reader keeps its whole
  body, as before. `python3 -c "..."` keeps its 0.6.x treatment (interpreter code is
  advice). Tail: both halves -- `callJev` aborts the budget's sleep once the race settles
  and the default sleep clears its timer on abort (a sleep that ignores the signal, like the
  mod's `$.clock.sleep`, runs out as before); and the hook writes its verdict with
  `writeSync` and exits when main() returns, like agent-model.ts.
- [ ] T6 README, QA, release, live check. Done so far: QA in odd/qa/qa-0.6.13.md (replay
  243/244, new rows 36/38, 42/42 push/tag/new-file probes, 16 request bodies clean, tail
  1375 -> 6 ms); the release history moved from the README to CHANGELOG.md, newest first;
  versions 0.6.13. Two defects found by the QA and fixed on the branch: a push to main was
  not "writing on main" in T2's question (afff863, rules version 5), and `kubectl`/
  `terraform` with a global option before the verb were advice although the plain spelling
  is a local refusal (ecfabb7; this reverses the plan's "stay advice" for those two).

## Acceptance criteria
- Every new behaviour is a regression test observed failing before its fix.
- The commands this session was advised on for text alone (a `git push` inside
  `orca terminal send --text '…'`, inside a heredoc written to a file) are
  allowed; a real `git push origin main` next to that text is still refused.
- `never_write_to_main`: `touch new.txt`, `cp x new.txt`, `echo x >> f` and
  `git commit` in demo-app are refused from demo-app and through `cd`/`git -C`
  from another repository; `git tag v1` is allowed from both. Same verdict in
  three runs each. The measured band between violations and non-violations is
  positive and published with the corpus size.
- The six N-04 commands of T3 are `REFUSED` (retry too); the five kept as advice
  are still advice.
- No home or volume path in any request body sent to Jev during the QA (checked
  on the recorded request, not only the unit test).
- The gate hook process exits within 100 ms of writing its verdict (measured).
- `npm test` green; no existing test weakened or removed.

## Checks
`npm test`; the 0.6.12 replay plus new rows (hook fed PreToolUse JSON, reason
read); live Jev for T2's corpus; live agent session in the scratch repos under
`/Volumes/Data/jev-live-check/`; no panel change expected.
