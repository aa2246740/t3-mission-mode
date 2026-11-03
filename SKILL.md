---
name: t3-mission-mode
description: Launch, orchestrate, validate, and losslessly resume durable multi-milestone Missions in T3 Code using T3 Orchestration V2, the Mission HUD, and three-role model slots (Orchestrator, Worker, Validator). Trigger when the user enters `/mission <request>`, says "开启 mission" / "start mission", or says `[resume the mission]` / "继续" / "恢复 mission".
---

# T3 Mission Mode (`t3-mission-mode`)

This skill turns the current T3 Code thread into a durable **Mission Orchestrator** backed by `.mission/` state files, the live **Mission HUD** preview panel, and **T3 Code Orchestration V2** (`orchestrator_capabilities`, `delegate_task`, `t3_thread_send`, `t3_thread_organize`).

## Installed skill paths

Before running the commands below, set these values to the absolute installed skill directory and the explicitly selected target project. Resolve the skill path you read to its canonical location; do not assume that the target project contains the skill's source tree.

```bash
T3_MISSION_SKILL_ROOT="/absolute/path/to/installed/t3-mission-mode"
T3_MISSION_PROJECT_ROOT="/absolute/path/to/approved/target/project"
```

The commands use absolute script and Mission paths through these variables. For this host the installed canonical skill root is the resolved directory of the SKILL.md supplied by the skills catalog. Repository development commands such as npm test run from that source root, not the target project.

## Core Architecture & Roles

Every Mission uses three independent model slots configured in `.mission/model-settings.json`:

1. **Orchestrator (`orchestrator`)**: Plans milestones/features/validation contracts (`VAL-*`), coordinates handoffs, and manages user checkpoints.
2. **Worker (`worker`)**: Executes scoped feature implementations inside isolated worktrees (`isolation: "worktree"`, `role: "implementation"`).
3. **Validator (`validator`)**: Performs independent **Scrutiny** (`role: "review"`) and **User-Testing** (`role: "test"`) validation at the end of every Milestone.

### Provider Slot Normalization (`normalizeTargetFromSlot`) & Autonomy Mapping

When dispatching via `delegate_task`, model slot settings (including numeric effort bars `1..5`: `1 -> "minimal"`, `2 -> "low"`, `3 -> "medium"`, `4 -> "high"`, `5 -> "max"`) are normalized into `target: { providerInstanceId, model, options }`:

- `providerInstanceId === "codex"` -> `options.reasoningEffort` (`"minimal" | "low" | "medium" | "high" | "xhigh" | "max"`)
- `providerInstanceId === "antigravity"` -> direct `model` ID (e.g. `"gemini-4-argon-high"`, `"claude-opus-5-5-high"`), with `supportsEffort: false` (no `effort` or `reasoningEffort` keys persisted or passed)
- `providerInstanceId === "acpRegistry_factory_droid"` -> `options.reasoning_effort` and `options.autonomy_level` via `mapApprovalModeToProviderAutonomy("acpRegistry_factory_droid", slotConfig)` (defaults to `"auto-high"` in Mission Mode so workers do not stall in `"auto-medium"` or `"normal"`)
- `providerInstanceId === "acpRegistry_devin"` -> `options.mode` via `mapApprovalModeToProviderAutonomy("acpRegistry_devin", slotConfig)` (defaults to `"bypass"` so Devin does not stall on shell commands in `"accept-edits"`) and `options.thought_level` (`"minimal"|"low"|"medium"` -> `"medium"`, `"high"` -> `"high"`, `"xhigh"|"max"` -> `"max"`)
- `providerInstanceId === "acpRegistry_cursor"` -> `options.mode` via `mapApprovalModeToProviderAutonomy("acpRegistry_cursor", slotConfig)` (defaults to `"agent"`, or `"plan"` / `"ask"`) plus `options.reasoning_effort` (`"minimal"` -> `"low"`, `"max"` -> `"xhigh"`, else `"low"|"medium"|"high"|"xhigh"`) and `options.effort` (`"minimal"` -> `"low"`, else `"low"|"medium"|"high"|"xhigh"|"max"`)
- `providerInstanceId === "grok"` or `"cpa"` (`grok-*` models) -> `options.reasoningEffort` (`"low" | "medium" | "high" | "xhigh"`, clamping `"minimal"` -> `"low"` and `"max"` -> `"xhigh"`)
- `providerInstanceId === "pi"` -> `options.thinking` (and `resolveEffectiveRuntimeMode` filters against `pi`'s supported `runtimeModes: ["approval-required", "auto-accept-edits", "full-access"]` while respecting `parentRuntimeMode` as ceiling)

#### Bidirectional Factory Droid `autonomy_level` <-> T3 Approval/Runtime Mode Mapping

- `T3_APPROVAL_TO_DROID_AUTONOMY`:
  - `"plan"` (`interactionMode: "plan"`) -> `"spec"`
  - `"approval-required"` -> `"normal"`
  - `"auto-accept-edits"` -> `"auto-low"`
  - `"auto"` -> `"auto-high"` (explicit `autonomy_level: "auto-medium"` is still preserved when passed directly)
  - `"full-access"` -> `"auto-high"`
- `DROID_AUTONOMY_TO_T3_RUNTIME_MODE`:
  - `"spec"` -> `"approval-required"`
  - `"normal"` -> `"approval-required"`
  - `"auto-low"` -> `"auto-accept-edits"`
  - `"auto-medium"` -> `"auto"`
  - `"auto-high"` -> `"full-access"`

---

## First-Principles HUD Acceptance Criteria (Mandatory for Validators)

When any Validator (`gpt-6.1-sol`, `scrutiny-validator`, or `user-testing-validator`) inspects the T3 Mission Control HUD, validate against these **First-Principles T3-Native HUD Acceptance Criteria**:

1. **No Fake Standalone Chat Composer**:
   - The HUD runs inside T3 Code's preview pane alongside T3's native chat thread.
   - There must be **NO** fake chat input box (`"Pause to send messages"`), **NO** fake `Autonomy ||` or `Connectors (1)` toolbar chips, **NO** `< Back to App` button, **NO** fake `USAGE 0%` bar, and **NO** hardcoded `Wu David` avatar.
2. **At-a-Glance Progress Clarity**:
   - Milestones (`#milestone-pipeline-bar`), Features (`#features-list`, `.feature-row[data-feature-id]` with their linked `VAL-*` assertion pills), and Validation Contract assertions (`#assertions-list`, `.assertion-row[data-assertion-id]`) must be displayed in full (**never** truncated to `.slice(0, 8)`).
   - Progress bars (`#metric-progress-bar`, `#metric-contract-bar`) must reflect real completion percentages (`0%` when `0/N`, never hardcoded `65%`).
3. **Zero Log Spam / Duplication**:
   - Changing model slots or effort bars must **not** flood `#orchestrator-stream` in the center execution board with `model_slots_updated` cards, and consecutive `model_slots_updated` events in `#progress-log-list` are coalesced.
   - There must be **no** hardcoded fallback strings (`Open SlideStudio`, `Milestone 1: Intake`, `Milestone 2: Materials In Run`, `M2 material test gaps`, `Worker #28`) when mission fields are empty.
4. **Role Model Capability Gating**:
   - Fixed-tier models (`supportsEffort: false`, such as `gemini-4-argon-high` or `gpt-6-astra-high`) hide `#effort-bars-<slot>` (`display: none`, `aria-hidden="true"`, 0 `.effort-bar-btn` children) and omit `effort` and `reasoningEffort` keys in `.mission/model-settings.json`.

---

## Workflow A: Starting a New Mission (`/mission <需求>` or "开启 mission")

When the user triggers `/mission <需求>` or asks to start a Mission ("开启 mission"):

### Step 1: Optionally open the Mission HUD

1. When the user wants the observer panel, start the local Mission HUD server pointing at the repository's `.mission` directory if it is not already running. The Mission can run without a HUD:
   ```bash
   node "$T3_MISSION_SKILL_ROOT/t3-mission/hud/server.mjs" --mission-dir "$T3_MISSION_PROJECT_ROOT/.mission"
   ```
2. Check T3 preview status with `preview_status`, and open or navigate the right-side collaborative panel with `preview_open` / `preview_navigate` to the HUD URL so the user can monitor live progress, review the plan, and configure model slots.

### Step 2: Dispatch Read-Only `Explorer` Subtasks to Survey the Repository

1. Query `orchestrator_capabilities` to inspect live available providers and models.
2. Dispatch one or more read-only `Explorer` subtasks (`role: "research"`, title format `[M1] Explorer #1: <scope>`) to map the repository structure, existing conventions, test runners, and architectural boundaries.

### Step 3: Propose the Mission Plan (`ProposeMission`) & Wait for User Approval

1. Synthesize the exploration findings into a structured Mission Plan containing:
   - **Milestones** (`M1`, `M2`, ...)
   - **Features** (scoped implementation units mapped to milestones and `VAL-*` assertions; supports optional per-feature model overrides via `feature.target` or `feature.workerTarget`)
   - **Validation Contract** (`VAL-*` assertions with testable acceptance criteria)
   - **Three-Role Model Settings** (`orchestrator`, `worker`, `validator`; preserves any slots the user already edited in the HUD unless `forceModelSettings: true` is passed)
     Each `VAL-*` assertion must be independently decidable within a single validation stage. Do not reference Scrutiny, User-Testing, or another stage's receipts in an assertion. The controller verifies that both stages pass on the final integration SHA.

2. Include `autopilot:true` and the original `ownerThreadId` in the plan payload, along with declared integration policy and permission gates. This makes HUD approval record approval without selecting or dispatching a worker. Invoke `ProposeMission` via MCP or CLI:
   ```bash
   node "$T3_MISSION_SKILL_ROOT/t3-mission/bridge/cli.mjs" ProposeMission --mission-dir "$T3_MISSION_PROJECT_ROOT/.mission" --json '<plan-payload>'
   ```
3. If the HUD is in use, start `WaitForApproval` as a background command (or via the `WaitForApproval` MCP tool) so the Orchestrator thread is woken automatically as soon as the user clicks **Approve & Start Mission** or **Request Changes** in the HUD:
   ```bash
   node "$T3_MISSION_SKILL_ROOT/t3-mission/bridge/cli.mjs" WaitForApproval --mission-dir "$T3_MISSION_PROJECT_ROOT/.mission" --timeout-ms 600000
   ```
   _(You may also pass `--notify-url <webhookUrl>` when starting `hud/server.mjs` to POST HUD command notifications to a T3 `schedule_task` webhook.)_
4. **HARD GUARDRAIL (Mandatory Approval Gate)**:
   - Ask the user to approve the proposed milestones, features, assertions, model slots, integration policy and permissions in the HUD or chat. Chat approval is recorded with ApproveMissionPlan before ticking.
   - **NEVER** call `StartMissionRun` or dispatch any implementation `Worker` before the user has explicitly approved the plan (`planAccepted === true`).

### Step 4: Run the Autopilot loop (`MissionTick`)

After the user approves the plan, record chat-only approval with `ApproveMissionPlan`. If the HUD already recorded it, proceed directly. Declare `integration: {"branch":"mission/<name>","auto":true}` in the proposed plan only when the user authorizes local integration into that exact branch. Omitted integration or `auto:false` waits for merge approval. Declare account, secret, deployment, or other permission gates in `permissions` before approval. Do not infer approval from a task result.

1. Use the original owner thread throughout. The controller identifies its owner and requests a timer before dispatch. Never create a timer independently. The ledger `.mission/autopilot/controller.json` owns scheduler identity and pending operations. Child notifications wake the fast path; the timer checks for missed results. A closed HUD does not stop execution.
2. Invoke the kernel and inspect its single `action`. For an explicitly bounded run, pass `timerMaxWakeups` (1–12) on the first tick, before any timer or worker exists. Optionally pass `timerWakeInstructions` on that same tick to retain the exact candidate and preflight instructions in the scheduler prompt. Both are immutable for the Mission. The controller uses one-shot schedules under a fixed deadline. Exhaustion returns `TIMER_WAKE_LIMIT_REACHED`; it does not authorize another timer. This bounds requested schedules, not undocumented T3 restart delivery:

   ```bash
   node "$T3_MISSION_SKILL_ROOT/t3-mission/bridge/cli.mjs" MissionTick --mission-dir "$T3_MISSION_PROJECT_ROOT/.mission" --json '{"observations":[]}'
   # Or pass complex observation JSON via stdin (--json - or --stdin) without creating temporary files in /tmp:
   # node "$T3_MISSION_SKILL_ROOT/t3-mission/bridge/cli.mjs" MissionTick --mission-dir "$T3_MISSION_PROJECT_ROOT/.mission" --json - <<'JSON'
   # {"observations":[...]}
   # JSON
   ```

3. Execute only the returned action. Preserve its featureId, runId, intentId, and taskId in the observation wrapper. Copy the tool return unchanged into `response`, including MCP `content`, `structuredContent`, and error fields. Never summarize or repair a raw response.

   - `identify_owner`: call `orchestrator_capabilities({})` and submit `{type:"owner",response:<original return>}`. The controller persists `parentThreadId` verbatim as ownerThreadId. Do not substitute a child or a new conversation ID.
   - `ensure_timer`: when `action.updateScheduledTask` is present, call `schedule_task(action.updateScheduledTask)` to update the original `scheduledTaskId`; never create another timer. Otherwise call `schedule_task(action.scheduleTask)` once. Then submit `{type:"timer",requestId:action.requestId,response:<original return>}`. The default period is 600000 ms; plans may set timerEveryMs. An uncertain creation or update returns TIMER_OUTCOME_UNKNOWN on later ticks. Reconcile the original operation and return its raw record; never create a second timer.
   - `dispatch`: call `delegate_task` with exactly `action.delegateTask`. Its title, role, worktree isolation, target options, clientRequestId, and async mode are fixed by the controller. Submit `{type:"dispatch",featureId,runId,intentId,invocationId:action.invocationId,response:<original return>}` to the next tick. The invocationId identifies this call and must be echoed verbatim; it is separate from clientRequestId. If the call throws or its return is lost, submit no invented receipt and tick again. Never repeat delegate_task on your own.
   - Late execution evidence returns `poll` or `recover_dispatch` for the original run, including a consumed session. Submit complete original `task_status`; a terminal task with no pending children produces an immutable audit resolution and progress log entry. Late results are never merged or adopted, and their worktrees and branches stay intact. After all late executions for the feature stop, normal attempt and provider budgets decide whether to continue or wait_user. Historical retarget keys use the same reconciliation. Pause/Resume and approval do not clear uncertainty. For identity conflicts, obtain the user's explicit selection, collect terminal status for every conflicting execution, then submit `MissionTick.dispatchResolution` with those archived terminalObservationIds, intentId, selectedTaskId, selectedChildThreadId and the user's reason. Never set `userConfirmed:true` without that user decision.
   - `recover_dispatch`: call `t3_thread_list(action.t3ThreadList)` exactly. It includes includeSubagents:true, the original dispatch title as titleContains, limit, and a cursor when needed. Submit `{type:"children",featureId,runId,intentId,cursor:action.t3ThreadList.cursor ?? null,response:<original page>}`. Follow every nextCursor through subsequent recover_dispatch actions. The controller URL-decodes request IDs embedded in any ID field, requires parentThreadId === ownerThreadId, and derives node:/thread: identities. Titles only filter the query. Zero or multiple owner matches return wait_user. Session prefix changes never authorize redispatch.
   - `poll`: call `task_status({taskId:action.taskId})` in the original owner thread. Submit `{type:"task_status",featureId,runId,intentId:action.intentId,taskId,response:<original return>}`; preserve intentId when supplied. A completed turn with working, waiting_for_children, or hasPendingChildRuns is not ready for End. After dispatch, if the task is still running and T3 says not to poll, end the turn and await its completion notification or the timer. Execute poll on the next wakeup. Do not repeatedly poll within one turn.
   - `orchestrator_decision`: handle only the named decision. For kind:"validation_failed", use failedAssertions to insert a repair with UpdateMissionFeatures, sourceFeatureId pointing to the validator, and resolvesHandoffItemIds covering its failure. After repair integration, the controller marks prior stages stale and dispatches validators automatically. Other handoff items may require repairs or explicit reasons through DismissHandoffItems. For `incomplete_work`, the default is UpdateMissionFeatures to insert or rewrite a recover-and-finish task, with resolvesHandoffItemIds linking the corresponding pending items. Preserve the original worktree and history. For `handoff`, use the same repair path for unfinished work; close already resolved items with DismissHandoffItems and evidence in its justification. Malformed results stay active: execute the controller's bounded resume_worker correction on the same child and run. Never edit or invent an envelope.
   - `orchestrator_decision` with `kind:"integrate"`: apply only the already-approved local fast-forward integration into `context.branch`. Check the integration checkout before writing. Resolve `context.commit` uniquely with Git and verify the actual source HEAD equals context.commit (its resolved full SHA). If the main checkout contains unknown dirty changes, preserve them and report blocked. Use only that exact SHA for the approved fast-forward; do not establish provenance from a branch name or a model claim. If unknown uncommitted files or conflicts block integration, preserve them and submit `{type:"integration",featureId,runId,response:{blocked:true,reason,dirtyFiles:[...]}}`. The controller disables its timer and returns wait_user with gate INTEGRATION_BLOCKED. After the user resolves the obstruction, invoke MissionTick again to retry integrate; the controller re-enables the same timer. For successful integration, submit `{type:"integration",featureId,runId,response:{branch,sourceBranch,commit,mergeSha}}` with the full observed source commit and resulting merge SHA. Do not push, deploy, or merge into another branch. Manual integration requires the user's explicit approval of that target and commit; only then include `approved:true` in this observation.
   - `interrupt_worker`: call `t3_thread_interrupt({threadId:action.threadId})` once. Submit `{type:"interrupt",featureId,runId,controlId:action.controlId,response:<original return>}`. Keep the user's Pause gate set. Lost responses require reconciliation, never repeated interrupts.
   - A wait for an accepted-child compensation Pause includes its original controlId and child identity. Reconcile that original operation and submit its raw confirmation as an interrupt observation with the supplied controlId. Never execute another Pause or Interrupt to obtain a receipt. Explicit Resume only opens the user gate; wait for the same-child resume_worker and its confirmed receipt before consuming results.
   - `resume_worker`: call `t3_thread_send({threadId:action.threadId,message:action.message})` once. Submit `{type:"resume",featureId,runId,controlId:action.controlId,response:<original return>}`. This continues the same child, task, feature run, and worktree. If T3 says to await completion, end this turn and poll on the next wakeup. The controller consumes latestTerminalSummary/latestTerminalRunId after the acknowledged resume, once. Never create a replacement task to resume.
   - `sleep`: honor until when present, end the current turn, and wait for a notification or scheduled tick. Provider rate/quota errors persist nextRetryAt using Retry-After or bounded exponential backoff. Feature attempt limits and consecutive provider error limits survive restarts. Public callback retries within one run are bounded by the smaller of maxAttempts and maxConsecutiveProviderErrors, including retarget history; DISPATCH_RETRY_BUDGET_EXHAUSTED requires MissionTick to consume its trusted refusal before continuing. Reapproval does not reset that count. Routine progress retains its latest raw status and a count; terminal, acceptance, new execution identity, and refusal facts remain archived. Corruption guards block further execution without blocking terminal intake. Authentication errors without an approved alternate require the user. Only fallbackTargets declared in the approved plan may replace provider/model/options, by worker or validator role. Never switch channels independently.
   - `wait_user`: report its gate and message and end the turn. Keep Pause, rejection, credentials, permissions, and merge decisions with the user. An expired timer is not approval.
   - `disable_timer`: call `schedule_task(action.updateScheduledTask)`, which contains `scheduledTaskId` and `enabled:false`. Submit `{type:"timer_disabled",requestId:action.requestId,response:<original return>}`. The raw disabled record must identify that same scheduled task. A stalled, blocked integration, or exhausted result correction first returns disable_timer with nextAction describing the forthcoming wait_user. Submit the disable receipt and tick until wait_user. Do not interpret nextAction as an additional executable action. If the return is lost, query the original task; do not create or disable another timer.
   - `done`: end the turn. The controller has already confirmed the timer is disabled. Both completed and awaiting_merge stop automatic work.

4. After every executable action or resolved model decision, submit observations to `MissionTick` again in the same turn. Continue until `sleep`, `wait_user`, or `done`, or until T3 reports a running task and instructs you to end the turn without polling. On each child notification or scheduled wakeup, resume at `MissionTick` with empty observations first, then execute its action.

The controller owns dispatch intent, Bind, End, validator injection, retries, and next-feature selection. Do not call `delegate_task`, `BindFeatureDispatch`, `EndFeatureRun`, or `StartMissionRun` outside this loop during Autopilot. Every result needs one complete mission-result JSON fence. Workers modify and commit only in the worktree T3 created for them, their current working directory; the main checkout is only a read-only integration reference. The generated brief explicitly authorizes normal require_escalated requests solely for sandbox-blocked local git add/commit in that worktree, and requires the exact refusal and partial if denied. If a worker sees commits or a branch rename it did not execute, it must compare the content with its intended changes, continue on top, and report the actual branch, HEAD and those commits as not executed by itself. Do not assume another executor finished the task; do not reset, rebase or delete those commits. Validators are read-only and must not write to any directory. Validators must include testedSha equal to the current integration SHA, assertionResults with only "passed" or "failed" values based on this stage's independent evidence, and failedAssertions listing exactly the failed assertion IDs. Integration into the shared branch invalidates prior stages for its old SHA. Completion requires both stages on the final SHA for every milestone. A build or child notification cannot replace acceptance.

Optional approved plan fields: pauseMode defaults to "interrupt"; "let_finish" retains logical Pause. timerEveryMs defaults to 600000. retryPolicy supports baseDelayMs (30000), maxDelayMs (1800000), maxConsecutiveProviderErrors (5), maxStalledDecisionRepeats (3, minimum 1), and maxResultFormatRetries (2, minimum 0). The same decision, revision, and observation set reaching maxStalledDecisionRepeats disables the timer and returns wait_user with gate STALLED_DECISION and the original decision. A new observation, approval, or UpdateMissionFeatures revision resumes normal evaluation and re-enables the original timer when needed; it grants no dispatch authority and clears no fence. Result-format retries resume only the same child and Mission run after terminal proof, confirm the original resume receipt before consuming a new terminal result, and never allocate a dispatch or clientRequestId. Exhaustion disables the timer and returns wait_user with gate RESULT_UNPARSEABLE. A corrected authentic result can still be consumed; approval alone does not replenish the correction budget. fallbackTargets maps worker/validator/orchestrator roles to ordered arrays of exact {providerInstanceId,model,options} targets; options is required, including {}. The controller has no orchestrator-provider transport and only applies worker/validator fallback. Missing fallbackTargets never authorizes switching.

---

## Workflow B: Resume Autopilot in its original owner thread

Read the absolute `.mission` directory and its controller ledger. Continue the same MissionTick loop. Do not call CheckMissionStateBeforeResuming as a health check or reset the active run. Only a resume_worker action authorizes t3_thread_send to the existing child. task_status is scoped to the original task owner; a new top-level conversation cannot assume access.

An outstanding intent returns recover_dispatch. Return raw original-owner pages as requested. Zero matches, multiple matches, foreign identity, and missing lookup capability stop safely. Accepted evidence is retained during Pause or plan rejection. Reapproval permits binding that same task. In interrupt mode, tick after Pause to interrupt the bound child once. After explicit Resume, the controller requests a turn on that same child unless a consumable terminal result already exists. let_finish allows the child to finish while Pause withholds End and subsequent dispatch. Do not clear Pause because T3 or the HUD reopened.

The timer remains bound to the original owner. Preserve nextRetryAt and budgets after restart. Missing scheduler/control receipts need reconciliation of the original operation. T3 exit and machine shutdown stop local execution; fixture tests do not prove app bootstrap, provider recovery, or restart delivery. HUD availability does not govern this protocol.

If a bounded timer's enable returned but a later safety stop disabled that same timer before the enable receipt was consumed, `ReconcileBoundedTimer` records both original receipts without scheduling or dispatching. Supply the pending requestId, the original enabled response, a fresh disabled response for the same one-shot task, and the reviewed replacement wake instructions. The disabled record must retain the same timer, owner, due time and base prompt. Do not invent either response.

### Legacy manual fallback

Use the old path only when Autopilot cannot run and the user explicitly chooses manual recovery. First inspect the exact active run and Git tree. `CheckMissionStateBeforeResuming` is an explicit reconciliation command that can pause state, not an observation command. Preserve dirty trees and merge conflicts.

HUD Git preflight runs outside the Mission write lock with a default 10000 ms deadline. Set `--git-preflight-timeout-ms` or `gitPreflightTimeoutMs` to an integer from 1 to 30000 ms when needed. A timeout returns `GIT_PREFLIGHT_TIMEOUT` / `RESUME_BLOCKED_BY_GIT_ERROR`, preserves the Pause gate, and does not authorize Resume.

For an already accepted task, use `BindFeatureDispatch` with original featureId, runId, taskId, childThreadId, clientRequestId, target and current expectedRevision. It never dispatches. For an unknown acceptance outcome, retain the journal fence and recover the original receipt. Do not call StartMissionRun to attach an existing task. For a verified completed task, the manual EndFeatureRun path still requires the original run identity and a complete structured handoff. The kernel checks expectedRevision inside the per-Mission OS lock and recoverable file transaction. Keep execution ownership in the original owner thread; independent official processes serialize their storage changes.

Opening or restarting the default HUD preserves current run state. An initialized legacy Mission can retain `missionId:"mission-uninitialized"`; honor initialized:true and preserve its history. Legacy active runs without an Autopilot intent stop for explicit reconciliation rather than guessing whether dispatch occurred.

### Mission transaction storage and recovery

Build the OS lock offline before using this kernel: `node t3-mission/native/build.mjs /path/to/local/node/headers`. Use an existing local C compiler and headers; never install dependencies to bypass a missing backend. The included target is macOS arm64. Node >=20 remains the runtime contract; this candidate was executed on Node 26, while Node 20 and Linux execution still need acceptance. `TX_LOCK_BACKEND_UNAVAILABLE` stops storage operations without an unlocked fallback.

All official commands and combined reads use a short per-Mission transaction. The four public files keep their paths and JSON shapes; `.txn/` holds the checksummed recovery WAL, command results, raw receipts and effect claims. Use `readMissionSnapshot` for a consistent combined read. Custom synchronous reducers can use `withMissionTransaction`; never await T3, a provider or a custom adapter inside it. Prepare and commit the intent, release the lock, invoke the transport, then re-read gate and run identity in a fresh transaction.

Retry one logical command with its original `commandId` and identical payload. Changed payload with the same ID is refused. Kernel Reject accepts `rejectMissionPlan(dir, feedback, {commandId})`; other command inputs and HUD JSON accept `commandId`. Calls without an ID are distinct manual commands. Automatic timer/control/dispatch claims retain stable identities even without a caller ID. Repeated executable actions require recovery or polling of the original operation; never treat replay as permission to execute again.

Do not delete `.txn/`, accepted/unknown dispatch records, old intent locks or controller budgets to force progress. `TX_BUSY` allows a later retry; corrupt/foreign WAL, lock or receipt errors require preserving and inspecting the reported material. A fresh official read replays a valid committed WAL before returning a snapshot. HUD GET/SSE performs storage recovery only, never business reconciliation or worker startup. A cached fallback still needs exact approval for the current feature role at the moment of selection.

HUD runtime-control Pause commits the paused gate and request log before control. Until control confirms, worker, session and feature retain their previous runtime state. Explicit refusal returns 409 with its original code, keeps the gate, and records pauseControl with code, at and runId. A repeated request reconciles that fact without another control call. Confirmation commits paused runtime projections in a new transaction. Runtime Resume for an already bound child follows P2: control first, commit only after confirmation, and preserve the paused gate on errors; a missing adapter returns NO_T3_TRANSPORT. A pending run with no child follows V03: directly clear the gate, return HTTP 200, perform zero external control calls, and retain its original run/intent and dispatch fence.

Offline edits to the public files remain effective when no committed WAL is pending. Noncooperating old writers cannot receive cross-file guarantees. Loaded low-level documents carry stale-write checks; use an explicit transaction to compose lifecycle changes, and pass `expectedRevision` for a detached state replacement. See DESIGN-transactions.md before adding an internal writer or recovery path.

## Local HUD diagnostics and repository development

The loopback HUD exposes read-only `/healthz`, `/readyz`, `/metrics`, and `/api/mission/diagnostics`. These endpoints never reconcile or resume a Mission. Health confirms the HTTP layer; it does not prove provider or scheduler liveness. Keep the HUD on its loopback listener. Foreign Origin/Host requests are refused, and command JSON must be an object no larger than 1 MiB. Use the response X-Request-ID to correlate bounded, redacted local diagnostics. No analytics are exported.

For changes to this skill package, read its root AGENTS.md and docs/development.md. Run the isolated `npm run qa` flow before touching an actual Mission; it uses no credentials, transport, or local worker daemon. Preserve root and packaged SKILL.md byte identity.
