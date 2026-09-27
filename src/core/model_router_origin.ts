// ---------------------------------------------------------------------------
// Model router (JEV-061): which `PromptOrigin` kinds (claude-code.d.ts) are a
// person's own prompt, for the router's point A/C personhood gate.
// `$.session.messages()` rows carry no origin, so a background task's
// notification reads there exactly like a brand-new real prompt; only
// `prompt.submit`'s own `e.origin.kind` tells it apart from the person's own
// Enter (see hooks/index.ts's `routeMainStep`/`routeEngineTurn`, and the
// defect this fixes: a notification used to run a full stage decision and
// count toward the downgrade hysteresis, exactly like a person's prompt).
//
// A closed set: `composer` (typed or queued at the terminal), `bridge`
// (Remote Control) and `sdk` (`claude -p`, the Agent SDK) are always a
// person's own; `unclassified` -- a channel the engine could not attest --
// is treated as one too, so today's behaviour is kept where the engine
// itself cannot tell. Every other kind the type declares (a task
// notification, a scheduled trigger, a peer session, a relay, a plugin's own
// submission, ...), and any kind a future engine adds that is not in this
// set, is engine- or agent-authored, never the person at the keyboard.
//
// Pure: a plain `string` in, never `claude-code`'s own `PromptOrigin` type --
// src/core stays host-agnostic (shared with the CLI tools), so it never
// imports the hooks module's own ambient `.d.ts`.
// ---------------------------------------------------------------------------

const PERSON_PROMPT_ORIGIN_KINDS: ReadonlySet<string> = new Set(["composer", "bridge", "sdk", "unclassified"]);

/** Whether a `prompt.submit` origin's `kind` is a person's own prompt, not an engine- or agent-authored one. */
export function isPersonPromptOrigin(kind: string): boolean {
  return PERSON_PROMPT_ORIGIN_KINDS.has(kind);
}
