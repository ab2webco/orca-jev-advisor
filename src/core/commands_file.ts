// 0.6.22 T2 (JEVADV-97): the --commands-file format of the CLIs (ab_benchmark
// and jev-health): one command per line, '#' starts a comment line.

export function isBlankOrComment(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.length === 0 || trimmed.startsWith("#");
}

/** The commands of a commands file's text, trimmed, in order. */
export function parseCommandsFile(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => !isBlankOrComment(line))
    .map((line) => line.trim());
}
