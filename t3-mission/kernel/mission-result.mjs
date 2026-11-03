import { MissionKernelError, isValidatorFeature } from "./schema.mjs";

const fail = (message) => {
  throw new MissionKernelError("INVALID_MISSION_RESULT", message);
};
export const isSha = (value) => typeof value === "string" && /^[a-f0-9]{7,64}$/i.test(value);

/** Parse the task summary chosen by the controller, including an acknowledged resumed turn. */
export function parseMissionResult(raw, { feature, runId, assertions = [] }) {
  if (typeof raw !== "string") fail("Task summary is missing");
  if ([...raw.matchAll(/^```mission-result[ \t]*\r?$/gm)].length !== 1)
    fail("Exactly one mission-result opening fence is required");
  const fences = [...raw.matchAll(/^```mission-result[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/gm)];
  if (fences.length !== 1) fail("Exactly one complete mission-result fence is required");
  let value;
  try {
    value = JSON.parse(fences[0][1]);
  } catch {
    fail("mission-result JSON is truncated or invalid");
  }
  if (!value || value.version !== 1 || value.featureId !== feature.id || value.runId !== runId)
    fail("Result version or feature/run identity does not match");
  if (!["success", "failure", "partial"].includes(value.status))
    fail("Explicit success, failure, or partial status is required");
  if (typeof value.summary !== "string" || value.summary.trim().length < 50)
    fail("Summary must contain at least 50 characters");
  if (
    !Array.isArray(value.tests) ||
    !value.tests.every(
      (test) =>
        test &&
        typeof test.command === "string" &&
        test.command.trim() &&
        ["passed", "failed", "not_run"].includes(test.status),
    )
  )
    fail("tests must contain command and status records");
  if (
    !Array.isArray(value.discoveredIssues) ||
    !value.discoveredIssues.every(
      (issue) =>
        (typeof issue === "string" && issue.trim()) ||
        (issue &&
          typeof issue === "object" &&
          typeof issue.summary === "string" &&
          issue.summary.trim()),
    )
  )
    fail("discoveredIssues must be an array of issues");
  if (!(
    typeof value.whatWasLeftUndone === "string" ||
    (Array.isArray(value.whatWasLeftUndone) &&
      value.whatWasLeftUndone.every((item) => typeof item === "string"))
  ))
    fail("whatWasLeftUndone must be a string or a string array");
  if (!Object.hasOwn(value, "commit") || !Object.hasOwn(value, "branch"))
    fail("commit and branch fields are required, including on failure");
  if (
    !(value.commit === null || isSha(value.commit)) ||
    !(value.branch === null || (typeof value.branch === "string" && value.branch.trim()))
  )
    fail("commit must be a SHA or null; branch must be a name or null");
  if (
    value.status === "success" &&
    (!isSha(value.commit) || typeof value.branch !== "string" || !value.branch.trim())
  )
    fail("Success requires a commit SHA and branch");
  const invalidSuccessTests =
    value.status === "success" &&
    (isValidatorFeature(feature)
      ? value.tests.some((test) => test.status === "failed") ||
        !value.tests.some((test) => test.status === "passed")
      : value.tests.some((test) => test.status !== "passed"));
  if (invalidSuccessTests) fail("Success cannot contain failed or unrun tests");
  if (isValidatorFeature(feature)) {
    if (!isSha(value.testedSha)) fail("Validator testedSha is required");
    if (
      !Array.isArray(value.failedAssertions) ||
      !value.failedAssertions.every((id) => typeof id === "string")
    )
      fail("Validator failedAssertions must list assertion IDs");
    if (
      !value.assertionResults ||
      typeof value.assertionResults !== "object" ||
      Array.isArray(value.assertionResults)
    )
      fail("Validator assertionResults are required");
    const invalid = Object.entries(value.assertionResults).find(
      ([, result]) => !["passed", "failed"].includes(result),
    );
    if (invalid)
      fail(
        `Invalid assertion result ${invalid[0]}: ${JSON.stringify(invalid[1])}; expected passed or failed`,
      );
    for (const assertion of assertions.filter((a) => a.milestoneId === feature.milestoneId)) {
      if (!["passed", "failed"].includes(value.assertionResults[assertion.id]))
        fail(`Missing assertion result ${assertion.id}`);
      if (value.status === "success" && value.assertionResults[assertion.id] !== "passed")
        fail("Validator success contains a failed assertion");
    }
    const failed = assertions
      .filter(
        (a) => a.milestoneId === feature.milestoneId && value.assertionResults[a.id] === "failed",
      )
      .map((a) => a.id)
      .sort();
    if (JSON.stringify([...value.failedAssertions].sort()) !== JSON.stringify(failed))
      fail("failedAssertions must exactly match failed milestone assertionResults");
  }
  return { raw, envelope: value };
}
