# Diagnose a Mission Mode installation

After a package change, check the actual installed source and Node version before
opening a Mission. On a disposable directory, run `npm run setup` and `npm run qa`.
Then inspect the live HUD's `/healthz`, `/readyz`, `/metrics`, and
`/api/mission/diagnostics`. These are the local install-impact dashboard and
health views. They do not contact a provider or resume work.

`/healthz` confirms that HTTP is alive. `/readyz` additionally reads a consistent
snapshot; an empty Mission returns `onboarding`, and an unreadable transaction or
snapshot returns 503. Neither endpoint proves that a host task, scheduler, remote
provider, or physical restart works. Compare these views before and after an
installation using the same project and source SHA.

Every HTTP response carries `X-Request-ID`. For a 500 or readiness failure, find
that request in stderr's JSON records and the bounded recent-error view. The
metrics endpoint reports fixed route/status counts, duration sums, uptime, and
successful feature interactions. There are no user, path, task, or Mission labels.
Counts reset when the HUD process restarts. The error ring retains at most 20
redacted records; restart clears it. See [data handling](../data-handling.md).

If `TX_LOCK_BACKEND_UNAVAILABLE` occurs, stop write attempts and build the native
module for this Node installation and machine. Run `npm run setup -- /path/to/local/headers`.
A native build failure is not permission to use an unlocked writer.

If `TX_CORRUPT`, `TX_FOREIGN_PATH`, `TX_FOREIGN_LOCK`, or `TX_BUSY` occurs, preserve
the entire `.mission` directory, its inode ownership, and the exact error. Stop
new commands and identify the existing writer. Do not remove `writer.lock`, a WAL,
commit record, or pending effect. Recovery must use official readers/writers and
the original transaction evidence. Never edit a checksummed record to force it.

For `DISPATCH_OUTCOME_UNKNOWN` or a failed accepted-receipt write, preserve every
original dispatch/effect record. Ask the owning T3 thread for the original task
and raw receipt. Verify task/thread/run identity through that host, then follow
the skill's explicit reconciliation or binding path. Do not call StartMissionRun
again to discover whether a child was accepted.

For HTTP 403, use the printed loopback URL and a matching Origin/Host. Do not
remove the origin guard or restore wildcard CORS. For 400 or 413, send a JSON
object smaller than 1 MiB. Parser errors omit the submitted data. For 409, retain
the user's approval/Pause gate and inspect the returned lifecycle/receipt reason.

If a release causes a regression, stop its HUD before replacing package files.
Restore the previous verified Git tag/checkout in a separate directory, build
its native module locally, and run its QA before pointing it at an existing
Mission. Keep a backup of Mission data. A code rollback does not roll back an
external provider effect or authorize deleting newer durable receipts.

For an integrity/security report, use the repository owner and include tested SHA,
Node/OS, safe command output, request ID, and reproduction layer. Keep credentials,
Mission content, paths, and receipts private. The security workflow retains
machine-readable reports; GitHub secret scanning/push protection is separately
managed on the repository.

For `INVALID_OBSERVATION_ARCHIVE` with duplicate sequence numbers, retain all records and stop automatic replay. Earlier writers could miss staged observation files when the caller used a directory alias such as macOS `/var` for `/private/var`. The reader rejects ambiguous order and does not renumber or rewrite those records. Recover the original order from the owning thread and authentic runtime evidence before any authorized migration; filenames do not establish event order.
