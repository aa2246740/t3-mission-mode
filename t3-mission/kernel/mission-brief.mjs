import { inferFeatureKind, isValidatorFeature } from "./schema.mjs";

export function buildDelegateTask(state, feature, intent) {
  const kind = inferFeatureKind(feature), validator = isValidatorFeature(feature);
  const milestone = state.milestones.find(item => item.id === feature.milestoneId);
  const ordinal = milestone?.ordinal ?? state.milestones.indexOf(milestone) + 1;
  const role = kind === "scrutiny" ? "review" : kind === "user_testing" ? "test" : kind === "explorer" ? "research" : "implementation";
  const diskGate = (state.permissions || []).some(permission => permission.id === "worker-worktree-disk-gate" && permission.status === "approved");
  const label = validator ? "Validator" : kind === "explorer" ? "Explorer" : "Worker";
  const assertions = (state.assertions || []).filter(item => item.milestoneId === feature.milestoneId);
  const example = {
    version: 1, featureId: feature.id, runId: intent.runId, status: "success",
    summary: "Describe the implemented behavior and actual verification in at least 50 characters.",
    commit: "<actual commit SHA>", branch: "<actual feature branch>",
    tests: [{ command: "<actual command>", status: "passed" }], discoveredIssues: [], whatWasLeftUndone: [],
    ...(validator ? { testedSha: milestone?.mergeSha ?? "<current milestone integration SHA>", failedAssertions: [], assertionResults: Object.fromEntries(assertions.map(item => [item.id, "passed"])) } : {}),
  };
  return {
    title: intent.recovery?.title ?? `[M${ordinal}] ${label} #${intent.worker.workerNumber}: ${feature.title}`,
    role, isolation: "worktree", target: intent.target, clientRequestId: intent.clientRequestId, mode: "async",
    task: [
      `Mission ${state.missionId}; feature ${feature.id}; run ${intent.runId}; attempt ${intent.attempt}.`,
      `Read-only integration reference (main checkout): ${state.repoPath}. Integration policy: ${JSON.stringify(state.integration ?? null)}.`,
      ...(diskGate ? ["Before doing the task, resolve the physical path of your current worktree and the integration reference, then verify their filesystem device IDs match. If either path cannot be checked or the devices differ, do not write or commit; report a partial result."] : []),
      validator ? "This validator is read-only. Do not write to any directory, including your worktree, the main checkout, temporary files, or Git metadata. Never use shell output redirection (>, >>, tee) or create files in /tmp, /private/tmp, or $TMPDIR; capture command output directly via stdout/stderr or pipes. On macOS, when /usr/bin/sandbox-exec is available, wrap verification commands in /usr/bin/sandbox-exec -p '(version 1)(allow default)(deny file-write*)(allow file-write* (literal \"/dev/null\") (literal \"/dev/dtracehelper\"))' so the kernel blocks all filesystem writes. Use checks that do not write files; report checks that require writes as unrun." : "Modify and commit only inside the worktree T3 created for you, which is your current working directory. The main checkout path above is a read-only integration reference. Never write to the main checkout, /tmp, /private/tmp, or any other directory.",
      ...(!validator ? ["If this worktree acquires a commit or branch rename that you did not execute, compare its content with your intended changes before assuming another executor completed the task. Continue on top of those changes. Report the actual branch, HEAD and these commits in your result, and state that you did not execute them. Do not reset, rebase or delete them."] : []),
      `Task: ${feature.title}\n${feature.description}`,
      `Feature contract: ${JSON.stringify(feature)}`,
      `Milestone assertions: ${JSON.stringify(assertions)}`,
      ...(validator ? [`Test the exact integration SHA ${milestone?.mergeSha}. Return testedSha and failedAssertions. A different SHA cannot pass acceptance.`] : []),
      ...(validator ? ['assertionResults values must be exactly "passed" or "failed". Judge each assertion using evidence independently available in this validation stage. Do not depend on another stage\'s receipts. The controller guarantees completion across stages.'] : ["You are explicitly authorized to perform local git add and git commit in your own worktree. If sandbox protection of .git metadata blocks either operation, you can and should request require_escalated through the normal approval flow for that specific local Git operation. Request no other escalation. Do not directly modify Git metadata or sandbox configuration. If approval is denied, preserve the exact refusal and return partial."]),
      validator ? (kind === "scrutiny" ? "Independently review code, boundaries and coverage. Record each assertion result." : "Exercise the real user path and verify every assertion. Report failures and unrun checks explicitly.") : "Implement only this feature, run relevant checks, and commit in your own feature branch. Obtain commit and branch for mission-result directly from git rev-parse HEAD and git branch --show-current in your worktree; never infer the branch name from the worktree directory path.",
      "Do not merge, push, deploy, approve permissions, or change Mission state. Honor repository instructions and declared user gates. Report discovered issues and unfinished work.",
      "End your final reply with exactly one complete mission-result JSON fence. Replace example values with observed results. Use failure or partial when work or verification did not succeed. Failure may use null commit and branch. Do not claim success from a build alone.",
      "```mission-result\n" + JSON.stringify(example, null, 2) + "\n```",
    ].join("\n\n"),
  };
}
