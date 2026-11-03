import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createFallbackKernel, callMissionTool, createBridgeDispatchAdapter } from "../bridge/mcp-server.mjs";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mission-kernel-unavailable-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, ".mission"));
  for (const name of ["state.json", "features.json", "model-settings.json", "progress_log.jsonl"])
    fs.writeFileSync(path.join(dir, ".mission", name), name === "state.json" ? JSON.stringify({ status: "completed", revision: 12, activeWorker: null }) : "{}\n");
  return dir;
}
function bytes(dir) {
  return Object.fromEntries(fs.readdirSync(path.join(dir, ".mission")).map(name => [name, fs.readFileSync(path.join(dir, ".mission", name), "utf8")]));
}
for (const tool of ["ProposeMission", "ApproveMissionPlan", "StartMissionRun", "EndFeatureRun", "UpdateMissionFeatures", "BindFeatureDispatch"])
test(`Unavailable kernel refuses ${tool} without writes or runtime calls`, async t => {
  const dir = fixture(t), before = bytes(dir); let calls = 0;
  await assert.rejects(() => callMissionTool(tool, { missionDir: dir, runId: "original-run", featureId: "f1" }, { kernel: createFallbackKernel(), dispatchAdapter: { runFeature: async () => { calls++; }, resumeWorker: async () => { calls++; } } }), { code: "KERNEL_UNAVAILABLE" });
  assert.equal(calls, 0); assert.deepEqual(bytes(dir), before);
});
test("The exported compatibility sentinel cannot directly resume or dispatch", t => {
  const dir = fixture(t), before = bytes(dir);
  assert.throws(() => createFallbackKernel().startMissionRun(dir), { code: "KERNEL_UNAVAILABLE" });
  assert.deepEqual(bytes(dir), before);
});
for (const fault of ["missing", "import-error", "missing-tool"])
test(`Real kernel ${fault} cannot select a writable fallback`, async t => {
  const dir = fixture(t), before = bytes(dir), code = path.join(dir, "code");
  for (const rel of ["bridge/mcp-server.mjs", "bridge/t3-adapter.mjs", "kernel/schema.mjs"]) {
    const dest = path.join(code, rel); fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(new URL(`../${rel}`, import.meta.url), dest);
  }
  if (fault !== "missing") fs.writeFileSync(path.join(code, "kernel/index.mjs"), fault === "import-error" ? 'throw new Error("Owned kernel import failure");' : "export const incomplete = true;");
  const bridge = await import(pathToFileURL(path.join(code, "bridge/mcp-server.mjs")).href);
  await assert.rejects(() => bridge.callMissionTool("StartMissionRun", { missionDir: dir }), { code: "KERNEL_UNAVAILABLE" });
  assert.deepEqual(bytes(dir), before);
});
for (const method of ["runFeature", "resumeWorker"])
test(`Bridge ${method} returns metadata without writing a second state`, async t => {
  const dir = fixture(t), before = bytes(dir);
  const adapter = createBridgeDispatchAdapter(dir, { [method]: async () => ({ taskId: "real-task", childThreadId: "real-thread", resumed: false, accepted: method === "runFeature" }) });
  const result = method === "runFeature" ? await adapter.runFeature({ id: "f1" }, {}, { activeWorker: { runId: "original-run" } }) : await adapter.resumeWorker({ runId: "original-run", featureId: "f1" }, {}, {});
  assert.equal(result.taskId, "real-task"); assert.deepEqual(bytes(dir), before);
});
