---
name: readiness-report
description: Perform a read-only Git repository assessment using the versioned 84-criterion readiness rubric and persist a complete, evidence-backed local JSON and Markdown report. Use for /readiness-report or agent-readiness audits.
---

# Readiness Report

对目标做一次有证据的只读审计，复现固定版本的 rubric、应用计数和评分。

## 步骤

1. 按 `../agent-readiness/SKILL.md` 定位 `READINESS_CLI`，确定 `READINESS_TARGET`、目标之外的新任务目录 `READINESS_WORK` 和报告目录 `READINESS_STATE`。读目标的 agent 指令和现有改动；默认评估当前工作树，不切分支、不丢弃修改。
2. 准备任务：

```sh
python3 "$READINESS_CLI" prepare "$READINESS_TARGET" --output "$READINESS_WORK" --state-dir "$READINESS_STATE"
```

3. 通读生成的 `assessment.md`，它是唯一依据：Phase 1–5 给出扫描、应用发现、84 条规则和计分，末尾 “Local adapter” 一节给出 `evaluation.json` 字段、证据格式、cwd 规则、条件证据和 report 命令。
4. 完成 `evaluation.json` 后提交：

```sh
python3 "$READINESS_CLI" report "$READINESS_TARGET" --input "$READINESS_WORK/evaluation.json" --state-dir "$READINESS_STATE"
```

`report` 一次列出全部问题。逐条修正后重跑，直到存储成功；失败时不要宣称已有报告。成功时默认只打印摘要（等级、分数、通过/失败/跳过数、JSON 与 Markdown 路径），`--json` 输出 `{report, markdown, summary}` 回执，含证据的完整评估在 `receipt.report` 指向的文件中。
5. 存储成功后按 `# Level`、`# Applications`、`# Criteria`、`# Action Items` 汇报（有历史报告加 `# Changes Since Last Report`），链接实际生成的 JSON/Markdown，并说明跳过项和证据局限。

## 要点

- 先完成应用发现并输出 `APPLICATIONS_IDENTIFIED: N`，再评分；`.git`、依赖和生成目录不计入，递归列表少于 200 条。
- `null` 只用于标有 `[Skippable]`、且按其自身文字不适用的条目（跳过条件、PREREQUISITE 未通过、规则列出的 N/A），并在 rationale 说明是哪一种。`gh`/`glab` 类跳过条件在 CLI 已登录却无法访问本仓库（无 remote、仓库不存在、无读权限）时同样适用，并在 rationale 写明；不要把适用的失败或未评估项改成跳过。
- 应用级条目的分子是通过的应用数，分母是 N；没有“单个应用 N/A”。分母留 `null` 即由 `report` 补齐。
- 证据要真实：命令保留实际文本、退出码、相关输出和真正的执行目录（cwd 规则见 `assessment.md`）；不记录凭据或环境转储。
- 可选 `capture`：`python3 "$READINESS_CLI" capture --target "$READINESS_TARGET" --timeout 60 [--append-to "$READINESS_WORK/evaluation.json" --criterion <id>] -- <命令>` 在目标内运行命令（无需 `cd`），输出或追加带真实 cwd、退出码、裁剪输出的命令证据；校验不依赖它。
- 运行类证据用目标自己的入口；评估阶段不安装运行时、不跑完整测试，目标保持只读。
- 有历史报告时以旧应用集合为预期，逐项重新核对，只在证据变化时改分并解释。

## 与原生的差别

由当前 agent 执行审计，本地 CLI 负责模板、校验、计分和存储；原版的云端报告由本地文件替代。差异清单见仓库 `docs/fidelity.md`。
