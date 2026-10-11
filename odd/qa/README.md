# QA reports

One report per version: `qa-<version>.md`, with each check written as a scenario.

Screenshots and other images are not on `main`. They are on the orphan branch
[`qa-evidence`](https://github.com/ab2webco/orca-jev-advisor/tree/qa-evidence/odd/qa),
under the same paths the reports name (`odd/qa/screens-<version>/`,
`odd/qa/shots-<version>/`).

Why: Orca installs this plugin by cloning a release tag and refuses a tree over
50 MiB or 2,000 entries. Committed screenshots pushed 0.6.29 and 0.7.0 over that
limit, and neither could be installed. `scripts/install-size.test.mjs` keeps
the tracked tree at 40 MiB or less.

To add evidence for a version, take the shots (`npm run shots`, they land in the
ignored `.screenshots/`), then commit them to `qa-evidence` under
`odd/qa/screens-<version>/`, never to `main`.
