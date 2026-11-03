import fs from "node:fs";
import path from "node:path";
import { parse } from "acorn";
const layers = {
  kernel: new Set(["kernel"]),
  bridge: new Set(["bridge", "kernel"]),
  hud: new Set(["hud", "bridge", "kernel", "ops"]),
  ops: new Set(["ops"]),
  native: new Set(["native"]),
};
const failures = [];
let count = 0;
function inspect(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      inspect(file);
      continue;
    }
    if (!/\.(?:mjs|js)$/.test(file)) continue;
    const from = file.split(path.sep)[1];
    const ast = parse(fs.readFileSync(file, "utf8"), {
      ecmaVersion: "latest",
      sourceType: "module",
    });
    for (const node of ast.body) {
      const specifier = node.source?.value;
      if (typeof specifier !== "string" || !specifier.startsWith(".")) continue;
      const target = path.normalize(path.join(path.dirname(file), specifier));
      const to = target.split(path.sep)[1];
      count++;
      if (
        !layers[from]?.has(to) ||
        target.startsWith("..") ||
        target.includes(`${path.sep}test${path.sep}`)
      )
        failures.push(`${file}: forbidden ${from} -> ${to} import ${specifier}`);
      if (!fs.existsSync(target)) failures.push(`${file}: unresolved local import ${specifier}`);
    }
  }
}
for (const layer of Object.keys(layers)) inspect(path.join("t3-mission", layer));
if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else
  console.log(
    `Verified ${count} local imports across kernel, bridge, HUD, operations, and native layers.`,
  );
