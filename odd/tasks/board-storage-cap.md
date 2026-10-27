# Board: stay under Orca's storage value cap (JEVADV-116)

## Objective

Orca refuses one plugin storage value over 262144 bytes
(`PLUGIN_STORAGE_VALUE_MAX_BYTES`). The `board` key keeps one entry per
pane ever seen and had grown to about 261906 bytes, so 8393 of 20963
`storage.set("board")` writes since 2026-10-25 failed. Orca's cap is its
contract and stays; the board must fit under it.

## Scope

- `src/core/store.ts`: `setBoard` writes `boundBoard(data)`, which keeps the
  most recently updated entries that fit in `BOARD_MAX_BYTES` (131072, half
  the cap), in their original order.
- `adapters/orca/main.mjs`: unchanged. Both board writers already catch a
  refused write and log `setBoard failed: <reason>`; a test now holds that.

## Checklist

- [x] T1 RED: `setBoard` with 2000 entries is refused by a host that
  enforces the cap (`Error: value exceeds 262144 bytes`); the worker test
  fails the same way against the old `store.ts`.
- [x] T2 GREEN: `boundBoard` trims by recency; store and worker tests pass.
- [x] T3 a refused board write is logged with its reason and never thrown.

## Acceptance criteria

- A board of any size is written at or under `BOARD_MAX_BYTES`.
- The newest entries survive; the least recently updated are dropped first.
- A board under the budget is written unchanged.

## Checks

`npm run check` (typecheck, unit tests, panel assertions, screenshots).
