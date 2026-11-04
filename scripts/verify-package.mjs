import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
const archive = process.argv[2];
if (!archive)
  throw new Error("Usage: node scripts/verify-package.mjs /absolute/path/to/package.tgz");
const absoluteArchive = path.resolve(archive);
const headers = [
  process.env.T3_NODE_HEADERS,
  path.resolve(path.dirname(process.execPath), "../include/node"),
  "/opt/homebrew/include/node",
  "/usr/local/include/node",
  "/usr/include/node",
]
  .filter(Boolean)
  .find((dir) => fs.existsSync(path.join(dir, "node_api.h")));
if (!headers)
  throw new Error(
    "Package verification requires existing local Node headers. Set T3_NODE_HEADERS.",
  );
const members = execFileSync("tar", ["-tzf", absoluteArchive], { encoding: "utf8" })
  .trim()
  .split("\n");
for (const member of members)
  assert.ok(
    member.startsWith("package/") && !member.split("/").includes(".."),
    `Unsafe archive member ${member}`,
  );
assert.equal(
  members.some((member) => /\.node(?:\.json)?$/.test(member)),
  false,
  "The distribution must not contain a machine-specific native binary.",
);
const readinessSkills = ["agent-readiness", "readiness-report", "readiness-fix"];
for (const name of readinessSkills) {
  for (const file of [
    "SKILL.md",
    "LICENSE",
    "NOTICE.md",
    "LICENSE-SCOPE.md",
    "_runtime/scripts/readiness.py",
  ])
    assert.ok(
      members.includes(`package/bundled-skills/${name}/${file}`),
      `Missing bundled skill file ${name}/${file}`,
    );
}
for (const file of [
  "bundled-skills/manifest.json",
  "reports/readiness/latest.json",
  "reports/readiness/latest.md",
])
  assert.ok(members.includes(`package/${file}`), `Missing readiness artifact ${file}`);
assert.equal(
  members.some((member) => /__pycache__|\.pyc$/.test(member)),
  false,
);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "mission-package-"));
try {
  execFileSync("tar", ["-xzf", absoluteArchive, "-C", temporary]);
  const packaged = path.join(temporary, "package");
  const manifest = JSON.parse(
    fs.readFileSync(path.join(packaged, "bundled-skills/manifest.json"), "utf8"),
  );
  for (const [file, expected] of Object.entries(manifest.sha256))
    assert.equal(
      createHash("sha256")
        .update(fs.readFileSync(path.join(packaged, "bundled-skills", file)))
        .digest("hex"),
      expected,
      file,
    );
  assert.equal(
    fs.readFileSync(path.join(packaged, "SKILL.md"), "utf8"),
    fs.readFileSync(path.join(packaged, "t3-mission/skill/SKILL.md"), "utf8"),
  );
  execFileSync(process.execPath, ["t3-mission/native/build.mjs", headers], {
    cwd: packaged,
    stdio: "inherit",
    timeout: 60000,
  });
  execFileSync(process.execPath, ["scripts/qa.mjs"], {
    cwd: packaged,
    stdio: "inherit",
    timeout: 60000,
  });
  const sha256 = createHash("sha256").update(fs.readFileSync(absoluteArchive)).digest("hex");
  const result = {
    archive: path.basename(absoluteArchive),
    sha256,
    nativeRebuilt: true,
    qa: "passed",
    layer: "download-independent local archive/native/HTTP",
    platform: process.platform,
    architecture: process.arch,
    node: process.version,
    bundledReadinessSkills: readinessSkills,
    bundledFilesVerified: Object.keys(manifest.sha256).length,
    readinessReportsIncluded: true,
  };
  fs.mkdirSync("reports", { recursive: true });
  fs.writeFileSync("reports/package-verification.json", JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result));
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
