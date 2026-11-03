import fs from "node:fs";
import path from "node:path";
import { createMissionHudServer } from "../hud/server.mjs";

export async function createHandlerHud(options) {
  const hud = await createMissionHudServer({ ...options, port: 0 });
  return {
    ...hud,
    post: async (action, body = {}) => {
      const response = await fetch(hud.url + "/api/mission/" + action, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
      return { status: response.status, body: await response.json() };
    },
  };
}

export async function bounded(promise, timeoutMs = 4000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("HUD handler fixture timed out")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function saveContractEvidence(name, evidence) {
  if (process.env.R9_EVIDENCE_DIR) {
    fs.writeFileSync(
      path.join(process.env.R9_EVIDENCE_DIR, name + ".json"),
      JSON.stringify(evidence, null, 2) + "\n",
    );
  }
}
