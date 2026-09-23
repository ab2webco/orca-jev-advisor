#!/usr/bin/env node
// CLI entry point. This is the only module allowed to print: everything
// else returns values. Usage:
//   node src/supervisor.ts "<encargo>" [--execute]
//   node src/supervisor.ts --self-check

import { performAction } from "./act.ts";
import { resolveApiKey } from "./core/secrets.ts";
import { loadCatalog } from "./core/catalog.ts";
import type { Catalog } from "./core/catalog.ts";
import { decide } from "./decide.ts";
import { askJev, buildJevRequest } from "./jev.ts";
import { terminalList, worktreePs } from "./orca.ts";
import { buildProjection } from "./projection.ts";
import type { Projection } from "./projection.ts";

function printUsage(): void {
  console.log(
    [
      "Usage:",
      '  node src/supervisor.ts "<encargo>" [--execute]',
      "  node src/supervisor.ts --self-check",
      "",
      "  --execute     Executes the decided action instead of only simulating it (default: dry run).",
      "  --self-check  Only reads Orca's live state and shows the projection; it does not call Jev or act.",
    ].join("\n"),
  );
}

function formatCell(value: string, width: number): string {
  return value.length >= width ? `${value.slice(0, width - 1)}…` : value.padEnd(width);
}

interface ProjectionColumn {
  header: string;
  width: number;
  get: (row: Projection["destinations"][number]) => string;
}

const PROJECTION_COLUMNS: ProjectionColumn[] = [
  { header: "ID", width: 24, get: (r) => r.id },
  { header: "Destination", width: 30, get: (r) => r.label },
  { header: "Type", width: 12, get: (r) => r.kind },
  { header: "Handle", width: 22, get: (r) => r.handle ?? "(no terminal)" },
  { header: "Agent state", width: 14, get: (r) => r.agentState ?? "(no agent)" },
  { header: "Min. idle", width: 14, get: (r) => (r.minutesSinceLastOutput === null ? "-" : String(r.minutesSinceLastOutput)) },
];

function printProjectionTable(projection: Projection): void {
  console.log(PROJECTION_COLUMNS.map((c) => formatCell(c.header, c.width)).join(" | "));
  console.log(PROJECTION_COLUMNS.map((c) => "-".repeat(c.width)).join("-|-"));
  for (const row of projection.destinations) {
    console.log(PROJECTION_COLUMNS.map((c) => formatCell(c.get(row), c.width)).join(" | "));
  }
}

interface CliArgs {
  encargo: string | null;
  execute: boolean;
  selfCheck: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  let encargo: string | null = null;
  let execute = false;
  let selfCheck = false;
  for (const arg of argv) {
    if (arg === "--execute") {
      execute = true;
    } else if (arg === "--self-check") {
      selfCheck = true;
    } else if (!arg.startsWith("--") && encargo === null) {
      encargo = arg;
    } else {
      throw new Error(`Unrecognized argument: ${arg}`);
    }
  }
  return { encargo, execute, selfCheck };
}

async function loadLiveProjection(): Promise<{ catalog: Catalog; projection: Projection }> {
  const [catalog, worktreesResult, terminalsResult] = await Promise.all([loadCatalog(), worktreePs(), terminalList()]);
  const projection = buildProjection(catalog, worktreesResult.worktrees, terminalsResult.terminals);
  return { catalog, projection };
}

async function runSelfCheck(): Promise<void> {
  console.log("=== Orca Supervisor: self-check (read-only) ===\n");
  const { projection } = await loadLiveProjection();
  printProjectionTable(projection);
  console.log("\nJev was not called and nothing was sent to any terminal.");
}

async function runEncargo(encargo: string, execute: boolean): Promise<void> {
  console.log("=== Orca Supervisor ===");
  console.log(`Encargo: "${encargo}"`);
  console.log(`Mode: ${execute ? "REAL EXECUTION" : "DRY RUN (no action will be executed)"}\n`);

  const { catalog, projection } = await loadLiveProjection();
  console.log("--- What is seen live ---");
  printProjectionTable(projection);

  const request = buildJevRequest(encargo, projection);
  const apiKey = await resolveApiKey();
  const jevResult = await askJev(request, apiKey);

  console.log("\n--- Jev ---");
  if (jevResult.kind === "dry") {
    console.log("No TYPESAFE_API_KEY is configured (neither an env var nor ~/.config/orca-supervisor/env): the network was not called.");
    console.log("This is exactly what would have been sent:\n");
    console.log(JSON.stringify(jevResult.request, null, 2));
    console.log("\n--- Decision ---");
    console.log("Cannot decide without a response from Jev. Set TYPESAFE_API_KEY to complete the flow.");
    return;
  }

  console.log(`Model: ${jevResult.response.model}`);
  console.log(`Tokens used: input=${jevResult.response.usage.input_tokens}, output=${jevResult.response.usage.output_tokens}`);
  console.log("Answers:");
  for (const [questionId, answer] of Object.entries(jevResult.response.answers)) {
    console.log(`  ${questionId}: ${JSON.stringify(answer)}`);
  }

  const decision = decide(encargo, jevResult.response, catalog, projection);

  console.log("\n--- Decision ---");
  console.log(`Action: ${decision.action}`);
  console.log(`Destination: ${decision.destinationId ?? "(none)"}`);
  console.log(`Handle: ${decision.handle ?? "(none)"}`);
  console.log(`Ambiguity (unambiguousDestination, noul): ${decision.ambiguityNoul === null ? "(no data)" : decision.ambiguityNoul.toFixed(2)}`);
  console.log(`Delicateness (score): ${decision.delicatenessScore === null ? "(no data)" : decision.delicatenessScore.toFixed(2)}`);
  console.log(`Reason: ${decision.reason}`);

  console.log("\n--- Result ---");
  if (decision.action !== "act" || decision.handle === null || decision.instruction === null) {
    console.log("Nothing is sent to any terminal (the decision was not 'act', or a destination/instruction is missing).");
    return;
  }

  const result = await performAction({ handle: decision.handle, instruction: decision.instruction }, execute);
  if (!result.executed) {
    console.log("Dry run: this is what would be executed (nothing was executed):");
    for (const command of result.commands) {
      console.log(`  ${command}`);
    }
  } else {
    console.log(`Wait 'composer-ready': satisfied=${result.composerWait.satisfied}`);
    if (result.writableWaitFallback !== null) {
      console.log(`Fallback wait 'writable': satisfied=${result.writableWaitFallback.satisfied}`);
    }
    console.log(`Send: accepted=${result.send.accepted}, bytes=${result.send.bytesWritten}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.selfCheck) {
    await runSelfCheck();
    return;
  }

  if (args.encargo === null) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  await runEncargo(args.encargo, args.execute);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exitCode = 1;
});
