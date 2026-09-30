# Release 0.6.12: close the gate bypasses found by the 0.6.11 live QA

## Objective
Every command class the 0.6.11 live QA (odd/qa/qa-0.6.11.md) saw pass or get
only advice, where a local rule or a team policy must refuse, is refused.
Authorized by the owner 2026-09-30: "Sí, arranca la 0.6.12" (scope F-01..F-05).

## Scope
- T1 F-01 (JEVADV-64): `rm` recursive+force in any spelling (`-fr`, `-r -f`,
  `-Rf`, `--recursive --force`, extra flags such as `-rfv`) on `/`, `/*`, `~`,
  `~/`, `$HOME`, `${HOME}`, `"$HOME"`, also inside a subshell `( ... )`, is a
  local-rule deny, never advice. Rule at `adapters/claude/gate-bash.ts` (rmRf).
- T2 F-02 (new): force push in any spelling is the forcePush local rule:
  clustered short flags containing `f` (`-fu`, `-uf`, `-fq`), and git global
  options before `push` (`-C <dir>`, `--no-pager`, `-c k=v`, `--git-dir=`,
  `--work-tree=`). `--force-with-lease`/`--force-if-includes` keep their
  current treatment.
- T3 F-03 (JEVADV-65 and new): a push to a protected branch is refused through
  git global options, env/command prefixes, and a backslash-newline
  continuation (`git push \` + newline + `origin main`).
- T4 F-04 (JEVADV-66 and new): remote code piped or fed to a shell or
  interpreter is the curlPipeShell local rule: through `tee`/other pipe stages,
  `/bin/bash`/`/usr/bin/env bash`/`env bash`, `bash <(curl ...)`,
  `bash -c "$(curl ...)"`, `eval "$(curl ...)"`, and `python3`/`python`/`perl`/
  `ruby`/`node` as the receiving stage.
- T5 F-05 + F-07 (new): a command is judged in the repository and branch it
  acts on, not the session cwd: `cd`/`pushd`, `( cd x && ... )`, `git -C <dir>`,
  `--git-dir`/`--work-tree`, and the inner command of `bash -c`/`sh -c`/`eval`.
  Policies (`never_write_to_main`), repository context sent to Jev and the
  recorded `project`/`commandFamily` follow the target. A write to main from a
  feature-branch session is refused; a commit to a feature branch from a main
  session is not (F-07).
- T6 README, QA rerun documented in `odd/qa/qa-0.6.12.md` (every F-01..F-05/
  F-07 row of the 0.6.11 QA replayed), release 0.6.12, live check.

Out of scope: F-06 redaction of unregistered paths, F-08..F-14.

## Checklist
- [ ] T1 rm recursive+force spellings
- [ ] T2 force push spellings
- [ ] T3 protected push through global options, prefixes, continuations
- [ ] T4 curl/wget to shell or interpreter
- [ ] T5 target repository and branch attribution
- [ ] T6 README, QA rerun in odd/qa/qa-0.6.12.md, release, live check

## Acceptance criteria
- Every 0.6.11 QA row in F-01..F-05/F-07 that failed is a regression test that
  was observed failing before its fix.
- Each of those commands is refused by a local rule or policy (`REFUSED`), not
  advice; an identical retry is refused too.
- A mention stays data: the same text inside a grep pattern, a quoted argument,
  an `echo`, or a heredoc body is not refused.
- `npm test` green; no existing test weakened or removed.

## Checks
`npm test`; the QA probe replay (hook fed PreToolUse JSON, reason read, not
only `permissionDecision`); live agent session in a scratch repo under
`/Volumes/Data/jev-live-check/`; no panel change expected (screenshots only if
one happens).
