# Release 0.6.26: an install never goes back a version; the catalog follows every release

## Objective
The owner, 2026-10-04:
- "dejo de salir el bloque que muestra que agentes estan trabajando y con que modelo";
- "ojo con eso no debe pasar";
- "esto no debe pasarle a ningun usuario del plugin areegla esto y que se pueda actualizar sin errores y la version correcta".

The orcalab-plugins catalog still pinned Jev Advisor at v0.6.10 while v0.6.11 through v0.6.25 shipped. Every marketplace user was held at 0.6.10. On 2026-10-03, Orca activated that catalog copy, and its installer, which runs on every activation, rewrote the hooks in all five settings files and the skills mod back to 0.6.10, over a 0.6.25 install. The running-agents band (0.6.14) and every gate fix since were gone.

## Scope
- **T1 (catalog):** point the catalog at v0.6.25 (orcalab-plugins #29, merged 17fbb1e).
- **T2 (catalog automation):** a workflow in orcalab-plugins that moves each git-sourced plugin's pin forward to its latest stable `vX.Y.Z` tag, so a release that forgets the catalog PR still reaches users. Forward only, never a pre-release.
- **T3 (installer):** `install()` decides once, before touching any target, whether a strictly newer install is already in place (the mod marker's `source`, that root's generated `.claude-plugin/plugin.json` version). If so, and that root still exists, and it is not an older content-hash directory of this same Orca plugin key that `current` no longer names, nothing is written. The skip is visible (a reason in the result, a log line, the Advisor panel) and a person's own Install overrides it.
- **T4:** README, CHANGELOG, version, QA (live check through the marketplace install: lock version, hook root, mod marker), release, catalog to v0.6.26.

## Checklist
- [x] T1 catalog at v0.6.25 (#29)
- [x] T2 catalog follows releases (orcalab-plugins #30, 9d2624c: RED module-not-found, GREEN 7/7; real-remote probe: v0.6.10 pin → `--check` exit 1, rewrite byte-identical to #29; main run green, nothing moved. Its commit path runs for real on the v0.6.26 tag.)
- [x] T3 install never downgrades (79b8aea; RED 5/96 + 7/148, GREEN 244/244; npm test 3284/3284; replay 7/7 in qa-0.6.26.md)
- [ ] T4 docs, release, catalog v0.6.26, live check

## Acceptance criteria
- Strict TDD; typecheck 0; npm test green; privacy 0.
- An older plugin root activating over a newer install writes nothing: no settings.json change, no mod copy change, a `newer-install-present` reason.
- Equal or older installed version, or a newer root that is gone or superseded by Orca's `current`, installs as before.
- A person's Install from the panel replaces the newer install.
- Live: after Orca updates from the catalog, the lock, all hook entries and the mod marker name the same root and version, and the band renders.
