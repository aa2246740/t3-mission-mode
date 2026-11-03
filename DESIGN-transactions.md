# Mission 文件事务（WP3 生产候选）

首轮事务输入为冻结 pre-WP3 `6009b025ddd62b8213895059f8fcfc7c3a1d906d`，canonical base 为 `7ae63065c7e8db019b9633d63aff02e6801e4f69`。本轮从逻辑 attempt1 `2cc9b6cc5151501ad8f26b88960f270a3d849680` 独立重建，64 个 tracked 文件大小和 SHA256 全部匹配，本地重建提交为 `54536cef1c03618a61ade5e947d770d5f984bf89`。

续做说明 SHA256 为 `b10a950b07c3b76a39736d76337dc20dde151ed5ef96c1efa643514ed4f38e66`。本轮叠加经过核对的 R9c 测试合同补丁，保留并补齐 attempt1 的未提交 WIP。WIP 删除 staged 授权快照，在真正 effect claim 内重验当前 Mission、revision、run 和 gate。A1 已将 MW-PARENT-R2-01 的批准纪元语义并入现有事务边界。六个批准入口共用 approvePlanState；真实批准与纪元同批提交，幂等重复批准不写入。

## 存储与同步合同

`state.json`、`features.json`、`model-settings.json`、`progress_log.jsonl` 保留路径、形状和权威读写效力。每个 Mission 的真实路径映射到一个 OS `flock`，不同 Mission 不共用锁。`mission-transaction.mjs` 是唯一 Mission 文件写后端；同步 API 仍同步返回，原异步 API 仍返回 Promise。没有引入 SQLite、常驻服务或网络依赖。

N-API 8 模块只提供 `flock(LOCK_EX|LOCK_NB)` / `LOCK_UN`。JS 自己打开 O_NOFOLLOW 的锁文件，持有并检查 fd 与命名 inode 的 dev/ino/nlink；调用者不能用环境变量或外来 fd 冒充持锁。锁不会 unlink，不猜 TTL，不依据 PID 存活删除锁，不杀陌生进程。进程退出或 SIGKILL 后由 OS 释放锁。默认最多等待 2000ms，超时返回 `TX_BUSY`。单个 reducer 不得同时持有两个 Mission 锁。

`withMissionTransaction(dir, reducer)` 是公开的同步组合入口，显式重复进入报 `TX_REENTRANT`；内部 `missionTransaction` 才能加入当前事务。Promise/thenable reducer 报 `TX_ASYNC_REDUCER` 并丢弃 staged 业务写入。事务内读取首先恢复 WAL，然后把读取字节和 after-image 保存在内存中；没有提交之前不会逐项改写业务文件。

`saveState` 拒绝旧 loaded state、倒退 revision 和缺少 expectedRevision 的 detached 变更，不能用自行递增的新 revision 猜测 base。`saveFeaturesDoc`、`saveModelSettings` 拒绝其 load API 返回的旧文件对象；它们也接受显式 expectedRevision。原有无 revision 的 detached 文档仍是显式全量替换，跨文件生命周期必须通过组合事务执行。对外暴露的底层替换 API 不能自动推断第三方丢失的读取基线。

## WAL 提交与恢复

每个事务按以下次序执行，所有 rename 和 fsync 都有前后故障注入点：

1. 锁内读取最新文档，检查 gate、run/feature/owner、revision、当前角色授权和 journal fence，计算完整 after-image。
2. 写 `.txn/prepare.json.<uuid>.tmp`，fsync 文件，rename 为 prepare，fsync 目录。payload 包含版本、事务 ID/sequence、Mission 目录真实路径/dev/ino、前后 missionId、每条路径的 preimage hash、after 字节/长度/hash；envelope 再校验整个 payload。
3. 同样耐久写 `.txn/commit.json`。这是批次决定；后续错误不得通过反向恢复旧文档撤销它。
4. 先验证所有当前文件等于各自 before 或 after，再逐项耐久发布 after-image。写 applied checkpoint，清 commit，再清 prepare，各步骤同步目录。
5. 释放锁后发送 HTTP 响应。提交失败不会提前发送成功响应；已 durable 的事实交给下一官方读者恢复。

fresh process 读取时先验证 WAL 校验和、版本、sequence、checkpoint 顺序、Mission 目录身份和文件白名单，验证全部 preimage 后再重放。重复恢复幂等。无 commit 的有效 prepare 可清除；有 commit 缺 prepare、未知版本、损坏校验、外部冲突或 foreign Mission 拒绝恢复并保留证据。EIO/ENOSPC 原样向上传播。不会初始化空 Mission 代替损坏状态，不会清 intent、预算或 controller ledger 来继续。

目录建立也 fsync 父目录。临时文件不具有提交权威，失败后保留用于诊断。锁缺失或本机二进制不可加载返回 `TX_LOCK_BACKEND_UNAVAILABLE`，不会静默改为无锁。

## 生产事务边界

- Propose/Approve/Reject/Dismiss/Update、验证注入、End，把关联四文件和事件 seq 合并为一批。End 的默认 commandId 由原 run/feature 组成，同一次通知最多写一次 End。MCP Update 的旧兼容写尾部已删除；不再在 await kernel 之后二次覆盖文档。
- Start/runner 选择、slot、run/session、intent/claim 在短事务中提交。`runMissionSteps` 把 generator 的每个同步段包成事务，先 commit/unlock，再调用 yield 出来的外部函数并 await；返回后在下一事务内重读 gate 和原身份。没有通过 async reducer 隐式延长锁。
- dispatch 返回后先以独立事务耐久保存 immutable raw receipt 和兼容 observedReceipt，再归一化 journal，最后合并投影。歧义异常保留 inflight fence；真正已拒绝才允许原 intent 的显式重试。CLI 实际 runtime dispatch 还保留返回原文的 effect 记录；恢复不会再次调用 transport。
- accepted/unknown journal 不受 Reject、重新 Propose 或预算重试清理。晚 Reject/reproposal/awaiting_input/handoff 仅保存 receipt。晚用户 Pause 保留其新 gate/pausedAt/owner，先记原 child 的真实 identity/slot 和一次补偿 Pause claim，再解锁暂停同一个 child。`operation === "resume" && !isResumeConfirmed(result)` 在借用旧身份之前立即返回；undefined、空对象、仅 status/identity、嵌套 pending/reject 不能成为 accepted。
- MissionTick 把观察归档为独立耐久事实，然后事务化 reducer。End 和 ledger consumed 同批提交；在选择下个 run 前另开事务。并发 tick 仅有一个 dispatch claim，其余 recover/poll。使用 budget.target 前按当前 feature 的 worker/validator 角色精确检查当前 state.fallbackTargets。同纪元撤权返回 FALLBACK_APPROVAL_REVOKED。更高批准纪元使已撤权旧决定作废，invalidatedFallbacks 与 ledger、选择和 intent 在同一短事务内提交。退避、计数、历史与 accepted/unknown intent 保留。fallback 仅通过 dispatchTarget 影响本次 worker/session/intent，不覆盖 feature.target。
- scheduler 与 interrupt/resume 在 ledger 中先写 requested，再返回可执行动作；重放只会要求对账。owner/receipt/控制回执和 SHA 失效都在短事务中应用。没有新观察、没有业务变化的 terminal tick 不写业务文件内容或 mtime。
- HUD 命令用同样事务和 command receipt。Pause 先提交 gate，再调用通知/控制。Approve 在 child transport 前耐久提交选定 run/plan；明确拒绝保留这个已提交的 pending run 与 retryable intent，409 返回当前 state，不反向恢复已提交 revision。原有“拒绝后四文件逐字回滚”不适用于这条已提交边界；这是防止旧回调撤销新 owner 的必要行为变化。
- 默认 HUD→CLI 的旧 staged 授权投影已删除；旧 CLI 请求只保留锁内 base hash 冲突检查。CLI 只信当前持锁快照，旧 payload 的 planAccepted 不能覆盖当前审批；实际 runtime effect claim 在同一短事务中重验 Mission/revision/run 和 dispatch gate，解锁后才调用外部 transport。
- HUD `commitMissionChanges` 只 stage，`restoreOwnedCommit` 的独立逆向回滚已删除。GET/SSE、WaitForApproval 和 CLI runtime 组合读取使用同一锁内快照；GET/SSE 只做存储恢复，不业务 reconcile、不修改 gate、不启动 worker。真实 TCP HTTP 在当前沙箱仍受端口权限限制；无端口 handler 验收不冒充真实 HTTP。

## 命令和 effect 幂等

稳定 commandId + 相同 payload 返回原已提交结果；同 ID 不同 payload 返回 `TX_COMMAND_ID_CONFLICT`。命令结果及 raw effect 响应都有 hash。MissionTick 不会把旧 dispatch/ensure_timer/interrupt/resume 再作为可执行动作返回；它要求恢复原收据。外部 effect 先 durable requested，解锁调用，返回后 durable 原文；进程死在外部动作后而无 receipt 时保留 unknown，拒绝再执行。

手动调用未传 commandId 表示新的显式用户命令，兼容原有多次人工 Resume。重试同一个用户动作必须带原 commandId；Reject 的兼容签名是 `rejectMissionPlan(dir, feedback, {commandId})`。自动 controller 动作即使调用者未传 ID，仍使用稳定的 phase/epoch/intent claim。

## 写者 census

下表覆盖最终设计 census 的全部 38 个路径组，另列 3 个新增的事务、CLI effect 和 HUD command 写者组。可机读的文件/符号/当前行号/源码 SHA 以及实际 raw fs 写点保存在交付 `out/writer-census.json`；原始 census、persistence-sites 和原 R01–R05 反例也随输入归档保留。

| Group | Production entry | Boundary |
|---|---|---|
| S01 | `kernel/store.mjs` — saveState, saveFeaturesDoc, saveModelSettings, writeFileAtomicSync, writeJsonAtomicSync | 同 Mission 短事务；外部调用前解锁。 |
| S02 | `kernel/store.mjs` — appendProgressLog | 同 Mission 短事务；外部调用前解锁。 |
| S03 | `kernel/store.mjs` — reconcileMissionOnLoad | 同 Mission 短事务；外部调用前解锁。 |
| T01 | `kernel/tools.mjs` — proposeMission | 同 Mission 短事务；外部调用前解锁。 |
| T02 | `kernel/tools.mjs` — approveMissionPlan | 同 Mission 短事务；外部调用前解锁。 |
| T03 | `kernel/tools.mjs` — rejectMissionPlan | 同 Mission 短事务；外部调用前解锁。 |
| T04 | `kernel/tools.mjs` — dismissHandoffItems | 同 Mission 短事务；外部调用前解锁。 |
| T05 | `kernel/tools.mjs` — updateMissionFeatures | 同 Mission 短事务；外部调用前解锁。 |
| T06 | `kernel/tools.mjs` — checkMilestoneCompletionAndInjectValidation | 同 Mission 短事务；外部调用前解锁。 |
| T07 | `kernel/tools.mjs` — endFeatureRun | 同 Mission 短事务；外部调用前解锁。 |
| R01 | `kernel/runner.mjs` — bindFeatureDispatch | 同 Mission 短事务；外部调用前解锁。 |
| R02 | `kernel/runner.mjs` — markDispatchPending | 同 Mission 短事务；外部调用前解锁。 |
| R03 | `kernel/runner.mjs` — dispatchFeatureToWorker | 同 Mission 短事务；外部调用前解锁。 |
| R04 | `kernel/runner.mjs` — dispatchPreparedWorker | 同 Mission 短事务；外部调用前解锁。 |
| R05 | `kernel/runner.mjs` — settlePausedWorkerResult | 同 Mission 短事务；外部调用前解锁。 |
| R06 | `kernel/runner.mjs` — startMissionRun | 同 Mission 短事务；外部调用前解锁。 |
| J01 | `kernel/dispatch-journal.mjs` — prepareDispatch, recordAcceptedDispatch, dispatchWithIntent, recoverAccepted, mutate | 同 Mission 短事务；外部调用前解锁。 |
| H01 | `hud/server.mjs` — handleApprove | 同 Mission 短事务；外部调用前解锁。 |
| H02 | `hud/server.mjs` — handleReject | 同 Mission 短事务；外部调用前解锁。 |
| H03 | `hud/server.mjs` — handleModelSlots | 同 Mission 短事务；外部调用前解锁。 |
| H04 | `hud/server.mjs` — handlePause, commitLifecycleState | 同 Mission 短事务；外部调用前解锁。 |
| H05 | `hud/server.mjs` — handleResume, commitLifecycleState | 同 Mission 短事务；外部调用前解锁。 |
| H06 | `hud/server.mjs` — commitMissionChanges; restoreOwnedCommit deleted | 同 Mission 短事务；外部调用前解锁。 |
| H07 | `hud/server.mjs` — runCli background startup | 自有 marker。 |
| M01 | `bridge/mcp-server.mjs` — callMissionTool UpdateMissionFeatures compatibility tail | 已删除兼容写尾部。 |
| C01 | `bridge/cli.mjs` — runCli LocalWorkerDaemon branch, writeDaemonState, cleanupAndExit | 自有 marker。 |
| C02 | `kernel/worker-process.mjs` — signalOwnedLocalWorker | 自有 marker。 |
| A01 | `kernel/autopilot-store.mjs` — archiveObservation | 同 Mission 短事务；外部调用前解锁。 |
| A02 | `kernel/autopilot-store.mjs` — readController, saveController, writeDurable | 同 Mission 短事务；外部调用前解锁。 |
| A03 | `kernel/autopilot-commands.mjs` — applyAutopilotCommand | 同 Mission 短事务；外部调用前解锁。 |
| A04 | `kernel/controller.mjs` — missionTick, ingest, integrationAction | 同 Mission 短事务；外部调用前解锁。 |
| W01 | `kernel/controller.mjs` — ingestGlobal | 同 Mission 短事务；外部调用前解锁。 |
| W02 | `kernel/controller.mjs` — timerAction | 同 Mission 短事务；外部调用前解锁。 |
| W03 | `kernel/controller.mjs` — controlAction | 同 Mission 短事务；外部调用前解锁。 |
| W04 | `kernel/controller.mjs` — recordMilestoneIntegration | 同 Mission 短事务；外部调用前解锁。 |
| W05 | `kernel/controller.mjs` — recordProviderFailure | 同 Mission 短事务；外部调用前解锁。 |
| W06 | `kernel/controller.mjs` — missionTick, ingest, integrationAction | 同 Mission 短事务；外部调用前解锁。 |
| W07 | `kernel/autopilot-commands.mjs` — applyAutopilotCommand | 同 Mission 短事务；外部调用前解锁。 |
| X01 | `kernel/mission-transaction.mjs` — withMissionTransaction, commandTransaction, runClaimedEffect, writeTransactionFile | New WAL backend, command and effect writers; validated claim inside the short transaction |
| X02 | `bridge/cli.mjs` — runtimeEffect, runtimeDispatchBlockReason | Current owner/revision/run/gate validated in effect claim; no staged-state authorization |
| X03 | `hud/server.mjs` — beginHudCommand, sendJson | Command result staged in transaction; HTTP delivery deferred until durable commit and unlock |

没有留在事务外的官方 Mission 业务写者。仅 HUD pid、显式本地 daemon 自有 marker 与 `signalOwnedLocalWorker` 对已验证自有 marker 的清理仍使用 raw fs；它们不写远端 task/session/feature 投影。本轮没有运行 daemon。

开放边界：不遵守 advisory lock 的旧程序可破坏任何文件级协议；本实现不能替它们获得原子性。没有 pending committed WAL 时，顺序离线编辑四文件仍有效。提交或恢复期间的直接外部编辑与 preimage 冲突时返回 `EXTERNAL_MISSION_WRITE`，保留双方材料，不猜测应覆盖谁。第三方 hook 的任意任性磁盘写入不属于官方协议。

## 本地构建与复验

```sh
node t3-mission/native/build.mjs /path/to/local/node/headers
node --test t3-mission/test/transactions.test.mjs
node t3-mission/test/fixtures/run-wp3-faults.mjs /absolute/new-owned-update-evidence
node t3-mission/test/fixtures/run-wp3-receipt-faults.mjs /absolute/new-owned-receipt-evidence
```

build 脚本只用已有 `cc` 和本地 `node_api.h`，不下载；输出相应 OS/arch 的 `.node` 及编译 argv/source/binary hash JSON。本次用 `/opt/homebrew/include/node` 构建 darwin/arm64，N-API 8。产品仍声明 Node >=20；实际执行环境是 Node 26.7.0。Node 20 运行、Linux 编译/执行、其他架构、断电及网络文件系统没有验收。

专用测试通过实际 kernel/MCP/handler 接口和独立进程验证 R01–R05、transport 期间 Pause/Reject、两个 Mission、busy/SIGKILL 锁释放、旧文档、命令冲突、End 一次、恢复/foreign/corrupt/missing backend、GET/SSE 无业务写、R9c 与撤销 fallback。矩阵对实际 Update、accepted receipt、End/consumed 的每个跟踪 rename/fsync/unlink 边界注入 EIO、ENOSPC 或真实 SIGKILL，fresh process 恢复两次并重试/重放命令。EIO/ENOSPC 是 syscall 边界软件注入，不称硬盘故障或断电测试。

完整允许集合前后比较及所有中间失败放在交付 `out/`。基线 790 项为 638 pass、152 fail；续做 811 项为 658 pass、153 fail。原 passing 用例零回归、原名称零遗漏。153 个失败按直接 listen EPERM、下游断言和父聚合逐项保留，不能称 socket HTTP 通过。六个含 daemon 的测试组按源码排除；端口/ps 权限失败保持原始输出。父基线的 6 个 R9c 旧冲突已按续做裁定迁移，精确身份、slot、owner、拒绝码和一次控制断言保留；其中 controlRequestId 参数回归另修产品。六个 daemon 组继续排除，未以 fixture 冒充 daemon 验收。没有运行真实 T3/provider、live Mission、timer、安装、canonical、merge/push/deploy；本候选不能据此宣布真实重启恢复或安装验收。


## P1 与 P2 的运行时合同

普通 HUD runtime-control Pause 先以短事务保存 `status=paused`、`pausedAt`、`pauseEpoch` 和 `mission_pause_requested` 日志。此时 `activeWorker`、对应 session 和 feature 保留原运行状态。`pauseControl` 保存当前控制的 phase、code、at、runId 和 epoch。外部控制在解锁后执行，每个控制已有耐久 effect claim。

所有支持的 response、delegation 及其嵌套容器中的明确拒绝都优先。HTTP 返回 409 和原拒绝码，gate 保留，运行三投影与模型槽不变，并记录一次 `pause_control_rejected`。抛错返回 500 并记 unknown。重试读取原事实，不再次调用控制。无明确肯定证据也不能谎报 paused。新 Resume 正在执行时，新的 Pause 必须推进 gate；effect 的 `resume:`、`resume-hook:`、`runtime-resume:` 以及 journal 的 `controlOperation=resume` 保存这条区分。

只有控制确认后，新事务才把 worker、session 和 feature 记为 paused，并依序追加 `mission_paused` 与完整的 `worker_paused` 日志。`FEATURE_STATUSES` 明确支持 paused；绑定、恢复和确认后的投影合并也支持该状态。controller 看到拒绝或未知 Pause 事实返回 wait_user；HUD 已确认的控制不再由 controller 重复执行。原 Autopilot owner 控制工作流保留，它不在 HUD 内调用 provider。

Resume 先执行外部控制，确认后才提交运行 gate 和投影。抛错仍为 500，拒绝或未确认仍为 409，原 paused gate 与四文件不变。仅 pending 且没有 task/thread/childRun 或本地 worker 身份的 run，HUD Resume 直接解除 gate 并返回 200，保留 resumePending/dispatchPending 与原 run/attempt，交回 Orchestrator 继续派发，不调用外部控制。P2 的先控制、确认后提交只约束已绑定 child 的运行。自定义 resumeWorker 的 worker 参数保持原合同，controlRequestId 放在 options，默认 HUD adapter 在进入 CLI 协议时再携带它。

Late Pause 保留 R9c/V11 的 owner 字段、原 pausedAt、真实 accepted 身份和实际 slot。补偿 Pause 对原 child 恰好一次。负面或未确认的 Resume 不先借用旧身份变成 accepted，也不触发补偿控制。

## WAL 断言迁移与未覆盖项

一个新的 Approve 必须在调用 transport 前提交原 run、选择和 intent。之后的明确拒绝或冲突收据不能把这些事实逆向回滚。并发第二次 Approve 在发现 inflight 时直接拒绝，不再制造一个多余 revision 破坏第一请求。冲突收据保留原文与 fence，三投影不附加外来身份。

accepted journal 的物化 rename 出错时，返回原始 EIO；原文收据和已经提交的 WAL 保留。fresh 官方读取恢复整个 accepted 批次，重开 HUD 只绑定原任务，不再次派发。新协议不再制造旧 accepted 临时文件；遗留临时文件仍按原意图严格核对，作为取证材料保留。5 项原字节与临时文件断言的逐条迁移见 `out/author-notes.md`。

最终故障矩阵对 58 个 Update 边界、90 个 accepted receipt 边界和 96 个 End/consumed 边界，分别注入 EIO、ENOSPC、SIGKILL，共 732 项。最终运行的全部源码 hash 前后不变。另有 4 个 Pause 控制阶段的独立进程 SIGKILL 恢复检查，均禁止重复控制。它们证明本机进程崩溃和软件注入下的文件合同，不证明真实断电、Node 20、Linux、网络文件系统或真实 provider 行为。

早期原始测试的一个临时目录前缀硬编码在 /private/tmp，未遵守本轮 TMPDIR。这项边界偏差保留在操作修正和 author-notes。最终测试专用 preload 将它改到本 worktree，逐次记录实际路径。force/30 秒的中间输出曾漏报名称；最终自然退出、120 秒默认超时，并检查完整名称集合和未完成 TAP 标题。不能把被漏报的用例当作通过。

## A1 的钩子与生命周期修复

已绑定运行的重复 HUD Approve 仍调用 onCommand，HUD 自身不写入、不递增纪元。所有 HUD 生命周期钩子抛错优先返回 500，保留 owner 已提交的字节；钩子正常返回而 owner 改变运行时返回 409。Pause gate 已提交后的未知控制事实继续保留，不能撤回用户的 Pause。

HUD listen 异步失败或同步抛错时均关闭已创建的文件 watcher 和轮询计时器。LocalWorkerDaemon 的退出判定不再依赖 activeWorker 是否为空；原 run 的 completed/failed session 即代表其生命周期结束。marker 初次登记使用排他创建，后续更新只写已验证的现有 inode，不以 rename 重建已删除的 marker；替换 owner 的 marker 不被更新或删除。短命 transport 父进程退出仍不终止一个有效 durable run。A1 只以无端口 helper 验证这些路径，没有启动 LocalWorkerDaemon，父线程观察到的整套间歇挂起尚未确证根因。
