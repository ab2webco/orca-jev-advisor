// Performs (or previews) the actual action: sending an instruction to a
// live Orca terminal. `execute` defaults to false everywhere in this
// project; when false, nothing touches the live terminal -- the exact
// commands that would run are returned instead.

import { terminalSend, terminalWait } from "./orca.ts";
import type { TerminalSend, TerminalWait } from "./orca.ts";

export interface ActionPlan {
  handle: string;
  instruction: string;
}

export interface ActionPreview {
  executed: false;
  commands: string[];
}

export interface ActionOutcome {
  executed: true;
  composerWait: TerminalWait;
  writableWaitFallback: TerminalWait | null;
  send: TerminalSend;
}

export type ActionResult = ActionPreview | ActionOutcome;

const DEFAULT_WAIT_TIMEOUT_MS = 15_000;

function describePlannedCommands(plan: ActionPlan, waitTimeoutMs: number): string[] {
  const quotedText = JSON.stringify(plan.instruction);
  return [
    `orca terminal wait --terminal ${plan.handle} --for composer-ready --timeout-ms ${waitTimeoutMs} --json`,
    `(si 'composer-ready' no se cumple a tiempo) orca terminal wait --terminal ${plan.handle} --for writable --timeout-ms ${waitTimeoutMs} --json`,
    `orca terminal send --terminal ${plan.handle} --text ${quotedText} --enter --json`,
  ];
}

/**
 * Waits for the composer to be ready, falling back to plain writability if
 * composer-ready is not reached within the timeout, then sends the
 * instruction. When `execute` is false, returns the exact commands that
 * would run without running them.
 */
export async function performAction(plan: ActionPlan, execute: boolean, waitTimeoutMs: number = DEFAULT_WAIT_TIMEOUT_MS): Promise<ActionResult> {
  if (!execute) {
    return { executed: false, commands: describePlannedCommands(plan, waitTimeoutMs) };
  }

  const composerWaitResult = await terminalWait(plan.handle, "composer-ready", waitTimeoutMs);
  let writableWaitFallback: TerminalWait | null = null;

  if (!composerWaitResult.wait.satisfied) {
    const writableWaitResult = await terminalWait(plan.handle, "writable", waitTimeoutMs);
    writableWaitFallback = writableWaitResult.wait;
  }

  const sendResult = await terminalSend(plan.handle, plan.instruction);

  return {
    executed: true,
    composerWait: composerWaitResult.wait,
    writableWaitFallback,
    send: sendResult.send,
  };
}
