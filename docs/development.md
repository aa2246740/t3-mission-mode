# Run the development and QA paths

Development uses Node 26.7.0, npm 11, Git, a C compiler, and local Node headers.
The application has no production npm dependencies or database. The optional T3
host transport is required only for real provider work. Standalone QA uses no
transport, no credentials, and no external service.

```sh
npm ci
npm run setup
npm run qa
```

`setup` searches the Node executable's sibling `include/node` directory,
`/opt/homebrew/include/node`, `/usr/local/include/node`, and `/usr/include/node`.
If the headers are elsewhere, run `npm run setup -- /absolute/path/to/headers`.
It fails with a clear message when `node_api.h` or `cc` is unavailable. Obtain
headers using your machine's normal Node installation, not an agent's automatic
runtime download. The native module is built for the current OS and architecture.

`qa` starts the actual HUD server on an ephemeral loopback port in a fresh temporary
directory. It checks the HTML, liveness/readiness, an empty Mission snapshot,
request correlation, a model-slot update and subsequent read, local usage counts,
and Prometheus metrics. It closes the server and removes its fixture. No login,
API key, T3 session, or local worker daemon is used. A settings change never proves
that the selected provider or model exists on a host.

To use the HUD manually, set a disposable project's absolute path and start it:

```sh
export T3_MISSION_PROJECT_ROOT=/absolute/path/to/disposable-project
npm run hud -- --mission-dir "$T3_MISSION_PROJECT_ROOT/.mission" --port 43110
```

Open the printed URL. The empty project shows onboarding. Read its state with:

```sh
curl --fail http://127.0.0.1:43110/api/mission/state
curl --fail http://127.0.0.1:43110/healthz
curl --fail http://127.0.0.1:43110/readyz
```

The default loopback listener has no login gate. It rejects foreign origins and
Host headers. Keep it on loopback; it is not an authenticated multi-user service.
For an actual Mission, use the host's skill, approval gate, and original owner
thread. The host supplies its MCP transport configuration. Standalone QA never
creates that configuration or dispatches providers.

Copy [.env.example](../.env.example) only when you need its optional settings.
The application reads exported process variables and does not load `.env`
automatically. Keep notification URLs containing credentials out of Git. Leave
`T3_MISSION_LOCAL_WORKER_DAEMON=0` for observational use. Do not point a test at an
existing Mission or a user's live HUD port.

Run the repository acceptance commands:

```sh
npm run check
npm test
npm run coverage
npm run test:security
npm run test:stability
npm run qa
```

The full suite includes expensive real-fsync and large-journal stress cases. The 1,610 late-identity combinations register across four independent test files by case index modulo four. Every original callback remains intact, and missing shard files fail registration. It
runs in isolated Node processes with bounded concurrency and a 90-minute per-file timeout. Each process receives its own evidence/TMPDIR directory; successful runs remove default fixtures, while failures retain their directory in the run report. Use `node --import ./scripts/test-environment.mjs --test <test-file>` for a direct legacy-regression run. Use
`T3_TEST_CONCURRENCY=1 npm test` when diagnosing contention. JUnit, total duration,
coverage, complexity, duplication, and stability reports remain in ignored
`reports/` and `coverage/` directories. A failed run stays failed; the stability
check compares two independent runs and never converts a failure into a pass.
Coverage merges subprocess results incrementally with c8's `merge-async` option.
This keeps the complete multi-process suite within the report generator's heap
limit without dropping subprocess coverage or lowering thresholds.

`npm run typecheck` applies strict checked JavaScript to the HTTP security,
logging, diagnostics, and route boundary in `t3-mission/ops`. The legacy kernel,
bridge, and HUD controller still need broader type coverage, tracked in DEBT-002.
ESLint and the complete behavior suite cover those modules meanwhile.

To inspect a performance problem, run `npm run profile`. It records a CPU profile
of 100 actual HTTP snapshot reads and the settings flow under `reports/profiles/`.
Open the `.cpuprofile` in a local profiler. This is a diagnostic workload, not a
throughput benchmark or a production performance claim.

Run `npm pack --dry-run` to inspect the distributable. Tag-triggered release CI
builds and checks the native source, packages runtime sources/assets and generated
API docs, writes checksums, and creates a GitHub release with generated notes.
The release workflow extracts the final archive, rebuilds its native lock, and runs the packaged HTTP QA before publishing. Each recipient builds its native lock against local headers. No machine-specific
binary is shipped in the npm archive.

## Run the same suite in an isolated Linux filesystem

The repository-owned [Containerfile.test](../Containerfile.test) builds Node and the native lock for an explicit Linux platform. On macOS, use the required Apple Container engine. The test image keeps Mission fixtures inside its own Linux filesystem, with no host project bind mount or published ports.

```sh
container build --platform linux/arm64 -f Containerfile.test -t localhost/t3-mission-tests:local .
container run --init --platform linux/arm64 --cpus 4 --memory 4g --tmpfs /tmp --name t3-mission-tests localhost/t3-mission-tests:local
container cp t3-mission-tests:/app/reports ./reports/linux
container cp t3-mission-tests:/app/coverage ./coverage/linux
container rm t3-mission-tests
```

The example runs the complete npm test entrypoint under the same coverage thresholds on a real Linux tmpfs for temporary fixtures. Use a separate run without `--tmpfs /tmp` for ordinary-filesystem lock/transaction recovery checks. The four test shards preserve all 1,610 matrix cases. Keep Linux-container results distinct from macOS/APFS and real T3/provider acceptance. Native process/transaction tests do not prove a physical power-loss boundary on either host. No Docker engine or socket is used.
