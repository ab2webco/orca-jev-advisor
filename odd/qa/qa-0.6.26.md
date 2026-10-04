# QA 0.6.26: an install never goes back a version; the catalog follows releases

Run on 2026-10-04 against the 0.6.26 branch.

## What happened

The orcalab-plugins catalog pinned Jev Advisor at v0.6.10 from 0.6.10 through 0.6.25. Orca never refreshes a catalog and never updates a plugin on its own. It also activates the copy named by `<pluginKey>/current`, and the plugin runs its installer on every activation. On 2026-10-03, Orca installed the catalog's 0.6.10 and activated it. The installer rewrote the hooks in all five settings files and the skills mod back to 0.6.10, over a 0.6.25 install. The running-agents band (0.6.14) and every gate fix since were gone.

It happened again on 2026-10-04, after the owner's install was restored by hand: the 0.6.10 copy activated again and put everything back to 0.6.10. The live checks for 0.6.11 to 0.6.25 had verified only the dev copy, so nobody noticed.

## Summary

| Check | Result |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm test` | 3284/3284; privacy test included |
| `install-claude-integration.test.mjs` + `main.test.mjs` | 244/244 |
| Panel spec (en/es newer-install) | passes |
| Catalog `Follow releases` (orcalab-plugins #30) | 7/7; CI green; main run moved nothing (pins current) |
| Incident replay, temp HOME, real `--permission` flags | 7/7 below |

## Incident replay

Three copies of this branch were built in a temporary HOME, differing only in their version:
- `roots/dev` at 0.6.25;
- `plugins/key/old` at 0.6.10, standing in for Orca's catalog copy;
- `roots/new` at 0.6.26.

Each run went through the same path as `main.mjs`: first `installed-roots`, then `install` with a read grant for each `package.json` it listed, under Node's permission model.

| # | Scenario | Expected | Result |
|---|---|---|---|
| 1 | dev 0.6.25 installs into an empty HOME | install | installed; marker and hooks name `roots/dev` |
| 2 | old 0.6.10 activates over it (the incident) | skip, nothing written | `newer-install-present`, installed 0.6.25; settings.json hash unchanged (3b1f56a146); marker still `roots/dev` |
| 3 | old 0.6.10 with `--force` (a person's Set up) | install | installed; marker and hooks name `plugins/key/old` |
| 4 | dev 0.6.25, then new 0.6.26 | both install | marker and hooks name `roots/new` |
| 5 | old 0.6.10 over new 0.6.26, read grant `roots/new/package.json` | skip | `newer-install-present`; marker still `roots/new` |
| 6 | the same, with `roots/new` moved away (gone root) | install | installed; marker names `plugins/key/old` |
| 7 | a 0.6.26 sibling in the same plugin-key directory, then old 0.6.10 (Orca rollback) | install | installed; marker names `plugins/key/old` |

## Screens

- **Advisor panel, General tab, `newer-install` scenario:** looked at 1440 dark and 320 light.
- **First render:** the fixture contradicted itself. It said "Skills mod: not installed" next to "A newer install is already in place". The fixture now has the newer install's copy on disk. Rendered again and looked at: 1440 dark and 320 light. Both are consistent ("Skills mod: installed"), with no overflow.

## Catalog

- **orcalab-plugins #29 (17fbb1e):** the pin moved from v0.6.10 to v0.6.25.
- **orcalab-plugins #30 (9d2624c):** added the `Follow releases` workflow.
  - **Probe against the real remotes:** with the pin set back to v0.6.10, `--check` exits 1 and names `ab2web.orca-jev-advisor v0.6.10 -> v0.6.25`. The rewrite is byte-identical to the hand fix in #29.
  - **Not run live yet:** the step that commits to main. It runs for real when v0.6.26 is tagged.

## Live check after the release

Pending: the catalog pin, the Orca update through Settings → Plugins, and the lock, `current`, hook root and mod marker.
