import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const names = ["agent-readiness", "readiness-report", "readiness-fix"];

test("bundled readiness skills match their source manifest and ship no interpreter caches", () => {
  const directory = path.join(root, "bundled-skills");
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8"));
  const files = fs
    .readdirSync(directory, { recursive: true })
    .filter((file) => fs.statSync(path.join(directory, file)).isFile() && file !== "manifest.json")
    .sort();
  assert.deepEqual(files, Object.keys(manifest.sha256).sort());
  for (const file of files) {
    assert.doesNotMatch(file, /__pycache__|\.pyc$/);
    assert.equal(
      crypto
        .createHash("sha256")
        .update(fs.readFileSync(path.join(directory, file)))
        .digest("hex"),
      manifest.sha256[file],
      file,
    );
  }
  for (const name of names) {
    assert.ok(fs.existsSync(path.join(directory, name, "LICENSE")));
    const output = execFileSync(
      "python3",
      ["-B", path.join(directory, name, "_runtime/scripts/readiness.py"), "--version"],
      { encoding: "utf8" },
    );
    assert.match(output, /\d+\.\d+/);
  }
});

test("install links bundled readiness skills into detected agents and preserves existing installations", (t) => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-install-"));
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  const source = path.join(fixtureRoot, "source");
  const fixtureHome = path.join(fixtureRoot, "home");
  fs.mkdirSync(source);
  fs.copyFileSync(path.join(root, "install.sh"), path.join(source, "install.sh"));
  fs.cpSync(path.join(root, "bundled-skills"), path.join(source, "bundled-skills"), {
    recursive: true,
  });
  const canonical = path.join(fixtureHome, ".agents/skills");
  const targets = [
    ".codex/skills",
    ".claude/skills",
    ".gemini/antigravity-cli/skills",
    ".gemini/skills",
    ".gemini/config/skills",
    ".factory/skills",
    ".pi/agent/skills",
    ".config/opencode/skills",
    ".cursor/skills",
  ];
  for (const target of targets) fs.mkdirSync(path.join(fixtureHome, target), { recursive: true });
  fs.mkdirSync(path.join(canonical, "readiness-report"), { recursive: true });
  fs.writeFileSync(path.join(canonical, "readiness-report/SKILL.md"), "Existing canonical skill");
  fs.mkdirSync(path.join(fixtureHome, ".codex/skills/agent-readiness"));
  fs.writeFileSync(
    path.join(fixtureHome, ".codex/skills/agent-readiness/SKILL.md"),
    "Existing Codex skill",
  );
  fs.symlinkSync(
    path.join(fixtureRoot, "missing"),
    path.join(fixtureHome, ".claude/skills/readiness-fix"),
  );
  for (let attempt = 0; attempt < 2; attempt++) {
    execFileSync("bash", [path.join(source, "install.sh")], {
      env: { ...process.env, HOME: fixtureHome },
    });
    for (const name of names) assert.ok(fs.existsSync(path.join(canonical, name, "SKILL.md")));
    for (const target of targets) {
      assert.ok(fs.lstatSync(path.join(fixtureHome, target, "t3-mission-mode")).isSymbolicLink());
      for (const name of names) assert.ok(fs.lstatSync(path.join(fixtureHome, target, name)));
    }
    assert.equal(
      fs.readFileSync(path.join(canonical, "readiness-report/SKILL.md"), "utf8"),
      "Existing canonical skill",
    );
    assert.equal(
      fs.readFileSync(path.join(fixtureHome, ".codex/skills/agent-readiness/SKILL.md"), "utf8"),
      "Existing Codex skill",
    );
    assert.equal(
      fs.readlinkSync(path.join(fixtureHome, ".claude/skills/readiness-fix")),
      path.join(fixtureRoot, "missing"),
    );
  }
  assert.equal(
    fs.realpathSync(path.join(canonical, "readiness-fix")),
    fs.realpathSync(path.join(canonical, "t3-mission-mode/bundled-skills/readiness-fix")),
  );
});

test("the archived official readiness report covers the 84-criterion rubric at Level 5", () => {
  const report = JSON.parse(
    fs.readFileSync(path.join(root, "reports/readiness/latest.json"), "utf8"),
  );
  assert.equal(report.rubricVersion, "droid-0.240.0");
  assert.equal(Object.keys(report.report).length, 84);
  assert.equal(report.summary.achievedLevel, 5);
  assert.ok(report.summary.overallProgress.percentComplete >= 80);
  assert.ok(fs.existsSync(path.join(root, "reports/readiness/latest.md")));
});
