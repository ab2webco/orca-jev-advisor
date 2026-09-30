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
- [ ] T2 prohibits judged on violation
- [ ] T3 N-04 refusals
- [ ] T4 unregistered paths redacted
- [ ] T5 interpreter heredocs and gate tail
- [ ] T6 README, QA, release, live check

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
