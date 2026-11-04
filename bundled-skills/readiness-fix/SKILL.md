---
name: readiness-fix
description: Make substantive, verified repository improvements from a readiness report, or follow the native no-report choice before fixing selected signals. Use for /readiness-fix or a readiness target.
---

# Readiness Fix

依据证据修复真实缺口。任务清单只是准备步骤，计划、空文件或关闭检查都不算修复。

## 1. 生成任务

按 `../agent-readiness/SKILL.md` 定位 `READINESS_CLI`，确定 `READINESS_TARGET` 和目标之外的 `READINESS_STATE`。先读目标的 agent 指令和当前改动，继承用户已有的选择与授权，不重复询问。按范围择一运行（以 `--help` 为准）：

```sh
python3 "$READINESS_CLI" fix "$READINESS_TARGET" --state-dir "$READINESS_STATE"
python3 "$READINESS_CLI" fix "$READINESS_TARGET" --state-dir "$READINESS_STATE" --signals lint_config,type_check
python3 "$READINESS_CLI" fix "$READINESS_TARGET" --state-dir "$READINESS_STATE" --instructions "Fix linting and type checking; leave CI unchanged"
python3 "$READINESS_CLI" fix "$READINESS_TARGET" --state-dir "$READINESS_STATE" --all
python3 "$READINESS_CLI" fix "$READINESS_TARGET" --state-dir "$READINESS_STATE" --target-level 4
```

- 有报告：先重新核对失败项。无参数时先选**有失败项**的 category，再用一个问题单选一个 signal（选项含名称与当前分子/分母，最多 10 个）。已通过的请求要说明并跳过；跳过项不是失败，先复核其适用条件。`--signals` 只接受准确 ID，自然语言放进 `--instructions`。
- 无报告：任务给出“先生成完整报告再修复”与“跳过报告直接修复所选信号”两条原生分支；完整评估指令通过 `prepare` 生成的 `assessment.md` 读取。`--all`、`--target-level` 必须先建立完整基线。
- 脚本只输出任务 Markdown，不改仓库；修改由你完成。

## 2. 实施并验证

1. 先看失败证据、代码、既有约定和应用边界，找根因。共享库不因被 workspace 列出就变成服务，也不要给 CLI 硬塞无用途的设施。
2. 做能改善真实工作流的改动，保留用户修改；用项目现有工具，保证命令与配置能实际运行。
3. 运行相关验证（linter、有意义断言的测试、CI 配置检查）。修复阶段可以跑必要的真实测试，审计阶段的 `unit_tests_runnable` 命令限制不适用于此。
4. 外部治理类事项（分支保护、组织权限、真实事故演练、历史数据）无法靠提交文件完成时，记录所需权限或观察周期，继续做不受阻的工作。

禁止：空测试或无意义断言、占位文档、关闭 lint/type/security 规则、`@ts-nocheck`、伪造 CI 记录；把失败项改成未经 rubric 允许的 `null`、删应用或改小分母；把只在 README 里描述的外部设置当作已生效。

## 3. 复评

每批改动验证后，用**新的**目标外任务目录 `prepare`，按新 `assessment.md` 完整评估全部 84 项，再 `report`：

```sh
python3 "$READINESS_CLI" prepare "$READINESS_TARGET" --output "$READINESS_WORK_NEXT" --state-dir "$READINESS_STATE"
python3 "$READINESS_CLI" report "$READINESS_TARGET" --input "$READINESS_WORK_NEXT/evaluation.json" --state-dir "$READINESS_STATE"
```

prepare 之后目标又改动，旧任务目录即作废，换新目录重新 prepare。不要只把旧报告的分子改成 1；任务里旧证据只是摘要，须重新核对，重评契约以新 `prepare` 的 assessment.md 为准。`--target-level` 以新报告的计算结果为准，`--all` 完成全部适用失败项或逐项记录阻碍；无新证据或进展时停止，不要把“无法保证”写成成功。

最终汇报：实际变更、已运行验证、修复前后分数与等级、报告路径、未完成项及原因。区分“生成任务”“已修改”“验证通过”“复评通过”，只有最后一步证明 readiness 改善。差异清单见仓库 `docs/fidelity.md`。
