# Mission Mode Autopilot WP1

WP1 把计划批准后的生命周期决策交给 `missionTick(missionDir, {observations})`。原 owner 只执行返回的动作，再提交原始返回。内核不调用 T3、不执行 Git、不依赖 HUD。本文描述本候选的协议和证据边界。

## 接口与动作表

JavaScript 接口从 `t3-mission/kernel/index.mjs` 导出，MCP 和 CLI 都叫 `MissionTick`。返回格式为 `{action:{type,...},missionId,revision}`。每次恰好一个动作。CLI 使用现有 `--mission-dir` 和 `--json` 参数。内核内部可先消费结果、End、注入验收，再返回下一项 dispatch。

| type                    | 条件                                                                                                                  | owner 执行                                                                                                          |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `wait_user`             | 计划未批准、Pause、awaiting_input、需人决定的 handoff、声明权限、子任务审批或问题、合并审批、重试次数耗尽、身份歧义。 | 保留 gate 和状态，向用户说明，结束本轮。                                                                            |
| `dispatch`              | 选中 pending feature，且所有当前 gate 均通过；intent 已落盘并标为 inflight。                                          | 原样调用 `delegate_task(action.delegateTask)`，把原始返回交回。                                                     |
| `recover_dispatch`      | 活跃 intent 已存在但没有可绑定的接受收据。                                                                            | 只读列出原 owner 的 child tasks 或 threads，原样交回。不得再次派发。                                                |
| `poll`                  | 已绑定 taskId，尚无可消费的结果。                                                                                     | 调原 owner 的 `task_status`，原样交回。                                                                             |
| `orchestrator_decision` | handoff 需要修复或理由销项、验收失败、结果无法解析、状态不一致、需要集成。                                            | 按 kind 处理。通常使用 UpdateMissionFeatures 或 DismissHandoffItems；integrate 执行已授权的本地 ff 合并并提交 SHA。 |
| `sleep`                 | 本轮已收到 working、waiting_for_children 或仍有 pending child runs 的状态。                                           | 结束当前 turn，等待通知或定时唤醒。                                                                                 |
| `done`                  | 严格完成谓词成立。                                                                                                    | 返回 completed 或 awaiting_merge，禁用本 Mission 的兜底 timer。                                                     |

`record_dispatch` 不作为动作。controller 直接校验观测，保存 journal，并走 R8 Bind。动作没有允许 owner 自由调用 Start、Bind 或 End 的分支。

## 文件与职责

- `kernel/controller.mjs` 读取当前 gate，消费观测，决定唯一动作，组合 R8 的生命周期函数。
- `kernel/autopilot-store.mjs` 保存内容寻址的原始观测、接收顺序和 controller ledger。相同 JSON 不写文件。
- `kernel/mission-result.mjs` 严格解析版本化结果信封，保留完整原文。
- `kernel/mission-brief.mjs` 用 feature、assertions、模型槽、repoPath 和 run identity 生成三种任务 brief。
- `kernel/autopilot-commands.mjs` 为显式 autopilot:true 计划处理 HUD 的 approve、逻辑 pause 和 resume。HUD 三个早期入口不选 worker、不调用 runtime adapter。
- `kernel/dispatch-journal.mjs` 仅新增 claim、只读检查和外置收据观测三个入口。现有 transport 与 Bind 路径保持原语义。
- `kernel/schema.mjs` 让计划保存 autopilot、integration、permissions、ownerThreadId，并承认 awaiting_merge 状态。旧计划不自动启用新 HUD 行为。
- MCP 工具表新增 MissionTick；CLI 复用工具别名与 JSON 调用机制。
- 两份 SKILL 的 Step 4 和 Workflow B 描述 owner 执行器、兜底 timer、恢复与手工降级。

## 观测协议

每个输入都有 `type`、`featureId`、`runId`、`response`。response 是未经改写的工具返回，可为普通 JSON、MCP structuredContent 或单个 JSON text block。原始 MCP 外壳也保存。输入不得是模型概述。

| type          | 额外关联字段                   | response                                                                                                                             |
| ------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `dispatch`    | `intentId`                     | delegate_task 原始返回。                                                                                                             |
| `children`    | `intentId`                     | 原 owner 的原始 tasks 数组、`{tasks:[...]}` 或 `{threads:[...]}`。每个候选必须暴露 clientRequestId 和可绑定身份。                    |
| `task_status` | `taskId`                       | 原始 task_status；需要明确 taskId、status、workState、hasPendingChildRuns，且不得冲突于已绑定的 child identity 和 target。           |
| `integration` | 无。featureId/runId 已在外层。 | `{branch,sourceBranch,commit,mergeSha}`。手工审批后另含 `approved:true`。这是 owner 对实际 Git 结果的记录，不是内核执行 Git 的凭证。 |

归档路径为 `.mission/autopilot/observations/<SHA256>.json`，记录原观测和单 owner 下的接收 sequence。ledger 位于 `.mission/autopilot/controller.json`，记录每个 run 的派发异常、最后状态、终态观测、解析结果、集成记录和消费标记。读取归档时核对内容 hash。原始 delegate 收据由 R8 journal 保存其标准化身份，原始返回仍在归档中。

sequence 表示本 owner 接收顺序，不是 T3 服务端事件序号。完成通知仅作唤醒。owner 必须调用 task_status 取得新快照，再作为观测提交。旧 run 的观测只归档，不影响当前 run。已解析的终态不因迟到的 working 状态退回；明确 pending child runs 会阻止 End，随后新查询的无 pending 终态可解除等待。

## 状态迁移

1. 审批前、Pause 和用户输入 gate 直接返回 wait_user，不选任务。
   新计划用 autopilot:true 声明控制器负责执行；HUD 批准只写审批，不走旧的选任务或 transport 路径。HUD 暂停和恢复只操作 controller gate，保留 run 身份；不会挂起或重新唤醒 provider。未声明 autopilot 的旧计划保持旧 HUD 行为。
2. 使用 R8 `dispatchFeatureToWorker` 创建一个 run，使用 `prepareDispatch` 保存 intent。intent 含 Mission、feature、run、attempt、target、worker number 和稳定 clientRequestId。key 使用 R8 对 mission/feature/attempt/run/target 的确定性 hash。运行身份只保存在 `.mission`。
3. 返回 dispatch 前，R8 journal 从 prepared 改为 inflight。后续 tick 看到该 run 时只恢复，绝不重新调用派发。selection 的 await 前保存 intent，await 后重新读取 Pause/Reject gate，较新的用户 gate 阻止外部动作。
4. 原始收据先归档，再校验并写 accepted journal。即使 plan 已被 Reject，也保留这个证据。只在当前计划已批准、active run 及三个投影匹配时调用 R8 Bind。Pause 可以保存身份，不会恢复 running。
5. 接受未知、拒绝、缺 ID、target 冲突或多个匹配均不重派。冲突不绑定。首次歧义保持 inflight；已有权威 accepted receipt 时保留原身份并拒绝替换。
6. 只有 T3 `status` 属于 completed、failed、cancelled、interrupted，`workState=result_available`，且 `hasPendingChildRuns=false`、没有额外 pending child runs 时，才解析其稳定 `summary`。单个 turn completed 不足以 End。
7. 结果解析失败返回 result_unparseable。原结果和 active run 保留。不得自动把自由文本、截断或缺字段当成功。WP1 不提供模型修改原始摘要的通道；需要 authentic 完整结果，或经用户选择手工降级。
8. 成功的 implementation/repair 先满足集成策略。auto=true 返回 integrate；未声明或 auto=false 返回 merge gate。controller 验证回传的 run、source branch、source commit 和目标 branch，并要求 merge SHA 等于 source SHA，再把 merge SHA 记入 feature。
9. 调 R8 endFeatureRun，并始终设置 returnToOrchestrator=true，防止旧完成谓词提前写 completed。保留 summary、tests、commit、branch、discoveredIssues、left-undone 和观测 ID。只有 validator 的 assertionResults 可以写验收 stage。
10. 无问题的 worker failure 可按既有 maxAttempts 进入新的 attempt/run/key。验收失败和 partial 返回模型决策。修复安排、重新排验与理由销项使用现有工具；重新排验时模型需显式重置失败 validator 的 lastHandoff，旧失败不会自行消失。
11. 复用 `checkMilestoneCompletionAndInjectValidation` 插入 scrutiny 和 user-testing。End 后在同一次 tick 继续选择下一项。已触发的 milestone 不会仅因空 tick 再次保存状态。

## 结果信封

最终回复恰好一个完整的 fenced JSON，语言标签为 `mission-result`，version 为 1。必需字段为 featureId、runId、status、summary、commit、branch、tests、discoveredIssues、whatWasLeftUndone。validator 另需 assertionResults 覆盖其 milestone 的全部 assertions。

status 只能是 success、failure、partial。summary 至少 50 字符。tests 每项有 command 和 passed、failed 或 not_run 状态；成功不能含失败或未运行项。成功需要格式有效的 SHA 和非空 branch；失败允许两者为 null。T3 status 不是 completed 时，不能把 envelope success 当成功。

discoveredIssues 和 left-undone 进入既有 handoff attention 协议。worker 自报 assertionResults 不代替独立 validator。解析器不证明提交存在、不验证测试是否真跑，也不绑定最终 SHA 的验收有效期。

## 幂等与恢复

派发前的 durable intent 是唯一任务身份。claim 先写 inflight，再把动作交给 owner。若进程在动作返回前、delegate 接受后或收据提交前退出，下一次只返回 recover_dispatch。零匹配或不唯一时 wait_user，不能因跨 MCP session 的 key 去重语义不确定而重派。真实列表若不暴露 clientRequestId，WP1 无法自动恢复这一段。

观测先 fsync 原文，再保存 ledger。进程在两者之间退出时，下一 tick 从归档重放。相同输入不创建第二归档；相同 receipt 不再次 Bind；已经 End 的 run 以 session.endedAt 和 handoff.runId 识别，结果不会再次 End。ledger consumed 标记写失败时，session 的已结束事实仍能避免第二次 End。

新 controller 文件使用原子 rename、文件和所在目录 fsync；R8 journal 保留自身耐久性。它们不是完整生命周期事务。R8 state/features/log 仍可能在多文件提交中部分更新。测试中的两个 EIO 注入证明归档后和 End 后的指定边界可恢复，不证明任意写边界或真实掉电安全。

无新观测且状态无变化时，不刷新 lastTick 或时间戳。重复终态 tick 不写 ledger、journal、state、features 或日志。无端口测试比较全部 `.mission` 文件内容和 mtime。

## 完成条件与权限

完成需要同时满足：无 activeWorker；无 unknown 或未消费 intent/result；必需 feature 全部 completed；可选 feature 才能 cancelled；没有 handoff attention；每个 milestone 的 scrutiny 和 user-testing 都完成且 validatorsPassed=true；每个 assertion 的两个 stage 都 passed；所有 implementation/repair 都保存本 run 的 integration.mergeSha；声明权限已获批准。

auto=true 的计划在上述条件成立后写 completed。手工集成策略在 feature 集成及验收齐全后写 awaiting_merge，表示最终用户合并仍保留在用户手上。WP1 不执行最终主干合并，也不替用户批准 push 或 deploy。

只有原 owner 调 T3。计时器由 SKILL 要求 owner 创建并保存，通过完成通知走快速路径、同线程 schedule_task 走补查路径。done 时 owner 禁用该 timer。kernel 本身不创建或禁用 scheduler，不读取其他线程，不发送消息。默认 HUD 仅供观察，关闭 HUD 不影响该协议。

## 验证与未覆盖项

`t3-mission/test/autopilot.test.mjs` 使用 Node 内置模块和假的 T3 执行器，无端口、网络、真实 provider、Git 合并或 live daemon。玩具正常路径包含 3 个 feature 和 2 个独立 validator；除计划批准外不注入用户回答。integrate 由假 owner 提交模拟 SHA，不能当真实合并证据。

故障矩阵覆盖 intent 后收据前中断、零或多条恢复匹配、第二任务身份冲突、target 冲突、重复和乱序状态、nested child、首次 worker failure、Pause/Reject 交错、缺失和截断信封、原始收据归档后 ledger EIO、End 后消费标记 EIO、跨进程 CLI 与 `.mission` 迁移恢复。基线与开发后的原始输出、失败原文和统计由交付目录保存。

- G06：没有跨进程单 writer、生命周期锁或 WAL 事务。HUD、CLI 与其他 writer 并发仍需后续工作。本 WP 的 await gate 检查不能代替事务。
- G07：没有 Retry-After、限流退避、预算持久化或自动换通道。worker 明确失败只有既有次数限制；未知派发和 API 错误安全停住。
- G09：没有 tested SHA、contract revision、validation epoch 或 repair 后 stage 失效。解析器只检查身份、字段和 assertion 完整性，旧 stage 的版本归属仍需后续 WP。
- G13：没有为既有多文件 state/features/log 提供任意崩溃边界或掉电保证。
- 真实 T3：没有验证 clientRequestId 列表查询能力、owner busy/idle 投递、MCP session 更换、schedule 重启恢复、T3/机器重启、真实 provider 接受后失联恢复。缺原任务查询键时会停在 recovery gate。
- HUD：用内存 HTTP transport 测了真实路由的 approve/pause/resume，无 socket 和 provider 调用；这不是浏览器或原生 HUD 验收。Autopilot Pause 只阻止 controller 推进，不挂起已经运行的 provider child。
- 输入语义：观测是可信 owner 从 T3 原样带回的证据，integration 是 owner 对 Git 的记录；WP1 没有独立执行 Git 验证或审批来源证明。
- 老 Mission：存在 active run 但没有 Autopilot intent 时，不猜测派发情况，等待人工对账。不会从旧手工收据自动迁移全历史。
- 接口：大型原始观测经 CLI --json 受系统 argv 长度限制，较大结果应走 MCP。归档目前全量读取，未做大 Mission 的体量优化。

## 异议

没有反证要求推翻“确定性控制器 + owner 执行器”的既定架构。它能把生命周期决定从 owner 自由操作收进协议，但 schedule、权限归属、真实恢复查询仍依赖原 owner 和 T3 应用。WP1 不能独立证明长期无人值守运行，也不能在 T3 退出或机器关机时继续执行。

## 后续 WP

先为每 Mission 建立单 writer 和可重放提交事务，再接原 owner 的持久事件、按 clientRequestId 的真实恢复查询和 app bootstrap。随后补持久退避和预算、SHA 绑定的验收与 repair 循环。最后在隔离的真实 T3/provider 玩具 Mission 上验证调度、接收后断连、关闭视图、重启和机器休眠；不要用本 fixture 的通过率替代这些验收。
