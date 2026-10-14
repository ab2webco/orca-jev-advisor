# QA 0.11.1: agents band under a project's band, shorter status line, quota error reason

Live check run on 2026-10-14 on the owner's Mac, against the marketplace install of v0.11.1 (`main` at ee738b6).

## Why

In a project that ships its own Orca plugin with a fleet band above the prompt, the owner saw no Jev agents band (who runs, which model, which effort). Jev passed through whenever another plugin had drawn a band. The status line also showed "sin skill · herramientas: sin cambio" on turns where nothing was picked. And the board said "error" for an account without saying why.

## Summary

| Check | Result |
|---|---|
| `npm test` | 4358/4358 |
| `npm run typecheck` | Clean |
| `npm run test:panels` | 268/268 |
| CI on PR #74 and on `main` (ee738b6) | Pass |
| Live | 1–4 PASS; 5 PENDING (no Claude account in error now); 6 PENDING (live paint in the project session) |

## Method

- **Install.**
  - Read `current` and `orca-plugin.json` in the marketplace install.
  - Searched every installed mod copy for the new band code and for the old pass-through line. The copies are in `~/.claude` and in the 4 Orca accounts.
- **Band.** Ran the installed hook (`~/.claude/skills/orca-jev-mod-skills/.../hooks/index.ts`) through the `scripts/screenshot-band.mjs` harness.
  - The layer beneath returns a fleet band shaped like the project plugin's (`Box column [Text "s: Fleet …"]`), not the engine.
  - Painted at 120 and 80 columns, es, dark. Both images were read.
- **Status line.** Imported the installed `status_line.ts` and composed the line with no skill and no tool picked.
- **Quota reason.**
  - Read the mirrored `consumptionSummary.quota` in the live `storage.json`.
  - Read `orca account list --json`.
  - Searched the installed `main.mjs` and `board.html` for the new code.

## Scenarios

| # | Scenario | Expected | Observed | Result |
|---|---|---|---|---|
| 1 | Install | v0.11.1 installed; every mod copy on it | `current` is `06bc1894…`; `orca-plugin.json` is 0.11.1 (installed 16:44Z). All 5 mod copies have the stacking code (`ownLines`); none has the old `beneath.type !== 'engine'` pass-through | PASS |
| 2 | Agents band under another plugin's band | The project's band stays first and untouched; Jev's heading and agent rows (model, why) follow | Installed hook's tree is `Box column [fleet band, "Agentes en curso: 10", 10 rows]`. Fleet line first; rows show model and reason; no line wider than the band at 120 or 80 | PASS |
| 3 | Band alone, nothing beneath | Same band as before 0.11.1 | `npm run shots:band` (the repo harness, engine beneath): 16 shots, no overflow | PASS |
| 4 | Status line with nothing picked | No "sin skill / herramientas: sin cambio"; with no part left the line is cleared | Installed `composeStatusLine([skillStatusPart(es, null), toolStatusPart(es, null)])` is `null`; the prompt hook passes `undefined` to `$.ui.status`, which clears it | PASS |
| 5 | Quota error reason on the board | An errored Claude account shows "Orca no pudo leer este cupo: {reason}" | The installed code has it (`QUOTA_ERROR_MAX_CHARS` in `main.mjs`, the string in `board.html`). The 4 mirrored Claude accounts are `ok` or not checked (16:44:45Z), so there is no reason to show. The only errors are 2 Codex accounts, which the board does not mirror | PENDING: next Claude quota error |
| 6 | Band as the engine paints it in the project session | Fleet band, then Jev's rows, in the orchestrator session while subagents run | Not looked at: a session must be (re)started on 0.11.1 and run subagents. The harness shows the hook's own tree, not the engine's paint | PENDING: owner's session |

## Finding fixed during the check

`npm run shots:band` had been failing since the CI watcher rows joined the band. Its fake host had no `$.clock`, so the hook threw, fell into its `catch` and returned the layer beneath: "the band drew nothing". The host now has a clock (commit f30ecc0). The run went from failing to 16 shots.

## Notes

- **qa-0.11.0 #8** stays pending. `boardPanelSeen` is still 05:04Z, so the board has not been opened since the update and the version chip still reads 0.10.1.
- **Codex quota errors** ("RPC process exited unexpectedly", "PTY timeout") come from Orca's Codex accounts. Jev's quota mirror covers Claude accounts only.
