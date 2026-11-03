# Working on Mission Mode

This repository is one installable application. The CLI/MCP bridge, transactional
kernel, native lock, and local HUD share the root package and release lifecycle.

Read [development.md](docs/development.md) before changing runtime behavior.
Use Node 26.7.0 and npm 11 for development, with an existing C compiler and local
Node headers. Runtime compatibility below the tested versions remains a separate
acceptance claim.

```sh
npm ci
npm run setup
npm run check
npm test
npm run qa
```

`setup` builds the native lock from local headers and enables this checkout's
`.githooks`. It downloads no headers and does not install the skill into other
agents. Pass a header directory explicitly if discovery fails. Do not use Docker
on macOS. No container is required for this repository's build or QA.

The full suite includes disk-fsync, crash, process-lifetime, and large-journal
stress cases. Keep its default bounded concurrency; do not remove cases to speed
it up. Timings and JUnit results go to ignored `reports/`. Run
`npm run test:security` after changing HTTP boundaries and `npm run coverage`
before delivering runtime changes. A passing build or local fixture does not
prove a real T3/provider dispatch, scheduler wakeup, restart, or reboot.

Use `camelCase` for functions and variables, `PascalCase` for classes, and
`UPPER_SNAKE_CASE` for constants. Runtime modules use `kebab-case.mjs`;
behavior tests use `*.test.mjs` under `t3-mission/test`. Keep fixtures under that
directory and give every new temporary fixture cleanup. Use Node's built-in
runner; it has no supported native test-list mode in the current development
runtime. Do not invent collection evidence.

Keep kernel code independent of the bridge and HUD. The HUD may import the bridge,
kernel, and checked operations modules. Operations modules depend only on Node
builtins and one another. `npm run architecture` enforces these import boundaries.
New functions must stay at complexity 20 or below. Existing higher limits are
frozen in [complexity-budget.json](scripts/complexity-budget.json) and tracked as
[DEBT-001](docs/technical-debt.md); reduce them rather than increasing a limit.

All official Mission writers use the per-Mission transaction and OS lock. Reducers
are synchronous; provider effects happen after the lock is released. Preserve
unknown dispatch receipts, approval gates, run identity, and command idempotency.
Never delete a lock/WAL/receipt or resume an actual Mission to test a change.
Use `npm run qa` for an isolated loopback HTTP flow without credentials or transport.
See the [operations runbook](docs/runbooks/operations.md) for faults and recovery.

Update root `SKILL.md` and `t3-mission/skill/SKILL.md` together. The documentation
check compares their bytes, validates these npm commands and local links, and
checks generated API documentation. Regenerate with `npm run docs:generate`.

Keep prompts, repository paths, receipts, tokens, and user content out of logs and
issues. Follow [data handling](docs/data-handling.md). Routine dependency bumps
must wait at least seven days after release; security exceptions need a cited
advisory and targeted validation. Review real compatibility before updating pins.
Record technical debt as `TODO(DEBT-NNN)` with a corresponding entry in the
[debt register](docs/technical-debt.md). CI and the Git hook reject orphan markers.
