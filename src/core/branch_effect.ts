// 0.6.24 T2 (JEVADV-103): what a command writes, for the commands whose
// target branch Jev keeps misreading. `gh pr update-branch 821` was refused
// as a write to main by a "never write on main" policy, five runs out of
// five (odd/tasks/release-0.6.24.md): it names a pull request and a base,
// and nothing told Jev which side gets written. It brings the base into the
// pull request's own head branch; the base is only read.
//
// A plain English fact for the same Jev state the policy and risk questions
// read, the way deploy_publish.ts feeds `deployPublishSignal`. Detected in
// COMMAND POSITION with the same mention-vs-command reading
// (git_discard.ts's someSegmentMatches): a grep pattern or a commit message
// that names the command is data. No network: the pull request itself is
// never looked up. Pure: no I/O.
import { withoutHeredocBodies, withoutLineContinuations } from "./command_text.ts";
import { someSegmentMatches } from "./git_discard.ts";

const BRANCH_EFFECTS: readonly { readonly pattern: { test(segment: string): boolean }; readonly effect: string }[] = [
  {
    pattern: /\bgh\s+pr\s+update-branch\b/,
    effect:
      "brings the pull request's base branch into the pull request's own branch (a merge, or a rebase with --rebase); it writes only to the pull request's own branch and never writes to the base branch, such as main",
  },
];

/** The effect fact for `command`, or null when none of the known commands runs in it. */
export function detectBranchEffect(command: string): string | null {
  const inspected = withoutLineContinuations(withoutHeredocBodies(command));
  for (const { pattern, effect } of BRANCH_EFFECTS) {
    if (someSegmentMatches(inspected, pattern) === "deny") return effect;
  }
  return null;
}
