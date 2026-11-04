import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function canonicalPath(value) {
  if (typeof value !== "string" || !value) return null;
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function readReport(file) {
  try {
    if (fs.statSync(file).size > 2 * 1024 * 1024) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function reportTime({ file, report }) {
  const created = Date.parse(report.createdAt);
  if (Number.isFinite(created)) return created;
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

function reportFiles(directory, depth = 0) {
  try {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory() && depth < 1) return reportFiles(file, depth + 1);
      return entry.isFile() && entry.name.endsWith(".json") ? [file] : [];
    });
  } catch {
    return [];
  }
}

function isEvaluatedReport(report, score, level) {
  return (
    report?.evaluated !== false &&
    typeof score === "number" &&
    Number.isFinite(score) &&
    score >= 0 &&
    score <= 100 &&
    Number.isInteger(level) &&
    level >= 1 &&
    level <= 5
  );
}

export function normalizeAgentReadiness(report, reportPath = null) {
  const score = report?.summary?.overallProgress?.percentComplete ?? report?.score;
  const level = report?.summary?.achievedLevel ?? report?.level;
  const evaluated = isEvaluatedReport(report, score, level);
  const recommendation =
    !evaluated || level < 3 || score < 60
      ? "Run /agent-readiness to assess repository autonomy and verification gaps."
      : null;
  return {
    evaluated,
    level: evaluated ? level : null,
    score: evaluated ? score : null,
    summary: evaluated
      ? `Stored evaluation: Level ${level} · ${score.toFixed(1)}%.`
      : "No stored Agent Readiness evaluation for this repository.",
    reportPath: evaluated ? reportPath : null,
    recommendation,
  };
}

/** Read reports only. Opening the HUD never runs an assessment or changes the repository. */
export function inspectRepoAgentReadiness(
  repoPath,
  {
    stateDir = process.env.T3_MISSION_READINESS_STATE_DIR ||
      path.join(os.homedir(), ".local", "state", "agent-readiness"),
    missionDir = path.join(repoPath, ".mission"),
    embedded = null,
  } = {},
) {
  const target = canonicalPath(repoPath);
  const reports = reportFiles(stateDir)
    .map((file) => ({ file, report: readReport(file) }))
    .filter(({ report }) => canonicalPath(report?.repository?.root ?? report?.repoPath) === target)
    .sort((a, b) => reportTime(b) - reportTime(a));
  for (const { file, report } of reports) {
    const result = normalizeAgentReadiness(report, file);
    if (result.evaluated) return result;
  }
  const localFile = path.join(missionDir, "readiness.json");
  const local = readReport(localFile);
  const localRoot = local?.repository?.root ?? local?.repoPath;
  if (local && (!localRoot || canonicalPath(localRoot) === target)) {
    const result = normalizeAgentReadiness(local, localFile);
    if (result.evaluated) return result;
  }
  return normalizeAgentReadiness(embedded);
}
