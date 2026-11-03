# Technical debt register

Each item names a real limitation, its owner, and an observable closure condition.
Source debt markers must use `TODO(DEBT-NNN)`, `FIXME(DEBT-NNN)`, or
`HACK(DEBT-NNN)` and reference an item below. The quality check rejects orphan
markers and writes measured complexity to `reports/quality.json`.

## DEBT-001: Legacy lifecycle functions have high complexity

Owner: @aa2246740. The HUD command handlers, receipt classifier, dispatch journal,
and Mission controller accumulated many state/identity branches. The initial
`scripts/complexity-budget.json` records every existing function above 20; CI
rejects increases and any new function above 20. This freezes existing debt,
without treating a high existing limit as a design target.

Close this item by extracting pure decisions along current transaction/effect
boundaries, preserving the full recovery matrices, and bringing every recorded
function to at most 20. Remove its old exception when it reaches that limit.
Do not split transactions, weaken approval gates, or discard receipt branches to
reduce a metric. The source-specific budget is reviewable and can only be raised
by an explicit reviewed edit, not by rerunning the initial recorder.

## DEBT-002: Strict typing covers the new operations boundary only

Owner: @aa2246740. `tsconfig.json` checks security, logging, diagnostics, and route
modules with strict null/index/optional-property checks. The existing kernel,
transport, and HUD controller remain JavaScript without complete static types.
Close this item by adding checked JSDoc types for the public Mission/receipt
variants and expanding the include set without suppressions or unchecked casts.
The behavior matrices remain required throughout that migration.

## DEBT-003: Remote governance and historical delivery evidence are incomplete

Owner: @aa2246740. Readiness cannot infer protected-branch policy, recurring fast
PR feedback, deployment frequency, bot-created dependency PRs, automated review
comments, or a healthy labeled backlog from configuration alone. Review repository
settings and collect actual records as the project uses its workflows. Do not
fabricate issues, PRs, releases, or successful runs to close this item.

## DEBT-004: Native platform and restart acceptance need separate runs

Owner: @aa2246740. Local tests on one machine do not prove other OS/architectures,
Node versions, real providers, scheduler delivery, power loss, or restart/reboot
behavior. CI defines additional OS/Node runs, but a configuration is not a passing
run. Close each boundary only with a result tied to the exact artifact and host.
