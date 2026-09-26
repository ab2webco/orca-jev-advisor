// Detects a command that triggers a deployment or publishes an artefact --
// the advise-model release's own local floor (Part 3). A command like this
// is never "local and cheap": the real miss that named this gap was
// `gh workflow run deploy-azure-dev.yml --ref release/0.3.1` on a client
// repository, allowed by Jev's risk stage with the reason "reversible,
// local and cheap" -- the risk axes have no notion of "this reaches a
// deployment pipeline or a public registry", because nothing told them.
//
// Detected in COMMAND POSITION, with the same mention-vs-command treatment
// every NEVER_SILENTLY rule uses (src/core/git_discard.ts's
// someSegmentMatches): a phrase sitting inside a grep pattern or a quoted
// argument is data, not a real invocation, and must never trigger this
// floor. Pure: no I/O.
import { someSegmentMatches } from "./git_discard.ts";

export interface DeployPublishPattern {
  readonly pattern: { test(segment: string): boolean };
  /** English, model- and Jev-facing: "This command {{description}}." */
  readonly description: string;
}

/**
 * Every recognised deploy/publish shape, in the order they are checked. The
 * FIRST command-position match wins -- a command is rarely more than one of
 * these at once, and the first match is enough to name the floor's own
 * concern.
 */
const DEPLOY_PUBLISH_PATTERNS: readonly DeployPublishPattern[] = [
  { pattern: /gh\s+workflow\s+run\b/, description: "triggers a deployment workflow on GitHub Actions" },
  { pattern: /gh\s+release\s+create\b/, description: "creates a GitHub release" },
  { pattern: /\b(npm|pnpm|yarn)\s+publish\b/, description: "publishes a package" },
  { pattern: /twine\s+upload\b/, description: "publishes a Python package" },
  { pattern: /cargo\s+publish\b/, description: "publishes a Rust crate" },
  { pattern: /gem\s+push\b/, description: "publishes a Ruby gem" },
  { pattern: /docker\s+push\b/, description: "publishes a container image" },
  // `vercel` deploys with EITHER an explicit `deploy` subcommand or a bare
  // invocation carrying `--prod` (its own production-deploy flag).
  { pattern: /\bvercel\b(?:.*--prod\b|\s+deploy\b)/, description: "deploys to Vercel" },
  { pattern: /netlify\s+deploy\b.*--prod\b/, description: "deploys to Netlify production" },
  { pattern: /fly\s+deploy\b/, description: "deploys to Fly.io" },
  { pattern: /eas\s+submit\b/, description: "submits a mobile app build for release" },
  { pattern: /eas\s+update\b.*--branch\s+production\b/, description: "publishes a production EAS update" },
  { pattern: /fastlane\s+(deliver|pilot|supply)\b/, description: "publishes a mobile app release via fastlane" },
  { pattern: /helm\s+(install|upgrade)\b/, description: "installs or upgrades a Helm release" },
  { pattern: /kubectl\s+apply\b/, description: "applies a Kubernetes manifest" },
];

export interface DeployPublishDetection {
  readonly description: string;
}

/**
 * Whether `command` triggers a deployment or publishes an artefact, in
 * COMMAND POSITION -- a mention (a phrase inside a grep pattern, a quoted
 * argument, a heredoc body) never counts. Returns the first matching
 * pattern's own description, or null when none match.
 */
export function detectDeployPublish(command: string): DeployPublishDetection | null {
  for (const { pattern, description } of DEPLOY_PUBLISH_PATTERNS) {
    if (someSegmentMatches(command, pattern) === "deny") return { description };
  }
  return null;
}
