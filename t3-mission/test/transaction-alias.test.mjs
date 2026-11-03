import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { missionTransaction, listTransactionFiles } from "../kernel/mission-transaction.mjs";
import { archiveObservation, readObservations } from "../kernel/autopilot-store.mjs";
import { proposeMission } from "../kernel/index.mjs";

for (const existingArchive of [false, true])
  test(`transaction directory aliases retain staged observations and order; existing archive ${existingArchive}`, (t) => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "mission-alias-"));
    t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
    const real = path.join(fixture, "real");
    const alias = path.join(fixture, "alias");
    fs.mkdirSync(path.join(real, ".mission"), { recursive: true });
    proposeMission(real, {
      title: "Directory alias",
      repoPath: real,
      milestones: [{ id: "m1" }],
      features: [{ id: "f1", milestoneId: "m1" }],
    });
    fs.symlinkSync(real, alias, "dir");
    if (existingArchive)
      fs.mkdirSync(path.join(real, ".mission", "autopilot", "observations"), { recursive: true });
    const expected = Array.from({ length: 20 }, (_, index) => `owner-${index}`);
    missionTransaction(alias, () => {
      for (const ownerThreadId of expected)
        archiveObservation(alias, { type: "owner", ownerThreadId });
      const names = listTransactionFiles(path.join(alias, ".mission", "autopilot", "observations"));
      assert.equal(
        names.length,
        20,
        "Every staged file must be visible through the caller alias before commit",
      );
    });
    const throughReal = readObservations(real);
    assert.deepEqual(
      throughReal.map((row) => row.sequence),
      Array.from({ length: 20 }, (_, index) => index + 1),
    );
    assert.deepEqual(
      throughReal.map((row) => row.observation.ownerThreadId),
      expected,
    );
    assert.deepEqual(readObservations(alias), throughReal);
    archiveObservation(real, { type: "owner", ownerThreadId: "real-next" });
    archiveObservation(alias, { type: "owner", ownerThreadId: "alias-next" });
    assert.deepEqual(
      readObservations(real)
        .slice(-2)
        .map((row) => [row.sequence, row.observation.ownerThreadId]),
      [
        [21, "real-next"],
        [22, "alias-next"],
      ],
    );
  });

test("ambiguous archived sequence numbers stop replay and preserve the original records", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mission-sequence-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  proposeMission(dir, {
    title: "Sequence integrity",
    repoPath: dir,
    milestones: [{ id: "m1" }],
    features: [{ id: "f1", milestoneId: "m1" }],
  });
  archiveObservation(dir, { type: "owner", ownerThreadId: "first-owner" });
  const second = archiveObservation(dir, { type: "owner", ownerThreadId: "second-owner" });
  const file = path.join(dir, ".mission", "autopilot", "observations", second + ".json");
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  record.sequence = 1;
  fs.writeFileSync(file, JSON.stringify(record) + "\n");
  const original = fs.readFileSync(file);
  assert.throws(() => readObservations(dir), { code: "INVALID_OBSERVATION_ARCHIVE" });
  assert.deepEqual(
    fs.readFileSync(file),
    original,
    "Ambiguous history must not be renumbered during a read",
  );
});
