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
      "Uso:",
      '  node src/supervisor.ts "<encargo>" [--execute]',
      "  node src/supervisor.ts --self-check",
      "",
      "  --execute     Ejecuta la acción decidida en vez de solo simularla (por defecto: simulacro).",
      "  --self-check  Solo lee el estado en vivo de Orca y muestra la proyección; no llama a Jev ni actúa.",
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
  { header: "Destino", width: 30, get: (r) => r.label },
  { header: "Tipo", width: 12, get: (r) => r.kind },
  { header: "Handle", width: 22, get: (r) => r.handle ?? "(sin terminal)" },
  { header: "Estado agente", width: 14, get: (r) => r.agentState ?? "(sin agente)" },
  { header: "Min. inactivo", width: 14, get: (r) => (r.minutesSinceLastOutput === null ? "-" : String(r.minutesSinceLastOutput)) },
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
      throw new Error(`Argumento no reconocido: ${arg}`);
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
  console.log("=== Supervisor Orca: auto-verificación (solo lectura) ===\n");
  const { projection } = await loadLiveProjection();
  printProjectionTable(projection);
  console.log("\nNo se llamó a Jev ni se envió nada a ninguna terminal.");
}

async function runEncargo(encargo: string, execute: boolean): Promise<void> {
  console.log("=== Supervisor Orca ===");
  console.log(`Encargo: "${encargo}"`);
  console.log(`Modo: ${execute ? "EJECUCIÓN REAL" : "SIMULACRO (no se ejecutará ninguna acción)"}\n`);

  const { catalog, projection } = await loadLiveProjection();
  console.log("--- Lo que se ve en vivo ---");
  printProjectionTable(projection);

  const request = buildJevRequest(encargo, projection);
  const apiKey = await resolveApiKey();
  const jevResult = await askJev(request, apiKey);

  console.log("\n--- Jev ---");
  if (jevResult.kind === "dry") {
    console.log("No hay TYPESAFE_API_KEY configurada (ni env var ni ~/.config/orca-supervisor/env): no se llamó a la red.");
    console.log("Esto es exactamente lo que se habría enviado:\n");
    console.log(JSON.stringify(jevResult.request, null, 2));
    console.log("\n--- Decisión ---");
    console.log("No se puede decidir sin respuesta de Jev. Configure TYPESAFE_API_KEY para completar el flujo.");
    return;
  }

  console.log(`Modelo: ${jevResult.response.model}`);
  console.log(`Tokens usados: entrada=${jevResult.response.usage.input_tokens}, salida=${jevResult.response.usage.output_tokens}`);
  console.log("Respuestas:");
  for (const [questionId, answer] of Object.entries(jevResult.response.answers)) {
    console.log(`  ${questionId}: ${JSON.stringify(answer)}`);
  }

  const decision = decide(encargo, jevResult.response, catalog, projection);

  console.log("\n--- Decisión ---");
  console.log(`Acción: ${decision.action}`);
  console.log(`Destino: ${decision.destinationId ?? "(ninguno)"}`);
  console.log(`Handle: ${decision.handle ?? "(ninguno)"}`);
  console.log(`Ambigüedad (unambiguousDestination, noul): ${decision.ambiguityNoul === null ? "(sin dato)" : decision.ambiguityNoul.toFixed(2)}`);
  console.log(`Delicadeza (score): ${decision.delicatenessScore === null ? "(sin dato)" : decision.delicatenessScore.toFixed(2)}`);
  console.log(`Razón: ${decision.reason}`);

  console.log("\n--- Resultado ---");
  if (decision.action !== "act" || decision.handle === null || decision.instruction === null) {
    console.log("No se envía nada a ninguna terminal (la decisión no fue 'act', o falta destino/instrucción).");
    return;
  }

  const result = await performAction({ handle: decision.handle, instruction: decision.instruction }, execute);
  if (!result.executed) {
    console.log("Simulacro: esto es lo que se ejecutaría (no se ejecutó nada):");
    for (const command of result.commands) {
      console.log(`  ${command}`);
    }
  } else {
    console.log(`Espera 'composer-ready': satisfecha=${result.composerWait.satisfied}`);
    if (result.writableWaitFallback !== null) {
      console.log(`Espera de respaldo 'writable': satisfecha=${result.writableWaitFallback.satisfied}`);
    }
    console.log(`Envío: aceptado=${result.send.accepted}, bytes=${result.send.bytesWritten}`);
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
