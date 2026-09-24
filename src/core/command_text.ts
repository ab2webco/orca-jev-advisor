// What part of a command line is a command, and what part is only data.
//
// The tier-1b rules match text anywhere in the command string. That is fine
// while the verdict is `ask` -- a false match costs a click -- and it is not
// fine once the verdict is `deny`, because then the agent simply cannot do
// the thing. Measured the hard way: writing a file whose CONTENT described a
// rule was refused as if the rule were being run. Documentation, tests,
// migrations and this plugin's own source all describe these commands.
//
// A heredoc body is the clearest case. In `python3 - <<'PY' ... PY` the body
// is Python handed to a program on stdin; no shell ever sees it. Stripping it
// before the rules look is therefore not a loosening, it is the rules finally
// looking at the command instead of at an argument.
//
// The exception that keeps this honest: when the program reading the heredoc
// IS a shell -- `bash -s`, `sh <<EOF`, `zsh` -- the body is exactly a list of
// commands, and stripping it would hide the real thing. Those keep their body
// and stay judged. When in doubt this errs toward keeping the text, because a
// false strip waves a dangerous command through while a false keep costs one
// refusal that the person can override by running it themselves.

/** Programs whose heredoc body is itself shell, so the body must keep being read. */
const SHELL_READERS = /(^|[\s|;&(])(ba|z|k|da|fi)?sh\b/;

/**
 * The command with every heredoc body removed, leaving the command line
 * itself. A command with no heredoc comes back unchanged.
 *
 * Handles the quoted (`<<'EOF'`), double-quoted (`<<"EOF"`), bare (`<<EOF`)
 * and indented (`<<-EOF`) spellings, and several heredocs in one command.
 * An unterminated heredoc -- the delimiter never reappears -- drops
 * everything after it, which is what the shell would have consumed anyway.
 */
export function withoutHeredocBodies(command: string): string {
  if (!command.includes("<<")) return command;
  if (SHELL_READERS.test(command)) return command;

  const lines = command.split("\n");
  const kept: string[] = [];
  let awaiting: string | null = null;

  for (const line of lines) {
    if (awaiting !== null) {
      if (line.trim() === awaiting) awaiting = null;
      continue;
    }
    kept.push(line);
    // Only the LAST heredoc opener on a line decides what the next lines are,
    // which is also how the shell queues them.
    const openers = [...line.matchAll(/<<-?\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/g)];
    const last = openers.at(-1);
    if (last) awaiting = last[1] ?? last[2] ?? last[3] ?? null;
  }

  return kept.join("\n");
}
