# Release 0.6.17: the gate guards itself, no false refusal on a PR merge

## Objective
Close what the field report of 2026-09-30 (0.6.10 on the owner's second
Mac, re-verified on 0.6.15) and the 0.6.16 live run left open: the advised
model can rewrite the gate's own decision inputs, a reviewed PR merge from a
checkout on main is refused, settings backups holding a token are readable
by other users, and four low findings. Then use Orca Lab's new panel close
action where the running Orca offers it.
Authorized by the owner 2026-09-30 ("sigue con la 0.6.17 mientras tanto").
Plane: JEVADV-93, 90, 91, 92, 67 (and 41 for T6).

## Scope
- T1 JEVADV-93: `gh pr merge` from a checkout on main is not a direct write.
  - Live on 0.6.16: in a repository whose primary checkout is on main,
    `gh pr merge 430 -R <owner>/<repo> --squash …` was REFUSED by Jev under
    `never_write_to_main`, while the same command from a feature checkout
    gets only risk advice.
  - Give Jev the fact the code can know: a `gh pr merge` merges a pull
    request on the server through its review, and the local branch does not
    change that (the 0.6.15 T3 push-destination facts are the model to follow).
  - Replay rows:
    - `gh pr merge` from a main checkout and from a feature checkout (allow
      under `never_write_to_main`);
    - `git merge feature && git push origin main` from main (refuse);
    - `gh api -X POST repos/o/r/merges …` into main (refuse);
    - `gh pr merge --admin` (state what it does and decide; record why).
  - No refusal lost on the 0.6.12–0.6.15 replay sets (244, 38 and 10 rows).
- T2 JEVADV-90: the model cannot rewrite its own judge.
  - Covered files: the gate's decision inputs under the plugin config
    directory (`team-owners.json`, `policies.json` mirror,
    `deny-tier-config.json`, `models-catalog.json`, the catalog, and any
    other file the gate or router reads to decide; list them from the code).
  - Bash: any write to one of them is a local refusal with the reason
    spelled out ("edits the gate's own rules; change them in the Advisor
    panel"). That covers a redirect, `tee`, `sed -i`, `cp`/`mv` over it,
    `rm`, `truncate`, an interpreter heredoc that opens it for writing, and
    `~`, `$HOME` and absolute spellings. Reading them stays allowed.
  - File tools: the Claude Code side registers the gate on Bash and Agent
    only, so Edit/Write/MultiEdit/NotebookEdit can still change these files.
    Add a PreToolUse matcher for the file tools that refuses only these
    paths and allows everything else silently and fast (no Jev call). The
    installer, uninstall, status and the hooks check learn the new entry.
  - Decide whether a hand-edit digest (the panel stamps what it wrote; the
    board flags a mirror changed outside it) is worth it in this release;
    record the decision. A person editing by hand is legitimate, so it can
    only inform, never block.
- T3 JEVADV-91: settings backups are owner-only. `backupSettingsOnce` writes
  with mode 0o600, and install and status tighten any existing
  `claude-settings-backup*` to 0600, because the once-only rule freezes the
  old ones. Test the mode of a new backup and of an existing 0644 one.
- T4 JEVADV-92, field lows:
  - `gate-decisions.jsonl` rotates like the other logs
    (src/core/measurement_files.ts), and every reader (activity, measurement
    readouts, calibration, the board) reads the rotated files plus the old
    single file during the transition. No append failure is swallowed
    without a counter that someone can see.
  - `commandFamily` skips the `time`, `nice`, `nohup`, `env` (with its
    assignments) and `command` prefixes, so `time sqlite3 …` is `sqlite3`.
  - `scripts/private-data.test.mjs` skips, with a reason, outside a git
    checkout instead of failing.
  - The installer's `doctor` mode is an alias of the hooks check plus
    status, not `unknown-mode`.
- T5 JEVADV-67 (A7): `ab_benchmark_cli.ts` compares `import.meta.url` with
  `pathToFileURL(process.argv[1]).href`, so it runs from a path with a space.
  Test from a path with a space.
- T6 JEVADV-41: the Advisor nav panel offers a close button only when the
  running Orca supports the panel close action that Orca Lab is adding
  (orca-oss PR #430, ORCA-538, release v1.4.160-lab.90.rc). Read the
  action's name and contract from orca-oss `docs/reference/plugin-development.md`
  on main. Feature-detect it: an older Orca shows no button, never a fake
  one. If lab.90.rc is not published when T1–T5 are done, T6 moves to the
  next release and says so.
- T7 README (latest "What changed"), CHANGELOG, QA in `odd/qa/qa-0.6.17.md`,
  release, live check.

## Checklist
- [x] T1 gh pr merge judged as the reviewed path, not a direct write. RED: deny_rule_shapes.test.ts 0/1 (ghMerges missing), cross_repo_context.test.ts 0/1 (buildGhMergeSentence missing), decisions.test.ts 80/81 (GATE_DECISION_RULES_VERSION 7). GREEN: 19/19, 19/19, 81/81, npm test 2899/2899. Fix: `ghMerges` (src/core/deny_rule_shapes.ts) reads every `gh` merge in command position, past wrappers, `bash -c` and `cd`: `gh pr merge` (with `--admin`, `--auto`), `gh api …/pulls/N/merge` (a pull request merge) and `gh api …/merges` (one branch straight into another, its `base=`/`head=` fields read). `buildGhMergeSentence` (src/core/cross_repo_context.ts) tells Jev what each goes through, in Jev's copy of the context only, like the 0.6.15 push sentence: a pull request merge lands its commits on the base branch only through that branch's protection, is the reviewed path and changes nothing in the checkout, so the checkout's branch plays no part; an API branch merge writes on its base with no pull request and no review. GATE_DECISION_RULES_VERSION 6 -> 7, so a refusal cached for `gh pr merge` from main (and an allow cached for an API merge into main) is judged again; the bump policy only requires it for a past allow, and both cases exist. Replay against this branch's gate (live Jev, the owner's policies, scratch repositories: demo-app on main, feat-app on a feature branch). New rows, before -> after: `gh pr merge 430 -R <o>/<r> --squash --delete-branch` from main refuse -> advice, from the feature checkout advice -> advice; `gh pr merge 12 --merge` from main refuse -> allow; `gh pr merge --auto --squash 12` from main refuse -> allow; `gh pr merge 430 --squash && git pull --ff-only` from main refuse -> allow; `git merge feature/qa-work && git push origin main` from main refuse -> refuse; `git push origin main` refuse -> refuse; `gh api -X POST repos/<o>/<r>/merges -f base=main -f head=feature/qa-work` from main and from the feature checkout allow -> refuse (the rows found it passing before: an API branch merge into main was never refused). `--admin`: stated as what it does (merges even when the required reviews or checks have not passed, bypassing the review, so it writes on the base branch as directly as a push would). Result: refused from the main checkout, advice from the feature checkout, the same as before the change, with a second wording too. Decision: kept, because the gate cannot know the pull request's base branch without a network call on the hot path, and Jev reads a checkout on main as the likely base; an admin merge is never allowed silently either way. Replay sets: 0.6.15's 244 rows 244/244 pass, 214 refusals, every row's outcome identical to the 0.6.15 run (0 changed); 0.6.13's 38 rows 38/38; 0.6.14's 10 rows 10/10. No refusal lost. No local rule changed, so the 0.6.15 false-positive corpus gains no local stop.
- [x] T2 writes to the gate's own config refused, Bash and file tools. RED: gate_own_files.test.ts 0/1 (module missing); gate-bash.test.mjs 255/256 (a write to the policies, deny-tier, team-owners mirrors and a python heredoc refused locally and recorded); gate-files.test.mjs 0/5 (hook missing); install-claude-integration.test.mjs 64/74 (the guard entry, its upgrade, uninstall, a third party in its group, its locale marker, hooks-check, eight node hooks); claude_integration_rescan.test.ts 9/10 (an install without the guard is reinstalled); main.test.mjs 140/141 (the doctor names a missing or stale guard); panels.spec.mjs 0/2 (the guard line, en and es, absent without the field). GREEN: 7/7, 256/256, 5/5, 74/74, 10/10, 141/141, 2/2, npm test 2919/2919.
  Files the gate and the router decide from (src/core/gate_own_paths.ts), with the read: config directory `catalog.json` (gate-bash.ts:1124, router hooks/index.ts:940), `policies.json` (gate-bash.ts:1132, index.ts:941), `team-owners.json` (gate-bash.ts:1146), `queue-mode.json` (gate-bash.ts:1154), `deny-tier-config.json` (gate-bash.ts:1249), `ab-benchmark-config.json` (gate-bash.ts:1409, sampling only, covered because the gate reads it), `models-catalog.json` (index.ts:887, agent-model.ts:107), `quota.json` (index.ts:888), `explicit-models.json` (index.ts:630), `mod-skills-config.json` (index.ts:256), `mod-skills-sampling-config.json` (index.ts:279), `env` (the key: src/core/secrets.ts:85 for the gate, index.ts:508 for the router; without it the gate passes everything); cache directory `gate-bash.json` (the verdict cache, gate-bash.ts:766), `gate-advice-retry.json` (the retry pass, gate-bash.ts:795), `gate-enablement.json` (orca-plugin-enablement.ts:45), `agent-model-enablement.json` (agent-model.ts:135), `human-queue.jsonl` (gate-bash.ts:1162); Orca's `orca-profile-index.json` and `profiles/<id>/orca-data.json` (orca-plugin-enablement.ts:38 and :54, agent-model.ts:128 and :144: whether the plugin runs at all). Not covered, on purpose: `locale` (language only); the logs (`gate-decisions.jsonl` and the rest decide nothing); the account's Claude Code `settings.json` (router options, agent-model.ts:96, index.ts:849): it is Claude Code's own file, edited for legitimate reasons, and the hooks check reports a gate entry removed from it; the plugin's own code and `seed/` (a developer edits them in a checkout).
  Bash (src/core/gate_own_files.ts, run in gate-bash.ts after the Orca switch and before the safe list, no key, cache or Jev): a redirect (`>`, `>>`, glued), `tee`, `sed -i`/`perl -i`/`ruby -i`, `cp`/`install`/`ln`/`rsync` onto one (or into its directory), `mv`/`rm`/`truncate`/`touch`/`chmod` of one, `rm`/`mv` of the whole directory, `dd of=`, after `cd`, inside `bash -c`, through a symlink (realpath), spelled `~`, `$HOME`, `${HOME}` or absolute; an interpreter (heredoc body or `-c`/`-e`) whose write call (`open(..., 'w')`, `writeFileSync`, `os.remove`, a pathlib `write_text`, ...) names the file in its path argument, directly or through variables. Refusal: `REFUSED: edits the gate's own rules (~/.config/orca-supervisor/<file>); change them in the Advisor panel. ...`, the person line `jev · blocked …: edits the gate's own rules (…)` / `edita las reglas del propio gate (…)`, a `local-rule` deny row. No switch (the switches live in those files). Matched against the real directories for this HOME: a test HOME's files and a command that sets HOME itself are not covered. Reading stays allowed.
  File tools: a PreToolUse entry, matcher `Edit|Write|MultiEdit|NotebookEdit`, `adapters/claude/gate-files.mjs` (timeout 2 s, marker localized like the gate's). Plain JavaScript first: a path that is not under a directory named `orca-supervisor`, an override directory or one of Orca's two profile files is passed before any TypeScript loads (the first TypeScript module costs Node ~22 ms); otherwise gate-files.ts decides with the same set and the Orca switch, and refuses with `ownFileEditDeny`. Latency, 40 runs each against a bare `node` start: an edit of an unrelated file 19.8 ms median (p90 21.1) against 18.5 ms (p90 19.5), +1.3 ms; an edit of a non-protected file under a path containing `orca-supervisor` (this repository) 50.0 ms against 19.0 ms, +31 ms. No Jev call, no network, no log line on a pass. Installer: install adds the entry (an existing install gains it on the next install; the worker's rescan now counts the guard, so an upgraded install is reinstalled within a minute), uninstall removes it and restores the original bytes, status reports `fileGuardHook` per target and in total, hooks-check runs it with a harmless Write payload, `doctor` (main.mjs) names a missing or stale guard, the config panel lists "Edit guard (the gate's own rules)" / "Guarda de ediciones (reglas del propio gate)" when the worker reports it. The Orca switch check moved to adapters/claude/orca-plugin-enablement.ts, shared by both hooks.
  Proof against data: the 0.6.15 false-positive corpus (512 commands) 0 matches after narrowing the interpreter reading to the write call's own path argument (the first version matched 3: a release script whose PR body named a mirror, a script editing another script's text, and a script reading the policies mirror to write elsewhere; each is now a negative unit test); the replay sets' commands 0 matches; replay re-run on this branch: 244/244 (214 refusals, 0 outcomes changed against the T1 run), 38/38, 10/10. Live on this branch's hooks with the real HOME: 9 writes refused (redirect, `tee $HOME`, `sed -i`, `cp` over, `mv` away, `rm` of the verdict cache, `truncate`, a python heredoc, `cd` then a relative write to `env`), 2 reads and a test-HOME write not refused, Edit/Write of two protected files refused and of two others silent (16/16).
  Decision, hand-edit digest: not in this release. A person editing a mirror by hand is legitimate, and the worker rewrites every mirror from Orca's storage on activation and on each panel save, so a hand edit is temporary and visible in the panel; a digest needs a new board surface and its panel tests for an informative line only. Moved to the backlog. Open finding for the lead: Orca's plugin storage (`<Orca user data>/plugins-data/ab2web.orca-jev-advisor/storage.json`) is what the mirrors are rewritten from, so a write there reaches the gate at the next refresh; the gate never reads it, the task names only files the gate reads, and the 0.6.15 QA itself edited it from a script, so it is not covered here.
  Full panel suite after T2 (`npm run test:panels`): 170/170.
  Looked at: the config panel's Claude Code integration section (the ready fixture, now with `fileGuardHook`), 1440, 768, 390 and 320, light and dark, English and Spanish: 16 images in odd/qa/shots-0.6.17/t2-integration-*.png, every one opened; the new line reads in full at every width and wraps under its bullet at 390 and 320; 768 renders the same as 1440 (the panel's own max width); no overflow and no script errors reported by the harness.
- [x] T3 settings backups 0600, old ones tightened. RED: install-claude-integration.test.mjs 74/76 (a new backup's mode; an existing 0644 backup, and a second `claude-settings-backup*` file, after install and after status). GREEN: 76/76, npm test 2921/2921. `backupSettingsOnce` writes its temporary file with mode 0600 and chmods it before the rename (the umask cannot widen it); `tightenSettingsBackups` runs first in `install` and in `status` and chmods every regular `claude-settings-backup*` file in every state directory (the Linux legacy one too) to 0600, mode only, never the bytes (the test checks the once-only capture is unchanged), best-effort, skipped on Windows. On this Mac the six existing backups were already 0600 (read only, nothing changed by this check); the field report's 0644 ones were on the second Mac, which the next install or status run on it tightens.
- [x] T4 gate-decisions rotation, family prefixes, privacy test skip, doctor alias. RED: measurement_files.test.ts 0/1 (the gate names missing); gate-bash.test.mjs + gate-deny-spellings.test.mjs 349/351 (a decision lands in the hour's file, never the legacy one; a failed append bumps the counter and the verdict still goes out); read-activity.test.mjs + read-measurements.test.mjs 42/44 (legacy plus hourly files read together; the counter in `gate.health`); ab_benchmark_cli.test.ts 13/14 (Jev decisions counted across the files); panels.spec.mjs 0/3 (the board chip, en and es, and the status card shown for failures with no decision at all); gate_measurement.test.ts 35/36 (runner prefixes); private-data.outside-git.test.mjs 0/1 against the old privacy test (its email check failed outside a checkout); install-claude-integration.test.mjs 76/77 (`doctor`). GREEN: 6/6, 351/351, 44/44, 14/14, 3/3, 36/36, 1/1, 77/77, npm test 2931/2931.
  Rotation: the gate appends to `gate-decisions-YYYY-MM-DDTHH.jsonl` (UTC hour, src/core/measurement_files.ts `gateDecisionFileName`), the naming of the other hourly logs; the single `gate-decisions.jsonl` is never written again and is read first by every reader (`gateDecisionFilesToRead`: legacy, then the hours in order), so no history disappears on upgrade. Not pruned: the board's "All time" window and the calibration card reach back to the first decision. Readers changed: adapters/orca/log-files.mjs `readGateDecisionLog` (new, shared), read-activity.mjs (the Activity tab's per-project fold), read-measurements.mjs `aggregateGate` (the Gate tab's windows, status, interventions, latest decisions and the calibration card, which joins approvals to these decisions), adapters/cli/ab_benchmark_cli.ts `countRealJevDecisions` (now exported); the board itself reads only what those publish, unchanged in shape. Failures: a record that cannot be written (any error in the append) bumps `gate-decisions-append-failures.json` `{count, lastAt}`; read-measurements puts it in `gate.health.appendFailures`; the board's "Is the gate working?" card shows an alarm chip "N decisions not logged, the last …" / "N decisiones sin registrar, la última …" (tooltip: the board's figures do not count them), and shows the card even with no decision written. Only the decision log has the counter; the approvals log and the A/B queue stay best-effort as before (they are not what the readers count). Families: `stripRunners` (src/core/gate_measurement.ts) drops `time [-p]`, `nice [-n N]`, `nohup`, `env` with `-i`/`-u NAME`/assignments, and `command [-p]` before the family is read, so `time sqlite3 …` is `sqlite3`; a runner alone stays its own family. Privacy test: outside a git checkout (no `.git`, or no `git`) its three checks skip with "not a git checkout (an installed copy has no .git): nothing tracked to scan"; a pre-push run always scans. Installer: `doctor` returns `{ok, status, hooksCheck}`, read-only.
  Full panel suite after T4 (`npm run test:panels`): 173/173.
  Looked at: the board's Gate tab in the degraded fixture (now with 3 append failures), 1440, 768, 390 and 320, light and dark, English and Spanish: 16 images in odd/qa/shots-0.6.17/t4-board-status-*.png, every one opened. The first take showed the long sentence wrapping to three lines inside a pill at 390/320; the chip text was shortened and the explanation moved to its tooltip, then all 16 retaken and opened again: one line at every width except Spanish at 320, where it wraps to two lines like the existing "12 sin respuesta seguidas desde entonces" chip. No overflow and no script errors.
- [x] T5 ab-benchmark runs from a path with a space. RED: ab_benchmark_cli.test.ts 14/15 (a copy of `src/` and `adapters/cli/` under a temporary directory whose names hold spaces, `node …/ab_benchmark_cli.ts help`: exit 0 and no output, because `main()` never ran). GREEN: 15/15, npm test 2932/2932. The entry check compares `import.meta.url` with `pathToFileURL(realpathSync(argv[1])).href`. `pathToFileURL` alone (the task's wording) was not enough: the test still failed, because macOS's temporary directory is reached through the `/var` -> `/private/var` symlink and `import.meta.url` holds the real path; the real path is now resolved first (the path as given if it cannot be). Also run by hand from a scratch copy under a directory named "with space": the help text printed. No other entry point in the repository uses the `file://` + argv comparison.
- [ ] T6 Advisor panel close button where Orca supports it. Not built in this release: when T1-T5 were done (2026-09-30) `gh release list -R ab2webco/orca-oss --limit 3` showed v1.4.160-lab.89.rc as the newest release candidate, and v1.4.160-lab.90.rc was not published. Per the scope above, T6 moves to the next release.
- [ ] T7 README, CHANGELOG, QA, release, live check

## Acceptance criteria
- Strict TDD per task: RED observed, then GREEN, `npm test` green, and
  `npm run test:panels` green where a panel changes (it takes ~17 minutes).
- T1 and T2: the replay sets keep every refusal. The false-positive corpus
  of 0.6.15 (odd/qa/qa-0.6.15.md) gains no new local-only stop.
- T2: the file-tool hook adds no Jev call and no measurable delay to edits
  of other files (measure it).
- Panel changes photographed at 1440/768/390/320, dark and light, at least
  one in Spanish. Every image opened.
- Privacy test exit code 0.

## Checks
`npm test`; `npm run test:panels`; `node --test scripts/private-data.test.mjs`
(exit code); the replay scripts of 0.6.13–0.6.15; the installer's
status and hooks check against a temp HOME.
