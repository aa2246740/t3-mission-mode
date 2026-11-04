# Local data and diagnostics

Mission JSON, prompts, handoffs, provider receipts, paths, and progress logs belong
to the project owner. They can contain confidential code or personal information.
Keep `.mission/` outside version control and do not attach it wholesale to issues.
HUD steering instructions are user content. The loopback steering endpoint sends them only to the selected Mission thread when transport is configured, and stores successful or local-only instructions in `.mission/progress_log.jsonl` for the session feed. Review this journal before sharing it.
Preserve its full contents for authorized recovery rather than selectively
removing locks, journals, or receipts.

The application sends no analytics to a remote service. The HUD records aggregate
successful feature interactions, fixed route/status counts, durations, and uptime
in process memory. It records no analytics identity, prompt, Mission title, task
ID, repository path, session identifier, or cookie. The local diagnostics endpoint
lets the operator inspect these counters. Restart clears the counters.

A bounded ring keeps 20 recent runtime errors with request ID, operation, code,
message, and stack. The dedicated logger and ring scrub bearer/API tokens,
credential keys, email addresses, and common local path roots. Structured logging
also redacts password/token/secret/cookie/prompt/payload/body/receipt fields before
writing JSON to stderr. Diagnostic output is still local operator data; do not
publish it without review. The process cannot identify every secret embedded in
arbitrary text, so custom adapters must avoid putting user content in errors.

`.env` and `.env.*` are ignored except the nonsecret example. Optional notification
URLs can contain credentials; supply them through exported environment variables
or your operating system's secret store. The app never prints its environment.
The HUD has no multi-user authentication; keep its listener on loopback.

To export local diagnostics, retrieve `/api/mission/diagnostics` over the loopback
listener and review the result before sharing it. To clear those diagnostics,
restart the HUD. To delete Mission data, stop all owners/runtimes and let the
project owner apply the project's retention requirements. Diagnostic cleanup never
authorizes deleting a live journal or an unresolved provider-effect record.
