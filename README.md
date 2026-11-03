# T3 Mission Mode (`t3-mission-mode`)

<p align="center">
  <img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="MIT License" />
  <img src="https://img.shields.io/badge/Runtime-Node.js_%E2%89%A520_%2B_N--API_lock-339933.svg" alt="Node.js 20 or newer with a native OS lock" />
  <img src="https://img.shields.io/badge/Validation-Local_QA_%26_Recovery_Tests-8A2BE2.svg" alt="Local QA and recovery tests" />
</p>

> **Durable Multi-Milestone Mission Mode for T3 Code** — Transform any T3 Code thread into a persistent, verifiable, multi-milestone software engineering orchestrator with **3-Role Heterogeneous Model Slots** (`Orchestrator` / `Worker` / `Validator`), a **Live SSE 3-Column Mission HUD**, **Git-Guarded Lossless Pause & Resume**, and **Cross-Provider Autonomy Mapping**.
>
> **面向 T3 Code 的持久化多里程碑 Mission 编排引擎** —— 将任意 T3 Code 会话升级为具备磁盘状态持久化（`.mission/`）、三角色异构模型槽位（`Orchestrator` / `Worker` / `Validator`）、实时三栏 SSE Mission HUD 面板、Git 工作树安全门禁无损暂停/恢复，以及跨 Provider 权限与推理强度自动映射的工程级 Mission 系统。

## Development and local diagnostics

Use [AGENTS.md](AGENTS.md) for repository commands and [the development guide](docs/development.md) for native build prerequisites, isolated QA, coverage, and profiling. `npm ci && npm run setup && npm run qa` runs a disposable loopback flow without credentials or provider dispatch. Development tools use Node 26.7.0; other runtime/platform claims need their own passing runs.

The HUD exposes `/healthz`, `/readyz`, `/metrics`, and `/api/mission/diagnostics`. Requests have correlation IDs; counters remain local, and recent errors are bounded and redacted. See the [operations runbook](docs/runbooks/operations.md), [data handling](docs/data-handling.md), and generated [API contract](docs/openapi.json). Cross-origin requests are refused and command JSON bodies are limited to 1 MiB.

---

## Installed skill paths

Before running the commands below, set these values to the absolute installed skill directory and the explicitly selected target project. Resolve the skill path you read to its canonical location; do not assume that the target project contains the skill's source tree.

```bash
T3_MISSION_SKILL_ROOT="/absolute/path/to/installed/t3-mission-mode"
T3_MISSION_PROJECT_ROOT="/absolute/path/to/approved/target/project"
```

The commands use absolute script and Mission paths through these variables. For this host the installed canonical skill root is the resolved directory of the SKILL.md supplied by the skills catalog. Repository development commands such as npm test run from that source root, not the target project.

## ✨ Core Highlights / 核心特性

1. **3-Role Heterogeneous Model Slots (`Orchestrator` / `Worker` / `Validator`) / 三角色异构模型槽位**
   - Assign specialized providers and models to each role in `.mission/model-settings.json` or live in the HUD:
     - **Orchestrator (`orchestrator`)**: Plans milestones, features, and `VAL-*` validation contracts; manages handoff gates and checkpoints.
     - **Worker (`worker`)**: Executes scoped feature implementations inside isolated Git worktrees (`isolation: "worktree"`, `role: "implementation"`).
     - **Validator (`validator`)**: Runs independent **Scrutiny** (`role: "review"`) and **User-Testing** (`role: "test"`) verification at the end of every milestone.
   - 支持为规划编排（Orchestrator）、隔离开发（Worker）与独立验收（Validator）分别指定不同供应商与模型，实现性价比与工程质量的最优组合。

2. **Live SSE 3-Column Mission HUD / 实时 SSE 三栏可视化监控面板**
   - Zero-dependency HTTP + Server-Sent Events (`text/event-stream`) server rendered directly in T3 Code's right-side collaborative preview panel.
   - Displays **Milestones & Features** (left), **Active Worker & Handoff Inspector** (center), and **Validation Contract (`VAL-*`) + Model Slots** (right) with real-time state updates.

3. **Capability-Aware Effort Bar Gating / 能力感知的推理档位自适应显隐**
   - Models with configurable effort tiers (e.g., `GPT-5.4`, `Claude Opus 4.7`) display an interactive 5-bar effort selector (`1..5` -> `minimal | low | medium | high | max`).
   - Fixed-tier models (e.g., `Gemini 4 Argon (High)`, `Claude Opus 5.5 (High)`) where `supportsEffort === false` automatically hide the effort bar selector (`hidden === true`) to prevent invalid parameter injection.

4. **Cross-Provider Autonomy & Runtime Mode Mapping with Fail-Closed Ceiling / 跨 Provider 权限映射与父会话安全上限**
   - Normalizes T3 approval/runtime modes across **Factory Droid** (`acpRegistry_factory_droid`), **Devin** (`acpRegistry_devin`), **Cursor** (`acpRegistry_cursor`), **Codex** (`codex`), **Antigravity** (`antigravity`), **Grok / CPA** (`grok` / `cpa`), and **Pi** (`pi`).
   - Enforces a **fail-closed parent ceiling** (`resolveEffectiveRuntimeMode`): child tasks can never escalate beyond the parent thread's runtime permission ceiling, and unsupported modes automatically fall back to the highest safe mode supported by both parent and target provider.

5. **Git-Guarded Lossless Pause & Resume / Git 安全门禁与无损恢复**
   - Closing T3 Code or pausing mid-feature preserves full state in `.mission/state.json`.
   - Before resuming (`CheckMissionStateBeforeResuming`), the engine inspects `git status --porcelain` in the target worktree (`checkGitTreeBeforeResume`). If clean, `StartMissionRun` prioritizes `t3_thread_send` on the original `activeWorker.childThreadId` to wake the exact worker thread in place without spawning duplicate tasks. If merge conflicts exist, it blocks execution and surfaces a clear diagnostic.

6. **Handoff Gate & Dynamic Feature Expansion / 交接门禁与动态任务扩展**
   - Every finished Worker submits a structured handoff (`salientSummary`, `whatWasImplemented`, `whatWasLeftUndone`, `verification`, `discoveredIssues`) fenced by `(featureId, runId)`.
   - Unfinished work or non-trivial discovered issues trigger a mandatory Handoff Gate: the Orchestrator must either expand the plan (`UpdateMissionFeatures`) or record an explicit justification (`>= 20` characters via `DismissHandoffItems`) before advancing.

7. **Two-Stage Milestone Validation (`scrutiny` + `user-testing`) / 双阶段里程碑强制验收**
   - Every milestone automatically injects two independent validator gates: **Scrutiny Validation** (code quality, architectural boundaries, unit tests) and **User-Testing Validation** (end-to-end verification of `VAL-*` assertions). Completed child threads are automatically settled via `t3_thread_organize({ action: "settle" })`.

---

## ⚡ 30-Second Quickstart / 30 秒快速开始

### 1. Install the Skill / 安装技能

```bash
git clone https://github.com/aa2246740/t3-mission-mode.git
cd t3-mission-mode
npm ci
npm run setup
./install.sh
```

`install.sh` installs the canonical package into `~/.agents/skills/t3-mission-mode`, creates `~/.agent/skills -> ~/.agents/skills` if needed, and links the skill into all detected agent skill directories (`~/.codex/skills`, `~/.claude/skills`, `~/.gemini/antigravity-cli/skills`, `~/.gemini/skills`, `~/.factory/skills`, `~/.pi/agent/skills`, `~/.cursor/skills`, etc.).

### 2. Trigger in T3 Code / 在 T3 Code 中启动与恢复

- **Start a new Mission / 开启新 Mission**:

  ```text
  /mission Build a full-stack analytics dashboard with authentication, CSV export, and E2E tests
  ```

  _(or simply say `开启 mission: <需求描述>`)_

- **Resume a paused Mission / 无损恢复已暂停的 Mission**:
  ```text
  [resume the mission]
  ```
  _(or say `继续` / `恢复 mission`)_

---

## 🖥️ Visual 6-Step Onboarding Walkthrough / 可视化全流程指南

### Step 1: Zero-Mission Onboarding Guide / 初始引导态

When the Mission HUD starts on a repository without an active `.mission/state.json`, it renders a bilingual 4-step Onboarding Guide explaining how `/mission` works:

```bash
node "$T3_MISSION_SKILL_ROOT/t3-mission/hud/server.mjs" --mission-dir "$T3_MISSION_PROJECT_ROOT/.mission"
```

![Step 1 — Onboarding Guide](./docs/screenshots/01-onboarding.png)

---

### Step 2: Plan Proposal & Mandatory Approval Gate / 计划提案与强制审批门禁

After read-only `Explorer` subagents map the repository, the Orchestrator calls `ProposeMission` to write `.mission/state.json`, `.mission/validation-contract.md`, and `.mission/model-settings.json`.
**Hard Guardrail**: No implementation `Worker` can be dispatched until you review the Milestones, Features, and `VAL-*` assertions in the HUD and click **Approve Plan**.

```bash
node "$T3_MISSION_SKILL_ROOT/t3-mission/bridge/cli.mjs" ProposeMission --mission-dir "$T3_MISSION_PROJECT_ROOT/.mission" --json '<plan-payload>'
```

![Step 2 — Plan Approval Gate](./docs/screenshots/02-plan-approval.png)

---

### Step 3: 3-Role Model Slots & Capability-Aware Effort Gating / 三角色模型槽位与推理档位门禁

Configure different providers and models for **Orchestrator**, **Worker**, and **Validator** directly in the HUD header.

- Models with `supportsEffort: true` (such as `GPT-5.4` or `Claude Opus 4.7`) display the 5-bar effort selector (`1..5`).
- Fixed-tier models with `supportsEffort: false` (such as `Gemini 4 Argon (High)`) automatically hide the effort bar selector (`hidden: true`).

![Step 3 — 3-Role Model Slots & Effort Bar Gating](./docs/screenshots/03-model-slots-effort-gating.png)

---

### Step 4: Serial Worker Execution in Isolated Worktrees / 隔离工作树串行开发

Once approved (`ApproveMissionPlan` + `StartMissionRun`), the Orchestrator dispatches the active feature's `Worker` via `delegate_task` with `isolation: "worktree"` and normalized provider options (`normalizeTargetFromSlot`). The HUD streams live worker progress, child thread ID, and isolated worktree path:

```bash
node "$T3_MISSION_SKILL_ROOT/t3-mission/bridge/cli.mjs" ApproveMissionPlan --mission-dir "$T3_MISSION_PROJECT_ROOT/.mission"
node "$T3_MISSION_SKILL_ROOT/t3-mission/bridge/cli.mjs" StartMissionRun --mission-dir "$T3_MISSION_PROJECT_ROOT/.mission"
```

![Step 4 — Running Worker in Isolated Worktree](./docs/screenshots/04-running-worker.png)

---

### Step 5: Git-Guarded Lossless Pause & Resume / Git 安全门禁与暂停恢复

You can pause the Mission at any time from the HUD (`Pause`) or close T3 Code. When resuming via `[resume the mission]`, `CheckMissionStateBeforeResuming` inspects `git status --porcelain` on the worker's worktree (`checkGitTreeBeforeResume`). If clean, `StartMissionRun` calls `t3_thread_send` on the existing `childThreadId` to wake the original worker thread losslessly:

```bash
node "$T3_MISSION_SKILL_ROOT/t3-mission/bridge/cli.mjs" CheckMissionStateBeforeResuming --mission-dir "$T3_MISSION_PROJECT_ROOT/.mission"
node "$T3_MISSION_SKILL_ROOT/t3-mission/bridge/cli.mjs" StartMissionRun --mission-dir "$T3_MISSION_PROJECT_ROOT/.mission"
```

![Step 5 — Paused State & Git Working Tree Guard](./docs/screenshots/05-paused-and-git-guard.png)

---

### Step 6: Handoff Inspector Gate & Milestone Completion / 交接审查门禁与双阶段里程碑完结

When a Worker finishes (`EndFeatureRun`), its structured handoff is inspected in the HUD. Any `discoveredIssues` or `whatWasLeftUndone` items must be converted into follow-up features (`UpdateMissionFeatures`) or explicitly justified (`DismissHandoffItems`) before the Milestone runs its **Scrutiny** and **User-Testing** Validators:

```bash
node "$T3_MISSION_SKILL_ROOT/t3-mission/bridge/cli.mjs" EndFeatureRun --mission-dir "$T3_MISSION_PROJECT_ROOT/.mission" --json '<handoff-payload>'
```

![Step 6A — Handoff Inspector Gate](./docs/screenshots/06-handoff-inspector.png)

Once all features and both Milestone Validators (`scrutiny` + `user-testing`) pass and all `VAL-*` assertions are verified, the Mission transitions to `completed` and settles completed child threads:

![Step 6B — Mission Completed & All VAL Assertions Passed](./docs/screenshots/07-mission-completed.png)

---

## 🧭 Multi-Provider Autonomy & Effort Mapping Matrix / 跨 Provider 权限与推理强度映射矩阵

`normalizeTargetFromSlot(slotConfig)` and `mapApprovalModeToProviderAutonomy(providerInstanceId, slotConfig)` automatically translate T3 Mission Mode settings (`effort: 1..5`, `approvalMode`, `parentRuntimeMode`) into each provider's native schema:

| Provider (`providerInstanceId`)                 | Effort Mapping (`1..5` -> Native Option)                                                                                        | Default Mission Autonomy                                       | Approval / Runtime Mode Mapping (`plan` / `approval-required` / `auto-accept-edits` / `auto` / `full-access`)                                                                                              |
| :---------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------ | :------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Codex** (`codex`)                             | `options.reasoningEffort`: `"minimal" \| "low" \| "medium" \| "high" \| "xhigh" \| "max"`                                       | `full-access` (clamped by parent ceiling)                      | Native T3 `runtimeMode` (`approval-required`, `auto-accept-edits`, `auto`, `full-access`)                                                                                                                  |
| **Antigravity** (`antigravity`)                 | Direct model tier ID (e.g. `gemini-4-argon-high`, `claude-opus-5-5-high`); effort bars auto-hidden when `supportsEffort: false` | `full-access` (clamped by parent ceiling)                      | Native T3 `runtimeMode` with fail-closed parent ceiling                                                                                                                                                    |
| **Factory Droid** (`acpRegistry_factory_droid`) | `options.reasoning_effort`: `"minimal" \| "low" \| "medium" \| "high" \| "max"`                                                 | `options.autonomy_level: "auto-high"` (prevents worker stalls) | `plan` <-> `"spec"`<br>`approval-required` <-> `"normal"`<br>`auto-accept-edits` <-> `"auto-low"`<br>`auto` <-> `"auto-high"` (`"auto-medium"` preserved when explicit)<br>`full-access` <-> `"auto-high"` |
| **Devin** (`acpRegistry_devin`)                 | `options.thought_level`: `1..3` -> `"medium"`, `4` -> `"high"`, `5` -> `"max"`                                                  | `options.mode: "bypass"` (prevents shell command stalls)       | `plan` / `approval-required` -> `"ask"`<br>`auto-accept-edits` -> `"accept-edits"`<br>`auto` / `full-access` -> `"bypass"`                                                                                 |
| **Cursor** (`acpRegistry_cursor`)               | `options.reasoning_effort` (`"low".."xhigh"`) + `options.effort` (`"low".."max"`)                                               | `options.mode: "agent"`                                        | `plan` -> `"plan"`<br>`approval-required` -> `"ask"`<br>`auto-accept-edits` / `auto` / `full-access` -> `"agent"`                                                                                          |
| **Grok / CPA** (`grok` / `cpa`)                 | `options.reasoningEffort`: `"low" \| "medium" \| "high" \| "xhigh"` (clamps `minimal`->`low`, `max`->`xhigh`)                   | `full-access` (clamped by parent ceiling)                      | Native T3 `runtimeMode` with fail-closed parent ceiling                                                                                                                                                    |
| **Pi** (`pi`)                                   | `options.thinking`: `"minimal" \| "low" \| "medium" \| "high" \| "xhigh" \| "max"`                                              | Highest supported mode `<= parentRuntimeMode`                  | Filtered against `["approval-required", "auto-accept-edits", "full-access"]` with fail-closed parent ceiling                                                                                               |

---

## 🏗️ Architecture Diagram / 系统架构图

```mermaid
flowchart TB
  subgraph T3["T3 Code Host & Orchestration V2"]
    Agent["Orchestrator Thread\n(SKILL.md Workflow)"]
    Preview["T3 Collaborative Preview\n(preview_open / preview_snapshot)"]
    Delegate["T3 Subagent Runtime\n(delegate_task / t3_thread_send / t3_thread_organize)"]
  end

  subgraph Package["t3-mission-mode (Zero-Dependency Node.js)"]
    CLI["bridge/cli.mjs & bridge/mcp-server.mjs\n(Mission Lifecycle Tools)"]
    Adapter["bridge/t3-adapter.mjs\n(Slot Normalization, Autonomy Mapping, Git Guard, Resume)"]
    Kernel["kernel/ (schema.mjs, store.mjs, runner.mjs, tools.mjs)\n(Atomic State Store, RunId Fencing, Handoff & Validation Gates)"]
    HUD["hud/server.mjs + hud/public/\n(Live SSE 3-Column Mission HUD + REST API)"]
  end

  subgraph Disk[".mission/ Durable State Directory"]
    State["state.json\n(Phase, Milestones, Features, ActiveWorker)"]
    Contract["validation-contract.md\n(VAL-* Assertions)"]
    Models["model-settings.json\n(Orchestrator / Worker / Validator Slots)"]
    Handoffs["handoffs/*.json\n(Salient Summary, Verification, Issues)"]
  end

  Agent -->|"CLI / JSON-RPC"| CLI
  CLI --> Kernel
  CLI --> Adapter
  Adapter -->|"Normalized Target + RuntimeMode"| Delegate
  Kernel <-->|"Mission transaction"| Disk
  HUD <-->|"Snapshots & commands"| Disk
  HUD <-->|"Live SSE Stream + UI Actions"| Preview
```

---

## 🛠️ CLI & Testing Reference / 命令行与测试参考

### Run the Unit Test Suite / 运行单元测试

`t3-mission-mode` uses Node.js's built-in test runner (`node:test`). Mission storage requires the included native OS lock; build it offline with an existing C compiler and local Node headers before running the kernel:

```bash
node t3-mission/native/build.mjs /path/to/local/node/headers
npm test
# or directly:
node --test t3-mission/test/*.test.mjs
```

### Start the Mission HUD Server / 启动 HUD 服务

```bash
npm run hud -- --mission-dir "$T3_MISSION_PROJECT_ROOT/.mission"
# or with an explicit port:
node "$T3_MISSION_SKILL_ROOT/t3-mission/hud/server.mjs" --mission-dir "$T3_MISSION_PROJECT_ROOT/.mission" --port 43110
```

### Mission Lifecycle CLI Commands / 核心生命周期 CLI 命令

```bash
# 1. Propose a Mission Plan (enters awaiting_approval)
node "$T3_MISSION_SKILL_ROOT/t3-mission/bridge/cli.mjs" ProposeMission --mission-dir "$T3_MISSION_PROJECT_ROOT/.mission" --json '<plan-json>'

# 2. Approve the proposed plan
node "$T3_MISSION_SKILL_ROOT/t3-mission/bridge/cli.mjs" ApproveMissionPlan --mission-dir "$T3_MISSION_PROJECT_ROOT/.mission"

# 3. Pre-check Mission state & Git working tree before resuming
node "$T3_MISSION_SKILL_ROOT/t3-mission/bridge/cli.mjs" CheckMissionStateBeforeResuming --mission-dir "$T3_MISSION_PROJECT_ROOT/.mission"

# 4. Start or resume the active feature/validator run
node "$T3_MISSION_SKILL_ROOT/t3-mission/bridge/cli.mjs" StartMissionRun --mission-dir "$T3_MISSION_PROJECT_ROOT/.mission"

# 5. Record a finished Worker or Validator handoff (fenced by featureId + runId)
node "$T3_MISSION_SKILL_ROOT/t3-mission/bridge/cli.mjs" EndFeatureRun --mission-dir "$T3_MISSION_PROJECT_ROOT/.mission" --json '<handoff-json>'

# 6. Dynamically add/update features or dismiss non-blocking handoff items
node "$T3_MISSION_SKILL_ROOT/t3-mission/bridge/cli.mjs" UpdateMissionFeatures --mission-dir "$T3_MISSION_PROJECT_ROOT/.mission" --json '<features-json>'
node "$T3_MISSION_SKILL_ROOT/t3-mission/bridge/cli.mjs" DismissHandoffItems --mission-dir "$T3_MISSION_PROJECT_ROOT/.mission" --json '<dismiss-json>'
```

---

## 📄 License

Released under the [MIT License](./LICENSE).

### Observe an existing Mission and attach a manual dispatch

Opening or restarting the default HUD is observational: it preserves the current run, revision and files. Runtime reconciliation is an explicit recovery command, never a side effect of opening a HUD, even when the local-daemon option is enabled. Do not use `CheckMissionStateBeforeResuming` as a health check while the original T3 orchestrator or worker is active; that command deliberately reconciles a recovery state.

A CLI/HUD process without a live T3 transport keeps `dispatchPending:true`. This is a request for the original orchestrator to dispatch, not proof that a worker exists. If the orchestrator calls `delegate_task` itself, verify the returned task/thread with T3, then record that accepted receipt through `BindFeatureDispatch`:

```bash
node "$T3_MISSION_SKILL_ROOT/t3-mission/bridge/cli.mjs" BindFeatureDispatch --mission-dir "$T3_MISSION_PROJECT_ROOT/.mission" --json '{"featureId":"f1","runId":"<current-run-id>","expectedRevision":12,"taskId":"<accepted-task-id>","childThreadId":"<accepted-child-thread-id>","runtimeTransport":"t3-delegate-task","target":{"providerInstanceId":"codex","model":"gpt-6.1-sol","options":{"reasoningEffort":"high"}}}'
```

The tool checks the active feature/run and revision, refuses conflicting identities, records the same identity in the worker, session and feature, and makes identical replay write-free. It never calls dispatch or resume and preserves a user pause. Do not call `StartMissionRun` to attach a task that already exists. Once bound, use the original runId and featureId for its `EndFeatureRun`; do not start another worker for the same feature.

An initialized legacy state may retain `missionId: "mission-uninitialized"`. The HUD honors its explicit `initialized:true` flag and preserves its ID and history; a model-slot edit does not reset it into onboarding.

Binding checks expectedRevision inside a short per-Mission OS lock and recoverable file transaction. Supply the original clientRequestId when it is available; a conflicting target or identity is refused.

### Durable dispatch receipts

The kernel stores each original dispatch intent in `.mission/dispatch-<scope-hash>.json` before it calls a child-creating runtime. It records an accepted receipt before committing the worker, session, or feature projection. A version conflict or a failed first Mission-file write therefore retains the original run and receipt. A retry reads that receipt instead of dispatching another child.

Keep these journal files with the Mission. Clearing task IDs from the three projections does not remove an accepted dispatch. A record left `inflight` after a crash or an ambiguous transport exception returns `DISPATCH_OUTCOME_UNKNOWN`. Recover and verify the original receipt, then use `BindFeatureDispatch`; do not delete the journal to force a retry. An accepted-receipt write failure returns `DISPATCH_RECEIPT_DURABILITY_FAILED` and retains the same fence.

Explicit rejection and pending responses remain retryable. A custom adapter may mark a thrown error with `dispatchOutcome: "rejected"` only when it knows that no child was accepted. Ordinary thrown errors provide no such proof. If a custom HTTP adapter supplies both `startMissionRun` and `runFeature`, the explicit start hook owns that dispatch; the HUD does not invoke both for one intent. A normal resume with an existing child thread or local runtime continues that runtime.

The Bridge returns `KERNEL_UNAVAILABLE` if the real kernel cannot load or lacks the requested tool. The compatibility `createFallbackKernel` export is an inert sentinel and cannot write lifecycle state. All official lifecycle writers and combined snapshot readers use the same per-Mission transaction. External transport runs after the lock is released.

### Transaction storage and offline build

The four public Mission files remain authoritative. `.mission/.txn/` stores a checksummed WAL, commit/checkpoint records, command results and external-effect claims. Official readers recover a committed batch under the OS lock before reading a complete snapshot. Use `readMissionSnapshot` for a combined read and `withMissionTransaction` for synchronous custom reducers; a reducer must never return a Promise. Supply the same `commandId` and payload when retrying one command. A repeated executable action requires recovery of its original receipt, never a new dispatch.

The native module uses N-API 8 and POSIX `flock`, with no package downloads or Node SQLite requirement. `build.mjs` supports macOS and Linux with an existing compiler and headers; it records the exact compiler arguments and source/binary hashes beside the output. Source checkouts build the native module for their own OS and architecture; machine-specific binaries are excluded from the distributable. The development toolchain runs Node 26.7.0 on macOS and Linux/arm64. Node 20 and other target architectures require separate verification. Other targets fail with `TX_LOCK_BACKEND_UNAVAILABLE`; there is no unlocked fallback.

Do not delete a writer lock, WAL, accepted receipt or unknown effect to force progress. Preserve the directory and resolve the reported error. Sequential offline edits to public files remain effective when no committed WAL is pending. Processes that bypass the advisory lock cannot obtain atomic multi-file views; migrate custom writers to the transaction API. See [DESIGN-transactions.md](DESIGN-transactions.md) for commit boundaries, stale-save checks, recovery errors and verification limits.

HUD runtime-control Pause first commits the paused gate. Refused control returns 409, preserves the gate and the previous worker/session/feature runtime state, and records one `pauseControl` fact. Confirmed control then commits paused runtime projections. Runtime Resume calls the adapter before committing its running gate; errors and unconfirmed returns retain the original paused state.

### Git budget and control receipts

The HUD runs Git preflight outside the Mission write lock. Its default deadline is 10000 ms. For a slower repository, start the HUD with a larger budget:

```sh
node t3-mission/hud/server.mjs --mission-dir /absolute/project --git-preflight-timeout-ms 15000
```

`createMissionHudServer` accepts the same value as `gitPreflightTimeoutMs`. The value must be an integer from 1 through 30000 ms. A timeout returns `GIT_PREFLIGHT_TIMEOUT`, keeps the Pause gate, and does not authorize Resume. The 30-second cap bounds each interactive request while allowing a finite slow fsmonitor hook to finish. Git process-group cleanup, the output cap, and state revalidation still apply.

`classifyControlReceipt(raw, operation, expectedIdentity)` in `kernel/schema.mjs` returns `classification`, `raw`, `identity`, and `diagnostics`. Pass the bound task, thread, and child-run IDs in `expectedIdentity`. The order is `rejected`, `identity_conflict`, `pending`, `confirmed`, then `unknown`. Missing identity remains compatible with the operation's confirmation rules. Explicit foreign identity never confirms the bound child. An unbound legacy Resume still needs an actual child identity before the dispatch journal can bind it.

The CLI forwards provider control evidence. The bridge's `resumeWorker` result exposes `classification` and `response`; callers read `classification` instead of expecting synthesized `resumed` or `canResume` flags. A bound Resume retains one control claim per Pause epoch, including claims created by older command-scoped callers. Repeating a request or changing its command ID does not repeat an unknown or rejected control.

An `isError:true` result alone does not prove that a dispatch was never accepted. The shared classifier reports the refusal and its retry evidence separately. The journal keeps that dispatch inflight unless explicit nonacceptance is proven; contradictory acceptance or identity remains fenced.
