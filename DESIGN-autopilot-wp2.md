# Mission Mode Autopilot WP2

WP2 extends R8+WP1 with owner identity, real-format T3 recovery, durable scheduler requests, provider backoff, SHA-bound acceptance, and interrupt/resume actions. The kernel still performs no T3, scheduler, network, or Git operation. The original owner executes one returned action and submits the raw return.

The reconstructed R8+WP1 commit is `ebd63cc`. Its canonical base is `7ae63065c7e8db019b9633d63aff02e6801e4f69`. All 46 WP1 manifest entries matched before development. This document supersedes the corresponding WP1 limitations and leaves its evidence history intact.

## Action changes

| Action | Condition | Owner operation and observation |
| --- | --- | --- |
| `identify_owner` | Approved plan has no ownerThreadId. | Call orchestrator_capabilities. Return `{type:"owner",response}`. Persist its parentThreadId verbatim. No task selection precedes this step. |
| `ensure_timer` | Runnable Mission has no timer request or confirmation. | Call schedule_task once with action.schedule, action.prompt, and bindToCurrentThread:true. Return `{type:"timer",requestId,response}`. |
| `disable_timer` | Completion predicate holds and timer is confirmed. | Disable action.scheduledTaskId through update_scheduled_task. Return `{type:"timer_disabled",requestId,response}` identifying the same task with enabled:false. `done` follows confirmation. |
| `interrupt_worker` | interrupt-mode Pause has a bound child without a known terminal result. | Call t3_thread_interrupt on action.threadId once. Return `{type:"interrupt",featureId,runId,controlId,response}`. Pause remains set. |
| `resume_worker` | Explicit Resume follows confirmed interruption without a consumable result. | Call t3_thread_send on that same thread with action.message once. Return `{type:"resume",featureId,runId,controlId,response}`. No delegate or new feature run is created. |
| `recover_dispatch` | Original intent has unknown acceptance or a receipt was lost. | Call t3_thread_list with action.t3ThreadList. It sets includeSubagents:true, the original dispatch title, limit:100, and the current cursor. Return the whole page as children with its request cursor. Continue every nextCursor. |
| `sleep` | Provider retry is not due. | Return until=nextRetryAt. End the turn. Notifications and the timer may wake the owner; early ticks cannot dispatch. |
| `orchestrator_decision`, kind=`validation_failed` | A valid validator failure was consumed. | Use failedAssertions to add a repair with sourceFeatureId and resolvesHandoffItemIds. The controller reruns stale validators after integration. |

Other WP1 actions retain their purpose. `poll` also consumes a resumed child's latestTerminalSummary/latestTerminalRunId. Missing, conflicting, or unconfirmed evidence stops at a gate. Timer creation and worker control are claimed durably before returning an external action. Repeating a tick while a receipt is missing returns wait_user, never a second external create/send/interrupt operation.

## Recovery and owner identity

The controller accepts explicit clientRequestId or decodes it from any ID field containing `:delegate-task:<clientRequestId>`. The changing MCP session prefix is ignored. Every candidate must carry parentThreadId equal to the persisted ownerThreadId. A unique match derives childThreadId with the `thread:` prefix and taskId with the `node:` prefix. Conflicting explicit and derived IDs are refused.

Pages are retained in the ledger until the final page. Finding a match on an early page cannot bind it before checking later pages for ambiguity. Zero or multiple owner matches return DISPATCH_RECOVERY_AMBIGUOUS. No recovery path dispatches another child. Foreign and late run observations remain archived.

## Durable timer and Pause transitions

The timer ledger moves through `requested`, `confirmed`, `disable_requested`, and `disabled`. It records a stable Mission requestId, the raw observation archive, and scheduledTaskId. The default interval is 600000 ms. Plans can set timerEveryMs to an integer of at least 1000. The prompt contains only the Mission path and the bounded MissionTick instruction.

An unknown scheduler return retains the request and asks the owner to reconcile that original operation. It does not create a replacement. A completed or awaiting_merge state can still return disable_timer until its disabled receipt is confirmed. Empty terminal ticks then leave file contents and mtimes unchanged.

pauseMode defaults to interrupt. Each actual HUD Pause increments pauseEpoch. The run stores one interrupt request for that epoch and its acknowledged receipt. Resume requests one continuation on the existing child unless an authentic consumable terminal result is already archived. New permission gates also block resume_worker. pauseMode=let_finish keeps WP1 logical Pause behavior.

After an acknowledged resume, an old latestTerminalRunId cannot finish the feature. A new latestTerminalRunId, result_available, no pending children, and a valid envelope permit consumption of latestTerminalSummary. Explicit latestTerminalStatus failure still rejects envelope success. When T3 supplies no latestTerminalStatus, the controller uses the new terminal identity and result_available contract, plus the envelope status, rather than the original task's interrupted status. The original taskId stays bound. A changed childRunId is accepted only after acknowledged resume. End remains keyed by the Mission run and occurs once.

## Failure classes and budgets

| Class | Controller behavior |
| --- | --- |
| No transport | Persist no_transport and return NO_T3_TRANSPORT. No fabricated receipt or replacement child. |
| Explicit nonacceptance | Persist not_accepted. Without a classified provider error, return DISPATCH_NOT_ACCEPTED. An explicit unaccepted rate/quota error can settle the run, retain a retryable journal record, back off, then open a new attempt. |
| Unknown acceptance | Retain the inflight intent and return recover_dispatch. Positive acceptance without IDs also requires recovery. |
| Worker failure envelope | Persist worker_failure, End failure once, and use the existing bounded feature attempt policy. |
| T3 failed with rate/quota summary | End a provider failure, persist retry deadline and counters, then sleep. A validator provider failure does not write failed assertion stages or request a product repair. |
| T3 failed with authentication/permission summary | Use only an approved alternate, otherwise return PROVIDER_AUTH_REQUIRED. |
| Unparseable result | Preserve raw evidence and active identity, persist result_unparseable, and request an orchestrator decision. Never invent success. |

retryPolicy supports baseDelayMs=30000, maxDelayMs=1800000, and maxConsecutiveProviderErrors=5. Numeric Retry-After seconds and HTTP-date headers take precedence, including waits longer than the exponential cap. Without that hint, the per-feature provider error count sets bounded exponential delay. The clock parameter `now` exists for deterministic fixture tests; normal operation uses Date.now().

Feature attempts/maxAttempts remain in features.json. Per-feature provider counts, nextRetryAt, approved target switches with reasons, and Mission consecutive provider errors remain in controller.json. A new process cannot clear them. Authentic non-provider results reset the consecutive provider count before End. Budget exhaustion returns wait_user.

fallbackTargets maps worker, validator, or orchestrator to ordered arrays of exact providerInstanceId/model/options objects. Only declared worker/validator targets are applied by this controller. The owner model's provider is outside its transport. Missing declarations never authorize a switch. The controller records each switch and refuses a fallback if the runner would drop or alter its options. It does not mutate global model slots.

## Acceptance belongs to the current integration SHA

Validator envelopes require testedSha and failedAssertions. failedAssertions must exactly list failed milestone assertion IDs in assertionResults. A testedSha different from the milestone's recorded mergeSha cannot End or write passed.

The plan has one shared integration branch. Each new implementation/repair integration records its mergeSha as that branch's latest head and every milestone's current mergeSha. Existing assertion stages become stale. Completed or failed validators become pending, retain staleHandoff, and rerun automatically after pending work for their milestone. Attempts remain cumulative; invalidation does not reset the budget.

End stores testedSha in the handoff and stageTestedSha next to stageResults. A successful revalidation changes validationState from stale to passed. Completion requires both validators and both assertion stages for every milestone to match the final shared integration SHA, in addition to WP1's identity, integration, handoff, and permission predicates.

Validation failure yields a model decision, not a user approval requirement. Adding the repair through UpdateMissionFeatures resolves the named handoff items. Pending repairs take precedence over that milestone's validators. Integration clears obsolete failed-validator handoffs and starts the new acceptance cycle. The controller does not invent the repair implementation or dismiss unrelated issues.

## Changed files and integration with R9b

WP2 adds autopilot-policy.mjs and autopilot-wp2.test.mjs. Most logic lives in controller.mjs. schema.mjs parses and preserves plan policy. mission-result.mjs and mission-brief.mjs carry the validator contract. autopilot-commands.mjs records Pause epochs. dispatch-journal.mjs adds a narrowly checked explicit-rejection observation. tools.mjs distinguishes provider failures from validator findings and records tested SHA/validationState. mcp-server.mjs exposes the observation and policy fields. Both SKILL files are identical.

WP2 changes no runner, HUD server, CLI, runtime adapter, W0, or Factory implementation. R9b has not been merged here. WP1 fixtures now seed a confirmed, archived timer and explicitly select let_finish where they test the old Pause behavior. Their envelopes include testedSha/failedAssertions, recovery receipts include parent identity, and two accepted-without-ID expectations now require recovery instead of a permanent gate. All 66 original named tests remain.

## Verification

The final focused set passes 100/100: the 66 WP1 tests and 34 new WP2 tests. The fixed no-port set passes 229/229 before and after. The allowed full set changes from 445 tests, 296 passed and 149 failed to 479 tests, 330 passed and 149 failed. Every prior passing result, including nested results, stays passing. No new failure appears. Five daemon cases are excluded from both comparable full runs; Node's reporter omits them rather than counting them as skipped. The complete discovered collection is therefore 450 before and 484 after.

The 149 unchanged failures contain 139 direct listen EPERM results, six downstream receipt assertions, and four parent subtest failure aggregates. They are not 149 independent direct environment errors. No direct ps EPERM remains in this allowed selection. Parent WP1 450/450 unsandboxed is referenced evidence, not reproduced here.

The WP2 toy scenarios include an actual SIGKILL of the fixture owner process after durable dispatch, a new CLI process, a changed MCP prefix, real-format paginated T3 IDs, 429 retry and approved fallback, fresh-process backoff/budget preservation, repair/revalidation, shared-head invalidation, Pause/Resume, latestTerminal consumption, and terminal zero-write checks. All T3/provider/scheduler returns and merge SHAs come from the toy executor. There are no provider calls or Git merges. The SIGKILL is a process-crash test, not power-loss acceptance.

Raw failures and intermediate runs are retained in out. The first full run used the brief's three daemon exclusions. Source inspection then found two HUD composite tests containing daemon operations; both had already failed at listen EPERM before reaching those operations. Comparable and final runs exclude all five. Subsequent runners set TMPDIR inside .mm-dev. An intermediate no-port run exposed three missing-module regressions caused by making schema depend on autopilot-policy. Moving policy validation into schema fixed them without weakening their assertions.

## Limits and objections

- Real T3/provider/scheduler behavior, owner idle/busy delivery, app bootstrap, and machine restart remain untested. This task explicitly forbids those tool calls. No live Mission was opened or changed.
- Unknown scheduler/control receipts stop for reconciliation. This deliberately favors one external operation over automatic recreation. It cannot promise unattended progress across every lost scheduler/send/interrupt receipt. The repeated unconfirmed-timer tick returns wait_user rather than a second ensure/create instruction.
- The gap analysis proposed reusing a key after known nonacceptance. This WP follows the authoritative brief's new-attempt retry path for explicit unaccepted provider errors. The old intent is retained as retryable and ended; accepted or unknown intents are never retried this way.
- Authentication and exhausted-budget gates require an explicit operator recovery decision. This WP does not add a general API to reset provider counters or clear an authentication block. It never resets those automatically after elapsed time or restart.
- A resumed result without latestTerminalStatus relies on T3's new latestTerminalRunId/result_available semantics. A real-provider acceptance run must verify that contract and the raw control/scheduler return shapes before installation.
- This WP adds no cross-process single-writer lock or lifecycle WAL. Existing state/features/log partial-write risks remain. Durable request/receipt ordering is not an arbitrary crash or power-loss guarantee. Manual deletion of the ledger is not a supported way to reset budgets or paused control history.
- The integration receipt is still trusted owner evidence. The kernel does not independently verify Git branches, source commits, or test execution. SHA equality binds reported evidence; it does not establish that the tests actually ran.
- Revalidation uses cumulative feature attempts and conservatively invalidates all milestones sharing the branch. Large plans may need an explicitly approved higher validator budget.
- The user's no-delegation boundary overrides show-me-your-work's independent-review step. Parent review remains required. Nothing here authorizes canonical installation, merge, deployment, dependency installation, or broader permissions.
