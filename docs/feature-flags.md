# Optional local worker execution

`allowLocalDaemon` is a permanent execution-backend switch. The HUD API defaults
it to false; the CLI reads `T3_MISSION_LOCAL_WORKER_DAEMON=1` or the explicit local
daemon option. An observational HUD never enables the backend implicitly.
The flag is evaluated when the adapter is constructed. Changing an environment
variable later does not reconfigure an existing process.

The owner is @aa2246740. When changing this flag, review its references in
`hud/server.mjs`, `bridge/cli.mjs`, the public skill, and the lifecycle tests.
Run `npm run test:security`, `npm run qa`, and the complete runtime suite. The
bounded QA path always passes `allowLocalDaemon: false` and no provider transport.

Review flags on each release. Temporary flags require an owner, removal condition,
and an entry here. A flag with no callers, or a backend retired from the product,
must be removed together with its environment/CLI aliases, docs, and tests. The
local-daemon switch has no retirement date because it preserves an operator's
permanent choice of runtime; its referenced call sites and tests are checked at
release review. Documentation of this lifecycle is the stale-flag mechanism.
