---
name: agent-readiness
description: Evaluate a Git repository against the versioned 84-criterion readiness rubric, produce an evidence-based local report, and route authorized remediation to readiness-fix. Use for /agent-readiness or requests to assess or make a repository agent-ready.
---

# Agent Readiness

总入口。原版 0.240.0 的原生命令是 `/readiness-report` 和 `/readiness-fix`；`/agent-readiness` 只是本项目的便携别名。

## 定位 CLI

从**本 SKILL.md 所在目录**找：存在 `_runtime/scripts/readiness.py` 就用它，否则用 `../../scripts/readiness.py`。解析为绝对路径 `READINESS_CLI`，不要相对当前工作目录寻找。目标 Git 根目录记为 `READINESS_TARGET`；任务目录（`--output`）和报告目录（`--state-dir`）必须在目标之外。

## 路由

- 评估、评分、出报告：读 `../readiness-report/SKILL.md`。
- 修复、补齐缺口、让仓库 agent-ready：读 `../readiness-fix/SKILL.md`。
- 未指定等级只报告实测等级；“修到 Level 4”才是目标策略。

`prepare` 生成的 `assessment.md` 是 84 条规则和全部填写契约的唯一依据，不要凭记忆或其他文档替代。

## 忠实性

- 规则、计分、命令流程固定参照原版 0.240.0；等级边界 20/40/60/80%，没有 Level 6。
- 本地实现与原版的差异（本地存储、两条规则的条件证据、unit_tests_runnable 本地检查、当前工作树、自动补分母等）列在仓库的 `docs/fidelity.md`。
- 报告只存本地 JSON/Markdown，不上传，不伪造云端报告 URL。只有实际改动、验证并重评后，才能说“已修复”。
