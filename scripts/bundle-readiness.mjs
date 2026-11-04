import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

// Refresh the portable upstream skills without shipping Python interpreter caches.
const root = fileURLToPath(new URL("../", import.meta.url));
const source = path.resolve(
  process.argv[2] || path.join(os.homedir(), ".local/share/agent-ready/skills"),
);
const destination = path.join(root, "bundled-skills");
const names = ["agent-readiness", "readiness-report", "readiness-fix"];
const hashes = {};
for (const name of names) {
  if (!fs.existsSync(path.join(source, name, "SKILL.md")))
    throw new Error(`Missing upstream skill: ${name}`);
}
for (const name of names) {
  const target = path.join(destination, name);
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(path.join(source, name), target, {
    recursive: true,
    filter: (file) => path.basename(file) !== "__pycache__" && !file.endsWith(".pyc"),
  });
  for (const file of fs.readdirSync(target, { recursive: true }).sort()) {
    const absolute = path.join(target, file);
    if (fs.statSync(absolute).isFile())
      hashes[`${name}/${file}`] = crypto
        .createHash("sha256")
        .update(fs.readFileSync(absolute))
        .digest("hex");
  }
}
fs.writeFileSync(
  path.join(destination, "manifest.json"),
  JSON.stringify({ source: "agent-ready portable skills", sha256: hashes }, null, 2) + "\n",
);
console.log(`Bundled ${names.length} readiness skills (${Object.keys(hashes).length} files).`);
